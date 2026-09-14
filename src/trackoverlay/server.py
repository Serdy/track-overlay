"""A local HTTP server: serves the editor, the session and the video.

A server cannot be avoided here, even though the viewer in the neighbouring
``DDA_Reader`` lives straight on ``file://``. The reason is range requests: the browser
seeks through video by asking for pieces of the file, and that machinery is unavailable
on ``file://``. Besides, something has to launch ffmpeg when the export button is hit.

Video is served **from a whitelist only**, taken from the session itself and addressed
by clip and chunk number. Arbitrary paths are never exposed, so there is nothing to
escape — not because of checks, but by construction.
"""

from __future__ import annotations

import json
import mimetypes
import re
import subprocess
import sys
import threading
import uuid
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parent.parent.parent / "web"
CHUNK = 1 << 20                       # 1 MiB per socket write

# Opens the system file dialog. Run through System Events so the window comes to the
# front rather than appearing behind whatever the person was looking at.
CHOOSE_SCRIPT = """
tell application "System Events"
	activate
	set chosen to choose file with prompt "Choose GoPro video and RaceBox exports" with multiple selections allowed
end tell
set out to ""
repeat with f in chosen
	set out to out & POSIX path of f & linefeed
end repeat
return out
"""

# What the tool can read. Anything else picked in the dialog is ignored.
READABLE = {".mp4", ".mov", ".csv", ".vbo"}
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


class Job:
    """One background render, watched by the browser through polling."""

    def __init__(self, identifier: str):
        self.id = identifier
        self.progress = 0.0
        self.state = "running"          # running | done | failed | cancelled
        self.message = ""
        self.output: Path | None = None
        self.cancel = threading.Event()

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "progress": round(self.progress, 4),
            "message": self.message,
            "output": str(self.output) if self.output else None,
        }


JOBS: dict[str, Job] = {}


class RangeError(Exception):
    """The requested range does not intersect the file (HTTP 416)."""


@dataclass(frozen=True)
class Media:
    """The whitelist of files that may be served."""
    full: dict[tuple[str, int], Path]
    proxy: dict[tuple[str, int], Path]

    @classmethod
    def from_session(cls, payload: dict) -> "Media":
        full, proxy = {}, {}
        for clip in payload.get("clips", []):
            for i, path in enumerate(clip.get("files") or []):
                full[(clip["id"], i)] = Path(path)
            for i, path in enumerate(clip.get("proxy") or []):
                proxy[(clip["id"], i)] = Path(path)
        return cls(full, proxy)

    def resolve(self, clip_id: str, index: int, *, prefer_proxy: bool) -> Path | None:
        key = (clip_id, index)
        if prefer_proxy and key in self.proxy:
            return self.proxy[key]
        return self.full.get(key)


def parse_range(header: str | None, size: int) -> tuple[int, int] | None:
    """``Range: bytes=…`` to ``(first byte, last byte)``, inclusive.

    ``None`` means there was no header and the whole file should go out.
    """
    if not header:
        return None
    match = _RANGE.match(header.strip())
    if not match:
        return None                   # unparseable header — serve the whole file
    first, last = match.group(1), match.group(2)

    if not first:                     # bytes=-500: the last 500 bytes
        length = int(last or 0)
        if length <= 0:
            raise RangeError("empty suffix range")
        return max(0, size - length), size - 1

    start = int(first)
    end = int(last) if last else size - 1
    if start >= size or start > end:
        raise RangeError(f"range {start}-{end} lies outside a file of {size} bytes")
    return start, min(end, size - 1)


class Handler(BaseHTTPRequestHandler):
    server_version = "trackoverlay"
    session_path: Path
    layout_path: Path
    media: Media

    def log_message(self, fmt, *args):      # quieter than the default logger
        pass

    # --- sending --------------------------------------------------------------

    def _send(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: HTTPStatus, message: str) -> None:
        self._send(status, json.dumps({"error": message}, ensure_ascii=False).encode(),
                   "application/json; charset=utf-8")

    def _send_file(self, path: Path) -> None:
        """Serves a file, honouring partial requests."""
        if not path.exists():
            return self._error(HTTPStatus.NOT_FOUND, f"no file {path.name}")
        size = path.stat().st_size
        media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"

        try:
            span = parse_range(self.headers.get("Range"), size)
        except RangeError as err:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if span is None:
            start, end, status = 0, size - 1, HTTPStatus.OK
        else:
            start, end = span
            status = HTTPStatus.PARTIAL_CONTENT

        self.send_response(status)
        self.send_header("Content-Type", media_type)
        self.send_header("Accept-Ranges", "bytes")
        # The editor is served straight off the working tree, so a cached copy means
        # editing a file and reloading quietly changes nothing. Video is exempt: those
        # files are large, immutable during a session, and re-fetching them on every
        # scrub would be painful.
        if path.suffix.lower() not in (".mp4", ".lrv", ".mov"):
            self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(end - start + 1))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return

        remaining = end - start + 1
        with path.open("rb") as handle:
            handle.seek(start)
            while remaining > 0:
                block = handle.read(min(CHUNK, remaining))
                if not block:
                    break
                self.wfile.write(block)
                remaining -= len(block)

    # --- routes ----------------------------------------------------------------

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path, _, query = self.path.partition("?")

        if path in ("/", "/index.html"):
            return self._send_index()
        if path == "/api/session":
            return self._send_file(self.session_path)
        if path == "/api/layout":
            if not self.layout_path.exists():
                return self._error(HTTPStatus.NOT_FOUND, "no layout saved yet")
            return self._send_file(self.layout_path)
        if path.startswith("/api/render/"):
            job = JOBS.get(path.rsplit("/", 1)[-1])
            if job is None:
                return self._error(HTTPStatus.NOT_FOUND, "no such render job")
            return self._send(HTTPStatus.OK,
                              json.dumps(job.as_dict()).encode(),
                              "application/json; charset=utf-8")
        if path.startswith("/media/"):
            return self._serve_media(path, query)
        if path.startswith("/api/output/"):
            return self._serve_output(path)

        # Editor statics. Canonicalise the path and make sure it stayed inside web/ —
        # otherwise ../ would lead out.
        target = (WEB_ROOT / path.lstrip("/")).resolve()
        if not target.is_relative_to(WEB_ROOT.resolve()) or not target.is_file():
            return self._error(HTTPStatus.NOT_FOUND, f"no resource {path}")
        return self._send_file(target)

    def _serve_media(self, path: str, query: str) -> None:
        parts = path.strip("/").split("/")
        if len(parts) != 3:
            return self._error(HTTPStatus.BAD_REQUEST, "expected /media/<clip>/<index>")
        _, clip_id, index = parts
        if not index.isdigit():
            return self._error(HTTPStatus.BAD_REQUEST, "the chunk index must be a number")
        target = self.media.resolve(clip_id, int(index), prefer_proxy="proxy=1" in query)
        if target is None:
            return self._error(HTTPStatus.NOT_FOUND, f"clip {clip_id}/{index} is not in the session")
        return self._send_file(target)

    def do_POST(self):
        if self.path == "/api/overlay":
            return self._receive_overlay()
        if self.path == "/api/render":
            return self._start_render()
        if self.path == "/api/reveal":
            return self._reveal_output()
        if self.path == "/api/build":
            return self._start_build()
        if self.path == "/api/choose":
            return self._choose_files()
        if self.path.startswith("/api/render/") and self.path.endswith("/cancel"):
            job = JOBS.get(self.path.split("/")[3])
            if job is None:
                return self._error(HTTPStatus.NOT_FOUND, "no such render job")
            job.cancel.set()
            return self._send(HTTPStatus.OK, b'{"cancelled":true}', "application/json")
        if self.path != "/api/layout":
            return self._error(HTTPStatus.NOT_FOUND, f"no route {self.path}")
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as err:
            return self._error(HTTPStatus.BAD_REQUEST, f"the layout does not parse: {err}")
        self.layout_path.parent.mkdir(parents=True, exist_ok=True)
        self.layout_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self._send(HTTPStatus.OK, b'{"saved":true}', "application/json")


    def _send_index(self) -> None:
        """Serves the editor page with a version stamped onto every local asset.

        `Cache-Control: no-store` only helps from the moment it is first seen. A browser
        that cached a script before then will keep serving it on an ordinary reload, and
        the symptom - half the editor quietly not working - gives no hint of the cause.
        A stamp derived from the file's own mtime sidesteps the cache entirely.
        """
        page = (WEB_ROOT / "index.html").read_text(encoding="utf-8")

        def stamp(match: re.Match) -> str:
            attribute, url = match.group(1), match.group(2)
            if "//" in url:
                return match.group(0)            # leave anything remote alone
            asset = (WEB_ROOT / url).resolve()
            if not asset.is_file():
                return match.group(0)
            return f'{attribute}="{url}?v={int(asset.stat().st_mtime)}"'

        page = re.sub(r'(src|href)="([^"]+)"', stamp, page)
        body = page.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _choose_files(self) -> None:
        """Opens the system file dialog and returns what was picked.

        A folder browser rendered in the page was the obvious thing to build and the
        wrong thing to use: people already know their own file dialog, and it handles
        favourites, search, and network volumes that this would have had to reimplement.

        The request blocks until the dialog is answered, which is fine - it was opened by
        a click a moment earlier, and nothing else is waiting on it.
        """
        if sys.platform != "darwin":
            return self._error(HTTPStatus.NOT_IMPLEMENTED,
                               "the file dialog is wired up for macOS only; "
                               "use the build command instead")
        done = subprocess.run(["osascript", "-e", CHOOSE_SCRIPT],
                              capture_output=True, text=True)
        if done.returncode != 0 or "User canceled" in done.stderr:
            # Cancelling is an ordinary outcome, not a failure.
            return self._send(HTTPStatus.OK, b'{"files":[],"cancelled":true}',
                              "application/json")

        files = [line for line in done.stdout.splitlines() if line.strip()]
        usable = [f for f in files if Path(f).suffix.lower() in READABLE]
        payload = {"files": usable,
                   "ignored": [Path(f).name for f in files if f not in usable]}
        self._send(HTTPStatus.OK, json.dumps(payload).encode(),
                   "application/json; charset=utf-8")

    def _start_build(self) -> None:
        """Assembles a session from files the editor picked, in the background."""
        from .session import build_session

        length = int(self.headers.get("Content-Length") or 0)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as err:
            return self._error(HTTPStatus.BAD_REQUEST, f"bad request: {err}")

        picked = [Path(p) for p in request.get("files", [])]
        if not picked:
            return self._error(HTTPStatus.BAD_REQUEST, "no files were chosen")
        unusable = [str(p) for p in picked
                    if p.suffix.lower() not in READABLE or not p.is_file()]
        if unusable:
            return self._error(HTTPStatus.BAD_REQUEST, f"cannot read: {unusable}")

        telemetry = [p for p in picked if p.suffix.lower() in (".csv", ".vbo")]
        videos = [p for p in picked if p.suffix.lower() in (".mp4", ".mov")]

        job = Job(uuid.uuid4().hex[:12])
        JOBS[job.id] = job

        def work() -> None:
            try:
                job.progress = 0.1
                session = build_session(telemetry, videos, track=request.get("track", ""))
                job.progress = 0.9
                session.write(self.session_path)
                job.output = self.session_path
                # The whitelist is derived from the session, so it has to follow it.
                type(self).media = Media.from_session(json.loads(
                    self.session_path.read_text(encoding="utf-8")))
                job.state = "done"
                job.progress = 1.0
            except Exception as err:                 # noqa: BLE001 - reported to the browser
                job.state = "failed"
                job.message = str(err)[:500]

        threading.Thread(target=work, daemon=True).start()
        self._send(HTTPStatus.OK, json.dumps(job.as_dict()).encode(),
                   "application/json; charset=utf-8")

    def _serve_output(self, path: str) -> None:
        """Hands back a rendered file as a download.

        Only the output directory is reachable, and only by bare filename: the editor
        never needs to name anything else, and a path that cannot contain a separator
        cannot escape.
        """
        name = path.rsplit("/", 1)[-1]
        if not name or "/" in name or name.startswith("."):
            return self._error(HTTPStatus.BAD_REQUEST, "bad output name")
        target = self.session_path.parent / name
        if not target.is_file():
            return self._error(HTTPStatus.NOT_FOUND, f"no rendered file {name}")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(target.stat().st_size))
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.end_headers()
        with target.open("rb") as handle:
            while block := handle.read(CHUNK):
                self.wfile.write(block)

    def _reveal_output(self) -> None:
        """Shows the file in Finder, which beats downloading a copy of it.

        A finished render runs to hundreds of megabytes; pulling it through the browser
        would write a second copy onto the same disk for no reason.
        """
        length = int(self.headers.get("Content-Length") or 0)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as err:
            return self._error(HTTPStatus.BAD_REQUEST, f"bad request: {err}")
        name = (request.get("name") or "").strip()
        if not name or "/" in name:
            return self._error(HTTPStatus.BAD_REQUEST, "bad output name")
        target = self.session_path.parent / name
        if not target.exists():
            return self._error(HTTPStatus.NOT_FOUND, f"no rendered file {name}")
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(target)])
        elif sys.platform.startswith("linux"):
            subprocess.Popen(["xdg-open", str(target.parent)])
        else:
            return self._error(HTTPStatus.NOT_IMPLEMENTED,
                               "revealing a file is only wired up for macOS and Linux")
        self._send(HTTPStatus.OK, b'{"revealed":true}', "application/json")

    def _receive_overlay(self) -> None:
        """Takes the telemetry layer the browser just encoded."""
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._error(HTTPStatus.BAD_REQUEST, "the overlay is empty")
        # The container depends on which codec the browser could encode: H.264 goes in
        # MP4, VP9 and VP8 in WebM. ffmpeg reads either, so the extension just follows.
        suffix = ".mp4" if "mp4" in (self.headers.get("Content-Type") or "") else ".webm"
        for stale in self.session_path.parent.glob("overlay.*"):
            stale.unlink(missing_ok=True)
        target = self.session_path.parent / f"overlay{suffix}"
        remaining = length
        with target.open("wb") as handle:
            while remaining > 0:
                block = self.rfile.read(min(CHUNK, remaining))
                if not block:
                    break
                handle.write(block)
                remaining -= len(block)
        self._send(HTTPStatus.OK,
                   json.dumps({"saved": str(target), "bytes": length}).encode(),
                   "application/json; charset=utf-8")

    def _start_render(self) -> None:
        """Launches ffmpeg in the background and hands back a job to poll."""
        from . import render as render_module

        length = int(self.headers.get("Content-Length") or 0)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as err:
            return self._error(HTTPStatus.BAD_REQUEST, f"bad request: {err}")

        session = json.loads(self.session_path.read_text(encoding="utf-8"))
        if not self.layout_path.exists():
            return self._error(HTTPStatus.BAD_REQUEST, "no layout has been saved yet")
        layout = json.loads(self.layout_path.read_text(encoding="utf-8"))

        out_dir = self.session_path.parent
        # The container follows whichever codec the browser managed to encode, so the
        # extension is not known here - take whatever the upload left behind.
        overlay = next(iter(sorted(out_dir.glob("overlay.*"))), None)
        output = out_dir / (request.get("name") or "final.mp4")

        job = Job(uuid.uuid4().hex[:12])
        JOBS[job.id] = job

        def work() -> None:
            try:
                prepared = render_module.prepare_clips(session, out_dir / "work")
                plan = render_module.build_plan(
                    prepared, layout, overlay, output,
                    duration_s=request.get("duration"))

                def tick(done: float) -> None:
                    job.progress = done
                    if job.cancel.is_set():
                        raise render_module.RenderError("cancelled")

                render_module.run(plan, on_progress=tick)
                job.output = output
                job.state = "done"
                job.progress = 1.0
            except Exception as err:                 # noqa: BLE001 — reported to the browser
                job.state = "cancelled" if job.cancel.is_set() else "failed"
                job.message = str(err)[:500]

        threading.Thread(target=work, daemon=True).start()
        self._send(HTTPStatus.OK, json.dumps(job.as_dict()).encode(),
                   "application/json; charset=utf-8")


def make_server(session_path: Path, *, layout_path: Path | None = None,
                port: int = 8712) -> ThreadingHTTPServer:
    payload = json.loads(session_path.read_text(encoding="utf-8"))
    handler = type("BoundHandler", (Handler,), {
        "session_path": session_path,
        "layout_path": layout_path or session_path.with_name("layout.json"),
        "media": Media.from_session(payload),
    })
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def serve(session_path: Path, *, port: int = 8712, open_browser: bool = True) -> None:
    httpd = make_server(session_path, port=port)
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    print(f"editor: {url}   (Ctrl+C to stop)")
    if open_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()
