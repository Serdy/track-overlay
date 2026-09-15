"""The track-overlay command line."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import json

from . import render as render_module
from .projects import ProjectError
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
    """Opens the editor. With no arguments it opens the project list instead of refusing.

    That is the whole point: everything the tool does - picking files, building a session,
    checking the sync - now happens in the page, so there is nothing left to do first.
    """
    if args.session is not None:
        if not args.session.exists():
            raise SessionError(f"no such file {args.session} — run build first")
        serve(args.data, session_path=args.session, port=args.port,
              open_browser=not args.no_browser)
        return 0
    serve(args.data, project=args.project, port=args.port,
          open_browser=not args.no_browser)
    return 0


def _render(args: argparse.Namespace) -> int:
    if not args.session.exists():
        raise SessionError(f"no such file {args.session} — run build first")
    if not args.layout.exists():
        raise SessionError(f"no such file {args.layout} — arrange the layout in the editor first")

    session = json.loads(args.session.read_text(encoding="utf-8"))
    layout = json.loads(args.layout.read_text(encoding="utf-8"))
    overlay = args.overlay if args.overlay and args.overlay.exists() else None
    if overlay is None:
        # The editor writes whichever container the browser managed to encode.
        overlay = next((p for p in sorted(args.session.parent.glob("overlay.*"))), None)

    prepared = render_module.prepare_clips(session, args.output.parent / "work")
    plan = render_module.build_plan(prepared, layout, overlay, args.output,
                                    duration_s=args.duration)
    print(f"rendering {plan.duration_s / 60:.1f} min from {len(plan.inputs)} input(s)"
          + ("" if overlay else ", no overlay layer"))

    last = -1.0
    def tick(done: float) -> None:
        nonlocal last
        if done - last >= 0.02 or done >= 1.0:
            last = done
            print(f"\r  {done * 100:5.1f}%", end="", flush=True)

    render_module.run(plan, on_progress=tick)
    print(f"\rwritten: {args.output}   ({args.output.stat().st_size / 1e6:.0f} MB)")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="trackoverlay",
        description="Overlay RaceBox telemetry onto GoPro video")
    sub = parser.add_subparsers(dest="command")

    build = sub.add_parser("build", help="assemble session.json from the session files")
    build.add_argument("files", nargs="+", type=Path,
                       help="RaceBox CSV and VBO, GoPro MP4 files")
    build.add_argument("-o", "--output", type=Path, default=Path("out/session.json"))
    build.add_argument("--track", default="", help="circuit name for the header")
    build.set_defaults(func=_build)

    run = sub.add_parser("serve", help="open the editor in a browser")
    run.add_argument("session", type=Path, nargs="?", default=None,
                     help="a session file to open directly; without it the project list opens")
    run.add_argument("--data", type=Path, default=Path("data"),
                     help="where projects live (default: data/)")
    run.add_argument("--project", default=None, help="open this project straight away")
    run.add_argument("-p", "--port", type=int, default=8712)
    run.add_argument("--no-browser", action="store_true")
    run.set_defaults(func=_serve)

    out = sub.add_parser("render", help="compose the finished video with ffmpeg")
    out.add_argument("session", type=Path, nargs="?", default=Path("out/session.json"))
    out.add_argument("layout", type=Path, nargs="?", default=Path("out/layout.json"))
    out.add_argument("--overlay", type=Path, default=Path("out/overlay.webm"),
                     help="the telemetry layer exported from the editor")
    out.add_argument("-o", "--output", type=Path, default=Path("out/final.mp4"))
    out.add_argument("--duration", type=float, default=None,
                     help="render only the first N seconds, for a quick check")
    out.set_defaults(func=_render)

    args = parser.parse_args(argv)
    if args.command is None:
        # `trackoverlay` on its own opens the browser, like any other desktop tool.
        args = parser.parse_args([*(argv or []), "serve"])
    try:
        return args.func(args)
    except (SessionError, ProjectError, render_module.RenderError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
