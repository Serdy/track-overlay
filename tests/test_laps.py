import math

import numpy as np
import pytest

from conftest import DATA
from trackoverlay import laps as L
from trackoverlay.laps import Gate, Lap, LapError

LAT0, LON0 = 48.0554, 17.5699


def north_track(count=21, span_m=200.0, east_m=0.0):
    """A straight segment running south to north through the reference point."""
    frame = L.LocalFrame(LAT0, LON0)
    y = np.linspace(-span_m / 2, span_m / 2, count)
    lon, lat = frame.to_lonlat(np.full(count, east_m), y)
    return lat.tolist(), lon.tolist(), np.linspace(0.0, 10.0, count).tolist()


def circle_track(radius_m, turns=1, count=400):
    frame = L.LocalFrame(LAT0, LON0)
    angle = np.linspace(0, 2 * math.pi * turns, count * turns, endpoint=False)
    lon, lat = frame.to_lonlat(radius_m * np.cos(angle), radius_m * np.sin(angle))
    return lat, lon


def test_local_frame_round_trip():
    frame = L.LocalFrame(LAT0, LON0)
    x, y = frame.to_xy([LAT0 + 0.001], [LON0 + 0.001])
    lon, lat = frame.to_lonlat(x, y)
    assert lat[0] == pytest.approx(LAT0 + 0.001, abs=1e-9)
    assert lon[0] == pytest.approx(LON0 + 0.001, abs=1e-9)


def test_local_frame_scale():
    """One minute of latitude is a nautical mile."""
    frame = L.LocalFrame(LAT0, LON0)
    _, y = frame.to_xy([LAT0 + 1 / 60], [LON0])
    assert y[0] == pytest.approx(1852, rel=0.005)


@pytest.mark.parametrize("dlat, dlon", [(0.01, 0.0), (0.0, 0.01), (0.005, -0.008)])
def test_local_frame_agrees_with_haversine(dlat, dlon):
    """The flat projection and the spherical formula must agree on distance."""
    from trackoverlay.telemetry import haversine_m

    frame = L.LocalFrame(LAT0, LON0)
    x, y = frame.to_xy([LAT0 + dlat], [LON0 + dlon])
    flat = float(np.hypot(x, y)[0])
    exact = haversine_m(LAT0, LON0, LAT0 + dlat, LON0 + dlon)
    assert flat == pytest.approx(exact, rel=0.002)


@pytest.mark.parametrize("a, b, expected", [
    (0.0, 10.0, 10.0), (350.0, 10.0, 20.0), (10.0, 350.0, 20.0), (0.0, 180.0, 180.0),
])
def test_bearing_delta(a, b, expected):
    assert L._bearing_delta(a, b) == pytest.approx(expected, abs=0.01)


def test_crossing_is_interpolated_between_samples():
    """The crossing moment must land between samples, not on the nearest one."""
    lat, lon, times = north_track(count=21)
    gate = Gate(LAT0, LON0, 0.0)
    crossings = L.find_crossings(lat, lon, times, gate)
    assert len(crossings) == 1
    assert crossings[0] == pytest.approx(5.0, abs=0.01)


def test_crossing_ignores_reverse_direction():
    """Driving back over the same line does not count as a lap."""
    lat, lon, times = north_track()
    gate = Gate(LAT0, LON0, 180.0)           # the gate faces south
    assert L.find_crossings(lat, lon, times, gate) == []


def test_crossing_ignores_pass_beyond_gate_width():
    lat, lon, times = north_track(east_m=L.GATE_HALF_WIDTH_M + 10.0)
    gate = Gate(LAT0, LON0, 0.0)
    assert L.find_crossings(lat, lon, times, gate) == []


def test_crossing_respects_minimum_gap():
    """Two crossings closer together than the minimum lap are one trigger."""
    lat, lon, times = north_track(count=11, span_m=100.0)
    doubled_lat = lat + lat
    doubled_lon = lon + lon
    doubled_times = times + [t + 12.0 for t in times]      # a second pass 12 s later
    gate = Gate(LAT0, LON0, 0.0)
    assert len(L.find_crossings(doubled_lat, doubled_lon, doubled_times, gate)) == 1


def test_split_laps_pairs_crossings():
    times = np.linspace(0, 600, 601).tolist()
    laps = L.split_laps(times, [10.0, 180.0, 350.0])
    assert [lap.number for lap in laps] == [1, 2]
    assert laps[0].duration_s == pytest.approx(170.0)
    assert laps[0].index_start == 10


def test_split_laps_drops_too_short():
    times = np.linspace(0, 600, 601).tolist()
    assert L.split_laps(times, [10.0, 20.0]) == []


def test_frenet_offset_on_straight_reference():
    """A point 5 m to the side of a straight line must give exactly that lateral offset."""
    ref_x = np.linspace(0, 100, 101)
    ref_y = np.zeros(101)
    s, offset = L.frenet_project(ref_x, ref_y, np.array([50.0]), np.array([5.0]))
    assert s[0] == pytest.approx(50.0, abs=1.0)
    assert offset[0] == pytest.approx(5.0, abs=0.01)


def test_frenet_offset_sign_flips_by_side():
    ref_x = np.linspace(0, 100, 101)
    ref_y = np.zeros(101)
    _, left = L.frenet_project(ref_x, ref_y, np.array([50.0]), np.array([+5.0]))
    _, right = L.frenet_project(ref_x, ref_y, np.array([50.0]), np.array([-5.0]))
    assert left[0] > 0 > right[0]


def test_envelope_width_matches_lap_spread():
    """Two laps on concentric circles give a band as wide as the difference."""
    inner_lat, inner_lon = circle_track(200.0)
    outer_lat, outer_lon = circle_track(203.0)
    lats = np.concatenate([inner_lat, outer_lat])
    lons = np.concatenate([inner_lon, outer_lon])
    n = len(inner_lat)
    laps = [Lap(1, 0.0, 100.0, 0, n), Lap(2, 100.0, 205.0, n, 2 * n)]

    left, right = L.build_envelope(lats, lons, laps, bins=120)
    frame = L.LocalFrame(float(lats.mean()), float(lons.mean()))
    widths = []
    for (la, lo), (rb_lat, rb_lon) in zip(left, right):
        ax, ay = frame.to_xy([la], [lo])
        bx, by = frame.to_xy([rb_lat], [rb_lon])
        widths.append(float(np.hypot(ax - bx, ay - by)[0]))
    assert np.median(widths) == pytest.approx(3.0, abs=0.6)


def test_envelope_requires_laps():
    with pytest.raises(LapError, match="no laps"):
        L.build_envelope([48.0], [17.0], [])


def test_detect_gate_needs_motion():
    with pytest.raises(LapError, match="confident movement"):
        L.detect_start_finish([48.0] * 10, [17.0] * 10, [0.0] * 10, [1.0] * 10)


def test_real_session_lap_times():
    """The gate is found automatically, and the times are checked against RaceBox."""
    from trackoverlay.ingest import racebox
    from trackoverlay import telemetry as T

    csv = DATA / "RaceBox Track Session on 12-09-2026 14-31_lean.csv"
    if not csv.exists():
        pytest.skip("no RaceBox export")
    rb = racebox.read_csv(csv)
    c = rb.columns
    heading = T.heading_from_track(c["lat"], c["lon"])

    gate = L.detect_start_finish(c["lat"], c["lon"], heading, c["speed_kmh"])
    laps = L.split_laps(rb.times, L.find_crossings(c["lat"], c["lon"], rb.times, gate))

    assert len(laps) == int(max(c["lap"]))            # as many as RaceBox counted
    best = min(lap.duration_s for lap in laps)
    assert best == pytest.approx(160.34, abs=0.05)    # the app shows 2:40.34

    left, right = L.build_envelope(c["lat"], c["lon"], laps)
    assert len(left) == len(right) == 400
