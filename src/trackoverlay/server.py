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
import webbrowser
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parent.parent.parent / "web"
CHUNK = 1 << 20                       # 1 MiB per socket write
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


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
            return self._send_file(WEB_ROOT / "index.html")
        if path == "/api/session":
            return self._send_file(self.session_path)
        if path == "/api/layout":
            if not self.layout_path.exists():
                return self._error(HTTPStatus.NOT_FOUND, "no layout saved yet")
            return self._send_file(self.layout_path)
        if path.startswith("/media/"):
            return self._serve_media(path, query)

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
