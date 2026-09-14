"""Reading GoPro telemetry from the GPMF stream embedded in the MP4.

GoPro writes telemetry as a separate data stream tagged ``gpmd``. Inside it is the GPMF
format: a tree of KLV records (key, length, value) where the key is a four-character
code and containers are marked by a zero type.

Three records inside every ``STRM`` stream matter here:

``GPSU``
    A UTC stamp from the satellites, ASCII shaped ``yymmddhhmmss.sss``. It arrives once
    a second and does not depend on the camera clock — which is why it survives a reset
    RTC, something GoPro cameras do often enough.
``GPS5``
    A batch of fixes: latitude, longitude, altitude, 2D speed, 3D speed. Integers,
    divided by the multipliers from ``SCAL``.
``GPSF``
    Fix type: 0 means no satellites, 2 is 2D, 3 is 3D. Blocks without a fix carry
    garbage coordinates and have to be dropped.
"""

from __future__ import annotations

import datetime as _dt
import struct
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

# GPMF type codes mapped to struct format codes.
_TYPES = {
    'b': 'b', 'B': 'B', 's': 'h', 'S': 'H',
    'l': 'i', 'L': 'I', 'f': 'f', 'd': 'd',
}

_HEADER = 8           # four key bytes, type, structure size, two repeat bytes
_FALLBACK_STEP = 1.0  # duration of the final block when there is no next one


class GpmfError(Exception):
    """The gpmd stream is missing or does not parse."""


@dataclass(frozen=True)
class GpsSample:
    t_utc: float      # seconds since the epoch
    lat: float
    lon: float
    alt_m: float
    speed_kmh: float
    fix: int


@dataclass(frozen=True)
class Window:
    """The recording window in satellite time."""
    start_utc: float
    end_utc: float
    blocks: int
    fixed_blocks: int

    @property
    def duration_s(self) -> float:
        return self.end_utc - self.start_utc


def find_gpmd_stream(mp4: Path) -> int:
    """Index of the ``gpmd`` stream inside the container."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "d",
         "-show_entries", "stream=index,codec_tag_string",
         "-of", "csv=p=0", str(mp4)],
        capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        parts = line.split(",")
        if len(parts) >= 2 and parts[1] == "gpmd":
            return int(parts[0])
    raise GpmfError(f"{mp4.name}: no gpmd stream — was GPS switched off on the camera?")


def extract_gpmd(mp4: Path) -> bytes:
    """The raw GPMF stream.

    ffmpeg pulls it out by index without reading the whole file, so this costs a
    fraction of a second even on a four-gigabyte clip.
    """
    idx = find_gpmd_stream(mp4)
    with tempfile.TemporaryDirectory() as tmp:
        dst = Path(tmp) / "gpmd.bin"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(mp4), "-codec", "copy",
             "-map", f"0:{idx}", "-f", "rawvideo", str(dst)], check=True)
        return dst.read_bytes()


def parse_streams(buf: bytes) -> list[dict]:
    """Walks the KLV tree and returns one dict per ``STRM`` container.

    Values are stored as-is; turning them into numbers is a separate step, because for
    most keys it is never needed.
    """
    streams: list[dict] = []

    def walk(off: int, end: int, scope: dict | None) -> None:
        while off + _HEADER <= end:
            key = buf[off:off + 4].decode('latin1')
            typ, size = buf[off + 4], buf[off + 5]
            count = struct.unpack_from('>H', buf, off + 6)[0]
            payload_len = size * count
            body = off + _HEADER
            if body + payload_len > end:
                return                       # truncated buffer: nothing left to walk
            if typ == 0:                     # nested container
                inner = {} if key == 'STRM' else scope
                walk(body, body + payload_len, inner)
                if key == 'STRM' and inner:
                    streams.append(inner)
            elif scope is not None:
                scope.setdefault(key, (chr(typ), size, count, buf[body:body + payload_len]))
            off = body + payload_len + (-payload_len % 4)   # pad to a 4-byte boundary

    walk(0, len(buf), None)
    return streams


def _numbers(entry: tuple[str, int, int, bytes]) -> list[tuple]:
    """A KLV value as a list of number tuples."""
    typ, size, count, payload = entry
    fmt = _TYPES.get(typ)
    if fmt is None:
        raise GpmfError(f"non-numeric GPMF type: {typ!r}")
    per = size // struct.calcsize(fmt)
    return [struct.unpack_from('>' + fmt * per, payload, i * size) for i in range(count)]


def _gpsu_to_epoch(payload: bytes) -> float:
    text = payload.decode('latin1').strip('\x00').strip()
    if len(text) < 12:
        raise GpmfError(f"GPSU stamp too short: {text!r}")
    stamp = _dt.datetime.strptime(text[:12], "%y%m%d%H%M%S")
    fraction = float(text[12:] or 0)
    return stamp.replace(tzinfo=_dt.timezone.utc).timestamp() + fraction


def _gps_blocks(buf: bytes) -> list[dict]:
    return [s for s in parse_streams(buf) if 'GPS5' in s and 'GPSU' in s]


def parse_window(buf: bytes) -> Window:
    """The recording window and fix quality, without decoding coordinates."""
    blocks = _gps_blocks(buf)
    if not blocks:
        raise GpmfError("the GPMF stream contains no GPS blocks")
    fixed = sum(1 for b in blocks if _numbers(b['GPSF'])[0][0] >= 2)
    return Window(
        start_utc=_gpsu_to_epoch(blocks[0]['GPSU'][3]),
        end_utc=_gpsu_to_epoch(blocks[-1]['GPSU'][3]),
        blocks=len(blocks),
        fixed_blocks=fixed,
    )


def parse_gps(buf: bytes) -> list[GpsSample]:
    """Coordinates and speed tied to satellite time.

    ``GPSU`` arrives once a second while ``GPS5`` delivers a batch of fixes over that
    same second, so times inside a batch are spread linearly up to the next block's
    stamp. Blocks without a fix are skipped whole: their coordinates are garbage.
    """
    blocks = _gps_blocks(buf)
    if not blocks:
        raise GpmfError("the GPMF stream contains no GPS blocks")

    stamps = [_gpsu_to_epoch(b['GPSU'][3]) for b in blocks]
    samples: list[GpsSample] = []

    for i, block in enumerate(blocks):
        fix = _numbers(block['GPSF'])[0][0] if 'GPSF' in block else 0
        if fix < 2:
            continue
        scale = [v[0] for v in _numbers(block['SCAL'])] if 'SCAL' in block else [1] * 5
        if len(scale) == 1:
            scale = scale * 5
        rows = _numbers(block['GPS5'])
        begin = stamps[i]
        end = stamps[i + 1] if i + 1 < len(stamps) else begin + _FALLBACK_STEP
        step = (end - begin) / len(rows)
        for j, row in enumerate(rows):
            samples.append(GpsSample(
                t_utc=begin + step * j,
                lat=row[0] / scale[0],
                lon=row[1] / scale[1],
                alt_m=row[2] / scale[2],
                speed_kmh=row[3] / scale[3] * 3.6,
                fix=fix,
            ))
    return samples


def read_gps(mp4: Path) -> list[GpsSample]:
    return parse_gps(extract_gpmd(mp4))


def read_window(mp4: Path) -> Window:
    return parse_window(extract_gpmd(mp4))
