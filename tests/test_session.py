import json

import pytest

from conftest import DATA, require_data
from trackoverlay import cli
from trackoverlay.ingest.gpmf import GpsSample
from trackoverlay.session import (SessionError, _refuse_if_another_day,
                                  build_session)
from trackoverlay.telemetry import Telemetry

CSV_LEAN = DATA / "RaceBox Track Session on 12-09-2026 14-31_lean.csv"
CSV_CORNERING = DATA / "RaceBox Track Session on 12-09-2026 14-31_corneringG.csv"
VBO = DATA / "RaceBox Track Session on 12-09-2026 14-31.vbo"


@pytest.fixture(scope="module")
def session():
    """A session without video: the RaceBox exports live in the repository, the video does not."""
    return build_session([CSV_LEAN, CSV_CORNERING, VBO], [], track="Slovakia Ring")


def test_session_channels(session):
    assert set(session.telemetry.channels) == {"lat", "lon", "speed", "lean", "accel", "dist"}
    assert session.telemetry.rate_hz == pytest.approx(25.0, abs=0.1)
    assert all(len(ch) == len(session.telemetry.times)
               for ch in session.telemetry.channels.values())


def test_session_laps(session):
    assert len(session.laps) == 8
    best = min(lap.duration_s for lap in session.laps)
    assert best == pytest.approx(160.349, abs=0.01)


def test_times_are_relative_to_session_start(session):
    payload = session.as_dict()
    assert payload["session"]["start_utc"].endswith("Z")
    assert payload["laps"][0]["t_start"] >= 0
    assert payload["laps"][-1]["t_end"] <= payload["session"]["duration_s"] + 1


def test_exactly_one_lap_marked_best(session):
    marked = [lap for lap in session.as_dict()["laps"] if lap["best"]]
    assert len(marked) == 1
    assert marked[0]["duration_s"] == pytest.approx(160.349, abs=0.01)


def test_payload_shape(session):
    payload = session.as_dict()
    assert set(payload) == {"session", "channels", "laps", "gates", "envelope", "clips"}
    assert payload["gates"][0]["id"] == "sf"
    assert len(payload["envelope"]["left"]) == len(payload["envelope"]["right"]) == 400
    assert payload["clips"] == []


def test_samples_are_rounded(session):
    """Full float precision inflates the file fivefold and adds nothing."""
    speeds = session.as_dict()["channels"]["speed"]["samples"]
    assert all(round(v, 2) == v for v in speeds[:500])


def test_write_produces_valid_json(session, tmp_path):
    path = session.write(tmp_path / "nested" / "session.json")
    assert path.exists()
    loaded = json.loads(path.read_text(encoding="utf-8"))
    assert loaded["session"]["track"] == "Slovakia Ring"


def test_requires_racebox_files():
    with pytest.raises(SessionError, match="no telemetry export"):
        build_session([], [])


def test_a_vbo_on_its_own_builds_a_session():
    """Everything drawn comes from GPS: the lean angle is computed from the trajectory
    and braking from the speed, so a file with position and heading is enough. It is also
    what RaceChrono exports, which is the only telemetry some people have."""
    session = build_session([VBO], [], track="Slovakia Ring")

    assert set(session.telemetry.channels) == {"lat", "lon", "speed", "lean", "accel", "dist"}
    assert len(session.laps) == 8
    assert min(lap.duration_s for lap in session.laps) == pytest.approx(160.349, abs=0.3)


def test_no_telemetry_at_all_is_still_refused():
    with pytest.raises(SessionError, match="no telemetry export"):
        build_session([], [])


def test_cli_build_without_video(tmp_path, capsys):
    out = tmp_path / "session.json"
    code = cli.main(["build", str(CSV_LEAN), str(VBO), "-o", str(out),
                     "--track", "Slovakia Ring"])
    assert code == 0
    assert out.exists()
    printed = capsys.readouterr().out
    assert "8 laps" in printed
    assert "2:40.349" in printed


def test_cli_reports_error_without_telemetry(tmp_path, capsys):
    code = cli.main(["build", str(tmp_path / "nothing.mp4"), "-o", str(tmp_path / "s.json")])
    assert code == 2
    assert "error" in capsys.readouterr().err


def test_cli_build_with_video(tmp_path, capsys):
    """A full run with video: the clip must align by correlation."""
    videos = require_data("GH013429.MP4", "GH023429.MP4", "GH033429.MP4")
    out = tmp_path / "session.json"
    assert cli.main(["build", str(CSV_LEAN), str(VBO), *map(str, videos),
                     "-o", str(out)]) == 0

    payload = json.loads(out.read_text(encoding="utf-8"))
    (clip,) = payload["clips"]
    assert clip["id"] == "cam_3429"
    assert len(clip["files"]) == 3
    assert clip["sync"]["method"] == "xcorr"
    assert clip["sync"]["correlation"] > 0.99
    assert clip["sync"]["reliable"] is True
    assert clip["offset_s"] == pytest.approx(-116.1, abs=0.5)
    assert "✓ cam_3429" in capsys.readouterr().out


def test_progress_is_reported_and_monotonic():
    """A build runs for minutes; a bar that sits at 10% the whole time says nothing."""
    seen = []
    build_session([CSV_LEAN, CSV_CORNERING, VBO], [], track="Slovakia Ring",
                  on_progress=lambda done, stage: seen.append((done, stage)))

    fractions = [done for done, _ in seen]
    assert fractions == sorted(fractions)
    assert 0.0 <= fractions[0] and fractions[-1] <= 1.0
    assert all(stage for _, stage in seen)
    assert any("telemetry" in stage for _, stage in seen)


def _sample(t: float) -> GpsSample:
    return GpsSample(t_utc=t, lat=48.0, lon=17.0, alt_m=120.0, speed_kmh=80.0, fix=3)


def _one_second_of_telemetry() -> Telemetry:
    tel = Telemetry(times=[1000.0, 1001.0, 1002.0])
    tel.add("speed", "speed", "km/h", [80.0, 80.0, 80.0])
    return tel


def test_footage_from_another_day_is_refused_by_name():
    """A VBO carries a time of day and no date. Dated wrong, the correlation finds nothing,
    falls back to raw UTC, and the offset becomes days - which renders as a black screen."""
    stamps = [_sample(1000.0 + 16 * 86400 + i) for i in range(3)]

    with pytest.raises(SessionError, match="days apart"):
        _refuse_if_another_day("cam_1", stamps, _one_second_of_telemetry())


def test_footage_minutes_off_the_logger_is_left_alone():
    """A camera clock minutes out is ordinary, and a pit-lane clip may sit outside the
    session altogether. Correlation handles both; refusing them would refuse real work."""
    stamps = [_sample(1000.0 + 600 + i) for i in range(3)]

    _refuse_if_another_day("cam_1", stamps, _one_second_of_telemetry())
