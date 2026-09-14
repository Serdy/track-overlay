#!/usr/bin/env python3
"""Shows the real GoPro recording time and repairs file dates.

The GoPro clock drifts, and files then carry a meaningless date (ours read 25.01.2016).
Satellite time inside the GPMF stream does not suffer from that, so the date can always
be recovered from the file itself.

    uv run python tools/gopro_dates.py data/*.MP4            # show only
    uv run python tools/gopro_dates.py --apply data/*.MP4    # also write the dates
"""

import argparse
import datetime as dt
import subprocess
import zoneinfo
from pathlib import Path

from trackoverlay.ingest import gpmf

TZ = zoneinfo.ZoneInfo("Europe/Warsaw")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--apply", action="store_true", help="write the dates onto the files")
    args = ap.parse_args()

    for path in sorted(args.files):
        try:
            raw = gpmf.extract_gpmd(path)
            window = gpmf.parse_window(raw)
            samples = gpmf.parse_gps(raw) if window.fixed_blocks else []
        except gpmf.GpmfError as err:
            print(f"{path.name}: {err}")
            continue

        local = dt.datetime.fromtimestamp(window.start_utc, TZ)
        where = (f"{samples[0].lat:.5f},{samples[0].lon:.5f}" if samples
                 else "no fix in any block")
        print(f"{path.name}  {local:%d.%m.%Y %H:%M:%S} {local:%Z}  "
              f"{window.duration_s/60:5.1f}min  "
              f"fix {window.fixed_blocks}/{window.blocks}  {where}")

        if args.apply:
            subprocess.run(["touch", "-t", local.strftime("%Y%m%d%H%M.%S"), str(path)],
                           check=True)
            subprocess.run(["SetFile", "-d", local.strftime("%m/%d/%Y %H:%M:%S"), str(path)],
                           check=True)


if __name__ == "__main__":
    main()
