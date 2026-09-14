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
    # Bike Mode отдаёт угол наклона вместо бокового ускорения.
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
    with pytest.raises(RaceBoxError, match="разные сессии"):
        racebox.merge(short, trimmed)


def test_merge_rejects_time_skew(rb_lean, rb_cornering):
    base = racebox.read_csv(rb_lean)
    shifted = racebox.read_csv(rb_cornering)
    shifted = racebox.RaceBoxData([t + 1.0 for t in shifted.times],
                                  shifted.columns, shifted.source)
    with pytest.raises(RaceBoxError, match="расхождение меток"):
        racebox.merge(base, shifted)


def test_merge_without_arguments_raises():
    with pytest.raises(RaceBoxError, match="нечего объединять"):
        racebox.merge()


def test_read_vbo(rb_vbo):
    data = racebox.read_vbo(rb_vbo)
    assert len(data) == 2000
    assert data.times[0] == pytest.approx(FIRST_STAMP, abs=0.01)
    assert "heading_deg" in data          # ради этой колонки VBO и нужен
    assert 0 <= data.columns["heading_deg"][0] <= 360


def test_vbo_coordinates_match_csv(rb_vbo, rb_lean):
    """VBOX хранит координаты в минутах, а долготу с обратным знаком."""
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
    bad.write_text("что-то совсем другое\n1,2,3\n")
    with pytest.raises(RaceBoxError, match="не найден заголовок"):
        racebox.read_csv(bad)


def test_csv_missing_required_columns_raises(tmp_path):
    bad = tmp_path / "partial.csv"
    bad.write_text("Record,Time,Latitude\n1,2026-09-12T12:31:30.120Z,48.0\n")
    with pytest.raises(RaceBoxError, match="обязательных колонок"):
        racebox.read_csv(bad)


def test_csv_empty_table_raises(tmp_path):
    bad = tmp_path / "empty.csv"
    bad.write_text("Record,Time,Speed\n")
    with pytest.raises(RaceBoxError, match="пуста"):
        racebox.read_csv(bad)


def test_bad_timestamp_raises(tmp_path):
    bad = tmp_path / "broken.csv"
    bad.write_text("Record,Time,Speed\n1,вчера,5.0\n")
    with pytest.raises(RaceBoxError, match="метка времени"):
        racebox.read_csv(bad)


def test_vbo_without_data_section_raises(tmp_path):
    bad = tmp_path / "empty.vbo"
    bad.write_text("[header]\ntime\n")
    with pytest.raises(RaceBoxError, match=r"\[column names\]"):
        racebox.read_vbo(bad)
