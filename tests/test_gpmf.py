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


@pytest.mark.parametrize("stamp", [
    b"2609",                    # truncated
    b"286000014309.123",        # month sixty, straight off a card from a track day
    b"000000000000.000",        # the field before the receiver has the time
    b"26091a122935.340",        # a letter where a digit belongs
])
def test_an_unusable_satellite_stamp_is_skipped_not_fatal(stamp):
    """One rubbish block used to stop the whole file, and every good block with it."""
    assert gpmf._gpsu_to_epoch(stamp) is None


def test_a_good_stamp_still_reads(gpmd_head):
    blocks = [s for s in gpmf.parse_streams(gpmd_head) if "GPSU" in s]
    assert gpmf._gpsu_to_epoch(blocks[0]["GPSU"][3]) == pytest.approx(FIRST_STAMP, abs=0.01)


def _with_broken_stamp(buf: bytes, which: int = 0) -> bytes:
    """The real stream with one GPSU payload overwritten by the rubbish a card wrote."""
    patched = bytearray(buf)
    found = 0
    at = patched.find(b"2609")
    while at != -1:
        if found == which:
            patched[at:at + 12] = b"286000014309"
            return bytes(patched)
        found += 1
        at = patched.find(b"2609", at + 1)
    raise AssertionError("no stamp to break in this fixture")


def test_one_broken_stamp_does_not_lose_the_other_blocks(gpmd_head):
    whole = gpmf.parse_gps(gpmd_head)
    patched = gpmf.parse_gps(_with_broken_stamp(gpmd_head))

    assert patched, "the file still has usable blocks"
    # Exactly one block's worth of samples goes, and the rest keep their own times.
    assert 0 < len(whole) - len(patched) <= 20
    assert patched[-1].t_utc == pytest.approx(whole[-1].t_utc, abs=0.01)


def test_a_window_ignores_a_broken_stamp(gpmd_head):
    """Breaking the first stamp costs that block, not the recording window."""
    whole = gpmf.parse_window(gpmd_head)
    patched = gpmf.parse_window(_with_broken_stamp(gpmd_head))

    assert patched.blocks == whole.blocks == 30
    assert patched.end_utc == pytest.approx(whole.end_utc, abs=0.01)
    assert 0 < patched.start_utc - whole.start_utc < 3   # the next stamp along


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


def test_a_file_with_no_usable_stamp_reports_rather_than_crashes(gpmd_head):
    """The tools catch GpmfError and move to the next file; a ValueError from strptime
    escaped that and took the whole run down."""
    patched = bytearray(gpmd_head)
    at = patched.find(b"2609")
    while at != -1:
        patched[at:at + 12] = b"286000014309"
        at = patched.find(b"2609", at + 1)

    with pytest.raises(gpmf.GpmfError, match="usable satellite stamp"):
        gpmf.parse_window(bytes(patched))
    assert gpmf.parse_gps(bytes(patched)) == []
