"""Сборка чанков GoPro в один логический клип.

Длинную запись камера режет на файлы примерно по 4 ГБ и кодирует номера прямо в имя:
``GH``\\ **01**\\ ``3429.MP4`` — первый чанк записи 3429, ``GH023429.MP4`` — второй.
Рядом с каждым лежит ``GL013429.LRV``: та же запись в низком разрешении, штатный прокси
GoPro. Для превью в браузере используется именно он, иначе скраб по 4K невозможен.

Именам доверять нельзя: файл могли переименовать, потерять или подложить чужой. Поэтому
стык каждой пары чанков проверяется по спутниковому времени — разрыв должен укладываться
в один интервал меток ``GPSU`` (они идут раз в секунду).
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import gpmf

# GH/GX — HEVC-поколения, GP — продолжение записи у старых камер.
_CHUNKED = re.compile(r"^(GH|GX|GP)(\d{2})(\d{4})$", re.IGNORECASE)
# GOPRxxxx — первый файл записи у старых камер, номера чанка в имени нет.
_FIRST = re.compile(r"^GOPR(\d{4})$", re.IGNORECASE)

MAX_JOINT_GAP_S = 2.0   # метки GPSU идут раз в секунду, на стыке допустим один интервал


class ClipError(Exception):
    """Чанки не складываются в непрерывную запись."""


@dataclass(frozen=True)
class Chunk:
    path: Path
    index: int
    duration_s: float
    start_utc: float | None
    end_utc: float | None
    proxy: Path | None


@dataclass(frozen=True)
class Clip:
    """Непрерывная запись одной камеры, собранная из чанков."""
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

    def proxies(self) -> list[Path] | None:
        """Прокси-файлы, если они есть у всех чанков без исключения."""
        found = [c.proxy for c in self.chunks]
        return found if all(p is not None for p in found) else None


def parse_name(path: Path) -> tuple[int, str] | None:
    """``GH023429.MP4`` → ``(2, "3429")``. Возвращает None для чужих имён."""
    stem = path.stem
    if m := _CHUNKED.match(stem):
        return int(m.group(2)), m.group(3)
    if m := _FIRST.match(stem):
        return 1, m.group(1)
    return None


def find_proxy(path: Path) -> Path | None:
    """Прокси GoPro рядом с исходником: ``GH013429.MP4`` → ``GL013429.LRV``."""
    if not _CHUNKED.match(path.stem):
        return None
    for name in (f"GL{path.stem[2:]}.LRV", f"GL{path.stem[2:]}.lrv"):
        candidate = path.with_name(name)
        if candidate.exists():
            return candidate
    return None


def probe_duration(path: Path) -> float:
    """Длительность контейнера. Работает и без GPS, в отличие от окна GPMF."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def _load_chunk(path: Path, index: int) -> Chunk:
    start = end = None
    try:
        window = gpmf.parse_window(gpmf.extract_gpmd(path))
        if window.fixed_blocks:              # без фикса метки есть, но доверия им меньше
            start, end = window.start_utc, window.end_utc
    except (gpmf.GpmfError, subprocess.CalledProcessError):
        pass                                 # видео без телеметрии — тоже допустимый вход
    return Chunk(path, index, probe_duration(path), start, end, find_proxy(path))


def _check_joints(chunks: list[Chunk]) -> None:
    for prev, nxt in zip(chunks, chunks[1:]):
        if prev.index + 1 != nxt.index:
            raise ClipError(
                f"пропущен чанк между {prev.path.name} и {nxt.path.name}: "
                f"номера {prev.index} и {nxt.index}")
        if prev.end_utc is None or nxt.start_utc is None:
            continue                          # без спутникового времени сверять нечего
        gap = nxt.start_utc - prev.end_utc
        if not 0 <= gap <= MAX_JOINT_GAP_S:
            raise ClipError(
                f"разрыв {gap:.2f} с на стыке {prev.path.name} → {nxt.path.name}, "
                f"допустимо до {MAX_JOINT_GAP_S} с — это разные записи?")


def discover(paths: list[Path]) -> list[Clip]:
    """Группирует файлы по номеру записи и собирает непрерывные клипы."""
    groups: dict[str, list[tuple[int, Path]]] = {}
    for path in paths:
        parsed = parse_name(path)
        if parsed is None:
            raise ClipError(f"{path.name}: имя не похоже на файл GoPro")
        index, recording = parsed
        groups.setdefault(recording, []).append((index, path))

    clips = []
    for recording, entries in sorted(groups.items()):
        indexes = [i for i, _ in entries]
        if len(set(indexes)) != len(indexes):
            raise ClipError(f"запись {recording}: чанк указан дважды")
        chunks = [_load_chunk(p, i) for i, p in sorted(entries)]
        _check_joints(chunks)
        clips.append(Clip(recording, chunks))
    return clips


def write_concat_file(clip: Clip, dst: Path, *, proxy: bool = False) -> Path:
    """Список для демультиплексора ``concat`` ffmpeg."""
    sources = clip.proxies() if proxy else None
    if proxy and sources is None:
        raise ClipError(f"запись {clip.id}: прокси-файлы есть не у всех чанков")
    paths = sources or clip.files
    dst.write_text("".join(f"file '{p.resolve()}'\n" for p in paths))
    return dst
