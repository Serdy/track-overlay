#!/usr/bin/env python3
"""Показывает, как сводятся видео GoPro и телеметрия RaceBox.

Диагностический скрипт: считает поправку синхронизации для каждой записи и проверяет,
не плывёт ли она по ходу сессии.

    uv run python tools/sync_check.py data/*.csv data/GH*.MP4
"""

import argparse
import datetime as dt
from pathlib import Path

import numpy as np

from trackoverlay import sync
from trackoverlay.ingest import clips, gpmf, racebox

WINDOWS = 8


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", type=Path)
    args = ap.parse_args()

    csvs = [p for p in args.files if p.suffix.lower() == ".csv"]
    videos = [p for p in args.files if p.suffix.lower() == ".mp4"]
    if not csvs or not videos:
        raise SystemExit("нужен хотя бы один CSV RaceBox и одно видео")

    telemetry = racebox.merge(*(racebox.read_csv(p) for p in csvs))
    speeds = telemetry.columns["speed_kmh"]
    start = telemetry.times[0]
    print(f"телеметрия: {len(telemetry)} строк, {telemetry.rate_hz:.1f} Гц, "
          f"старт {dt.datetime.fromtimestamp(start, dt.timezone.utc):%d.%m %H:%M:%S} UTC\n")

    for clip in clips.discover(videos):
        samples = []
        for path in clip.files:
            try:
                samples += gpmf.read_gps(path)
            except gpmf.GpmfError:
                pass
        result = sync.align([s.t_utc for s in samples], [s.speed_kmh for s in samples],
                            telemetry.times, speeds, session_start_utc=start)
        print(f"запись {clip.id}: метод {result.method:6} поправка {result.correction_s:+6.2f}с "
              f"корр {result.correlation:.4f} перекрытие {result.overlap_s/60:5.1f}мин "
              f"старт {result.offset_s:+9.2f}с")

        if result.method != "xcorr" or not samples:
            continue

        # Постоянна ли поправка? Дрейф часов выдал бы себя разбросом по окнам.
        video_t = np.array([s.t_utc for s in samples])
        video_v = np.array([s.speed_kmh for s in samples])
        lo, hi = max(video_t[0], start), min(video_t[-1], telemetry.times[-1])
        edges = np.linspace(lo, hi, WINDOWS + 1)
        lags = []
        for a, b in zip(edges, edges[1:]):
            mask = (video_t >= a) & (video_t <= b)
            try:
                shift, score, _ = sync.cross_correlate(
                    video_t[mask].tolist(), video_v[mask].tolist(),
                    telemetry.times, speeds, max_lag_s=5.0)
                lags.append(shift)
            except sync.SyncError:
                pass
        if lags:
            print(f"    по {len(lags)} окнам: разброс {max(lags)-min(lags):.2f}с "
                  f"(дрейфа нет, если меньше 0.1с)")


if __name__ == "__main__":
    main()
