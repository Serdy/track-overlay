"""Projects: a folder per track day, discovered under a data directory.

A project is nothing more than a folder. What makes it a project is `project.json`, which
records the things a folder cannot: the human title, the circuit, source files that live
elsewhere on disk, and the sync correction a person confirmed by eye.

Sources are the readable files sitting *in* the folder plus the paths registered in the
manifest. Nothing is ever copied: a session is twenty gigabytes of GoPro footage, and the
server reads the same filesystem the camera card is mounted on.

Everything produced goes to `out/`, which the source scan skips - otherwise the rendered
`final.mp4` would come back round as an input.
"""

from __future__ import annotations

import json
import re
import time
import unicodedata
from dataclasses import dataclass, field, replace
from pathlib import Path

VERSION = 1

# A project name is also a folder name and arrives inside URLs, so it is kept to the
# characters that mean the same thing everywhere.
NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# What the tool can read. Anything else in the folder is somebody else's file.
READABLE = {".mp4", ".mov", ".csv", ".vbo"}

OUT_DIR = "out"
MANIFEST = "project.json"


class ProjectError(Exception):
    """A project that cannot be named, found, or safely addressed."""


@dataclass(frozen=True)
class Project:
    name: str
    root: Path
    title: str = ""
    track: str = ""
    created_utc: float = 0.0
    built_utc: float | None = None
    registered: list[Path] = field(default_factory=list)
    manual_sync: dict[str, float] = field(default_factory=dict)

    @property
    def manifest_path(self) -> Path:
        return self.root / MANIFEST

    @property
    def session_path(self) -> Path:
        return self.root / "session.json"

    @property
    def layout_path(self) -> Path:
        return self.root / "layout.json"

    @property
    def out_dir(self) -> Path:
        return self.root / OUT_DIR

    @property
    def work_dir(self) -> Path:
        return self.out_dir / "work"

    def has_session(self) -> bool:
        return self.session_path.is_file()

    def overlay(self) -> Path | None:
        """The telemetry layer the editor last uploaded, in whichever container."""
        return next(iter(sorted(self.out_dir.glob("overlay.*"))), None)

    def as_dict(self) -> dict:
        """What the project list in the browser needs to draw a card."""
        found = sources(self)
        summary = {
            "name": self.name,
            "title": self.title or self.name,
            "track": self.track,
            "created_utc": self.created_utc,
            "built_utc": self.built_utc,
            "files": [str(p) for p in found],
            "videos": sum(1 for p in found if p.suffix.lower() in (".mp4", ".mov")),
            "telemetry": sum(1 for p in found if p.suffix.lower() in (".csv", ".vbo")),
            "built": self.has_session(),
        }
        if summary["built"]:
            summary.update(_session_summary(self.session_path))
            summary["missing"] = _missing_footage(self)
        return summary


def _missing_footage(project: "Project") -> list[str]:
    """Files the session names that are no longer on disk.

    Worth saying out loud: the editor shows a black slot and the render dies at the far
    end of a long ffmpeg command line, neither of which points at the camera involved.
    """
    try:
        payload = json.loads(project.session_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    gone = []
    for clip in payload.get("clips") or []:
        for name in clip.get("files") or []:
            if not resolve_source(name, project.root).exists():
                gone.append(f"{clip.get('id')}: {Path(name).name}")
    return gone


def _session_summary(path: Path) -> dict:
    """The few numbers worth showing on a card, or nothing if the file is unreadable."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"built": False, "broken": True}
    laps = payload.get("laps") or []
    return {
        "track": payload.get("session", {}).get("track", ""),
        "duration_s": payload.get("session", {}).get("duration_s", 0.0),
        "laps": len(laps),
        "best_s": min((lap["duration_s"] for lap in laps), default=0.0),
        "clips": len(payload.get("clips") or []),
    }


# --- naming ------------------------------------------------------------------------

def slugify(title: str) -> str:
    """A folder name from a human title. Accents are folded, everything else falls away."""
    plain = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")[:64].rstrip("-")
    return slug


def valid_name(name: str) -> bool:
    return bool(NAME.match(name))


# --- reading and writing -----------------------------------------------------------

def _manifest(project: Project) -> dict:
    return {
        "version": VERSION,
        "title": project.title,
        "track": project.track,
        "created_utc": round(project.created_utc, 3),
        "built_utc": round(project.built_utc, 3) if project.built_utc else None,
        "sources": [str(p) for p in project.registered],
        "sync": {clip: {"manual_s": value} for clip, value in project.manual_sync.items()},
    }


def write(project: Project) -> Project:
    project.root.mkdir(parents=True, exist_ok=True)
    project.manifest_path.write_text(
        json.dumps(_manifest(project), ensure_ascii=False, indent=2), encoding="utf-8")
    return project


def _load(root: Path, name: str) -> Project:
    """Reads the manifest if there is one; a folder without one is still a project."""
    manifest = root / MANIFEST
    if not manifest.is_file():
        # A folder somebody made by hand deserves a readable name, not its own slug.
        spoken = name.replace("-", " ").replace("_", " ").capitalize()
        return migrate(Project(name=name, root=root, title=spoken))
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise ProjectError(f"{manifest} does not parse: {err}") from err

    sync = payload.get("sync") or {}
    return Project(
        name=name,
        root=root,
        title=payload.get("title") or name,
        track=payload.get("track", ""),
        created_utc=float(payload.get("created_utc") or 0.0),
        built_utc=payload.get("built_utc"),
        registered=[Path(p) for p in payload.get("sources") or []],
        manual_sync={clip: float(entry.get("manual_s", 0.0))
                     for clip, entry in sync.items()},
    )


def read(data_root: Path, name: str) -> Project:
    """The one place a project name from outside becomes a path."""
    if not valid_name(name):
        raise ProjectError(f"{name!r} is not a project name")
    root = data_root / name
    if not root.is_dir():
        raise ProjectError(f"no project named {name}")
    return _load(root, name)


def discover(data_root: Path) -> list[Project]:
    """Every project under the data directory, newest first."""
    if not data_root.is_dir():
        return []
    found = []
    for entry in sorted(data_root.iterdir()):
        if not entry.is_dir() or not valid_name(entry.name):
            continue
        try:
            found.append(_load(entry, entry.name))
        except ProjectError:
            continue                    # a broken manifest hides one project, not all
    return sorted(found, key=lambda p: (p.built_utc or p.created_utc or 0.0), reverse=True)


def create(data_root: Path, title: str) -> Project:
    """A new, empty project folder. The title is what the person typed."""
    base = slugify(title)
    if not base:
        raise ProjectError("a project needs a name with letters or digits in it")
    name, n = base, 2
    while (data_root / name).exists():
        name, n = f"{base}-{n}", n + 1
    if not valid_name(name):
        raise ProjectError(f"{title!r} does not make a usable folder name")

    project = Project(name=name, root=data_root / name, title=title.strip(),
                      created_utc=time.time())
    project.out_dir.mkdir(parents=True, exist_ok=True)
    return write(project)


def from_session_path(session_path: Path) -> Project:
    """Wraps a bare session file as a project, for `trackoverlay serve out/session.json`."""
    root = session_path.parent
    name = root.name if valid_name(root.name) else "session"
    return migrate(Project(name=name, root=root, title=name))


# --- sources ------------------------------------------------------------------------

def sources(project: Project) -> list[Path]:
    """Readable files in the folder plus the registered ones, deduplicated."""
    found: dict[Path, Path] = {}
    if project.root.is_dir():
        for entry in sorted(project.root.iterdir()):
            if (entry.is_file() and not entry.name.startswith(".")
                    and entry.suffix.lower() in READABLE):
                found[entry.resolve()] = entry
    for path in project.registered:
        if path.is_file():
            found.setdefault(path.resolve(), path)
    return list(found.values())


def add_sources(project: Project, paths: list[Path]) -> Project:
    """Registers files that live outside the folder. Files inside it need no registering."""
    unusable = [str(p) for p in paths
                if p.suffix.lower() not in READABLE or not p.is_file()]
    if unusable:
        raise ProjectError(f"cannot read: {', '.join(unusable)}")

    known = {p.resolve() for p in sources(project)}
    added = list(project.registered)
    for path in paths:
        resolved = path.resolve()
        if resolved not in known:
            known.add(resolved)
            added.append(resolved)
    return write(replace(project, registered=added))


def remove_source(project: Project, path: Path) -> Project:
    """Drops a registered path. A file sitting in the folder is the person's to delete."""
    target = path.resolve()
    kept = [p for p in project.registered if p.resolve() != target]
    if len(kept) == len(project.registered) and target.parent == project.root.resolve():
        raise ProjectError(f"{path.name} is in the project folder — remove it there")
    return write(replace(project, registered=kept))


def resolve_source(path: Path | str, root: Path) -> Path:
    """A source file, looked for beside the project when its recorded path is gone.

    Sessions store the paths the files had when they were built, and those do not survive
    the folder being moved, copied to another machine, or mounted into a container at a
    different place. Anything sitting in the project folder is found again by name, which
    is what makes a project folder portable; files kept elsewhere on disk are not.
    """
    given = Path(path)
    if given.exists():
        return given
    beside = root / given.name
    return beside if beside.exists() else given


def resolve_output(project: Project, name: str) -> Path:
    """A produced file by bare name, proven to be inside `out/`."""
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise ProjectError(f"{name!r} is not an output file name")
    path = (project.out_dir / name).resolve()
    if not path.is_relative_to(project.out_dir.resolve()):
        raise ProjectError(f"{name!r} is not an output file name")
    return path


# --- the confirmed sync correction ---------------------------------------------------

def set_manual_sync(project: Project, clip_id: str, manual_s: float) -> Project:
    """Records what a person confirmed by eye.

    It lives here rather than in the session because every rebuild rewrites the session,
    and a human decision must outlive the machine's.
    """
    corrections = dict(project.manual_sync)
    if manual_s:
        corrections[clip_id] = round(float(manual_s), 3)
    else:
        corrections.pop(clip_id, None)
    return write(replace(project, manual_sync=corrections))


def mark_built(project: Project, track: str = "") -> Project:
    return write(replace(project, built_utc=time.time(), track=track or project.track))


# --- migration -----------------------------------------------------------------------

def migrate(project: Project) -> Project:
    """Brings a folder that predates projects up to the current shape.

    Two things happened before this module existed. Sessions were built into a bare folder
    with no manifest, and the manual sync adjustment was stored as `layout.nudge_s`, where
    the renderer never looked at it - so an export silently ignored it. Folding it into the
    manifest is also what finally makes that adjustment reach ffmpeg.
    """
    if project.manifest_path.is_file() or not project.root.is_dir():
        return project

    session = project.session_path
    if not session.is_file():
        return project

    registered: list[Path] = []
    track = ""
    try:
        payload = json.loads(session.read_text(encoding="utf-8"))
        track = payload.get("session", {}).get("track", "")
        for clip in payload.get("clips") or []:
            # Only what lives elsewhere needs registering; files in the folder are found
            # by the scan, and listing them twice would just be noise in the manifest.
            registered += [Path(f) for f in clip.get("files") or []
                           if Path(f).resolve().parent != project.root.resolve()]
    except (OSError, json.JSONDecodeError):
        payload = None

    manual: dict[str, float] = {}
    layout = project.layout_path
    if layout.is_file() and payload is not None:
        try:
            saved = json.loads(layout.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            saved = {}
        nudge = float(saved.get("nudge_s") or 0.0)
        if nudge:
            manual = {clip["id"]: nudge for clip in payload.get("clips") or []}
            _fold_nudge_into_session(session, payload, nudge)
            saved["nudge_s"] = 0
            layout.write_text(json.dumps(saved, ensure_ascii=False, indent=2),
                              encoding="utf-8")

    project.out_dir.mkdir(parents=True, exist_ok=True)
    _adopt_outputs(project)
    return write(replace(project, track=track, registered=registered, manual_sync=manual,
                         created_utc=session.stat().st_mtime,
                         built_utc=session.stat().st_mtime))


def _fold_nudge_into_session(path: Path, payload: dict, nudge: float) -> None:
    for clip in payload.get("clips") or []:
        auto = clip.get("auto_offset_s", clip["offset_s"])
        clip["auto_offset_s"] = auto
        clip["offset_s"] = round(auto + nudge, 3)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _adopt_outputs(project: Project) -> None:
    """Moves renders made before `out/` existed into it, so nothing goes missing."""
    for name in ("final.mp4", "work"):
        stale = project.root / name
        if stale.exists() and not (project.out_dir / name).exists():
            stale.rename(project.out_dir / name)
    for stale in project.root.glob("overlay.*"):
        target = project.out_dir / stale.name
        if not target.exists():
            stale.rename(target)
    for stale in project.root.glob("preview_*.mp4"):
        target = project.out_dir / stale.name
        if not target.exists():
            stale.rename(target)
