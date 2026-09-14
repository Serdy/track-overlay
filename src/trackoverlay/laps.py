"""Разметка трассы: линия старт/финиша, круги и огибающая траекторий.

Круги нужны не только ради времён. Огибающая всех кругов — это тот бледный контур,
поверх которого виджет карты рисует текущую линию, и без разбивки на круги его не
построить.

Два места, где легко ошибиться:

**Пересечение ворот** считается настоящим пересечением отрезков, а не попаданием в
радиус. Радиус даёт время срабатывания с точностью до сэмпла и ошибается тем сильнее,
чем быстрее едешь; пересечение отрезков даёт точку между сэмплами.

**Усреднение кругов** идёт по пройденному пути, а не по времени или номеру сэмпла.
Круги разной длительности, поэтому сэмпл номер 500 на быстром и на медленном круге —
это разные места трассы. Точки проецируются на эталонный круг (координаты Френе), и
усредняется уже боковое отклонение при равном пути.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .telemetry import EARTH_R

GATE_HALF_WIDTH_M = 25.0     # половина длины линии ворот
MIN_LAP_S = 25.0             # быстрее этого круг не проехать — значит ложное срабатывание
MIN_GATE_SPEED_KMH = 30.0    # ворота ищем по быстрым участкам, а не по пит-лейну
CANDIDATE_STEP = 25          # каждая N-я точка как кандидат в ворота
MATCH_RADIUS_M = 22.0        # допуск при подсчёте проездов через кандидата
MATCH_BEARING_DEG = 50.0     # и допуск по курсу: встречное направление не считается


class LapError(Exception):
    """Трек не размечается на круги."""


@dataclass(frozen=True)
class Gate:
    lat: float
    lon: float
    bearing: float           # курс движения через ворота, градусы

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
    """Перевод координат в метры вокруг опорной точки.

    На масштабе автодрома равнопромежуточной проекции более чем достаточно, а возни
    с настоящей картографией она не требует.
    """

    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        # Длина градуса берётся из той же сферической модели, что и haversine_m в
        # telemetry. Эллипсоидальные коэффициенты точнее в абсолюте, но расходятся с
        # ней на 0.3%, а вся геометрия здесь относительная — единая модель важнее.
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
    """Разница курсов по кратчайшей дуге, 0..180."""
    return abs((b - a + 180.0) % 360.0 - 180.0)


def detect_start_finish(lats, lons, headings, speeds_kmh) -> Gate:
    """Ищет точку, которую трек чаще всего проезжает в одну и ту же сторону.

    Подход тот же, что в ``DDA_Reader``: перебрать кандидатов и посчитать проезды,
    разделённые по времени, чтобы соседние сэмплы одного проезда не считались за разные.
    """
    lats, lons = np.asarray(lats, float), np.asarray(lons, float)
    headings, speeds = np.asarray(headings, float), np.asarray(speeds_kmh, float)

    fast = np.flatnonzero(speeds > MIN_GATE_SPEED_KMH)
    if len(fast) < 100:
        raise LapError("на треке нет участка с уверенным движением")

    frame = LocalFrame(float(lats[fast].mean()), float(lons[fast].mean()))
    x, y = frame.to_xy(lats, lons)

    best_count, best_index = 0, int(fast[0])
    for candidate in fast[::CANDIDATE_STEP]:
        distance = np.hypot(x[fast] - x[candidate], y[fast] - y[candidate])
        near = fast[(distance < MATCH_RADIUS_M)]
        near = near[[_bearing_delta(headings[candidate], headings[i]) < MATCH_BEARING_DEG
                     for i in near]]
        # Соседние сэмплы одного проезда схлопываются в один: считаем только разрывы.
        passes = 1 + int(np.count_nonzero(np.diff(near) > 1)) if len(near) else 0
        if passes > best_count:
            best_count, best_index = passes, int(candidate)

    return Gate(float(lats[best_index]), float(lons[best_index]),
                float(headings[best_index]))


def find_crossings(lats, lons, times, gate: Gate, *,
                   half_width_m: float = GATE_HALF_WIDTH_M,
                   min_gap_s: float = MIN_LAP_S) -> list[float]:
    """Моменты пересечения линии ворот, с точностью лучше шага сэмплов.

    Ворота — отрезок, перпендикулярный курсу проезда. Учитываются только пересечения
    в правильную сторону: обратный проезд по той же линии кругом не считается.
    """
    frame = LocalFrame(gate.lat, gate.lon)
    x, y = frame.to_xy(lats, lons)
    times = np.asarray(times, float)

    # Направление проезда и перпендикуляр к нему. Курс отсчитывается от севера по
    # часовой стрелке, отсюда такая пара синус/косинус.
    heading = math.radians(gate.bearing)
    forward = np.array([math.sin(heading), math.cos(heading)])
    across = np.array([forward[1], -forward[0]])

    points = np.column_stack([x, y])
    along = points @ forward             # знак меняется в момент пересечения
    lateral = points @ across            # смещение вдоль линии ворот

    crossings: list[float] = []
    sign_change = np.flatnonzero((along[:-1] < 0) & (along[1:] >= 0))
    for i in sign_change:
        span = along[i + 1] - along[i]
        ratio = -along[i] / span if span else 0.0
        offset = lateral[i] + ratio * (lateral[i + 1] - lateral[i])
        if abs(offset) > half_width_m:
            continue                      # проехал мимо края линии
        moment = float(times[i] + ratio * (times[i + 1] - times[i]))
        if crossings and moment - crossings[-1] < min_gap_s:
            continue
        crossings.append(moment)
    return crossings


def split_laps(times, crossings: list[float]) -> list[Lap]:
    """Круги между соседними пересечениями. Выезд и заезд в круги не попадают."""
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
    """Проекция точек на эталонную линию: путь вдоль неё и боковое отклонение.

    Возвращает ``(s, offset)``. Знак ``offset`` — сторона относительно направления
    движения эталона: положительный слева, отрицательный справа.
    """
    ref_s = _path_length(ref_x, ref_y)
    # Касательная эталона в каждой вершине, через центральную разность.
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
        # Боковое отклонение — компонента поперёк касательной эталона.
        off_out[begin:end] = (dx[np.arange(end - begin), nearest] * (-ty[nearest])
                              + dy[np.arange(end - begin), nearest] * tx[nearest])
    return s_out, off_out


def build_envelope(lats, lons, laps: list[Lap], *, bins: int = 400
                   ) -> tuple[list[list[float]], list[list[float]]]:
    """Полоса, которую занимают все круги сессии.

    Возвращает две линии в координатах ``[lat, lon]`` — левый и правый край полосы.
    За эталон берётся самый быстрый круг: его траектория ближе всего к тому, что
    стоит показывать как основную линию.
    """
    if not laps:
        raise LapError("без кругов огибающую не построить")

    lats, lons = np.asarray(lats, float), np.asarray(lons, float)
    frame = LocalFrame(float(lats.mean()), float(lons.mean()))
    x, y = frame.to_xy(lats, lons)

    reference = min(laps, key=lambda lap: lap.duration_s)
    ref_x = x[reference.index_start:reference.index_end]
    ref_y = y[reference.index_start:reference.index_end]
    if len(ref_x) < 10:
        raise LapError("эталонный круг слишком короткий")
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

    # Корзины, куда не попало ни одной точки, берут значение соседей.
    valid = np.isfinite(low) & np.isfinite(high)
    if not valid.any():
        raise LapError("круги не проецируются на эталон")
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
    nx, ny = -ty / norm, tx / norm       # единичная нормаль слева от направления

    def to_line(offsets: np.ndarray) -> list[list[float]]:
        lon, lat = frame.to_lonlat(base_x + nx * offsets, base_y + ny * offsets)
        return [[round(float(a), 7), round(float(b), 7)] for a, b in zip(lat, lon)]

    return to_line(high), to_line(low)
