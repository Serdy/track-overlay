"""The track-overlay command line."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .server import serve
from .session import SessionError, build_session


def _build(args: argparse.Namespace) -> int:
    telemetry = [p for p in args.files if p.suffix.lower() in (".csv", ".vbo")]
    videos = [p for p in args.files if p.suffix.lower() in (".mp4", ".mov")]

    session = build_session(telemetry, videos, track=args.track)
    session.write(args.output)

    best = min((lap.duration_s for lap in session.laps), default=0.0)
    print(f"session: {session.telemetry.rate_hz:.1f} Hz, "
          f"{len(session.telemetry.times)} samples, {len(session.laps)} laps, "
          f"best {best // 60:.0f}:{best % 60:06.3f}")
    for clip in session.clips:
        mark = "✓" if clip["sync"]["reliable"] else "!"
        print(f"  {mark} {clip['id']}: starts {clip['offset_s']:+.2f} s, "
              f"{clip['duration_s'] / 60:.1f} min, "
              f"sync {clip['sync']['method']} "
              f"(corr {clip['sync']['correlation']:.4f})")
    print(f"written: {args.output}")
    return 0


def _serve(args: argparse.Namespace) -> int:
    if not args.session.exists():
        raise SessionError(f"no such file {args.session} — run build first")
    serve(args.session, port=args.port, open_browser=not args.no_browser)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="trackoverlay",
        description="Overlay RaceBox telemetry onto GoPro video")
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="assemble session.json from the session files")
    build.add_argument("files", nargs="+", type=Path,
                       help="RaceBox CSV and VBO, GoPro MP4 files")
    build.add_argument("-o", "--output", type=Path, default=Path("out/session.json"))
    build.add_argument("--track", default="", help="circuit name for the header")
    build.set_defaults(func=_build)

    run = sub.add_parser("serve", help="open the editor in a browser")
    run.add_argument("session", type=Path, nargs="?", default=Path("out/session.json"))
    run.add_argument("-p", "--port", type=int, default=8712)
    run.add_argument("--no-browser", action="store_true")
    run.set_defaults(func=_serve)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except SessionError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
