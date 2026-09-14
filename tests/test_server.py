import json
import threading
import urllib.error
import urllib.request

import pytest

from trackoverlay import server
from trackoverlay.server import RangeError, make_server, parse_range

MEDIA = b"0123456789" * 100        # 1000 байт


@pytest.mark.parametrize("header, size, expected", [
    (None, 1000, None),                      # заголовка нет — файл целиком
    ("bytes=0-99", 1000, (0, 99)),
    ("bytes=500-", 1000, (500, 999)),        # от байта до конца
    ("bytes=-200", 1000, (800, 999)),        # последние 200 байт
    ("bytes=0-99999", 1000, (0, 999)),       # хвост за границей обрезается
    ("bytes=999-999", 1000, (999, 999)),     # ровно последний байт
    ("что-то странное", 1000, None),         # непонятный заголовок — файл целиком
])
def test_parse_range(header, size, expected):
    assert parse_range(header, size) == expected


@pytest.mark.parametrize("header, size", [
    ("bytes=1000-1100", 1000),               # начало за концом файла
    ("bytes=900-100", 1000),                 # конец раньше начала
    ("bytes=-0", 1000),                      # пустой суффикс
])
def test_parse_range_rejects_unsatisfiable(header, size):
    with pytest.raises(RangeError):
        parse_range(header, size)


@pytest.fixture
def live(tmp_path):
    """Поднятый сервер с одной минимальной сессией и одним медиафайлом."""
    media = tmp_path / "clip.mp4"
    media.write_bytes(MEDIA)
    proxy = tmp_path / "clip.lrv"
    proxy.write_bytes(b"P" * 50)

    session = tmp_path / "session.json"
    session.write_text(json.dumps({
        "session": {"track": "тест"},
        "clips": [{"id": "cam_1", "files": [str(media)], "proxy": [str(proxy)]}],
    }), encoding="utf-8")

    httpd = make_server(session, layout_path=tmp_path / "layout.json", port=0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", tmp_path
    httpd.shutdown()
    httpd.server_close()


def fetch(base, path, **headers):
    request = urllib.request.Request(base + path, headers=headers)
    return urllib.request.urlopen(request)


def test_serves_session(live):
    base, _ = live
    response = fetch(base, "/api/session")
    assert response.status == 200
    assert json.load(response)["session"]["track"] == "тест"


def test_serves_editor_index(live):
    base, _ = live
    assert fetch(base, "/").status == 200


def test_full_media_request(live):
    base, _ = live
    response = fetch(base, "/media/cam_1/0")
    assert response.status == 200
    assert response.headers["Accept-Ranges"] == "bytes"
    assert response.read() == MEDIA


def test_range_request_returns_206(live):
    """Без частичных запросов браузер не сможет перематывать видео."""
    base, _ = live
    response = fetch(base, "/media/cam_1/0", Range="bytes=10-19")
    assert response.status == 206
    assert response.headers["Content-Range"] == f"bytes 10-19/{len(MEDIA)}"
    assert response.read() == MEDIA[10:20]


def test_unsatisfiable_range_returns_416(live):
    base, _ = live
    with pytest.raises(urllib.error.HTTPError) as err:
        fetch(base, "/media/cam_1/0", Range="bytes=99999-")
    assert err.value.code == 416
    assert err.value.headers["Content-Range"] == f"bytes */{len(MEDIA)}"


def test_proxy_is_served_when_asked(live):
    """Превью играет по прокси GoPro, иначе скраб по 4K невозможен."""
    base, _ = live
    assert fetch(base, "/media/cam_1/0?proxy=1").read() == b"P" * 50
    assert fetch(base, "/media/cam_1/0").read() == MEDIA


def test_unknown_clip_is_rejected(live):
    """Отдаются только файлы из белого списка сессии."""
    base, _ = live
    for path in ("/media/cam_99/0", "/media/cam_1/7"):
        with pytest.raises(urllib.error.HTTPError) as err:
            fetch(base, path)
        assert err.value.code == 404


def test_malformed_media_path_is_rejected(live):
    base, _ = live
    for path in ("/media/cam_1", "/media/cam_1/abc"):
        with pytest.raises(urllib.error.HTTPError) as err:
            fetch(base, path)
        assert err.value.code in (400, 404)


def test_path_traversal_is_blocked(live):
    """../ не должен выводить за пределы каталога редактора."""
    base, _ = live
    for path in ("/../pyproject.toml", "/..%2fpyproject.toml", "/js/../../pyproject.toml"):
        try:
            response = fetch(base, path)
        except urllib.error.HTTPError as err:
            assert err.code == 404
        else:
            assert b"[project]" not in response.read()


def test_layout_round_trip(live):
    base, folder = live
    with pytest.raises(urllib.error.HTTPError) as err:
        fetch(base, "/api/layout")
    assert err.value.code == 404               # раскладки ещё нет

    payload = {"output": {"width": 1920}, "cuts": [{"t": 0.0, "main": "cam_1"}]}
    request = urllib.request.Request(
        base + "/api/layout", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    assert json.load(urllib.request.urlopen(request)) == {"saved": True}
    assert json.loads((folder / "layout.json").read_text()) == payload
    assert json.load(fetch(base, "/api/layout")) == payload


def test_broken_layout_is_rejected(live):
    base, _ = live
    request = urllib.request.Request(base + "/api/layout", data="{не json".encode(),
                                     method="POST")
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(request)
    assert err.value.code == 400


def test_unknown_post_route(live):
    base, _ = live
    request = urllib.request.Request(base + "/api/nope", data=b"{}", method="POST")
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(request)
    assert err.value.code == 404
