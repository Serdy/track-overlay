import datetime as dt

import pytest

from conftest import utc
from trackoverlay.ingest import racebox
from trackoverlay.ingest.racebox import RaceBoxError

FIRST_STAMP = utc("2026-09-12T12:31:30.120+00:00")
FIRST_LAT, FIRST_LON = 48.0560154, 17.5707847


def test_read_csv_bike_mode(rb_lean):
    data = racebox.read_csv(rb_lean)
    assert len(data) == 2000
    assert data.rate_hz == pytest.approx(25.0, abs=0.1)
    assert data.times[0] == pytest.approx(FIRST_STAMP, abs=0.001)
    assert data.columns["lat"][0] == pytest.approx(FIRST_LAT)
    assert data.columns["lon"][0] == pytest.approx(FIRST_LON)
    # Bike Mode yields the lean angle instead of lateral acceleration.
    assert "lean_deg" in data
    assert "g_lat" not in data


def test_read_csv_cornering_mode(rb_cornering):
    data = racebox.read_csv(rb_cornering)
    assert "g_lat" in data
    assert "lean_deg" not in data
    assert len(data) == 2000


def test_both_exports_describe_same_session(rb_lean, rb_cornering):
    lean, cornering = racebox.read_csv(rb_lean), racebox.read_csv(rb_cornering)
    assert lean.times == cornering.times
    assert lean.columns["speed_kmh"] == cornering.columns["speed_kmh"]


def test_merge_combines_lean_and_lateral_g(rb_lean, rb_cornering):
    merged = racebox.merge(racebox.read_csv(rb_lean), racebox.read_csv(rb_cornering))
    assert "lean_deg" in merged and "g_lat" in merged
    assert len(merged) == 2000


def test_merge_rejects_different_lengths(rb_lean, rb_cornering):
    short = racebox.read_csv(rb_lean)
    other = racebox.read_csv(rb_cornering)
    trimmed = racebox.RaceBoxData(other.times[:-1],
                                  {k: v[:-1] for k, v in other.columns.items()},
                                  other.source)
    with pytest.raises(RaceBoxError, match="different sessions"):
        racebox.merge(short, trimmed)


def test_merge_rejects_time_skew(rb_lean, rb_cornering):
    base = racebox.read_csv(rb_lean)
    shifted = racebox.read_csv(rb_cornering)
    shifted = racebox.RaceBoxData([t + 1.0 for t in shifted.times],
                                  shifted.columns, shifted.source)
    with pytest.raises(RaceBoxError, match="timestamps differ"):
        racebox.merge(base, shifted)


def test_merge_without_arguments_raises():
    with pytest.raises(RaceBoxError, match="nothing to merge"):
        racebox.merge()


def test_read_vbo(rb_vbo):
    data = racebox.read_vbo(rb_vbo)
    assert len(data) == 2000
    assert data.times[0] == pytest.approx(FIRST_STAMP, abs=0.01)
    assert "heading_deg" in data          # this column is the whole point of the VBO
    assert 0 <= data.columns["heading_deg"][0] <= 360


def test_vbo_coordinates_match_csv(rb_vbo, rb_lean):
    """VBOX stores coordinates in minutes, and longitude with the opposite sign."""
    vbo, csv_data = racebox.read_vbo(rb_vbo), racebox.read_csv(rb_lean)
    for channel in ("lat", "lon"):
        for a, b in zip(vbo.columns[channel][:200], csv_data.columns[channel][:200]):
            assert a == pytest.approx(b, abs=1e-6)


def test_vbo_speed_matches_csv(rb_vbo, rb_lean):
    vbo, csv_data = racebox.read_vbo(rb_vbo), racebox.read_csv(rb_lean)
    for a, b in zip(vbo.columns["speed_kmh"][:200], csv_data.columns["speed_kmh"][:200]):
        assert a == pytest.approx(b, abs=0.01)


def test_csv_without_header_raises(tmp_path):
    bad = tmp_path / "notes.csv"
    bad.write_text("something else entirely\n1,2,3\n")
    with pytest.raises(RaceBoxError, match="no table header"):
        racebox.read_csv(bad)


def test_csv_missing_required_columns_raises(tmp_path):
    bad = tmp_path / "partial.csv"
    bad.write_text("Record,Time,Latitude\n1,2026-09-12T12:31:30.120Z,48.0\n")
    with pytest.raises(RaceBoxError, match="required Time and Speed"):
        racebox.read_csv(bad)


def test_csv_empty_table_raises(tmp_path):
    bad = tmp_path / "empty.csv"
    bad.write_text("Record,Time,Speed\n")
    with pytest.raises(RaceBoxError, match="empty"):
        racebox.read_csv(bad)


def test_bad_timestamp_raises(tmp_path):
    bad = tmp_path / "broken.csv"
    bad.write_text("Record,Time,Speed\n1,yesterday,5.0\n")
    with pytest.raises(RaceBoxError, match="timestamp"):
        racebox.read_csv(bad)


def test_vbo_without_data_section_raises(tmp_path):
    bad = tmp_path / "empty.vbo"
    bad.write_text("[header]\ntime\n")
    with pytest.raises(RaceBoxError, match=r"\[column names\]"):
        racebox.read_vbo(bad)


def _rewritten(path, tmp_path, replace_line, new_line):
    """The same VBO with one line changed, which is how another logger's file differs."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    out = tmp_path / path.name
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    out.write_text("\n".join(new_line if line.strip().startswith(replace_line) else line
                             for line in lines), encoding="utf-8")
    return out


def test_the_vbox_spelling_of_the_coordinate_columns_reads_too(rb_vbo, tmp_path):
    """RaceBox writes lat/lng; the VBOX format RaceLogic and RaceChrono follow says
    lat/long. Same numbers, different spelling."""
    theirs = _rewritten(rb_vbo, tmp_path, "time lat lng",
                        "time lat long velocity heading height LongAcc VertAcc "
                        "x-rotation-gyroscope y-rotation-gyroscope z-rotation-gyroscope "
                        "lean-angle sats")
    ours = racebox.read_vbo(rb_vbo)
    other = racebox.read_vbo(theirs)

    assert other.columns["lon"] == ours.columns["lon"]
    assert other.columns["lat"] == ours.columns["lat"]


def test_the_header_line_dates_a_vbo_when_the_comment_does_not(rb_vbo, tmp_path):
    """Only RaceBox writes 'UTC Date Started'. Every writer of the format opens with
    'File created on', so that line dates the other loggers' exports."""
    theirs = _rewritten(rb_vbo, tmp_path, "UTC Date Started", "Generated by something else")
    data = racebox.read_vbo(theirs)

    assert data.times == racebox.read_vbo(rb_vbo).times


def test_a_vbo_without_a_date_anywhere_falls_back_to_the_file(rb_vbo, tmp_path):
    """A file with neither line still reads. The date is then a guess, but not a silent
    one: the video fails to correlate and the sync panel says so."""
    stripped = _rewritten(rb_vbo, tmp_path, "UTC Date Started", "Generated by something else")
    undated = _rewritten(stripped, tmp_path / "sub", "File created on", "")
    data = racebox.read_vbo(undated)

    assert len(data) == len(racebox.read_vbo(rb_vbo))
    day = dt.datetime.fromtimestamp(data.times[0], dt.timezone.utc).date()
    assert day == dt.datetime.fromtimestamp(undated.stat().st_mtime, dt.timezone.utc).date()


# --- RaceChrono ---------------------------------------------------------------------
#
# The same format, written by another tool: no 'UTC Date Started' comment, the VBOX
# lat/long spelling, and its own names for the channels it works out rather than measures.

RC_FIRST_STAMP = utc("2026-09-12T09:59:15.120+00:00")


def test_read_racechrono_vbo(rc_vbo):
    data = racebox.read_vbo(rc_vbo)

    assert data.times[0] == pytest.approx(RC_FIRST_STAMP, abs=0.01)
    assert data.rate_hz == pytest.approx(10.0, abs=0.1)
    # Slovakia Ring, so east of Greenwich once the VBOX sign flip is undone.
    assert data.columns["lat"][0] == pytest.approx(48.055, abs=0.01)
    assert data.columns["lon"][0] == pytest.approx(17.571, abs=0.01)


def test_racechrono_channels_read_under_their_own_names(rc_vbo):
    """`longacc-calc`, `lean_angle-calc`, `x_rate_of_rotation-gyro`: the same channels
    RaceBox writes as LongAcc, lean-angle and x-rotation-gyroscope."""
    data = racebox.read_vbo(rc_vbo)

    assert {"heading_deg", "g_long", "g_lat", "lean_deg", "gyro_x"} <= set(data.columns)
    assert max(abs(v) for v in data.columns["lean_deg"]) > 5


def test_an_accelerometer_that_was_never_connected_is_not_a_channel(rc_vbo):
    """RaceChrono writes `longacc` whether or not a sensor was there. Importing a column
    of zeroes would win over deriving the channel from speed, and the render would show a
    bike that never brakes."""
    data = racebox.read_vbo(rc_vbo)

    assert any(data.columns["g_long"])
