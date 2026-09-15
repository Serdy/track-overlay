"""A local HTTP server: serves the project list, the editor, the session and the video.

A server cannot be avoided here, even though the viewer in the neighbouring
``DDA_Reader`` lives straight on ``file://``. The reason is range requests: the browser
seeks through video by asking for pieces of the file, and that machinery is unavailable
on ``file://``. Besides, something has to launch ffmpeg when the export button is hit.

Every project is addressed in the URL — ``/p/<name>/api/session`` — rather than the server
holding a "current project". Two tabs on two projects then cannot corrupt each other's
files, and a ``<video>`` tag, which keeps issuing range requests for minutes, cannot be
redirected mid-playback into another project's footage.

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
from urllib.parse import unquote

from . import projects
from .projects import Project, ProjectError

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

READABLE = projects.READABLE
_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


class Job:
    """One background job — a build or a render — watched by the browser through polling."""

    def __init__(self, identifier: str):
        self.id = identifier
        self.progress = 0.0
        self.stage = ""
        self.state = "running"          # running | done | failed | cancelled
        self.message = ""
        self.output: Path | None = None
        self.cancel = threading.Event()

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "progress": round(self.progress, 4),
            "stage": self.stage,
            "message": self.message,
            "output": str(self.output) if self.output else None,
        }


JOBS: dict[str, Job] = {}

# One build at a time per project: two of them would race to write the same session.
_BUILDS: dict[str, str] = {}
_BUILD_LOCK = threading.Lock()


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


class MediaCache:
    """Whitelists by session file, refreshed when the file changes.

    Rebuilding it per request is out of the question — a session is megabytes of JSON and
    a single scrub costs hundreds of range requests — and caching it for the server's
    lifetime was what forced the old design to reach back and mutate handler state after
    a build. Keying on the file's own mtime does both jobs and needs no invalidation call.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[Path, tuple[tuple[int, int], Media]] = {}

    def get(self, session_path: Path) -> Media:
        try:
            stat = session_path.stat()
        except OSError:
            return Media({}, {})
        key = (stat.st_mtime_ns, stat.st_size)
        with self._lock:
            cached = self._entries.get(session_path)
            if cached is not None and cached[0] == key:
                return cached[1]
        try:
            media = Media.from_session(
                json.loads(session_path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            return Media({}, {})
        with self._lock:
            self._entries[session_path] = (key, media)
        return media


MEDIA = MediaCache()


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
    data_root: Path
    bound: Project | None = None        # set when serving a single session file

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

    def _json(self, payload: dict | list, status: HTTPStatus = HTTPStatus.OK) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode(),
                   "application/json; charset=utf-8")

    def _error(self, status: HTTPStatus, message: str) -> None:
        self._json({"error": message}, status)

    def _redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _body(self) -> dict | None:
        """The JSON body of a POST, or None once the error has been sent."""
        length = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as err:
            self._error(HTTPStatus.BAD_REQUEST, f"bad request: {err}")
            return None

    def _send_file(self, path: Path) -> None:
        """Serves a file, honouring partial requests."""
        if not path.exists():
            return self._error(HTTPStatus.NOT_FOUND, f"no file {path.name}")
        size = path.stat().st_size
        media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"

        try:
            span = parse_range(self.headers.get("Range"), size)
        except RangeError:
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

    # --- routing ----------------------------------------------------------------

    def _split(self, path: str) -> tuple[Project | None, str] | None:
        """Peels ``/p/<name>`` off the front. Returns None once an error has been sent.

        The name arrives from outside on every single request, so it goes through exactly
        one resolver, and that resolver is the only place a name becomes a path.
        """
        if not path.startswith("/p/"):
            return self.bound, path         # legacy mode, or a server-level route
        parts = path.split("/", 3)          # ['', 'p', name, rest]
        name = unquote(parts[2])
        rest = "/" + (parts[3] if len(parts) > 3 else "")
        try:
            return projects.read(self.data_root, name), rest
        except ProjectError as err:
            self._error(HTTPStatus.NOT_FOUND, str(err))
            return None

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        raw, _, query = self.path.partition("?")

        if raw == "/api/projects":
            return self._json([p.as_dict() for p in projects.discover(self.data_root)])
        if raw.startswith("/api/render/"):
            job = JOBS.get(raw.rsplit("/", 1)[-1])
            if job is None:
                return self._error(HTTPStatus.NOT_FOUND, "no such render job")
            return self._json(job.as_dict())
        if raw == "/p" or (raw.startswith("/p/") and raw.count("/") == 2):
            return self._redirect(raw + "/")    # /p/demo -> /p/demo/, so js/ resolves

        split = self._split(raw)
        if split is None:
            return
        project, path = split

        if project is None:
            if path in ("/", "/index.html"):
                return self._send_page("projects.html")
            if path.startswith("/api/") or path.startswith("/media/"):
                return self._error(HTTPStatus.NOT_FOUND,
                                   f"{path} needs a project: /p/<name>{path}")
        else:
            if path in ("/", "/index.html"):
                return self._send_page("index.html")
            if path == "/api/project":
                return self._json(project.as_dict())
            if path == "/api/session":
                if not project.has_session():
                    return self._error(HTTPStatus.NOT_FOUND, "this project is not built yet")
                return self._send_file(project.session_path)
            if path == "/api/layout":
                if not project.layout_path.exists():
                    return self._error(HTTPStatus.NOT_FOUND, "no layout saved yet")
                return self._send_file(project.layout_path)
            if path.startswith("/media/"):
                return self._serve_media(project, path, query)
            if path.startswith("/api/output/"):
                return self._serve_output(project, path)

        # Editor statics. Canonicalise the path and make sure it stayed inside web/ —
        # otherwise ../ would lead out.
        target = (WEB_ROOT / path.lstrip("/")).resolve()
        if not target.is_relative_to(WEB_ROOT.resolve()) or not target.is_file():
            return self._error(HTTPStatus.NOT_FOUND, f"no resource {path}")
        return self._send_file(target)

    def do_POST(self):
        raw, _, _ = self.path.partition("?")

        if raw == "/api/choose":
            return self._choose_files()
        if raw == "/api/projects":
            return self._create_project()
        if raw.startswith("/api/render/") and raw.endswith("/cancel"):
            job = JOBS.get(raw.split("/")[3])
            if job is None:
                return self._error(HTTPStatus.NOT_FOUND, "no such render job")
            job.cancel.set()
            return self._json({"cancelled": True})

        split = self._split(raw)
        if split is None:
            return
        project, path = split
        if project is None:
            return self._error(HTTPStatus.NOT_FOUND,
                               f"{path} needs a project: /p/<name>{path}")

        if path == "/api/layout":
            return self._save_layout(project)
        if path == "/api/sources":
            return self._edit_sources(project)
        if path == "/api/build":
            return self._start_build(project)
        if path == "/api/sync":
            return self._confirm_sync(project)
        if path == "/api/overlay":
            return self._receive_overlay(project)
        if path == "/api/render":
            return self._start_render(project)
        if path == "/api/reveal":
            return self._reveal_output(project)
        return self._error(HTTPStatus.NOT_FOUND, f"no route {self.path}")

    # --- pages ------------------------------------------------------------------

    def _send_page(self, name: str) -> None:
        """Serves a page with a version stamped onto every local asset.

        `Cache-Control: no-store` only helps from the moment it is first seen. A browser
        that cached a script before then will keep serving it on an ordinary reload, and
        the symptom - half the editor quietly not working - gives no hint of the cause.
        A stamp derived from the file's own mtime sidesteps the cache entirely.

        The stamped URLs are rooted. The editor is served from /p/<name>/, where a
        relative `js/state.js` would resolve to /p/<name>/js/state.js and 404 — silently,
        since a missing script reports nothing to the page.
        """
        page = (WEB_ROOT / name).read_text(encoding="utf-8")

        def stamp(match: re.Match) -> str:
            attribute, url = match.group(1), match.group(2)
            if "//" in url or url.startswith("/"):
                return match.group(0)            # leave anything remote or rooted alone
            asset = (WEB_ROOT / url).resolve()
            if not asset.is_file():
                return match.group(0)
            return f'{attribute}="/{url}?v={int(asset.stat().st_mtime)}"'

        body = re.sub(r'(src|href)="([^"]+)"', stamp, page).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # --- projects ---------------------------------------------------------------

    def _create_project(self) -> None:
        request = self._body()
        if request is None:
            return
        try:
            project = projects.create(self.data_root, (request.get("title") or "").strip())
        except ProjectError as err:
            return self._error(HTTPStatus.BAD_REQUEST, str(err))
        self._json(project.as_dict(), HTTPStatus.CREATED)

    def _edit_sources(self, project: Project) -> None:
        """Registers files picked in the dialog, or drops one."""
        request = self._body()
        if request is None:
            return
        try:
            for path in request.get("remove") or []:
                project = projects.remove_source(project, Path(path))
            added = [Path(p) for p in request.get("files") or []]
            if added:
                project = projects.add_sources(project, added)
        except ProjectError as err:
            return self._error(HTTPStatus.BAD_REQUEST, str(err))
        self._json(project.as_dict())

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
            return self._json({"files": [], "cancelled": True})

        files = [line for line in done.stdout.splitlines() if line.strip()]
        usable = [f for f in files if Path(f).suffix.lower() in READABLE]
        self._json({"files": usable,
                    "ignored": [Path(f).name for f in files if f not in usable]})

    # --- building ---------------------------------------------------------------

    def _start_build(self, project: Project) -> None:
        """Assembles the session from the project's own files, in the background."""
        from .session import build_session

        request = self._body()
        if request is None:
            return
        try:
            added = [Path(p) for p in request.get("files") or []]
            if added:
                project = projects.add_sources(project, added)
        except ProjectError as err:
            return self._error(HTTPStatus.BAD_REQUEST, str(err))

        found = projects.sources(project)
        telemetry = [p for p in found if p.suffix.lower() in (".csv", ".vbo")]
        videos = [p for p in found if p.suffix.lower() in (".mp4", ".mov")]
        if not telemetry:
            return self._error(HTTPStatus.BAD_REQUEST,
                               "this project has no RaceBox export to build from")

        with _BUILD_LOCK:
            running = JOBS.get(_BUILDS.get(project.name, ""))
            if running is not None and running.state == "running":
                return self._json(running.as_dict())
            job = Job(uuid.uuid4().hex[:12])
            JOBS[job.id] = job
            _BUILDS[project.name] = job.id

        track = (request.get("track") or project.track or "").strip()
        # The thread outlives this handler instance, so it closes over values, never self.
        session_path = project.session_path
        manual = dict(project.manual_sync)
        root, name = self.data_root, project.name

        def work() -> None:
            try:
                def tick(done: float, stage: str) -> None:
                    job.progress, job.stage = done, stage

                session = build_session(telemetry, videos, track=track,
                                        manual_s=manual, on_progress=tick)
                session.write(session_path)
                projects.mark_built(projects.read(root, name), track)
                job.output = session_path
                job.state = "done"
                job.progress, job.stage = 1.0, "done"
            except Exception as err:                 # noqa: BLE001 - reported to the browser
                job.state = "failed"
                job.message = str(err)[:500]

        threading.Thread(target=work, daemon=True).start()
        self._json(job.as_dict())

    def _confirm_sync(self, project: Project) -> None:
        """Stores the correction a person confirmed by eye.

        It lands in two files on purpose: `project.json` keeps the human decision, which
        must survive a rebuild, and `session.json` keeps the total, because that is the
        number the renderer reads.
        """
        request = self._body()
        if request is None:
            return
        if not project.has_session():
            return self._error(HTTPStatus.BAD_REQUEST, "this project is not built yet")

        clip_id = request.get("clip")
        try:
            payload = json.loads(project.session_path.read_text(encoding="utf-8"))
            if clip_id is not None:
                manual = float(request.get("manual_s") or 0.0)
                _apply_offset(payload, clip_id, manual)
                projects.set_manual_sync(project, clip_id, manual)
            if request.get("confirmed"):
                payload.setdefault("session", {})["sync_confirmed"] = True
        except (ValueError, TypeError) as err:
            return self._error(HTTPStatus.BAD_REQUEST, str(err))
        project.session_path.write_text(json.dumps(payload, ensure_ascii=False),
                                        encoding="utf-8")
        self._json({"clips": payload.get("clips", [])})

    # --- media and output --------------------------------------------------------

    def _serve_media(self, project: Project, path: str, query: str) -> None:
        parts = path.strip("/").split("/")
        if len(parts) != 3:
            return self._error(HTTPStatus.BAD_REQUEST, "expected /media/<clip>/<index>")
        _, clip_id, index = parts
        if not index.isdigit():
            return self._error(HTTPStatus.BAD_REQUEST, "the chunk index must be a number")
        media = MEDIA.get(project.session_path)
        target = media.resolve(clip_id, int(index), prefer_proxy="proxy=1" in query)
        if target is None:
            return self._error(HTTPStatus.NOT_FOUND,
                               f"clip {clip_id}/{index} is not in the session")
        return self._send_file(target)

    def _save_layout(self, project: Project) -> None:
        request = self._body()
        if request is None:
            return
        project.layout_path.parent.mkdir(parents=True, exist_ok=True)
        project.layout_path.write_text(
            json.dumps(request, ensure_ascii=False, indent=2), encoding="utf-8")
        self._json({"saved": True})

    def _serve_output(self, project: Project, path: str) -> None:
        """Hands back a rendered file as a download.

        Only the project's output directory is reachable, and only by bare filename: the
        editor never needs to name anything else, and a path that cannot contain a
        separator cannot escape.
        """
        name = unquote(path.rsplit("/", 1)[-1])
        try:
            target = projects.resolve_output(project, name)
        except ProjectError as err:
            return self._error(HTTPStatus.BAD_REQUEST, str(err))
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

    def _reveal_output(self, project: Project) -> None:
        """Shows the file in Finder, which beats downloading a copy of it.

        A finished render runs to hundreds of megabytes; pulling it through the browser
        would write a second copy onto the same disk for no reason.
        """
        request = self._body()
        if request is None:
            return
        try:
            target = projects.resolve_output(project, (request.get("name") or "").strip())
        except ProjectError as err:
            return self._error(HTTPStatus.BAD_REQUEST, str(err))
        if not target.exists():
            return self._error(HTTPStatus.NOT_FOUND, f"no rendered file {target.name}")
        if sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(target)])
        elif sys.platform.startswith("linux"):
            subprocess.Popen(["xdg-open", str(target.parent)])
        else:
            return self._error(HTTPStatus.NOT_IMPLEMENTED,
                               "revealing a file is only wired up for macOS and Linux")
        self._json({"revealed": True})

    def _receive_overlay(self, project: Project) -> None:
        """Takes the telemetry layer the browser just encoded."""
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._error(HTTPStatus.BAD_REQUEST, "the overlay is empty")
        # The container depends on which codec the browser could encode: H.264 goes in
        # MP4, VP9 and VP8 in WebM. ffmpeg reads either, so the extension just follows.
        suffix = ".mp4" if "mp4" in (self.headers.get("Content-Type") or "") else ".webm"
        project.out_dir.mkdir(parents=True, exist_ok=True)
        for stale in project.out_dir.glob("overlay.*"):
            stale.unlink(missing_ok=True)
        target = project.out_dir / f"overlay{suffix}"
        remaining = length
        with target.open("wb") as handle:
            while remaining > 0:
                block = self.rfile.read(min(CHUNK, remaining))
                if not block:
                    break
                handle.write(block)
                remaining -= len(block)
        self._json({"saved": str(target), "bytes": length})

    def _start_render(self, project: Project) -> None:
        """Launches ffmpeg in the background and hands back a job to poll."""
        from . import render as render_module

        request = self._body()
        if request is None:
            return
        if not project.has_session():
            return self._error(HTTPStatus.BAD_REQUEST, "this project is not built yet")
        if not project.layout_path.exists():
            return self._error(HTTPStatus.BAD_REQUEST, "no layout has been saved yet")

        session = json.loads(project.session_path.read_text(encoding="utf-8"))
        layout = json.loads(project.layout_path.read_text(encoding="utf-8"))
        overlay = project.overlay()
        try:
            output = projects.resolve_output(project, request.get("name") or "final.mp4")
        except ProjectError as err:
            return self._error(HTTPStatus.BAD_REQUEST, str(err))
        work_dir = project.work_dir

        job = Job(uuid.uuid4().hex[:12])
        JOBS[job.id] = job

        def work() -> None:
            try:
                prepared = render_module.prepare_clips(session, work_dir)
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
        self._json(job.as_dict())


def _apply_offset(payload: dict, clip_id: str, manual_s: float) -> None:
    """Sets a clip's total offset, keeping the machine's answer beside it.

    Storing the automatic value makes the operation idempotent and reversible: the slider
    can be dragged a dozen times and the correction is still measured from one baseline.
    """
    for clip in payload.get("clips") or []:
        if clip.get("id") != clip_id:
            continue
        auto = clip.get("auto_offset_s", clip.get("offset_s", 0.0))
        clip["auto_offset_s"] = auto
        clip["offset_s"] = round(auto + manual_s, 3)
        clip.setdefault("sync", {})["manual_s"] = round(manual_s, 3)
        return
    raise ValueError(f"no clip {clip_id} in this session")


def make_server(data_root: Path, *, project: str | None = None,
                session_path: Path | None = None,
                port: int = 8712) -> ThreadingHTTPServer:
    """A server over a data directory.

    `project` or `session_path` binds it to one project, so the un-prefixed routes still
    work — that is what keeps `trackoverlay serve out/session.json` and old bookmarks
    alive. The binding is fixed at construction: nothing switches it later, which is the
    whole reason two tabs cannot tread on each other.
    """
    bound: Project | None = None
    if session_path is not None:
        bound = projects.from_session_path(session_path)
    elif project is not None:
        bound = projects.read(data_root, project)

    handler = type("BoundHandler", (Handler,), {
        "data_root": data_root,
        "bound": bound,
    })
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def serve(data_root: Path, *, project: str | None = None,
          session_path: Path | None = None, port: int = 8712,
          open_browser: bool = True) -> None:
    data_root.mkdir(parents=True, exist_ok=True)
    httpd = make_server(data_root, project=project, session_path=session_path, port=port)
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
