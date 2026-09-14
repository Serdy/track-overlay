"""Каналы телеметрии и вычисляемые из них величины.

Телеметрия хранится словарём каналов, а не структурой с фиксированными полями. Причина
конкретная: в соседнем проекте ``DDA_Reader`` поля зашиты в ``DDARecord.__slots__``, и
добавление канала требует правки в ``to_dict``, во всех экспортёрах и в каждом виджете —
поэтому за всю его историю там не появилось ни одного источника данных кроме ``.dda``.

Из четырёх величин, которые показывает оверлей, измеряется напрямую только скорость.
Остальные считаются здесь.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

G = 9.80665                  # м/с², стандартное ускорение свободного падения
EARTH_R = 6371000.0          # м
MIN_LEAN_SPEED_KMH = 10.0    # ниже этой скорости курс шумит и наклон считать бессмысленно
MAX_LEAN_DEG = 65.0          # физический предел для мотоцикла, всё выше — артефакт

# Ширина сглаживания скорости изменения курса. Подобрана на сессии 3429 сверкой с
# собственным углом наклона RaceBox: 0.4 с дают корреляцию 0.999 при курсе из VBO и
# 0.996 при курсе из координат. Шире — точнее, но индикатор начинает опаздывать за
# картинкой, что на видео заметнее погрешности в полградуса.
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
    """Каналы, привязанные к общей шкале времени (секунды эпохи)."""
    times: list[float]
    channels: dict[str, Channel] = field(default_factory=dict)

    def add(self, name: str, role: str, unit: str, samples: list[float]) -> Channel:
        if len(samples) != len(self.times):
            raise ValueError(
                f"канал {name}: {len(samples)} значений против {len(self.times)} меток времени")
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
    """Курс из последовательных координат, когда готовой колонки нет."""
    if len(lats) < 2:
        return [0.0] * len(lats)
    out = [bearing_deg(lats[i], lons[i], lats[i + 1], lons[i + 1])
           for i in range(len(lats) - 1)]
    out.append(out[-1])
    return out


def heading_rate_dps(headings: list[float], times: list[float]) -> list[float]:
    """Скорость изменения курса, град/с, центральной разностью.

    Разворачивает переход через 360°: без этого на каждом пересечении севера
    получался бы выброс в 360 град/с.
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
    """Угол наклона из траектории: ``lean = atan(v · dψ/dt / g)``.

    С акселерометра этот угол взять нельзя, хотя интуиция подсказывает обратное:
    в установившемся повороте мотоцикл наклоняется ровно настолько, чтобы
    равнодействующая сил совпала с его вертикальной осью, поэтому закреплённый на нём
    датчик покажет боковое ускорение около нуля независимо от угла.

    Расчёт из траектории вдобавок не зависит от того, как и под каким углом прикручен
    логгер, — калибровка ориентации не нужна.
    """
    out = []
    for speed_kmh, rate in zip(speeds_kmh, heading_rate):
        if speed_kmh < MIN_LEAN_SPEED_KMH:
            out.append(0.0)
            continue
        lateral = (speed_kmh / 3.6) * math.radians(rate)   # v · dψ/dt, м/с²
        angle = math.degrees(math.atan2(lateral, G))
        out.append(max(-MAX_LEAN_DEG, min(MAX_LEAN_DEG, angle)))
    return out


def accel_long_g(speeds_kmh: list[float], times: list[float]) -> list[float]:
    """Продольное ускорение центральной разностью скорости, в g.

    Запасной путь на случай, когда готовой колонки G нет. Формула та же, что в
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
    """Скользящее среднее с шириной окна в секундах, а не в сэмплах.

    Ширина в сэмплах привязывает алгоритм к частоте конкретного источника: RaceBox даёт
    25 Гц, GoPro около 18, а ``sr-track.js`` писался под 10. Окно в секундах переживает
    смену источника без пересчёта констант.
    """
    if seconds <= 0 or len(values) < 2:
        return list(values)
    span = times[-1] - times[0]
    rate = (len(times) - 1) / span if span > 0 else 0.0
    window = max(1, int(round(seconds * rate)) | 1)     # нечётная ширина
    return moving_average(values, window)


def compute_lean(speeds_kmh: list[float], headings: list[float], times: list[float],
                 *, smooth_s: float = LEAN_SMOOTH_S) -> list[float]:
    """Угол наклона из курса и скорости, со сглаживанием производной курса."""
    rate = smooth_seconds(heading_rate_dps(headings, times), times, smooth_s)
    return lean_from_trajectory(speeds_kmh, rate)


def moving_average(values: list[float], window: int) -> list[float]:
    """Центрированное скользящее среднее нечётной ширины."""
    if window <= 1:
        return list(values)
    half = window // 2
    out = []
    for i in range(len(values)):
        lo, hi = max(0, i - half), min(len(values), i + half + 1)
        out.append(sum(values[lo:hi]) / (hi - lo))
    return out
