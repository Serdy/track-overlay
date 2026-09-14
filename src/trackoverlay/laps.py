"""Track layout: the start/finish line, laps and the envelope of trajectories.

Laps are not only about times. The envelope of all laps is the pale outline the map
widget draws the current line on top of, and it cannot be built without splitting the
session into laps.

Two places where it is easy to go wrong:

**A gate crossing** is computed as a real segment intersection, not as falling inside a
radius. A radius resolves the trigger only to the nearest sample and errs the more the
faster you go; a segment intersection lands between samples.

**Averaging laps** goes by distance travelled, not by time or sample index. Laps differ
in duration, so sample number 500 on a fast lap and on a slow one are different places
on the circuit. Points are projected onto a reference lap (Frenet coordinates), and it
is the lateral offset at equal distance that gets averaged.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .telemetry import EARTH_R

GATE_HALF_WIDTH_M = 25.0     # half the length of the gate line
MIN_LAP_S = 25.0             # no lap is quicker than this, so it must be a false trigger
MIN_GATE_SPEED_KMH = 30.0    # gates are looked for on fast sections, not in the pit lane
CANDIDATE_STEP = 25          # every Nth point is a gate candidate
MATCH_RADIUS_M = 22.0        # tolerance when counting passes through a candidate
MATCH_BEARING_DEG = 50.0     # and a heading tolerance: the opposite direction does not count


class LapError(Exception):
    """The track does not split into laps."""


@dataclass(frozen=True)
class Gate:
    lat: float
    lon: float
    bearing: float           # heading of travel through the gate, degrees

    def as_dict(self) -> dict:
        return {"lat": self.lat, "lon": self.lon, "bearing": self.bearing}


@dataclass(frozen=True)
class Lap:
    number: int
    t_start: float
    t_end: float
    index_start: int
    index_end: int

    @property
    def duration_s(self) -> float:
        return self.t_end - self.t_start


class LocalFrame:
    """Converting coordinates to metres around a reference point.

    At circuit scale an equirectangular projection is more than enough, and it spares the
    fuss of real cartography.
    """

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        # The degree length comes from the same spherical model as haversine_m in
        # telemetry. Ellipsoidal coefficients are more accurate in absolute terms but
        # differ from it by 0.3%, and all geometry here is relative — one model matters more.
        phi = math.radians(lat0)
        self._ky = math.radians(1.0) * EARTH_R
        self._kx = self._ky * math.cos(phi)

    def to_xy(self, lats, lons) -> tuple[np.ndarray, np.ndarray]:
        return ((np.asarray(lons, float) - self.lon0) * self._kx,
                (np.asarray(lats, float) - self.lat0) * self._ky)

    def to_lonlat(self, x, y) -> tuple[np.ndarray, np.ndarray]:
        return (np.asarray(x, float) / self._kx + self.lon0,
                np.asarray(y, float) / self._ky + self.lat0)


def _bearing_delta(a: float, b: float) -> float:
    """Difference between headings along the shorter arc, 0..180."""
    return abs((b - a + 180.0) % 360.0 - 180.0)


def detect_start_finish(lats, lons, headings, speeds_kmh) -> Gate:
    """Finds the point the track passes most often in the same direction.

    Same approach as in ``DDA_Reader``: walk the candidates and count passes separated in
    time, so that adjacent samples of one pass are not counted as several.
    """
    lats, lons = np.asarray(lats, float), np.asarray(lons, float)
    headings, speeds = np.asarray(headings, float), np.asarray(speeds_kmh, float)

    fast = np.flatnonzero(speeds > MIN_GATE_SPEED_KMH)
    if len(fast) < 100:
        raise LapError("the track has no stretch of confident movement")

    frame = LocalFrame(float(lats[fast].mean()), float(lons[fast].mean()))
    x, y = frame.to_xy(lats, lons)

    best_count, best_index = 0, int(fast[0])
    for candidate in fast[::CANDIDATE_STEP]:
        distance = np.hypot(x[fast] - x[candidate], y[fast] - y[candidate])
        near = fast[(distance < MATCH_RADIUS_M)]
        near = near[[_bearing_delta(headings[candidate], headings[i]) < MATCH_BEARING_DEG
                     for i in near]]
        # Adjacent samples of one pass collapse into one: only the breaks are counted.
        passes = 1 + int(np.count_nonzero(np.diff(near) > 1)) if len(near) else 0
        if passes > best_count:
            best_count, best_index = passes, int(candidate)

    return Gate(float(lats[best_index]), float(lons[best_index]),
                float(headings[best_index]))


def find_crossings(lats, lons, times, gate: Gate, *,
                   half_width_m: float = GATE_HALF_WIDTH_M,
                   min_gap_s: float = MIN_LAP_S) -> list[float]:
    """Moments of crossing the gate line, resolved finer than the sample step.

    The gate is a segment perpendicular to the direction of travel. Only crossings in the
    right direction count: driving back over the same line is not a lap.
    """
    frame = LocalFrame(gate.lat, gate.lon)
    x, y = frame.to_xy(lats, lons)
    times = np.asarray(times, float)

    # Direction of travel and the perpendicular to it. Heading runs clockwise from north,
    # hence this sine/cosine pairing.
    heading = math.radians(gate.bearing)
    forward = np.array([math.sin(heading), math.cos(heading)])
    across = np.array([forward[1], -forward[0]])

    points = np.column_stack([x, y])
    along = points @ forward             # the sign flips at the moment of crossing
    lateral = points @ across            # displacement along the gate line

    crossings: list[float] = []
    sign_change = np.flatnonzero((along[:-1] < 0) & (along[1:] >= 0))
    for i in sign_change:
        span = along[i + 1] - along[i]
        ratio = -along[i] / span if span else 0.0
        offset = lateral[i] + ratio * (lateral[i + 1] - lateral[i])
        if abs(offset) > half_width_m:
            continue                      # passed beyond the end of the line
        moment = float(times[i] + ratio * (times[i + 1] - times[i]))
        if crossings and moment - crossings[-1] < min_gap_s:
            continue
        crossings.append(moment)
    return crossings


def split_laps(times, crossings: list[float]) -> list[Lap]:
    """Laps between adjacent crossings. Out and in laps are not included."""
    times = np.asarray(times, float)
    laps = []
    for number, (start, end) in enumerate(zip(crossings, crossings[1:]), start=1):
        if end - start < MIN_LAP_S:
            continue
        laps.append(Lap(
            number=number,
            t_start=start, t_end=end,
            index_start=int(np.searchsorted(times, start)),
            index_end=int(np.searchsorted(times, end)),
        ))
    return laps


def _path_length(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    steps = np.hypot(np.diff(x), np.diff(y))
    return np.concatenate([[0.0], np.cumsum(steps)])


def frenet_project(ref_x: np.ndarray, ref_y: np.ndarray,
                   qx: np.ndarray, qy: np.ndarray,
                   *, chunk: int = 2000) -> tuple[np.ndarray, np.ndarray]:
    """Projects points onto a reference line: distance along it and lateral offset.

    Returns ``(s, offset)``. The sign of ``offset`` is the side relative to the
    reference's direction of travel: positive to the left, negative to the right.
    """
    ref_s = _path_length(ref_x, ref_y)
    # The reference tangent at each vertex, by central difference.
    tx = np.gradient(ref_x)
    ty = np.gradient(ref_y)
    norm = np.hypot(tx, ty)
    norm[norm == 0] = 1.0
    tx, ty = tx / norm, ty / norm

    s_out = np.empty(len(qx))
    off_out = np.empty(len(qx))
    for begin in range(0, len(qx), chunk):
        end = min(begin + chunk, len(qx))
        dx = qx[begin:end, None] - ref_x[None, :]
        dy = qy[begin:end, None] - ref_y[None, :]
        nearest = np.argmin(dx * dx + dy * dy, axis=1)
        s_out[begin:end] = ref_s[nearest]
        # Lateral offset is the component across the reference tangent.
        off_out[begin:end] = (dx[np.arange(end - begin), nearest] * (-ty[nearest])
                              + dy[np.arange(end - begin), nearest] * tx[nearest])
    return s_out, off_out


def build_envelope(lats, lons, laps: list[Lap], *, bins: int = 400
                   ) -> tuple[list[list[float]], list[list[float]]]:
    """The band that all laps of the session occupy.

    Returns two lines in ``[lat, lon]`` coordinates — the left and right edge of the band.
    The fastest lap serves as the reference: its trajectory is closest to what is worth
    showing as the main line.
    """
    if not laps:
        raise LapError("no laps, so no envelope")

    lats, lons = np.asarray(lats, float), np.asarray(lons, float)
    frame = LocalFrame(float(lats.mean()), float(lons.mean()))
    x, y = frame.to_xy(lats, lons)

    reference = min(laps, key=lambda lap: lap.duration_s)
    ref_x = x[reference.index_start:reference.index_end]
    ref_y = y[reference.index_start:reference.index_end]
    if len(ref_x) < 10:
        raise LapError("the reference lap is too short")
    ref_s = _path_length(ref_x, ref_y)

    edges = np.linspace(0.0, ref_s[-1], bins + 1)
    low = np.full(bins, np.inf)
    high = np.full(bins, -np.inf)

    for lap in laps:
        qx = x[lap.index_start:lap.index_end]
        qy = y[lap.index_start:lap.index_end]
        if len(qx) < 10:
            continue
        s, offset = frenet_project(ref_x, ref_y, qx, qy)
        slot = np.clip(np.searchsorted(edges, s) - 1, 0, bins - 1)
        np.minimum.at(low, slot, offset)
        np.maximum.at(high, slot, offset)

    # Bins that caught no points take the value of their neighbours.
    valid = np.isfinite(low) & np.isfinite(high)
    if not valid.any():
        raise LapError("the laps do not project onto the reference")
    index = np.arange(bins)
    low = np.interp(index, index[valid], low[valid])
    high = np.interp(index, index[valid], high[valid])

    centers = (edges[:-1] + edges[1:]) / 2
    base_x = np.interp(centers, ref_s, ref_x)
    base_y = np.interp(centers, ref_s, ref_y)
    tx = np.gradient(base_x)
    ty = np.gradient(base_y)
    norm = np.hypot(tx, ty)
    norm[norm == 0] = 1.0
    nx, ny = -ty / norm, tx / norm       # unit normal to the left of the direction

    def to_line(offsets: np.ndarray) -> list[list[float]]:
        lon, lat = frame.to_lonlat(base_x + nx * offsets, base_y + ny * offsets)
        return [[round(float(a), 7), round(float(b), 7)] for a, b in zip(lat, lon)]

    return to_line(high), to_line(low)
