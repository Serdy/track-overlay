"""Чтение экспорта сессии из приложения RaceBox.

Приложение отдаёт три формата, из которых нужны два.

**CSV** — основной. 25 Гц, время в ISO 8601 UTC. Есть подвох: настройка «Bike Mode»
*заменяет* боковое ускорение углом наклона, а не добавляет его. Поэтому одна и та же
сессия выгружается дважды, и :func:`merge` сводит обе выгрузки в один набор колонок.

**VBO** — формат VBOX, нужен ради колонки ``heading``, которой в CSV нет. У него свои
причуды: время как ``ЧЧММСС.сс``, координаты в угловых минутах, а **долгота с обратным
знаком** относительно CSV (в VBOX запад положителен).

Данные возвращаются набором именованных колонок, а не структурой с фиксированными
полями: наборы каналов у разных выгрузок отличаются, и перечислять их в классе — прямой
путь к тому, чтобы каждый новый канал требовал правки в пяти местах.
"""

from __future__ import annotations

import csv
import datetime as _dt
import math
from dataclasses import dataclass
from pathlib import Path

# Заголовки CSV → внутренние имена каналов.
_CSV_COLUMNS = {
    "Latitude": "lat", "Longitude": "lon", "Altitude": "alt_m",
    "Speed": "speed_kmh", "Lap": "lap",
    "GForceX": "g_long", "GForceY": "g_lat", "GForceZ": "g_vert",
    "LeanAngle": "lean_deg",
    "GyroX": "gyro_x", "GyroY": "gyro_y", "GyroZ": "gyro_z",
}

# Колонки VBO → внутренние имена. lat/lng и время обрабатываются отдельно.
_VBO_COLUMNS = {
    "velocity": "speed_kmh", "heading": "heading_deg", "height": "alt_m",
    "LongAcc": "g_long", "LatAcc": "g_lat", "VertAcc": "g_vert",
    "lean-angle": "lean_deg",
    "x-rotation-gyroscope": "gyro_x",
    "y-rotation-gyroscope": "gyro_y",
    "z-rotation-gyroscope": "gyro_z",
}

MAX_MERGE_SKEW_S = 0.005   # выгрузки одной сессии обязаны совпадать по времени точно


class RaceBoxError(Exception):
    """Файл не похож на экспорт RaceBox или выгрузки не сводятся."""


@dataclass(frozen=True)
class RaceBoxData:
    times: list[float]                 # секунды эпохи
    columns: dict[str, list[float]]
    source: Path

    def __len__(self) -> int:
        return len(self.times)

    @property
    def rate_hz(self) -> float:
        span = self.times[-1] - self.times[0]
        return (len(self.times) - 1) / span if span > 0 else 0.0

    def __contains__(self, channel: str) -> bool:
        return channel in self.columns


def _parse_iso(text: str) -> float:
    try:
        return _dt.datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
            tzinfo=_dt.timezone.utc).timestamp()
    except ValueError as err:
        raise RaceBoxError(f"нераспознанная метка времени: {text!r}") from err


def read_csv(path: Path) -> RaceBoxData:
    """Читает CSV-экспорт, автоматически определяя вариант Bike Mode."""
    with open(path, newline="", encoding="utf-8-sig") as handle:
        # Если включён «Include session description header», перед таблицей идут
        # строки метаданных — пропускаем их до настоящего заголовка.
        lines = [line for line in handle]
    start = next((i for i, line in enumerate(lines) if line.startswith("Record,")), None)
    if start is None:
        raise RaceBoxError(f"{path.name}: не найден заголовок таблицы (строка с 'Record,')")

    reader = csv.DictReader(lines[start:])
    known = {src: dst for src, dst in _CSV_COLUMNS.items() if src in (reader.fieldnames or [])}
    if "Speed" not in known or "Time" not in (reader.fieldnames or []):
        raise RaceBoxError(f"{path.name}: в таблице нет обязательных колонок Time и Speed")

    times: list[float] = []
    columns: dict[str, list[float]] = {name: [] for name in known.values()}
    for row in reader:
        times.append(_parse_iso(row["Time"]))
        for src, dst in known.items():
            columns[dst].append(float(row[src]))
    if not times:
        raise RaceBoxError(f"{path.name}: таблица пуста")
    return RaceBoxData(times, columns, path)


def _parse_vbo_time(token: str) -> float:
    """``123130.12`` → секунды от полуночи UTC."""
    value = float(token)
    hours, rest = divmod(value, 10000)
    minutes, seconds = divmod(rest, 100)
    return hours * 3600 + minutes * 60 + seconds


def _parse_vbo_coord(token: str) -> float:
    """VBOX хранит координаты в угловых минутах."""
    return float(token) / 60.0


def read_vbo(path: Path, *, day_utc: float | None = None) -> RaceBoxData:
    """Читает VBO. Нужен главным образом ради колонки ``heading``.

    Во времени VBO нет даты, только время суток, поэтому дату надо задать через
    ``day_utc`` (полночь нужных суток в секундах эпохи). Без него берётся дата из
    строки ``UTC Date Started`` в секции комментариев.
    """
    text = path.read_text(encoding="utf-8", errors="replace").splitlines()

    names: list[str] | None = None
    rows: list[list[str]] = []
    section = None
    started: _dt.date | None = None
    for line in text:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped[1:-1].lower()
            continue
        if not stripped:
            continue
        if section == "comments" and stripped.startswith("UTC Date Started"):
            stamp = stripped.split(":", 1)[1].strip()
            started = _dt.datetime.strptime(stamp.split()[0], "%d/%m/%Y").date()
        elif section == "column names":
            names = stripped.split()
        elif section == "data":
            rows.append(stripped.split())

    if names is None or not rows:
        raise RaceBoxError(f"{path.name}: нет секций [column names] и [data]")
    if day_utc is None:
        if started is None:
            raise RaceBoxError(f"{path.name}: дата не найдена, передайте day_utc")
        day_utc = _dt.datetime.combine(
            started, _dt.time(), tzinfo=_dt.timezone.utc).timestamp()

    index = {name: i for i, name in enumerate(names)}
    if "time" not in index:
        raise RaceBoxError(f"{path.name}: в [column names] нет колонки time")

    times = [day_utc + _parse_vbo_time(r[index["time"]]) for r in rows]
    columns: dict[str, list[float]] = {}
    if "lat" in index:
        columns["lat"] = [_parse_vbo_coord(r[index["lat"]]) for r in rows]
    if "lng" in index:
        # Знак долготы в VBOX обратный: запад положителен.
        columns["lon"] = [-_parse_vbo_coord(r[index["lng"]]) for r in rows]
    for src, dst in _VBO_COLUMNS.items():
        if src in index:
            columns[dst] = [float(r[index[src]]) for r in rows]
    return RaceBoxData(times, columns, path)


def merge(*datasets: RaceBoxData) -> RaceBoxData:
    """Сводит несколько выгрузок одной сессии в один набор каналов.

    Нужно из-за Bike Mode: он отдаёт либо ``lean_deg``, либо ``g_lat``, но не оба сразу.
    Метки времени обязаны совпадать — иначе это разные сессии, и молча склеивать их
    нельзя.
    """
    if not datasets:
        raise RaceBoxError("нечего объединять")
    base, *rest = datasets
    columns = dict(base.columns)
    for other in rest:
        if len(other) != len(base):
            raise RaceBoxError(
                f"{other.source.name}: {len(other)} строк против {len(base)} "
                f"в {base.source.name} — это разные сессии")
        skew = max(abs(a - b) for a, b in zip(base.times, other.times))
        if skew > MAX_MERGE_SKEW_S:
            raise RaceBoxError(
                f"{other.source.name}: расхождение меток до {skew:.3f} с — разные сессии")
        for name, values in other.columns.items():
            columns.setdefault(name, values)
    return RaceBoxData(base.times, columns, base.source)
