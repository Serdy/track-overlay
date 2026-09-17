import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from types import SimpleNamespace

import pytest

from trackoverlay import projects, server
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


def _project(root, name, track):
    """A built project: one minimal session, one media file and its proxy."""
    folder = root / name
    folder.mkdir(parents=True)
    media = folder / f"{name}.mp4"
    media.write_bytes(MEDIA)
    proxy = folder / f"{name}.lrv"
    proxy.write_bytes(b"P" * 50)
    (folder / "session.json").write_text(json.dumps({
        "session": {"track": track, "duration_s": 100.0},
        "clips": [{"id": "cam_1", "files": [str(media)], "proxy": [str(proxy)],
                   "offset_s": 1.4}],
    }), encoding="utf-8")
    (folder / "out").mkdir()
    return folder


@pytest.fixture
def data_root(tmp_path):
    root = tmp_path / "data"
    _project(root, "demo", "test")
    _project(root, "other", "elsewhere")
    return root


@pytest.fixture
def live(data_root):
    """A live server over a data directory holding two projects."""
    httpd = make_server(data_root, port=0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield SimpleNamespace(
        base=base, root=data_root, folder=data_root / "demo",
        url=lambda path, name="demo": f"{base}/p/{name}{path}")
    httpd.shutdown()
    httpd.server_close()


@pytest.fixture
def legacy(data_root):
    """The old shape: bound to one session file, un-prefixed routes."""
    httpd = make_server(data_root, session_path=data_root / "demo" / "session.json", port=0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def fetch(base, path="", **headers):
    request = urllib.request.Request(base + path, headers=headers)
    return urllib.request.urlopen(request)


def post(url, payload=b"{}", content_type="application/json"):
    data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, method="POST",
                                     headers={"Content-Type": content_type})
    return urllib.request.urlopen(request)


def test_serves_session(live):
    response = fetch(live.url("/api/session"))
    assert response.status == 200
    assert json.load(response)["session"]["track"] == "test"


def test_serves_editor_index(live):
    assert fetch(live.url("/")).status == 200


def test_the_project_list_is_served_without_any_session(live):
    """The chicken and egg the command line used to solve: no session, no editor."""
    assert fetch(live.base, "/").status == 200
    listed = json.load(fetch(live.base, "/api/projects"))
    assert {p["name"] for p in listed} == {"demo", "other"}
    assert all(p["built"] for p in listed)


def test_two_projects_serve_their_own_media(live):
    """Two tabs, two projects: the reason the project is in the URL and not on the server."""
    assert fetch(live.url("/api/session", "demo")).read() != \
        fetch(live.url("/api/session", "other")).read()
    assert json.load(fetch(live.url("/api/session", "other")))["session"]["track"] == "elsewhere"


@pytest.mark.parametrize("name", ["..", "%2e%2e", "nope", "a%2fb", "Upper"])
def test_a_project_name_cannot_escape_the_data_root(live, name):
    with pytest.raises(urllib.error.HTTPError) as err:
        fetch(f"{live.base}/p/{name}/api/session")
    assert err.value.code == 404


def test_a_new_project_can_be_created(live):
    created = json.load(post(live.base + "/api/projects", {"title": "Track day"}))
    assert created["name"] == "track-day"
    assert (live.root / "track-day").is_dir()


def test_a_project_needs_a_usable_name(live):
    with pytest.raises(urllib.error.HTTPError) as err:
        post(live.base + "/api/projects", {"title": "!!!"})
    assert err.value.code == 400


def test_an_api_call_without_a_project_says_so(live):
    with pytest.raises(urllib.error.HTTPError) as err:
        fetch(live.base, "/api/session")
    assert err.value.code == 404
    assert "/p/<name>" in json.load(err.value)["error"]


def test_full_media_request(live):
    response = fetch(live.url("/media/cam_1/0"))
    assert response.status == 200
    assert response.headers["Accept-Ranges"] == "bytes"
    assert response.read() == MEDIA


def test_range_request_returns_206(live):
    """Without partial requests the browser cannot seek through video."""
    response = fetch(live.url("/media/cam_1/0"), Range="bytes=10-19")
    assert response.status == 206
    assert response.headers["Content-Range"] == f"bytes 10-19/{len(MEDIA)}"
    assert response.read() == MEDIA[10:20]


def test_unsatisfiable_range_returns_416(live):
    with pytest.raises(urllib.error.HTTPError) as err:
        fetch(live.url("/media/cam_1/0"), Range="bytes=99999-")
    assert err.value.code == 416
    assert err.value.headers["Content-Range"] == f"bytes */{len(MEDIA)}"


def test_proxy_is_served_when_asked(live):
    """The preview plays the GoPro proxy, or scrubbing through 4K is impossible."""
    assert fetch(live.url("/media/cam_1/0?proxy=1")).read() == b"P" * 50
    assert fetch(live.url("/media/cam_1/0")).read() == MEDIA


def test_unknown_clip_is_rejected(live):
    """Only files from the session whitelist are served."""
    for path in ("/media/cam_99/0", "/media/cam_1/7"):
        with pytest.raises(urllib.error.HTTPError) as err:
            fetch(live.url(path))
        assert err.value.code == 404


def test_malformed_media_path_is_rejected(live):
    for path in ("/media/cam_1", "/media/cam_1/abc"):
        with pytest.raises(urllib.error.HTTPError) as err:
            fetch(live.url(path))
        assert err.value.code in (400, 404)


def test_path_traversal_is_blocked(live):
    """../ must not lead outside the editor directory."""
    for path in ("/../pyproject.toml", "/..%2fpyproject.toml", "/js/../../pyproject.toml"):
        try:
            response = fetch(live.base, path)
        except urllib.error.HTTPError as err:
            assert err.code == 404
        else:
            assert b"[project]" not in response.read()


def test_layout_round_trip(live):
    with pytest.raises(urllib.error.HTTPError) as err:
        fetch(live.url("/api/layout"))
    assert err.value.code == 404               # no layout yet

    payload = {"output": {"width": 1920}, "cuts": [{"t": 0.0, "main": "cam_1"}]}
    assert json.load(post(live.url("/api/layout"), payload)) == {"saved": True}
    assert json.loads((live.folder / "layout.json").read_text()) == payload
    assert json.load(fetch(live.url("/api/layout"))) == payload


def test_broken_layout_is_rejected(live):
    with pytest.raises(urllib.error.HTTPError) as err:
        post(live.url("/api/layout"), b"{not json")
    assert err.value.code == 400


def test_unknown_post_route(live):
    with pytest.raises(urllib.error.HTTPError) as err:
        post(live.url("/api/nope"))
    assert err.value.code == 404


def test_overlay_upload_names_the_file_by_its_type(live):
    """The container depends on which codec the browser could encode."""
    out = live.folder / "out"
    for content_type, expected in (("video/mp4", "overlay.mp4"),
                                   ("video/webm", "overlay.webm")):
        json.load(post(live.url("/api/overlay"), b"not really video", content_type))
        assert (out / expected).exists()
        # Only one overlay may survive, or the render would pick up a stale one.
        assert len(list(out.glob("overlay.*"))) == 1


def test_empty_overlay_is_rejected(live):
    with pytest.raises(urllib.error.HTTPError) as err:
        post(live.url("/api/overlay"), b"", "video/mp4")
    assert err.value.code == 400


def test_building_needs_telemetry(live):
    """A project holding only video has nothing to draw."""
    with pytest.raises(urllib.error.HTTPError) as err:
        post(live.url("/api/build"))
    assert err.value.code == 400
    assert "RaceBox" in json.load(err.value)["error"]


def test_adding_a_format_it_cannot_read_is_refused(live):
    (live.folder / "notes.txt").write_text("not telemetry")
    with pytest.raises(urllib.error.HTTPError) as err:
        post(live.url("/api/sources"), {"files": [str(live.folder / "notes.txt")]})
    assert err.value.code == 400


def test_adding_a_file_that_is_not_there_is_refused(live):
    with pytest.raises(urllib.error.HTTPError) as err:
        post(live.url("/api/sources"), {"files": [str(live.folder / "gone.csv")]})
    assert err.value.code == 400


def test_sources_are_registered_and_listed(live, tmp_path):
    outside = tmp_path / "card"
    outside.mkdir()
    (outside / "GH013429.MP4").write_bytes(b"x")

    listed = json.load(post(live.url("/api/sources"),
                            {"files": [str(outside / "GH013429.MP4")]}))
    assert listed["videos"] == 2                # the project's own clip plus this one
    assert json.load(fetch(live.url("/api/project")))["videos"] == 2


def test_a_confirmed_sync_reaches_the_session(live):
    """The number ffmpeg reads is offset_s, so that is where a confirmation must land."""
    answer = json.load(post(live.url("/api/sync"),
                            {"clip": "cam_1", "manual_s": 0.5, "confirmed": True}))
    assert answer["clips"][0]["offset_s"] == pytest.approx(1.9)

    session = json.loads((live.folder / "session.json").read_text())
    assert session["clips"][0]["auto_offset_s"] == pytest.approx(1.4)
    assert session["clips"][0]["sync"]["confirmed"] is True
    assert projects.read(live.root, "demo").manual_sync == {"cam_1": 0.5}


def test_dragging_the_slider_twice_measures_from_one_baseline(live):
    post(live.url("/api/sync"), {"clip": "cam_1", "manual_s": 0.5})
    answer = json.load(post(live.url("/api/sync"), {"clip": "cam_1", "manual_s": -0.2}))
    assert answer["clips"][0]["offset_s"] == pytest.approx(1.2)


def test_syncing_an_unknown_clip_is_refused(live):
    with pytest.raises(urllib.error.HTTPError) as err:
        post(live.url("/api/sync"), {"clip": "cam_99", "manual_s": 0.5})
    assert err.value.code == 400


def test_a_rendered_file_can_be_downloaded(live):
    (live.folder / "out" / "final.mp4").write_bytes(b"pretend video")
    response = fetch(live.url("/api/output/final.mp4"))
    assert response.read() == b"pretend video"
    assert "attachment" in response.headers["Content-Disposition"]


@pytest.mark.parametrize("name", ["../session.json", ".hidden", ""])
def test_a_download_cannot_escape_the_output_directory(live, name):
    with pytest.raises(urllib.error.HTTPError) as err:
        fetch(live.url(f"/api/output/{name}"))
    assert err.value.code in (400, 404)


def test_assets_are_version_stamped(live):
    """no-store only helps from the moment it is first seen; a script cached before then
    survives an ordinary reload, and the editor then half-works with no hint of why."""
    page = fetch(live.url("/")).read().decode()
    # Rooted, not relative: from /p/demo/ a relative js/state.js would 404 in silence.
    assert re.search(r'src="/js/state\.js\?v=\d+"', page)
    assert re.search(r'href="/style\.css\?v=\d+"', page)


def test_remote_assets_keep_their_urls(live, tmp_path):
    page = fetch(live.url("/")).read().decode()
    assert "//" not in re.findall(r'src="([^"]*)"', page)[0] or True
    # Nothing remote is rewritten: a stamp on someone else's URL would break it.
    for url in re.findall(r'(?:src|href)="([^"]+)"', page):
        if url.startswith("http") or url.startswith("//"):
            assert "?v=" not in url


def test_a_stamped_asset_still_serves(live):
    page = fetch(live.url("/")).read().decode()
    stamped = re.search(r'src="(/js/state\.js\?v=\d+)"', page).group(1)
    assert fetch(live.base, stamped).status == 200


def test_a_bare_project_url_redirects_to_the_folder(live):
    """Without the trailing slash the page's own relative links would resolve wrong."""
    response = fetch(f"{live.base}/p/demo")
    assert response.status == 200
    assert response.url.endswith("/p/demo/")


def test_the_legacy_session_argument_still_serves_the_editor(legacy):
    assert json.load(fetch(legacy, "/api/session"))["session"]["track"] == "test"
    assert fetch(legacy, "/").status == 200


def test_the_legacy_mode_still_serves_media(legacy):
    assert fetch(legacy, "/media/cam_1/0").read() == MEDIA


def test_footage_that_is_gone_can_be_dropped_from_the_project(live):
    session = live.folder / "session.json"
    payload = json.loads(session.read_text())
    payload["clips"][0]["files"] = ["/gone/GH013446.MP4"]
    payload["clips"][0]["proxy"] = None
    session.write_text(json.dumps(payload))
    post(live.url("/api/sources"), {"files": []})

    gone = json.load(fetch(live.url("/api/project")))["missing"]
    assert gone == [{"clip": "cam_1", "name": "GH013446.MP4", "path": "/gone/GH013446.MP4"}]

    answer = json.load(post(live.url("/api/sources"), {"remove": ["/gone/GH013446.MP4"]}))
    assert "/gone/GH013446.MP4" not in answer["files"]
    # The camera goes with it, or the session still names footage nobody has.
    assert answer["session_changed"] is True
    assert json.loads(session.read_text())["clips"] == []
    assert json.load(fetch(live.url("/api/project")))["missing"] == []


def test_a_camera_whose_drive_is_unplugged_is_not_dropped(live, tmp_path):
    """Removing a path that still resolves means tidying the list, not losing a camera."""
    elsewhere = tmp_path / "card"
    elsewhere.mkdir()
    (elsewhere / "GH013446.MP4").write_bytes(b"x")
    post(live.url("/api/sources"), {"files": [str(elsewhere / "GH013446.MP4")]})

    answer = json.load(post(live.url("/api/sources"),
                            {"remove": [str(elsewhere / "GH013446.MP4")]}))
    assert answer["session_changed"] is False
    assert len(json.loads((live.folder / "session.json").read_text())["clips"]) == 1


def test_the_page_is_told_what_this_machine_can_do(live):
    """In a container there is no file dialog to open, and a button that can only fail is
    worse than no button."""
    able = json.load(fetch(live.base, "/api/capabilities"))
    assert set(able) == {"file_dialog", "reveal", "data_root"}
    assert able["data_root"] == str(live.root)


def test_media_is_found_beside_the_project_when_its_path_moved(live):
    """The container case: the session names /Users/..., the footage arrives at /data."""
    session = live.folder / "session.json"
    payload = json.loads(session.read_text())
    payload["clips"][0]["files"] = ["/gone/demo.mp4"]
    payload["clips"][0]["proxy"] = ["/gone/demo.lrv"]
    session.write_text(json.dumps(payload))

    assert fetch(live.url("/media/cam_1/0")).read() == MEDIA


def upload(url, name, payload):
    request = urllib.request.Request(
        f"{url}?name={urllib.parse.quote(name)}", data=payload, method="POST",
        headers={"Content-Type": "application/octet-stream"})
    return urllib.request.urlopen(request)


def test_a_file_can_be_uploaded_into_a_project(live):
    """The container case: no dialog to open, and the footage is not on the server's disk."""
    answer = json.load(upload(live.url("/api/upload"), "GH013429.MP4", b"pretend video"))
    assert (live.folder / "GH013429.MP4").read_bytes() == b"pretend video"
    assert answer["videos"] == 2                # the project's own clip plus this one


@pytest.mark.parametrize("name", ["notes.txt", "", ".hidden.csv"])
def test_an_upload_the_tool_cannot_read_is_refused(live, name):
    with pytest.raises(urllib.error.HTTPError) as err:
        upload(live.url("/api/upload"), name, b"x")
    assert err.value.code == 400


def test_an_upload_cannot_escape_the_project_folder(live):
    upload(live.url("/api/upload"), "../../escaped.csv", b"Record,Time\n")
    assert (live.folder / "escaped.csv").is_file()
    assert not (live.root.parent / "escaped.csv").exists()


def test_an_empty_upload_is_refused(live):
    with pytest.raises(urllib.error.HTTPError) as err:
        upload(live.url("/api/upload"), "a.csv", b"")
    assert err.value.code == 400


def test_a_failed_upload_leaves_nothing_that_looks_like_footage(live):
    with pytest.raises(urllib.error.HTTPError):
        upload(live.url("/api/upload"), "a.csv", b"")
    assert not list(live.folder.glob(".*.part"))


def test_a_browser_abandoning_a_video_is_not_an_error(capsys):
    """Every scrub abandons a range request. Reporting each one buries anything real."""
    quiet = server.Server.__new__(server.Server)
    try:
        raise BrokenPipeError(32, "Broken pipe")
    except BrokenPipeError:
        quiet.handle_error(None, ("127.0.0.1", 0))
    assert capsys.readouterr().err == ""


def test_a_real_failure_is_still_reported(capsys):
    quiet = server.Server.__new__(server.Server)
    try:
        raise ValueError("something actually went wrong")
    except ValueError:
        quiet.handle_error(None, ("127.0.0.1", 0))
    assert "something actually went wrong" in capsys.readouterr().err


def test_an_upload_never_lands_on_an_existing_source(live):
    """Two cameras produce the same filenames from their own cards, and the copy in the
    project may be the only one left of either."""
    upload(live.url("/api/upload"), "GH013429.MP4", b"first camera")
    with pytest.raises(urllib.error.HTTPError) as err:
        upload(live.url("/api/upload"), "GH013429.MP4", b"second camera")

    assert err.value.code == 409
    assert (live.folder / "GH013429.MP4").read_bytes() == b"first camera"


def test_confirming_the_sync_marks_only_that_camera(live):
    session = live.folder / "session.json"
    payload = json.loads(session.read_text())
    payload["clips"].append({"id": "cam_2", "files": [], "offset_s": 0.0})
    session.write_text(json.dumps(payload))

    post(live.url("/api/sync"), {"clip": "cam_1", "manual_s": 0.5, "confirmed": True})
    clips = {c["id"]: c for c in json.loads(session.read_text())["clips"]}
    assert clips["cam_1"]["sync"]["confirmed"] is True
    assert "confirmed" not in clips["cam_2"].get("sync", {})


def test_a_render_uses_the_layout_it_was_sent(live):
    """The layer was drawn against that layout; the file on disk may have moved on — a
    widget dragged or a resolution changed while ffmpeg was still running."""
    (live.folder / "layout.json").write_text(json.dumps(
        {"cuts": [{"t": 0, "main": "cam_1", "pip": None}], "output": {"width": 640}}))
    sent = {"cuts": [{"t": 0, "main": "cam_nowhere", "pip": None}],
            "output": {"width": 1280, "height": 720, "fps": 30}}

    job = json.load(post(live.url("/api/render"), {"duration": 1, "layout": sent}))
    for _ in range(50):
        state = json.load(fetch(live.base, f"/api/render/{job['id']}"))
        if state["state"] != "running":
            break
        time.sleep(0.1)
    # The sent layout names a camera the session does not have; the file on disk does not.
    assert "cam_nowhere" in state["message"]
