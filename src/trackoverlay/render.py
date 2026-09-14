"""Building the ffmpeg command that composes the finished video.

One trick keeps this simple. There is no attempt to "switch the main camera": instead the
base is a black frame of the output size, and **every "camera + time window + slot" triple
becomes an identical overlay filter**. Cutting between angles and picture-in-picture stop
being different features — they are the same operation with different rectangles, and the
graph generator is an ordinary loop.

The overlay layer goes on last, over everything. It arrives from the browser already
rendered, which is why nothing here draws: this module only cuts, scales and encodes.
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

VIDEO_CODEC = "h264_videotoolbox"    # hardware encoder on macOS
AUDIO_CODEC = "aac"
DEFAULT_BITRATE = "40M"
PROGRESS = re.compile(r"out_time_ms=(\d+)")


class RenderError(Exception):
    """The layout cannot be turned into a render."""


@dataclass
class Plan:
    """Everything ffmpeg needs, ready to inspect before anything is launched."""
    args: list[str]
    duration_s: float
    inputs: list[str] = field(default_factory=list)

    @property
    def command(self) -> str:
        return " ".join(shlex.quote(a) for a in self.args)


def _slot_rects(layout: dict) -> dict[str, list[float]]:
    rects = {slot["id"]: slot["rect"] for slot in layout.get("slots", [])}
    if "main" not in rects:
        rects["main"] = [0.0, 0.0, 1.0, 1.0]
    return rects


def _windows(layout: dict, duration: float) -> list[dict]:
    """Expands the sparse cut list into explicit slot occupancies.

    Mirrors ``Cuts.windows`` in the browser: the same sparse list has to produce the same
    spans on both sides, or the render stops matching the preview.
    """
    cuts = sorted(layout.get("cuts", []), key=lambda c: c["t"])
    if not cuts:
        raise RenderError("the layout holds no camera arrangement")

    # Drop entries that change nothing, so the graph does not grow useless nodes.
    trimmed: list[dict] = []
    for cut in cuts:
        last = trimmed[-1] if trimmed else None
        if last and last.get("main") == cut.get("main") and last.get("pip") == cut.get("pip"):
            continue
        trimmed.append(cut)

    spans = []
    for i, cut in enumerate(trimmed):
        start = max(0.0, float(cut["t"]))
        end = float(trimmed[i + 1]["t"]) if i + 1 < len(trimmed) else duration
        # Rendering a shorter piece than the session must not emit windows past its end,
        # or ffmpeg builds nodes that can never fire.
        end = min(end, duration)
        if end - start <= 1e-6:
            continue
        for slot in ("main", "pip"):
            clip_id = cut.get(slot)
            if clip_id:
                spans.append({"slot": slot, "clip": clip_id, "from": start, "to": end})
    if not spans:
        raise RenderError("no camera occupies any slot")
    return spans


def _even(value: float) -> int:
    """Rounds to an even number of pixels — h264 refuses odd dimensions."""
    return max(2, int(round(value / 2)) * 2)


def build_plan(session: dict, layout: dict, overlay: Path | None, output: Path,
               *, bitrate: str = DEFAULT_BITRATE, duration_s: float | None = None) -> Plan:
    """Assembles the ffmpeg argument list without running anything."""
    out = layout.get("output", {})
    width, height = _even(out.get("width", 1920)), _even(out.get("height", 1080))
    fps = out.get("fps", 60)
    total = duration_s if duration_s is not None else session["session"]["duration_s"]

    clips = {clip["id"]: clip for clip in session.get("clips", [])}
    rects = _slot_rects(layout)
    spans = _windows(layout, total)

    used = sorted({span["clip"] for span in spans})
    missing = [clip_id for clip_id in used if clip_id not in clips]
    if missing:
        raise RenderError(f"the layout refers to clips absent from the session: {missing}")

    args = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1"]
    # The base: a black frame the whole thing is composed onto.
    args += ["-f", "lavfi", "-t", f"{total:.3f}", "-i", f"color=c=black:s={width}x{height}:r={fps}"]

    index = {}
    inputs = []
    for clip_id in used:
        clip = clips[clip_id]
        files = clip["files"]
        # A clip split into chunks is joined by the concat demuxer, which needs a list
        # file; a single file is passed straight through.
        source = files[0] if len(files) == 1 else clip.get("_concat")
        if source is None:
            raise RenderError(f"clip {clip_id} has several chunks but no concat list")
        if len(files) > 1:
            args += ["-f", "concat", "-safe", "0"]
        # The clip starts before or after the session zero; -itsoffset shifts its timeline
        # so that the sync correction is applied by ffmpeg rather than by seeking.
        args += ["-itsoffset", f"{clip['offset_s']:.3f}", "-i", str(source)]
        index[clip_id] = len(index) + 1
        inputs.append(str(source))

    overlay_index = None
    if overlay is not None:
        args += ["-i", str(overlay)]
        overlay_index = len(index) + 1
        inputs.append(str(overlay))

    steps = []
    label = "[0:v]"
    for n, span in enumerate(spans):
        x, y, w, h = rects.get(span["slot"], rects["main"])
        box_w, box_h = _even(w * width), _even(h * height)
        src = f"v{n}"
        steps.append(
            f"[{index[span['clip']]}:v]scale={box_w}:{box_h}:force_original_aspect_ratio=increase,"
            f"crop={box_w}:{box_h},setpts=PTS-STARTPTS[{src}]")
        nxt = f"b{n}"
        steps.append(
            f"{label}[{src}]overlay=x={int(x * width)}:y={int(y * height)}:"
            f"enable='between(t,{span['from']:.3f},{span['to']:.3f})'[{nxt}]")
        label = f"[{nxt}]"

    if overlay_index is not None:
        steps.append(f"{label}[{overlay_index}:v]overlay=0:0[out]")
        label = "[out]"

    args += ["-filter_complex", ";".join(steps), "-map", label]

    # Audio comes whole from the camera that opens the session — no mixing in v1.
    opening = spans[0]["clip"]
    args += ["-map", f"{index[opening]}:a?", "-c:a", AUDIO_CODEC, "-b:a", "192k"]
    args += ["-c:v", VIDEO_CODEC, "-b:v", bitrate, "-r", str(fps),
             "-t", f"{total:.3f}", "-pix_fmt", "yuv420p", str(output)]
    return Plan(args=args, duration_s=total, inputs=inputs)


def prepare_clips(session: dict, workdir: Path) -> dict:
    """Writes a concat list for every clip split into chunks.

    Returned as a copy of the session so the file on disk keeps holding only real data —
    the concat lists are a detail of one render, not part of the session.
    """
    workdir.mkdir(parents=True, exist_ok=True)
    prepared = json.loads(json.dumps(session))
    for clip in prepared.get("clips", []):
        files = clip.get("files") or []
        if len(files) <= 1:
            continue
        listing = workdir / f"concat_{clip['id']}.txt"
        listing.write_text("".join(f"file '{Path(f).resolve()}'\n" for f in files))
        clip["_concat"] = str(listing)
    return prepared


def parse_progress(line: str, duration_s: float) -> float | None:
    """Fraction complete from one line of ffmpeg's ``-progress`` output."""
    match = PROGRESS.search(line)
    if not match or duration_s <= 0:
        return None
    return min(1.0, int(match.group(1)) / 1e6 / duration_s)


def run(plan: Plan, *, on_progress=None) -> None:
    """Runs the plan, reporting progress as a fraction between 0 and 1."""
    process = subprocess.Popen(plan.args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, bufsize=1)
    try:
        for line in process.stdout:
            done = parse_progress(line, plan.duration_s)
            if done is not None and on_progress:
                on_progress(done)
    finally:
        process.stdout.close()
        code = process.wait()
    if code != 0:
        raise RenderError(f"ffmpeg exited with {code}: {process.stderr.read().strip()[:400]}")
