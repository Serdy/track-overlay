from pathlib import Path

import pytest

from conftest import require_data
from trackoverlay.ingest import clips
from trackoverlay.ingest.clips import Chunk, Clip, ClipError


def chunk(index: int, *, start: float | None = None, end: float | None = None,
          duration: float = 700.0, name: str | None = None) -> Chunk:
    """A chunk with no file on disk — joint checking is a pure function."""
    return Chunk(Path(name or f"GH{index:02d}3429.MP4"), index, duration, start, end, None)


@pytest.mark.parametrize("name, expected", [
    ("GH013429.MP4", (1, "3429")),
    ("GH023429.MP4", (2, "3429")),
    ("GX113429.MP4", (11, "3429")),
    ("GP029999.MP4", (2, "9999")),
    ("GOPR1234.MP4", (1, "1234")),
    ("gh013429.mp4", (1, "3429")),
])
def test_parse_name(name, expected):
    assert clips.parse_name(Path(name)) == expected


@pytest.mark.parametrize("name", ["random.mp4", "IMG_0001.MP4", "GH13429.MP4", "GH01342.MP4"])
def test_parse_name_rejects_foreign(name):
    assert clips.parse_name(Path(name)) is None


def test_find_proxy(tmp_path):
    video = tmp_path / "GH013429.MP4"
    video.touch()
    assert clips.find_proxy(video) is None
    (tmp_path / "GL013429.LRV").touch()
    assert clips.find_proxy(video).name == "GL013429.LRV"


def test_joints_accept_one_gpsu_interval():
    """GPSU stamps arrive once a second, so a gap of about a second at a joint is normal."""
    clips._check_joints([chunk(1, start=100.0, end=800.0),
                         chunk(2, start=800.99, end=1500.0)])


def test_joints_reject_missing_chunk():
    with pytest.raises(ClipError, match="missing chunk"):
        clips._check_joints([chunk(1, start=100.0, end=800.0),
                             chunk(3, start=800.99, end=1500.0)])


def test_joints_reject_large_gap():
    """A large gap means the chunks belong to different recordings."""
    with pytest.raises(ClipError, match="gap of"):
        clips._check_joints([chunk(1, start=100.0, end=800.0),
                             chunk(2, start=1400.0, end=2100.0)])


def test_joints_reject_overlap():
    with pytest.raises(ClipError, match="gap of"):
        clips._check_joints([chunk(1, start=100.0, end=800.0),
                             chunk(2, start=750.0, end=1500.0)])


def test_joints_skip_check_without_gps():
    """A recording without a fix has no satellite time — nothing to check, but no reason to fail."""
    clips._check_joints([chunk(1), chunk(2)])


def test_clip_aggregates_chunks():
    clip = Clip("3429", [chunk(1, duration=707.7), chunk(2, duration=691.3),
                         chunk(3, duration=318.0)])
    assert clip.duration_s == pytest.approx(1717.0)
    assert len(clip.files) == 3
    assert clip.has_gps is False
    assert clip.proxies() is None


def test_write_concat_file(tmp_path):
    clip = Clip("3429", [chunk(1, name=str(tmp_path / "GH013429.MP4")),
                         chunk(2, name=str(tmp_path / "GH023429.MP4"))])
    dst = clips.write_concat_file(clip, tmp_path / "list.txt")
    lines = dst.read_text().splitlines()
    assert len(lines) == 2
    assert all(line.startswith("file '/") for line in lines)   # paths are absolute


def test_write_concat_file_without_proxies_raises(tmp_path):
    clip = Clip("3429", [chunk(1)])
    with pytest.raises(ClipError, match="proxy"):
        clips.write_concat_file(clip, tmp_path / "list.txt", proxy=True)


def test_discover_rejects_duplicate_chunk(tmp_path):
    a, b = tmp_path / "GH013429.MP4", tmp_path / "sub" / "GH013429.MP4"
    b.parent.mkdir()
    for p in (a, b):
        p.touch()
    with pytest.raises(ClipError, match="twice"):
        clips.discover([a, b])


def test_discover_rejects_foreign_name(tmp_path):
    stray = tmp_path / "holiday.mp4"
    stray.touch()
    with pytest.raises(ClipError, match="does not look like a GoPro file"):
        clips.discover([stray])


def test_discover_real_sessions():
    """Three real recordings: 3429 and 3431 with GPS, 3430 with no fix at all."""
    paths = require_data("GH013429.MP4", "GH023429.MP4", "GH033429.MP4",
                         "GH013430.MP4", "GH023430.MP4",
                         "GH013431.MP4", "GH023431.MP4")
    found = {c.id: c for c in clips.discover(paths)}
    assert set(found) == {"3429", "3430", "3431"}

    assert len(found["3429"].chunks) == 3
    assert found["3429"].duration_s == pytest.approx(1733.7, abs=1.0)
    assert found["3429"].has_gps

    assert not found["3430"].has_gps          # GPS never caught a single fix
    assert found["3430"].duration_s == pytest.approx(1341.6, abs=1.0)
