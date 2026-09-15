import datetime as dt
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
# The sample project: telemetry is committed, the video that goes with it is not.
DATA = ROOT / "data" / "slovakia-ring-2026-09-12"


def utc(text: str) -> float:
    """ISO string to epoch seconds, so expectations in tests stay readable."""
    return dt.datetime.fromisoformat(text).timestamp()


@pytest.fixture(scope="session")
def gpmd_head() -> bytes:
    """The first 30 one-second GPMF blocks from session 3429."""
    return (FIXTURES / "gpmd_3429_ch1_head.bin").read_bytes()


def require_data(*names: str) -> list[Path]:
    """Skips the test when the source video is absent (it is not in the repository)."""
    paths = [DATA / n for n in names]
    missing = [p.name for p in paths if not p.exists()]
    if missing:
        pytest.skip(f"missing source files: {', '.join(missing)}")
    return paths


@pytest.fixture(scope="session")
def rb_lean() -> Path:
    """A RaceBox export with Bike Mode: has LeanAngle, no lateral G."""
    return FIXTURES / "racebox_lean_head.csv"


@pytest.fixture(scope="session")
def rb_cornering() -> Path:
    """The same session without Bike Mode: has GForceY, no lean angle."""
    return FIXTURES / "racebox_cornering_head.csv"


@pytest.fixture(scope="session")
def rb_vbo() -> Path:
    return FIXTURES / "racebox_head.vbo"
