import math

import numpy as np
import pytest

from conftest import DATA, require_data
from trackoverlay import sync
from trackoverlay.sync import SyncError


def make_profile(duration: float = 800.0, seed: int = 42):
    """A non-periodic speed profile as a function of time.

    A periodic signal (a sum of sines) is no good for testing correlation: it has several
    equally good peaks and the correlator legitimately picks the wrong one. A smoothed
    random walk gives one sharp peak and happens to look like a real trace as well.
    """
    rng = np.random.default_rng(seed)
    grid = np.arange(0.0, duration, 0.04)
    walk = np.cumsum(rng.normal(0.0, 1.0, len(grid)))
    smooth = np.convolve(walk, np.ones(51) / 51, mode="same")
    speeds = 120 + 50 * (smooth - smooth.mean()) / smooth.std()
    return lambda query: np.interp(np.asarray(query, float), grid, speeds)


SPEED = make_profile()


def lap_profile(times, *, delay: float = 0.0):
    return SPEED(np.asarray(times, float) - delay).tolist()


@pytest.fixture
def grid():
    return np.arange(0.0, 600.0, 0.04).tolist()      # 10 minutes at 25 Hz


def test_recovers_known_shift(grid):
    """A series delayed by 3 s must be recognised as delayed by exactly 3 s."""
    shift, score, overlap = sync.cross_correlate(
        grid, lap_profile(grid, delay=3.0), grid, lap_profile(grid))
    assert shift == pytest.approx(3.0, abs=0.02)
    assert score > 0.99
    assert overlap == pytest.approx(600.0, abs=1.0)


def test_recovers_negative_shift(grid):
    shift, _, _ = sync.cross_correlate(
        grid, lap_profile(grid, delay=-2.5), grid, lap_profile(grid))
    assert shift == pytest.approx(-2.5, abs=0.02)


def test_subsample_precision_beats_grid_step(grid):
    """A 1.234 s offset is not a multiple of the 0.1 s grid — only the parabola finds it."""
    shift, _, _ = sync.cross_correlate(
        grid, lap_profile(grid, delay=1.234), grid, lap_profile(grid))
    assert shift == pytest.approx(1.234, abs=0.02)
    assert abs(shift - round(shift, 1)) > 0.005      # the result did not land on a grid node


def test_zero_shift(grid):
    shift, score, _ = sync.cross_correlate(
        grid, lap_profile(grid), grid, lap_profile(grid))
    assert shift == pytest.approx(0.0, abs=0.01)
    assert score == pytest.approx(1.0, abs=1e-6)


def test_short_overlap_raises(grid):
    short = [t + 590.0 for t in grid[:500]]
    with pytest.raises(SyncError, match="overlap"):
        sync.cross_correlate(short, lap_profile(short), grid, lap_profile(grid))


def test_constant_series_raises(grid):
    with pytest.raises(SyncError, match="constant"):
        sync.cross_correlate(grid, [50.0] * len(grid), grid, lap_profile(grid))


@pytest.mark.parametrize("scores, expected", [
    (np.array([0.0, 1.0, 0.0]), 0.0),            # symmetric peak — nothing to refine
    (np.array([0.5, 1.0, 0.0]), -1 / 6),         # left neighbour higher — peak left of the node
    (np.array([0.0, 1.0, 0.5]), +1 / 6),         # right neighbour higher — peak right of the node
    (np.array([1.0, 1.0, 1.0]), 0.0),            # a plateau, zero denominator
])
def test_refine_peak(scores, expected):
    assert sync._refine_peak(scores, 1) == pytest.approx(expected, abs=0.01)


def test_refine_peak_at_boundary():
    scores = np.array([1.0, 0.5, 0.0])
    assert sync._refine_peak(scores, 0) == 0.0
    assert sync._refine_peak(scores, 2) == 0.0


def test_align_uses_utc_as_base(grid):
    """The video started 100 s before the telemetry but shows the same thing.

    Both series reflect one physical event, so the correction must come out zero and the
    video offset on the session axis must equal the difference between the starts.
    """
    video_t = [1000.0 + t for t in grid]
    tel_t = [1100.0 + t for t in grid]
    result = sync.align(video_t, SPEED(np.array(video_t) - 1000.0).tolist(),
                        tel_t, SPEED(np.array(tel_t) - 1000.0).tolist(),
                        session_start_utc=tel_t[0])
    assert result.method == "xcorr"
    assert result.correction_s == pytest.approx(0.0, abs=0.02)
    assert result.offset_s == pytest.approx(-100.0, abs=0.05)


def test_align_corrects_delayed_video(grid):
    """The video lags by 1.4 s — the same amount measured on the real session."""
    video_t = [1000.0 + t for t in grid]
    tel_t = [1100.0 + t for t in grid]
    result = sync.align(video_t, SPEED(np.array(video_t) - 1000.0 - 1.4).tolist(),
                        tel_t, SPEED(np.array(tel_t) - 1000.0).tolist(),
                        session_start_utc=tel_t[0])
    assert result.correction_s == pytest.approx(-1.4, abs=0.03)
    assert result.offset_s == pytest.approx(-101.4, abs=0.05)


def test_align_falls_back_to_manual_without_motion(grid):
    """Video without a GPS fix: nothing to correlate, but failing is not allowed."""
    result = sync.align([], [], grid, lap_profile(grid), session_start_utc=0.0)
    assert result.method == "manual"
    assert result.reliable is False


def test_align_falls_back_to_utc_without_overlap(grid):
    """Footage from different days: UTC has an answer, correlation does not."""
    far = [t + 86400.0 for t in grid]
    result = sync.align(far, lap_profile(grid), grid, lap_profile(grid),
                        session_start_utc=grid[0])
    assert result.method == "utc"
    assert result.offset_s == pytest.approx(86400.0, abs=1.0)


def test_align_applies_manual_correction(grid):
    result = sync.align([], [], grid, lap_profile(grid),
                        session_start_utc=0.0, manual_s=2.5)
    assert result.offset_s == pytest.approx(2.5)


def test_real_session_3429():
    """Real alignment: the video starts 116 s before the telemetry."""
    from trackoverlay.ingest import clips, gpmf, racebox

    files = require_data("GH013429.MP4", "GH023429.MP4", "GH033429.MP4")
    csv = DATA / "RaceBox Track Session on 12-09-2026 14-31_lean.csv"
    if not csv.exists():
        pytest.skip("no RaceBox export")

    rb = racebox.read_csv(csv)
    samples = [s for f in files for s in gpmf.read_gps(f)]
    result = sync.align([s.t_utc for s in samples], [s.speed_kmh for s in samples],
                        rb.times, rb.columns["speed_kmh"],
                        session_start_utc=rb.times[0])

    assert result.method == "xcorr"
    assert result.reliable
    assert result.correlation > 0.99
    # Measured during reconnaissance, before implementation: the peak sat between 1.30 and 1.40 s.
    assert -1.45 < result.correction_s < -1.25
    assert result.offset_s == pytest.approx(-116.1, abs=0.5)
    assert result.overlap_s == pytest.approx(26.9 * 60, abs=30)


def test_robust_offset_ignores_a_bad_stretch(grid):
    """One bad window must not drag the whole estimate.

    Real case: on session 3429 the second camera reads +2.51 s over the first window,
    where the bike pulls away on a freshly acquired fix, against a steady +1.40 s after.
    A single global correlation came out at +1.48 s — five frames at 60 fps off.
    """
    tel_t = [1000.0 + t for t in grid]
    tel_v = SPEED(np.array(tel_t) - 1000.0)

    # The video lags by a steady 1.4 s, except for the first eighth where the speed is
    # shifted much further, standing in for an unsettled GPS fix.
    video_t = np.array(tel_t)
    video_v = SPEED(video_t - 1000.0 - 1.4)
    spoiled = slice(0, len(video_t) // 8)
    video_v[spoiled] = SPEED(video_t[spoiled] - 1000.0 - 4.0)

    naive, _, _ = sync.cross_correlate(video_t.tolist(), video_v.tolist(), tel_t, tel_v.tolist())
    robust, _, _ = sync.robust_offset(video_t.tolist(), video_v.tolist(), tel_t, tel_v.tolist())

    assert robust == pytest.approx(1.4, abs=0.05)
    assert abs(robust - 1.4) < abs(naive - 1.4)     # the median is closer to the truth


def test_robust_offset_matches_plain_correlation_on_clean_data(grid):
    tel_t = [1000.0 + t for t in grid]
    tel_v = SPEED(np.array(tel_t) - 1000.0).tolist()
    video_v = SPEED(np.array(tel_t) - 1000.0 - 1.4).tolist()

    plain, _, _ = sync.cross_correlate(tel_t, video_v, tel_t, tel_v)
    robust, _, _ = sync.robust_offset(tel_t, video_v, tel_t, tel_v)
    assert robust == pytest.approx(plain, abs=0.05)


def test_robust_offset_falls_back_on_short_overlap():
    """Too short to split into windows — fall back to one global correlation."""
    short = np.arange(0.0, 100.0, 0.04).tolist()
    values = SPEED(np.array(short)).tolist()
    delayed = SPEED(np.array(short) - 1.0).tolist()
    offset, score, overlap = sync.robust_offset(short, delayed, short, values)
    assert offset == pytest.approx(1.0, abs=0.05)
    assert overlap == pytest.approx(100.0, abs=1.0)


def test_both_cameras_of_session_3429_agree():
    """Two cameras started a second apart must land a second apart on the session axis."""
    from trackoverlay.ingest import gpmf, racebox

    csv = DATA / "RaceBox Track Session on 12-09-2026 14-31_lean.csv"
    first, second = DATA / "GH013429.MP4", DATA / "GH013446.MP4"
    if not (csv.exists() and first.exists() and second.exists()):
        pytest.skip("the second camera footage is not available")

    rb = racebox.read_csv(csv)
    offsets = []
    for path in (first, second):
        samples = gpmf.read_gps(path)
        result = sync.align([s.t_utc for s in samples], [s.speed_kmh for s in samples],
                            rb.times, rb.columns["speed_kmh"],
                            session_start_utc=rb.times[0])
        assert result.method == "xcorr"
        assert result.correlation > 0.99
        offsets.append(result.offset_s)

    # GPSU puts the starts one second apart, so the session offsets must differ by about
    # the same — this is the check that both cameras land on one timeline.
    assert abs(abs(offsets[0] - offsets[1]) - 1.0) < 0.3
