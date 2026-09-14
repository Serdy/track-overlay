import json

import pytest

from conftest import DATA, require_data
from trackoverlay import cli
from trackoverlay.session import SessionError, build_session

CSV_LEAN = DATA / "RaceBox Track Session on 12-09-2026 14-31_lean.csv"
CSV_CORNERING = DATA / "RaceBox Track Session on 12-09-2026 14-31_corneringG.csv"
VBO = DATA / "RaceBox Track Session on 12-09-2026 14-31.vbo"


@pytest.fixture(scope="module")
def session():
    """Сессия без видео: экспорты RaceBox лежат в репозитории, видео — нет."""
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
    """Полная точность float раздувает файл впятеро и ничего не добавляет."""
    speeds = session.as_dict()["channels"]["speed"]["samples"]
    assert all(round(v, 2) == v for v in speeds[:500])


def test_write_produces_valid_json(session, tmp_path):
    path = session.write(tmp_path / "nested" / "session.json")
    assert path.exists()
    loaded = json.loads(path.read_text(encoding="utf-8"))
    assert loaded["session"]["track"] == "Slovakia Ring"


def test_requires_racebox_files():
    with pytest.raises(SessionError, match="не передан ни один экспорт"):
        build_session([], [])


def test_vbo_alone_is_not_enough():
    with pytest.raises(SessionError, match="VBO сам по себе"):
        build_session([VBO], [])


def test_cli_build_without_video(tmp_path, capsys):
    out = tmp_path / "session.json"
    code = cli.main(["build", str(CSV_LEAN), str(VBO), "-o", str(out),
                     "--track", "Slovakia Ring"])
    assert code == 0
    assert out.exists()
    printed = capsys.readouterr().out
    assert "8 кругов" in printed
    assert "2:40.349" in printed


def test_cli_reports_error_without_telemetry(tmp_path, capsys):
    code = cli.main(["build", str(tmp_path / "nothing.mp4"), "-o", str(tmp_path / "s.json")])
    assert code == 2
    assert "ошибка" in capsys.readouterr().err


def test_cli_build_with_video(tmp_path, capsys):
    """Полный прогон с видео: клип должен свестись корреляцией."""
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
