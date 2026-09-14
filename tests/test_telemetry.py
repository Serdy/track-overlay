import math

import pytest

from trackoverlay import telemetry as T
from trackoverlay.ingest import racebox
from conftest import FIXTURES


def test_channel_length_must_match_times():
    tel = T.Telemetry(times=[0.0, 1.0, 2.0])
    tel.add("speed", "speed", "km/h", [1.0, 2.0, 3.0])
    assert "speed" in tel and tel["speed"] == [1.0, 2.0, 3.0]
    with pytest.raises(ValueError, match="против 3 меток"):
        tel.add("rpm", "rpm", "rpm", [1.0])


def test_haversine_known_distance():
    # Одна минута широты это морская миля, 1852 м.
    assert T.haversine_m(48.0, 17.0, 48.0 + 1 / 60, 17.0) == pytest.approx(1852, rel=0.001)


def test_bearing_cardinal_directions():
    assert T.bearing_deg(48.0, 17.0, 48.1, 17.0) == pytest.approx(0, abs=0.1)    # север
    assert T.bearing_deg(48.0, 17.0, 48.0, 17.1) == pytest.approx(90, abs=0.1)   # восток


def test_heading_rate_unwraps_north_crossing():
    """Переход 359° → 1° это поворот на 2°, а не на -358°."""
    rate = T.heading_rate_dps([359.0, 0.0, 1.0], [0.0, 1.0, 2.0])
    assert rate[1] == pytest.approx(1.0, abs=0.01)
    assert max(abs(r) for r in rate) < 5.0


def test_lean_matches_steady_turn_physics():
    """Установившийся поворот радиуса R на скорости v даёт atan(v²/(R·g))."""
    v_ms, radius = 30.0, 50.0
    rate_dps = math.degrees(v_ms / radius)          # dψ/dt = v / R
    expected = math.degrees(math.atan(v_ms ** 2 / (radius * T.G)))
    got = T.lean_from_trajectory([v_ms * 3.6], [rate_dps])[0]
    assert got == pytest.approx(expected, abs=0.01)


def test_lean_sign_follows_turn_direction():
    right = T.lean_from_trajectory([100.0], [10.0])[0]
    left = T.lean_from_trajectory([100.0], [-10.0])[0]
    assert right > 0 > left
    assert right == pytest.approx(-left)


def test_lean_suppressed_at_low_speed():
    """На малой скорости курс шумит, и наклон из него считать бессмысленно."""
    assert T.lean_from_trajectory([T.MIN_LEAN_SPEED_KMH - 1], [90.0]) == [0.0]


def test_lean_clamped_to_physical_limit():
    assert T.lean_from_trajectory([200.0], [500.0])[0] == pytest.approx(T.MAX_LEAN_DEG)


def test_accel_long_constant_acceleration():
    """Разгон 0 → 36 км/ч за 1 с это 10 м/с², чуть больше одного g."""
    times = [0.0, 1.0, 2.0]
    got = T.accel_long_g([0.0, 36.0, 72.0], times)
    assert got[1] == pytest.approx(10.0 / T.G, rel=0.01)


def test_accel_long_handles_short_series():
    assert T.accel_long_g([5.0], [0.0]) == [0.0]


def test_cumulative_distance_is_monotonic():
    lats = [48.0 + i / 10000 for i in range(10)]
    lons = [17.0] * 10
    dist = T.cumulative_distance_m(lats, lons)
    assert dist[0] == 0.0
    assert dist == sorted(dist)
    assert dist[-1] == pytest.approx(9 * 11.1, rel=0.02)


def test_smooth_seconds_adapts_to_rate():
    """Одно и то же окно в секундах даёт разную ширину в сэмплах при разной частоте."""
    slow = [0.0, 10.0, 0.0, 10.0, 0.0]
    t_slow = [i * 0.5 for i in range(5)]           # 2 Гц
    assert T.smooth_seconds(slow, t_slow, 0.0) == slow
    smoothed = T.smooth_seconds(slow, t_slow, 1.5)
    assert max(smoothed) < max(slow)               # пики срезаны


def test_smooth_seconds_ignores_short_series():
    assert T.smooth_seconds([1.0], [0.0], 5.0) == [1.0]


def test_computed_lean_matches_racebox():
    """Главная проверка модуля: расчёт из траектории против собственного угла RaceBox."""
    rb = racebox.merge(
        racebox.read_csv(FIXTURES / "racebox_lean_head.csv"),
        racebox.read_vbo(FIXTURES / "racebox_head.vbo"))
    mine = T.compute_lean(rb.columns["speed_kmh"], rb.columns["heading_deg"], rb.times)
    reference = rb.columns["lean_deg"]

    moving = [i for i, v in enumerate(rb.columns["speed_kmh"]) if v > 30]
    assert moving, "в фикстуре нет участка движения"
    deltas = sorted(abs(mine[i] - reference[i]) for i in moving)
    assert deltas[len(deltas) // 2] < 3.0          # медиана расхождения меньше 3°


def test_computed_lean_works_without_vbo():
    """Курс можно вывести из координат — тогда VBO не нужен вовсе."""
    rb = racebox.read_csv(FIXTURES / "racebox_lean_head.csv")
    heading = T.heading_from_track(rb.columns["lat"], rb.columns["lon"])
    mine = T.compute_lean(rb.columns["speed_kmh"], heading, rb.times, smooth_s=1.0)
    reference = rb.columns["lean_deg"]

    moving = [i for i, v in enumerate(rb.columns["speed_kmh"]) if v > 30]
    deltas = sorted(abs(mine[i] - reference[i]) for i in moving)
    assert deltas[len(deltas) // 2] < 4.0
