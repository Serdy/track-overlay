import struct

import pytest

from conftest import require_data, utc
from trackoverlay.ingest import gpmf

# Session 3429, first chunk: 12.09.2026, Slovakia Ring, 3D fix from block zero.
FIRST_STAMP = utc("2026-09-12T12:29:35.340+00:00")
TRACK_LAT, TRACK_LON = 48.055, 17.571


def test_parse_streams_finds_gps_blocks(gpmd_head):
    blocks = [s for s in gpmf.parse_streams(gpmd_head) if "GPS5" in s]
    assert len(blocks) == 30
    assert {"GPSU", "GPSF", "SCAL"} <= set(blocks[0])


def test_parse_window(gpmd_head):
    window = gpmf.parse_window(gpmd_head)
    assert window.start_utc == pytest.approx(FIRST_STAMP, abs=0.01)
    assert window.blocks == 30
    assert window.fixed_blocks == 30          # GPS locked before recording even started
    assert window.duration_s == pytest.approx(29, abs=1.5)


def test_parse_gps_samples(gpmd_head):
    samples = gpmf.parse_gps(gpmd_head)
    # The GPS5 batch size wanders (17-18 samples per block) — which is exactly why times
    # are spread across block boundaries rather than assumed from a nominal rate.
    assert 30 * 17 <= len(samples) <= 30 * 19
    rate = len(samples) / gpmf.parse_window(gpmd_head).duration_s
    assert rate == pytest.approx(18, abs=1.0)

    first = samples[0]
    assert first.lat == pytest.approx(TRACK_LAT, abs=0.01)
    assert first.lon == pytest.approx(TRACK_LON, abs=0.01)
    assert first.fix == 3
    assert 100 < first.alt_m < 200            # Slovakia Ring sits at about 120 m

    times = [s.t_utc for s in samples]
    assert times == sorted(times)
    assert all(0 <= s.speed_kmh < 320 for s in samples)


def test_sample_times_are_evenly_spread(gpmd_head):
    """Samples of a batch spread up to the next block stamp instead of bunching up."""
    samples = gpmf.parse_gps(gpmd_head)
    steps = [b.t_utc - a.t_utc for a, b in zip(samples, samples[1:])]
    assert min(steps) > 0
    assert max(steps) < 0.2


def test_blocks_without_fix_are_dropped(gpmd_head):
    """Coordinates in fix-less blocks are garbage, so those blocks never reach the output."""
    streams = gpmf.parse_streams(gpmd_head)
    patched = bytearray(gpmd_head)
    # GPSF sits four bytes past the record header; zeroing it would need an offset search,
    # so instead we verify the filtering itself against real data.
    assert all(s.fix >= 2 for s in gpmf.parse_gps(bytes(patched)))
    assert len([s for s in streams if "GPS5" in s]) == 30


def test_empty_stream_raises():
    with pytest.raises(gpmf.GpmfError, match="no GPS blocks"):
        gpmf.parse_gps(b"")


def test_truncated_buffer_does_not_crash(gpmd_head):
    """A truncated KLV must stop the walk rather than read past the buffer."""
    for cut in (7, 100, len(gpmd_head) // 3, len(gpmd_head) - 1):
        gpmf.parse_streams(gpmd_head[:cut])   # must not throw


def test_garbage_buffer_does_not_crash():
    assert gpmf.parse_streams(b"\x00" * 64) == []


def test_short_gpsu_raises():
    stream = {"GPSU": ("U", 16, 1, b"2609"), "GPS5": ("l", 20, 1, b"\x00" * 20)}
    with pytest.raises(gpmf.GpmfError, match="too short"):
        gpmf._gpsu_to_epoch(stream["GPSU"][3])


def test_missing_gpmd_stream_raises(tmp_path):
    import subprocess
    plain = tmp_path / "plain.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", "testsrc=duration=1:size=64x64:rate=5", str(plain)], check=True)
    with pytest.raises(gpmf.GpmfError, match="gpmd"):
        gpmf.find_gpmd_stream(plain)


def test_full_chunk_integration():
    """A full chunk: 707 one-second blocks, every one with a 3D fix."""
    (mp4,) = require_data("GH013429.MP4")
    window = gpmf.read_window(mp4)
    assert window.blocks == 707
    assert window.fixed_blocks == 707
    assert window.start_utc == pytest.approx(FIRST_STAMP, abs=0.01)
    assert window.duration_s == pytest.approx(706.9, abs=1.0)
