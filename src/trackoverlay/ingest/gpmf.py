"""Чтение телеметрии GoPro из потока GPMF, вшитого в MP4.

GoPro пишет телеметрию отдельным потоком данных с тегом ``gpmd``. Внутри — формат
GPMF: дерево записей KLV (ключ, тип, длина, значение), где ключ это четырёхбуквенный
код, а контейнеры отличаются нулевым типом.

Нас интересуют три записи внутри каждого потока ``STRM``:

``GPSU``
    Метка UTC со спутников, ASCII вида ``ггммддччммсс.ссс``. Приходит раз в секунду и
    не зависит от часов камеры — поэтому переживает сбитый RTC, который у GoPro не
    редкость.
``GPS5``
    Пачка координат: широта, долгота, высота, скорость 2D, скорость 3D. Целые числа,
    делятся на множители из ``SCAL``.
``GPSF``
    Тип фикса: 0 — спутников нет, 2 — 2D, 3 — 3D. Блоки без фикса содержат мусор
    в координатах и должны отбрасываться.
"""

from __future__ import annotations

import datetime as _dt
import struct
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Коды типов GPMF → коды формата struct.
_TYPES = {
    'b': 'b', 'B': 'B', 's': 'h', 'S': 'H',
    'l': 'i', 'L': 'I', 'f': 'f', 'd': 'd',
}

_HEADER = 8          # четыре байта ключа + тип + размер структуры + два байта повтора
_FALLBACK_STEP = 1.0  # длительность последнего блока, когда следующего нет


class GpmfError(Exception):
    """Поток gpmd отсутствует или не разбирается."""


@dataclass(frozen=True)
class GpsSample:
    t_utc: float      # секунды эпохи
    lat: float
    lon: float
    alt_m: float
    speed_kmh: float
    fix: int


@dataclass(frozen=True)
class Window:
    """Окно записи по спутниковому времени."""
    start_utc: float
    end_utc: float
    blocks: int
    fixed_blocks: int

    @property
    def duration_s(self) -> float:
        return self.end_utc - self.start_utc


def find_gpmd_stream(mp4: Path) -> int:
    """Индекс потока ``gpmd`` внутри контейнера."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "d",
         "-show_entries", "stream=index,codec_tag_string",
         "-of", "csv=p=0", str(mp4)],
        capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        parts = line.split(",")
        if len(parts) >= 2 and parts[1] == "gpmd":
            return int(parts[0])
    raise GpmfError(f"{mp4.name}: поток gpmd не найден — GPS в камере был выключен?")


def extract_gpmd(mp4: Path) -> bytes:
    """Сырой поток GPMF.

    ffmpeg достаёт его по индексу и не читает файл целиком, поэтому операция стоит
    доли секунды даже на четырёхгигабайтном ролике.
    """
    idx = find_gpmd_stream(mp4)
    with tempfile.TemporaryDirectory() as tmp:
        dst = Path(tmp) / "gpmd.bin"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", str(mp4), "-codec", "copy",
             "-map", f"0:{idx}", "-f", "rawvideo", str(dst)], check=True)
        return dst.read_bytes()


def parse_streams(buf: bytes) -> list[dict]:
    """Разбирает дерево KLV и возвращает по словарю на каждый контейнер ``STRM``.

    Значения складываются как есть, разбор в числа — отдельным шагом, потому что для
    большинства ключей он не нужен.
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
                return                       # обрезанный буфер: дальше идти нечем
            if typ == 0:                     # вложенный контейнер
                inner = {} if key == 'STRM' else scope
                walk(body, body + payload_len, inner)
                if key == 'STRM' and inner:
                    streams.append(inner)
            elif scope is not None:
                scope.setdefault(key, (chr(typ), size, count, buf[body:body + payload_len]))
            off = body + payload_len + (-payload_len % 4)   # выравнивание на 4 байта

    walk(0, len(buf), None)
    return streams


def _numbers(entry: tuple[str, int, int, bytes]) -> list[tuple]:
    """Значение KLV как список кортежей чисел."""
    typ, size, count, payload = entry
    fmt = _TYPES.get(typ)
    if fmt is None:
        raise GpmfError(f"нечисловой тип GPMF: {typ!r}")
    per = size // struct.calcsize(fmt)
    return [struct.unpack_from('>' + fmt * per, payload, i * size) for i in range(count)]


def _gpsu_to_epoch(payload: bytes) -> float:
    text = payload.decode('latin1').strip('\x00').strip()
    if len(text) < 12:
        raise GpmfError(f"метка GPSU слишком коротка: {text!r}")
    stamp = _dt.datetime.strptime(text[:12], "%y%m%d%H%M%S")
    fraction = float(text[12:] or 0)
    return stamp.replace(tzinfo=_dt.timezone.utc).timestamp() + fraction


def _gps_blocks(buf: bytes) -> list[dict]:
    return [s for s in parse_streams(buf) if 'GPS5' in s and 'GPSU' in s]


def parse_window(buf: bytes) -> Window:
    """Окно записи и качество фикса, без разбора координат."""
    blocks = _gps_blocks(buf)
    if not blocks:
        raise GpmfError("в потоке GPMF нет ни одного блока GPS")
    fixed = sum(1 for b in blocks if _numbers(b['GPSF'])[0][0] >= 2)
    return Window(
        start_utc=_gpsu_to_epoch(blocks[0]['GPSU'][3]),
        end_utc=_gpsu_to_epoch(blocks[-1]['GPSU'][3]),
        blocks=len(blocks),
        fixed_blocks=fixed,
    )


def parse_gps(buf: bytes) -> list[GpsSample]:
    """Координаты и скорость с привязкой к спутниковому времени.

    ``GPSU`` приходит раз в секунду, а ``GPS5`` отдаёт за это время пачку сэмплов, —
    поэтому время внутри пачки раскладывается линейно до метки следующего блока.
    Блоки без фикса пропускаются целиком: координаты в них мусорные.
    """
    blocks = _gps_blocks(buf)
    if not blocks:
        raise GpmfError("в потоке GPMF нет ни одного блока GPS")

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
