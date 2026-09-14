import datetime as dt
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
DATA = ROOT / "data"


def utc(text: str) -> float:
    """ISO-строка → секунды эпохи, для читаемых ожиданий в тестах."""
    return dt.datetime.fromisoformat(text).timestamp()


@pytest.fixture(scope="session")
def gpmd_head() -> bytes:
    """Первые 30 секундных блоков GPMF из сессии 3429."""
    return (FIXTURES / "gpmd_3429_ch1_head.bin").read_bytes()


def require_data(*names: str) -> list[Path]:
    """Пропускает тест, если исходное видео не выложено (оно не в репозитории)."""
    paths = [DATA / n for n in names]
    missing = [p.name for p in paths if not p.exists()]
    if missing:
        pytest.skip(f"нет исходных файлов: {', '.join(missing)}")
    return paths
