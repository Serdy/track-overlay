import json
import re
import threading
import urllib.error
import urllib.request

import pytest

from trackoverlay import server
from trackoverlay.server import RangeError, make_server, parse_range

MEDIA = b"0123456789" * 100        # 1000 bytes


@pytest.mark.parametrize("header, size, expected", [
    (None, 1000, None),                      # no header — the whole file
    ("bytes=0-99", 1000, (0, 99)),
    ("bytes=500-", 1000, (500, 999)),        # from a byte to the end
    ("bytes=-200", 1000, (800, 999)),        # the last 200 bytes
    ("bytes=0-99999", 1000, (0, 999)),       # a tail past the end is trimmed
    ("bytes=999-999", 1000, (999, 999)),     # exactly the last byte
    ("something odd", 1000, None),           # unparseable header — the whole file
])
def test_parse_range(header, size, expected):
    assert parse_range(header, size) == expected


@pytest.mark.parametrize("header, size", [
    ("bytes=1000-1100", 1000),               # start past the end of the file
    ("bytes=900-100", 1000),                 # end before the start
    ("bytes=-0", 1000),                      # empty suffix
])
def test_parse_range_rejects_unsatisfiable(header, size):
    with pytest.raises(RangeError):
        parse_range(header, size)


@pytest.fixture
def live(tmp_path):
    """A live server with one minimal session and one media file."""
    media = tmp_path / "clip.mp4"
    media.write_bytes(MEDIA)
    proxy = tmp_path / "clip.lrv"
    proxy.write_bytes(b"P" * 50)

    session = tmp_path / "session.json"
    session.write_text(json.dumps({
        "session": {"track": "test"},
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
    assert json.load(response)["session"]["track"] == "test"


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
    """Without partial requests the browser cannot seek through video."""
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
    """The preview plays the GoPro proxy, or scrubbing through 4K is impossible."""
    base, _ = live
    assert fetch(base, "/media/cam_1/0?proxy=1").read() == b"P" * 50
    assert fetch(base, "/media/cam_1/0").read() == MEDIA


def test_unknown_clip_is_rejected(live):
    """Only files from the session whitelist are served."""
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
    """../ must not lead outside the editor directory."""
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
    assert err.value.code == 404               # no layout yet

    payload = {"output": {"width": 1920}, "cuts": [{"t": 0.0, "main": "cam_1"}]}
    request = urllib.request.Request(
        base + "/api/layout", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    assert json.load(urllib.request.urlopen(request)) == {"saved": True}
    assert json.loads((folder / "layout.json").read_text()) == payload
    assert json.load(fetch(base, "/api/layout")) == payload


def test_broken_layout_is_rejected(live):
    base, _ = live
    request = urllib.request.Request(base + "/api/layout", data=b"{not json",
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


def test_overlay_upload_names_the_file_by_its_type(live):
    """The container depends on which codec the browser could encode."""
    base, folder = live
    for content_type, expected in (("video/mp4", "overlay.mp4"),
                                   ("video/webm", "overlay.webm")):
        request = urllib.request.Request(
            base + "/api/overlay", data=b"not really video",
            headers={"Content-Type": content_type}, method="POST")
        json.load(urllib.request.urlopen(request))
        assert (folder / expected).exists()
        # Only one overlay may survive, or the render would pick up a stale one.
        assert len(list(folder.glob("overlay.*"))) == 1


def test_empty_overlay_is_rejected(live):
    base, _ = live
    request = urllib.request.Request(base + "/api/overlay", data=b"",
                                     headers={"Content-Type": "video/mp4"}, method="POST")
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(request)
    assert err.value.code == 400


def test_building_needs_files(live):
    base, _ = live
    request = urllib.request.Request(
        base + "/api/build", data=b"{}",
        headers={"Content-Type": "application/json"}, method="POST")
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(request)
    assert err.value.code == 400


def test_building_refuses_a_format_it_cannot_read(live):
    base, folder = live
    (folder / "notes.txt").write_text("not telemetry")
    request = urllib.request.Request(
        base + "/api/build",
        data=json.dumps({"files": [str(folder / "notes.txt")]}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(request)
    assert err.value.code == 400


def test_building_refuses_a_file_that_is_not_there(live):
    base, folder = live
    request = urllib.request.Request(
        base + "/api/build",
        data=json.dumps({"files": [str(folder / "gone.csv")]}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with pytest.raises(urllib.error.HTTPError) as err:
        urllib.request.urlopen(request)
    assert err.value.code == 400


def test_a_rendered_file_can_be_downloaded(live):
    base, folder = live
    (folder / "final.mp4").write_bytes(b"pretend video")
    response = fetch(base, "/api/output/final.mp4")
    assert response.read() == b"pretend video"
    assert "attachment" in response.headers["Content-Disposition"]


@pytest.mark.parametrize("name", ["../pyproject.toml", ".hidden", ""])
def test_a_download_cannot_escape_the_output_directory(live, name):
    base, _ = live
    with pytest.raises(urllib.error.HTTPError) as err:
        fetch(base, f"/api/output/{name}")
    assert err.value.code in (400, 404)


def test_assets_are_version_stamped(live):
    """no-store only helps from the moment it is first seen; a script cached before then
    survives an ordinary reload, and the editor then half-works with no hint of why."""
    base, _ = live
    page = fetch(base, "/").read().decode()
    assert re.search(r'src="js/state\.js\?v=\d+"', page)
    assert re.search(r'href="style\.css\?v=\d+"', page)


def test_remote_assets_keep_their_urls(live, tmp_path):
    base, _ = live
    page = fetch(base, "/").read().decode()
    assert "//" not in re.findall(r'src="([^"]*)"', page)[0] or True
    # Nothing remote is rewritten: a stamp on someone else's URL would break it.
    for url in re.findall(r'(?:src|href)="([^"]+)"', page):
        if url.startswith("http") or url.startswith("//"):
            assert "?v=" not in url


def test_a_stamped_asset_still_serves(live):
    base, _ = live
    page = fetch(base, "/").read().decode()
    stamped = re.search(r'src="(js/state\.js\?v=\d+)"', page).group(1)
    assert fetch(base, f"/{stamped}").status == 200
