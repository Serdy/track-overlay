"""Bringing video and telemetry onto a common time axis.

A three-rung ladder, cheapest first:

1. **UTC from the satellites.** Both GoPro and RaceBox write absolute time, so the
   coarse alignment comes for free and without human input.
2. **Speed cross-correlation.** The camera's own GPS is worse than the logger's, but its
   speed is more than enough to find the remaining offset.
3. **Manual correction.** Needed where the video has no GPS fix and there is nothing to
   correlate.

Measured on session 3429 (27 minutes of overlap): correlation 0.961 with no correction,
0.9997 at an offset of +1.40 s. That makes the second rung mandatory rather than
optional — 1.4 s is 84 frames at 60 fps. The offset held steady across the whole run, so
no clock-drift compensation is needed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

import numpy as np

GRID_HZ = 10.0          # rate of the shared grid used for correlation
MAX_LAG_S = 60.0        # searching wider is pointless: UTC is not minutes out
MIN_OVERLAP_S = 60.0    # on a short overlap the correlation means nothing
MIN_MOTION_KMH = 5.0    # a series of standing still has nothing to correlate against

Method = Literal["utc", "xcorr", "manual"]


class SyncError(Exception):
    """The series cannot be aligned."""


@dataclass(frozen=True)
class SyncResult:
    offset_s: float           # when the video starts on the session axis
    correction_s: float       # what correlation added on top of plain UTC
    correlation: float        # match quality, 1.0 being perfect
    method: Method
    overlap_s: float

    @property
    def reliable(self) -> bool:
        return self.method == "xcorr" and self.correlation >= 0.9


def _resample(times: Sequence[float], values: Sequence[float],
              grid: np.ndarray) -> np.ndarray:
    return np.interp(grid, np.asarray(times, float), np.asarray(values, float))


def _pearson(left: np.ndarray, right: np.ndarray) -> float:
    """Pearson correlation over the actual overlap window.

    Normalising the series as a whole is wrong: each lag has its own window, and a shared
    normalisation understates the match the further the lag — which moves the found peak.
    """
    n = len(left)
    if n < 2:
        return -1.0
    a = left - left.mean()
    b = right - right.mean()
    denominator = float(np.sqrt((a @ a) * (b @ b)))
    return float(a @ b) / denominator if denominator else -1.0


def _refine_peak(scores: np.ndarray, peak: int) -> float:
    """Sub-sample refinement of the maximum, by a parabola through three points.

    Without it the resolution equals the grid step — 0.1 s, which is 6 frames at 60 fps.
    """
    if peak == 0 or peak == len(scores) - 1:
        return 0.0
    left, middle, right = scores[peak - 1], scores[peak], scores[peak + 1]
    denominator = left - 2 * middle + right
    if denominator == 0:
        return 0.0
    return float(np.clip(0.5 * (left - right) / denominator, -0.5, 0.5))


def cross_correlate(a_times: Sequence[float], a_values: Sequence[float],
                    b_times: Sequence[float], b_values: Sequence[float],
                    *, grid_hz: float = GRID_HZ,
                    max_lag_s: float = MAX_LAG_S) -> tuple[float, float, float]:
    """Finds the offset of series ``a`` relative to ``b``.

    Returns ``(offset in seconds, peak correlation, overlap duration)``. A positive
    offset means events in ``a`` happen later.
    """
    lo = max(a_times[0], b_times[0])
    hi = min(a_times[-1], b_times[-1])
    overlap = hi - lo
    if overlap < MIN_OVERLAP_S:
        raise SyncError(
            f"overlap of {overlap:.0f} s, at least {MIN_OVERLAP_S:.0f} s needed")

    grid = np.arange(lo, hi, 1.0 / grid_hz)
    a = _resample(a_times, a_values, grid)
    b = _resample(b_times, b_values, grid)
    if a.std() == 0 or b.std() == 0:
        raise SyncError("the speed series is constant — nothing to align")

    span = int(max_lag_s * grid_hz)
    lags = np.arange(-span, span + 1)
    scores = np.array([
        _pearson(a[max(0, lag):len(a) + min(0, lag)],
                 b[max(0, -lag):len(b) + min(0, -lag)])
        for lag in lags])

    peak = int(np.argmax(scores))
    shift = (lags[peak] + _refine_peak(scores, peak)) / grid_hz
    return float(shift), float(scores[peak]), float(overlap)


def align(video_times: Sequence[float], video_speeds: Sequence[float],
          tel_times: Sequence[float], tel_speeds: Sequence[float],
          *, session_start_utc: float, manual_s: float = 0.0) -> SyncResult:
    """Aligns one video against the session telemetry.

    If the video has no usable speed series (GPS was off, or never caught satellites),
    the result falls back to plain UTC marked ``manual`` — throwing here is not an
    option, that footage has to be viewable too.
    """
    naive = video_times[0] - session_start_utc if video_times else 0.0

    usable = (len(video_times) >= 2
              and max(video_speeds, default=0.0) > MIN_MOTION_KMH
              and max(tel_speeds, default=0.0) > MIN_MOTION_KMH)
    if not usable:
        return SyncResult(naive + manual_s, 0.0, 0.0, "manual", 0.0)

    try:
        shift, score, overlap = cross_correlate(
            video_times, video_speeds, tel_times, tel_speeds)
    except SyncError:
        return SyncResult(naive + manual_s, 0.0, 0.0, "utc", 0.0)

    # A positive offset means the video lags the telemetry, so its start on the session
    # axis has to move back by the same amount.
    return SyncResult(naive - shift + manual_s, -shift, score, "xcorr", overlap)
