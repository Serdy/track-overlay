"""Сведение видео и телеметрии на общую шкалу времени.

Лесенка из трёх ступеней, от дешёвой к точной:

1. **UTC со спутников.** И GoPro, и RaceBox пишут абсолютное время, поэтому грубая
   привязка достаётся бесплатно и без участия человека.
2. **Кросс-корреляция скорости.** Собственный GPS камеры хуже логгера, но его скорости
   с избытком хватает, чтобы найти оставшийся сдвиг.
3. **Ручная поправка.** Нужна там, где у видео нет фикса GPS и корреляции не из чего
   считать.

Измерено на сессии 3429 (27 минут перекрытия): корреляция без поправки 0.961, с поправкой
0.9997 при сдвиге +1.40 с. Вторая ступень поэтому обязательна, а не факультативна —
1.4 с это 84 кадра при 60 fps. Сдвиг не менялся на всём отрезке, так что компенсация
дрейфа часов не нужна.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

import numpy as np

GRID_HZ = 10.0          # частота общей сетки для корреляции
MAX_LAG_S = 60.0        # шире искать бессмысленно: UTC не врёт на минуты
MIN_OVERLAP_S = 60.0    # на коротком перекрытии корреляция не значима
MIN_MOTION_KMH = 5.0    # ряд из стоянки коррелировать не с чем

Method = Literal["utc", "xcorr", "manual"]


class SyncError(Exception):
    """Ряды невозможно свести."""


@dataclass(frozen=True)
class SyncResult:
    offset_s: float           # когда начинается видео по шкале сессии
    correction_s: float       # сколько добавила корреляция поверх чистого UTC
    correlation: float        # качество совпадения, 1.0 — идеально
    method: Method
    overlap_s: float

    @property
    def reliable(self) -> bool:
        return self.method == "xcorr" and self.correlation >= 0.9


def _resample(times: Sequence[float], values: Sequence[float],
              grid: np.ndarray) -> np.ndarray:
    return np.interp(grid, np.asarray(times, float), np.asarray(values, float))


def _pearson(left: np.ndarray, right: np.ndarray) -> float:
    """Корреляция Пирсона по фактическому окну перекрытия.

    Нормировать ряды целиком нельзя: на каждом сдвиге окно своё, и общая нормировка
    занижает совпадение тем сильнее, чем больше сдвиг, — то есть смещает найденный пик.
    """
    n = len(left)
    if n < 2:
        return -1.0
    a = left - left.mean()
    b = right - right.mean()
    denominator = float(np.sqrt((a @ a) * (b @ b)))
    return float(a @ b) / denominator if denominator else -1.0


def _refine_peak(scores: np.ndarray, peak: int) -> float:
    """Субсэмпловое уточнение максимума параболой по трём точкам.

    Без него разрешение равно шагу сетки — 0.1 с, то есть 6 кадров при 60 fps.
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
    """Ищет сдвиг ряда ``a`` относительно ``b``.

    Возвращает ``(сдвиг в секундах, корреляция в пике, длительность перекрытия)``.
    Положительный сдвиг означает, что события в ``a`` происходят позже.
    """
    lo = max(a_times[0], b_times[0])
    hi = min(a_times[-1], b_times[-1])
    overlap = hi - lo
    if overlap < MIN_OVERLAP_S:
        raise SyncError(
            f"перекрытие {overlap:.0f} с, нужно хотя бы {MIN_OVERLAP_S:.0f} с")

    grid = np.arange(lo, hi, 1.0 / grid_hz)
    a = _resample(a_times, a_values, grid)
    b = _resample(b_times, b_values, grid)
    if a.std() == 0 or b.std() == 0:
        raise SyncError("ряд скорости постоянен — сводить нечего")

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
    """Сводит одно видео с телеметрией сессии.

    Если у видео нет пригодного ряда скорости (GPS был выключен или не поймал
    спутники), возвращает результат по одному UTC с пометкой ``manual`` — падать тут
    нельзя, такой материал тоже надо уметь показывать.
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

    # Положительный сдвиг означает, что видео отстаёт от телеметрии, значит его начало
    # по шкале сессии надо подвинуть назад на ту же величину.
    return SyncResult(naive - shift + manual_s, -shift, score, "xcorr", overlap)
