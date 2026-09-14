"""Assembling GoPro chunks into one logical clip.

The camera splits a long recording into roughly 4 GB files and encodes the numbering
straight into the name: ``GH013429.MP4`` is chunk 01 of recording 3429, and
``GH023429.MP4`` is chunk 02. Next to each sits ``GL013429.LRV``: the same footage at
low resolution, GoPro's stock proxy. The browser preview plays that one, because
scrubbing through 4K is otherwise hopeless.

Names cannot be trusted: a file may have been renamed, lost, or replaced by someone
else's. So every joint between chunks is checked against satellite time — the gap must
fit inside one ``GPSU`` interval, and those arrive once a second.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import gpmf

# GH/GX are the HEVC generations; GP continues a recording on older cameras.
_CHUNKED = re.compile(r"^(GH|GX|GP)(\d{2})(\d{4})$", re.IGNORECASE)
# GOPRxxxx is the first file of a recording on older cameras, with no chunk number.
_FIRST = re.compile(r"^GOPR(\d{4})$", re.IGNORECASE)

MAX_JOINT_GAP_S = 2.0   # GPSU stamps arrive once a second, so one interval is allowed


class ClipError(Exception):
    """The chunks do not add up to a continuous recording."""


@dataclass(frozen=True)
class Chunk:
    path: Path
    index: int
    duration_s: float
    start_utc: float | None
    end_utc: float | None
    proxy: Path | None
    size: tuple[int, int] = (0, 0)


@dataclass(frozen=True)
class Clip:
    """A continuous recording from one camera, assembled from chunks."""
    id: str
    chunks: list[Chunk]

    @property
    def files(self) -> list[Path]:
        return [c.path for c in self.chunks]

    @property
    def duration_s(self) -> float:
        return sum(c.duration_s for c in self.chunks)

    @property
    def start_utc(self) -> float | None:
        return self.chunks[0].start_utc

    @property
    def has_gps(self) -> bool:
        return self.start_utc is not None

    @property
    def size(self) -> tuple[int, int]:
        return self.chunks[0].size if self.chunks else (0, 0)

    def proxies(self) -> list[Path] | None:
        """Proxy files, but only if every single chunk has one."""
        found = [c.proxy for c in self.chunks]
        return found if all(p is not None for p in found) else None


def parse_name(path: Path) -> tuple[int, str] | None:
    """``GH023429.MP4`` becomes ``(2, "3429")``. Returns None for foreign names."""
    stem = path.stem
    if m := _CHUNKED.match(stem):
        return int(m.group(2)), m.group(3)
    if m := _FIRST.match(stem):
        return 1, m.group(1)
    return None


def find_proxy(path: Path) -> Path | None:
    """The GoPro proxy next to the source: ``GH013429.MP4`` to ``GL013429.LRV``."""
    if not _CHUNKED.match(path.stem):
        return None
    for name in (f"GL{path.stem[2:]}.LRV", f"GL{path.stem[2:]}.lrv"):
        candidate = path.with_name(name)
        if candidate.exists():
            return candidate
    return None


def probe_duration(path: Path) -> float:
    """Container duration. Works without GPS too, unlike the GPMF window."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def probe_size(path: Path) -> tuple[int, int]:
    """Frame size, so the render can skip scaling a clip that already fits."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    width, _, height = out.partition("x")
    return int(width), int(height)


def _load_chunk(path: Path, index: int) -> Chunk:
    start = end = None
    try:
        window = gpmf.parse_window(gpmf.extract_gpmd(path))
        if window.fixed_blocks:          # stamps exist without a fix, but trust them less
            start, end = window.start_utc, window.end_utc
    except (gpmf.GpmfError, subprocess.CalledProcessError):
        pass                             # video without telemetry is a valid input too
    return Chunk(path, index, probe_duration(path), start, end, find_proxy(path),
                 probe_size(path))


def _check_joints(chunks: list[Chunk]) -> None:
    for prev, nxt in zip(chunks, chunks[1:]):
        if prev.index + 1 != nxt.index:
            raise ClipError(
                f"missing chunk between {prev.path.name} and {nxt.path.name}: "
                f"indexes {prev.index} and {nxt.index}")
        if prev.end_utc is None or nxt.start_utc is None:
            continue                      # no satellite time means nothing to check
        gap = nxt.start_utc - prev.end_utc
        if not 0 <= gap <= MAX_JOINT_GAP_S:
            raise ClipError(
                f"gap of {gap:.2f} s at the joint {prev.path.name} -> {nxt.path.name}, "
                f"up to {MAX_JOINT_GAP_S} s allowed — are these different recordings?")


def discover(paths: list[Path]) -> list[Clip]:
    """Groups files by recording number and assembles continuous clips."""
    groups: dict[str, list[tuple[int, Path]]] = {}
    for path in paths:
        parsed = parse_name(path)
        if parsed is None:
            raise ClipError(f"{path.name}: the name does not look like a GoPro file")
        index, recording = parsed
        groups.setdefault(recording, []).append((index, path))

    clips = []
    for recording, entries in sorted(groups.items()):
        indexes = [i for i, _ in entries]
        if len(set(indexes)) != len(indexes):
            raise ClipError(f"recording {recording}: a chunk is listed twice")
        chunks = [_load_chunk(p, i) for i, p in sorted(entries)]
        _check_joints(chunks)
        clips.append(Clip(recording, chunks))
    return clips


def write_concat_file(clip: Clip, dst: Path, *, proxy: bool = False) -> Path:
    """The list file for ffmpeg's ``concat`` demuxer."""
    sources = clip.proxies() if proxy else None
    if proxy and sources is None:
        raise ClipError(f"recording {clip.id}: not every chunk has a proxy file")
    paths = sources or clip.files
    dst.write_text("".join(f"file '{p.resolve()}'\n" for p in paths))
    return dst
