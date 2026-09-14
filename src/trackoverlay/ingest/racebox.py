"""Reading a session export from the RaceBox app.

The app offers three formats, two of which are useful here.

**CSV** is the main one. 25 Hz, time in ISO 8601 UTC. There is a catch: the Bike Mode
setting *replaces* lateral acceleration with lean angle rather than adding it. So the
same session is exported twice and :func:`merge` folds both files into one channel set.

**VBO** is the VBOX format, wanted for the ``heading`` column that CSV lacks. It has its
own quirks: time as ``HHMMSS.ss``, coordinates in arc minutes, and **longitude with the
opposite sign** compared to CSV (VBOX counts west as positive).

Data comes back as a set of named columns rather than a struct with fixed fields: the
channel set differs between exports, and listing them in a class is the direct route to
every new channel requiring edits in five places.
"""

from __future__ import annotations

import csv
import datetime as _dt
import math
from dataclasses import dataclass
from pathlib import Path

# CSV headers mapped to internal channel names.
_CSV_COLUMNS = {
    "Latitude": "lat", "Longitude": "lon", "Altitude": "alt_m",
    "Speed": "speed_kmh", "Lap": "lap",
    "GForceX": "g_long", "GForceY": "g_lat", "GForceZ": "g_vert",
    "LeanAngle": "lean_deg",
    "GyroX": "gyro_x", "GyroY": "gyro_y", "GyroZ": "gyro_z",
}

# VBO columns mapped to internal names. lat/lng and time are handled separately.
_VBO_COLUMNS = {
    "velocity": "speed_kmh", "heading": "heading_deg", "height": "alt_m",
    "LongAcc": "g_long", "LatAcc": "g_lat", "VertAcc": "g_vert",
    "lean-angle": "lean_deg",
    "x-rotation-gyroscope": "gyro_x",
    "y-rotation-gyroscope": "gyro_y",
    "z-rotation-gyroscope": "gyro_z",
}

MAX_MERGE_SKEW_S = 0.005   # exports of one session must line up in time exactly


class RaceBoxError(Exception):
    """The file does not look like a RaceBox export, or the exports do not merge."""


@dataclass(frozen=True)
class RaceBoxData:
    times: list[float]                 # seconds since the epoch
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
        raise RaceBoxError(f"unrecognised timestamp: {text!r}") from err


def read_csv(path: Path) -> RaceBoxData:
    """Reads a CSV export, detecting the Bike Mode variant automatically."""
    with open(path, newline="", encoding="utf-8-sig") as handle:
        # When "Include session description header" is on, metadata lines precede the
        # table — skip them until the real header row.
        lines = [line for line in handle]
    start = next((i for i, line in enumerate(lines) if line.startswith("Record,")), None)
    if start is None:
        raise RaceBoxError(f"{path.name}: no table header found (a line starting with 'Record,')")

    reader = csv.DictReader(lines[start:])
    known = {src: dst for src, dst in _CSV_COLUMNS.items() if src in (reader.fieldnames or [])}
    if "Speed" not in known or "Time" not in (reader.fieldnames or []):
        raise RaceBoxError(f"{path.name}: the table lacks the required Time and Speed columns")

    times: list[float] = []
    columns: dict[str, list[float]] = {name: [] for name in known.values()}
    for row in reader:
        times.append(_parse_iso(row["Time"]))
        for src, dst in known.items():
            columns[dst].append(float(row[src]))
    if not times:
        raise RaceBoxError(f"{path.name}: the table is empty")
    return RaceBoxData(times, columns, path)


def _parse_vbo_time(token: str) -> float:
    """``123130.12`` becomes seconds since UTC midnight."""
    value = float(token)
    hours, rest = divmod(value, 10000)
    minutes, seconds = divmod(rest, 100)
    return hours * 3600 + minutes * 60 + seconds


def _parse_vbo_coord(token: str) -> float:
    """VBOX stores coordinates in arc minutes."""
    return float(token) / 60.0


def read_vbo(path: Path, *, day_utc: float | None = None) -> RaceBoxData:
    """Reads a VBO. Wanted mainly for the ``heading`` column.

    VBO time carries no date, only a time of day, so the date has to be supplied through
    ``day_utc`` (midnight of that day in epoch seconds). Without it the date is taken from
    the ``UTC Date Started`` line in the comments section.
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
        raise RaceBoxError(f"{path.name}: no [column names] and [data] sections")
    if day_utc is None:
        if started is None:
            raise RaceBoxError(f"{path.name}: no date found, pass day_utc")
        day_utc = _dt.datetime.combine(
            started, _dt.time(), tzinfo=_dt.timezone.utc).timestamp()

    index = {name: i for i, name in enumerate(names)}
    if "time" not in index:
        raise RaceBoxError(f"{path.name}: [column names] has no time column")

    times = [day_utc + _parse_vbo_time(r[index["time"]]) for r in rows]
    columns: dict[str, list[float]] = {}
    if "lat" in index:
        columns["lat"] = [_parse_vbo_coord(r[index["lat"]]) for r in rows]
    if "lng" in index:
        # VBOX flips the sign of longitude: west is positive there.
        columns["lon"] = [-_parse_vbo_coord(r[index["lng"]]) for r in rows]
    for src, dst in _VBO_COLUMNS.items():
        if src in index:
            columns[dst] = [float(r[index[src]]) for r in rows]
    return RaceBoxData(times, columns, path)


def merge(*datasets: RaceBoxData) -> RaceBoxData:
    """Folds several exports of one session into a single channel set.

    Needed because of Bike Mode: it yields either ``lean_deg`` or ``g_lat``, never both.
    The timestamps have to match — otherwise these are different sessions, and splicing
    them silently would be wrong.
    """
    if not datasets:
        raise RaceBoxError("nothing to merge")
    base, *rest = datasets
    columns = dict(base.columns)
    for other in rest:
        if len(other) != len(base):
            raise RaceBoxError(
                f"{other.source.name}: {len(other)} rows against {len(base)} "
                f"in {base.source.name} — these are different sessions")
        skew = max(abs(a - b) for a, b in zip(base.times, other.times))
        if skew > MAX_MERGE_SKEW_S:
            raise RaceBoxError(
                f"{other.source.name}: timestamps differ by up to {skew:.3f} s — different sessions")
        for name, values in other.columns.items():
            columns.setdefault(name, values)
    return RaceBoxData(base.times, columns, base.source)
