"""Командная строка track-overlay."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .session import SessionError, build_session


def _build(args: argparse.Namespace) -> int:
    telemetry = [p for p in args.files if p.suffix.lower() in (".csv", ".vbo")]
    videos = [p for p in args.files if p.suffix.lower() in (".mp4", ".mov")]

    session = build_session(telemetry, videos, track=args.track)
    session.write(args.output)

    best = min((lap.duration_s for lap in session.laps), default=0.0)
    print(f"сессия: {session.telemetry.rate_hz:.1f} Гц, "
          f"{len(session.telemetry.times)} сэмплов, {len(session.laps)} кругов, "
          f"лучший {best // 60:.0f}:{best % 60:06.3f}")
    for clip in session.clips:
        mark = "✓" if clip["sync"]["reliable"] else "!"
        print(f"  {mark} {clip['id']}: старт {clip['offset_s']:+.2f} с, "
              f"{clip['duration_s'] / 60:.1f} мин, "
              f"сведение {clip['sync']['method']} "
              f"(корр {clip['sync']['correlation']:.4f})")
    print(f"записано: {args.output}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="trackoverlay",
        description="Наложение телеметрии RaceBox на видео GoPro")
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="собрать session.json из файлов сессии")
    build.add_argument("files", nargs="+", type=Path,
                       help="CSV и VBO от RaceBox, файлы MP4 от GoPro")
    build.add_argument("-o", "--output", type=Path, default=Path("out/session.json"))
    build.add_argument("--track", default="", help="название трассы для заголовка")
    build.set_defaults(func=_build)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except SessionError as err:
        print(f"ошибка: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
