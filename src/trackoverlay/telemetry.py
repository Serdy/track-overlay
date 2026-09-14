"""Telemetry channels and the quantities derived from them.

Telemetry lives in a dict of channels rather than a struct with fixed fields, for a
concrete reason: in the neighbouring ``DDA_Reader`` project the fields are baked into
``DDARecord.__slots__``, so adding a channel means editing ``to_dict``, every exporter
and every widget — which is why in its whole history it never grew a source beyond ``.dda``.

Of the four quantities the overlay shows, only speed is measured directly. The rest are
computed here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

G = 9.80665                  # m/s², standard gravity
EARTH_R = 6371000.0          # m
MIN_LEAN_SPEED_KMH = 10.0    # below this speed heading is noise and lean is meaningless
MAX_LEAN_DEG = 65.0          # the physical limit for a motorcycle; beyond it is artefact

# Smoothing width for the heading rate. Tuned on session 3429 against RaceBox's own lean
# angle: 0.4 s gives a correlation of 0.999 with VBO heading and 0.996 with heading
# derived from coordinates. Wider is more accurate, but the indicator starts lagging the
# picture, and on video that shows up sooner than half a degree of error.
LEAN_SMOOTH_S = 0.4


@dataclass
class Channel:
    name: str
    role: str
    unit: str
    samples: list[float]

    def __len__(self) -> int:
        return len(self.samples)


@dataclass
class Telemetry:
    """Channels tied to a common time axis (epoch seconds)."""
    times: list[float]
    channels: dict[str, Channel] = field(default_factory=dict)

    def add(self, name: str, role: str, unit: str, samples: list[float]) -> Channel:
        if len(samples) != len(self.times):
            raise ValueError(
                f"channel {name}: {len(samples)} values against {len(self.times)} timestamps")
        channel = Channel(name, role, unit, samples)
        self.channels[name] = channel
        return channel

    def __contains__(self, name: str) -> bool:
        return name in self.channels

    def __getitem__(self, name: str) -> list[float]:
        return self.channels[name].samples

    def get(self, name: str) -> list[float] | None:
        channel = self.channels.get(name)
        return channel.samples if channel else None

    @property
    def rate_hz(self) -> float:
        span = self.times[-1] - self.times[0]
        return (len(self.times) - 1) / span if span > 0 else 0.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360.0


def cumulative_distance_m(lats: list[float], lons: list[float]) -> list[float]:
    out = [0.0]
    for i in range(1, len(lats)):
        out.append(out[-1] + haversine_m(lats[i - 1], lons[i - 1], lats[i], lons[i]))
    return out


def heading_from_track(lats: list[float], lons: list[float]) -> list[float]:
    """Heading from consecutive coordinates, when no ready column exists."""
    if len(lats) < 2:
        return [0.0] * len(lats)
    out = [bearing_deg(lats[i], lons[i], lats[i + 1], lons[i + 1])
           for i in range(len(lats) - 1)]
    out.append(out[-1])
    return out


def heading_rate_dps(headings: list[float], times: list[float]) -> list[float]:
    """Heading rate in degrees per second, by central difference.

    Unwraps the crossing through 360°: without it every pass through north would spike
    to 360 deg/s.
    """
    n = len(headings)
    if n < 2:
        return [0.0] * n

    def delta(a: float, b: float) -> float:
        return (b - a + 180.0) % 360.0 - 180.0

    out = []
    for i in range(n):
        lo, hi = max(0, i - 1), min(n - 1, i + 1)
        dt = times[hi] - times[lo]
        out.append(delta(headings[lo], headings[hi]) / dt if dt > 0 else 0.0)
    return out


def lean_from_trajectory(speeds_kmh: list[float], heading_rate: list[float]) -> list[float]:
    """Lean angle from the trajectory: ``lean = atan(v · dpsi/dt / g)``.

    This angle cannot be taken off the accelerometer, however much intuition suggests
    otherwise: in a steady corner the machine leans exactly enough for the resultant
    force to line up with its own vertical axis, so a sensor bolted to it reads close to
    zero lateral acceleration regardless of the angle.

    Deriving it from the trajectory has the further benefit of not caring how or at what
    angle the logger is mounted — no orientation calibration needed.
    """
    out = []
    for speed_kmh, rate in zip(speeds_kmh, heading_rate):
        if speed_kmh < MIN_LEAN_SPEED_KMH:
            out.append(0.0)
            continue
        lateral = (speed_kmh / 3.6) * math.radians(rate)   # v · dpsi/dt, m/s²
        angle = math.degrees(math.atan2(lateral, G))
        out.append(max(-MAX_LEAN_DEG, min(MAX_LEAN_DEG, angle)))
    return out


def accel_long_g(speeds_kmh: list[float], times: list[float]) -> list[float]:
    """Longitudinal acceleration by central difference of speed, in g.

    The fallback when no ready G column exists. Same formula as in
    ``DDA_Reader/dda_core.py``.
    """
    n = len(speeds_kmh)
    if n < 2:
        return [0.0] * n
    out = []
    for i in range(n):
        lo, hi = max(0, i - 1), min(n - 1, i + 1)
        dt = times[hi] - times[lo]
        dv = (speeds_kmh[hi] - speeds_kmh[lo]) / 3.6
        out.append(dv / (dt * G) if dt > 0 else 0.0)
    return out


def smooth_seconds(values: list[float], times: list[float], seconds: float) -> list[float]:
    """Moving average with the window given in seconds rather than samples.

    A width in samples ties the algorithm to one source's rate: RaceBox gives 25 Hz,
    GoPro about 18, and ``sr-track.js`` was written for 10. A window in seconds survives
    a change of source without recomputing constants.
    """
    if seconds <= 0 or len(values) < 2:
        return list(values)
    span = times[-1] - times[0]
    rate = (len(times) - 1) / span if span > 0 else 0.0
    window = max(1, int(round(seconds * rate)) | 1)     # odd width
    return moving_average(values, window)


def compute_lean(speeds_kmh: list[float], headings: list[float], times: list[float],
                 *, smooth_s: float = LEAN_SMOOTH_S) -> list[float]:
    """Lean angle from heading and speed, with the heading rate smoothed."""
    rate = smooth_seconds(heading_rate_dps(headings, times), times, smooth_s)
    return lean_from_trajectory(speeds_kmh, rate)


def moving_average(values: list[float], window: int) -> list[float]:
    """Centred moving average of odd width."""
    if window <= 1:
        return list(values)
    half = window // 2
    out = []
    for i in range(len(values)):
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out


def resample_uniform(tel: Telemetry, rate_hz: float) -> Telemetry:
    """Rebuilds every channel onto a strictly uniform grid.

    The logger drops a sample now and then: on session 3429 one step came out at 79 ms
    instead of 40. Treating the grid as uniform anyway would shift everything after the
    gap by 39 ms, which is more than two frames at 60 fps. Storing the full time axis
    alongside the channels would mean forty thousand more numbers in the file and a
    search on every frame in the browser. Resampling settles both at once.
    """
    if len(tel.times) < 2:
        return tel
    import numpy as np

    source = np.asarray(tel.times, float)
    grid = np.arange(source[0], source[-1], 1.0 / rate_hz)
    out = Telemetry(times=grid.tolist())
    for name, channel in tel.channels.items():
        values = np.interp(grid, source, np.asarray(channel.samples, float))
        out.add(name, channel.role, channel.unit, values.tolist())
    return out
