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


def _pick_source(clip: dict, seek_s: float, needed_s: float,
                 workdir: Path | None) -> tuple[str, float, bool]:
    """Chooses what to feed ffmpeg for one clip, and where to seek inside it.

    A clip split into chunks normally goes through the concat demuxer, but seeking into
    a concat list is slow - measured at 19.8 s against 9.4 s for the same seek on a
    single file. A short render usually needs only one chunk anyway, so when the window
    fits inside one it is used directly and the seek is rebased onto it.

    Returns the source path, the seek to apply, and whether the concat demuxer is needed.
    """
    files = clip.get("files") or []
    durations = clip.get("chunks") or []
    if len(files) <= 1:
        return files[0], seek_s, False
    if len(durations) != len(files):
        return clip.get("_concat"), seek_s, True

    start = 0.0
    for path, length in zip(files, durations):
        if seek_s < start + length - 1e-6:
            # Everything needed sits inside this one chunk.
            if seek_s + needed_s <= start + length + 1e-6:
                return path, seek_s - start, False
            break
        start += length

    # Spanning a joint: fall back to the full list, seeking from its beginning.
    return clip.get("_concat"), seek_s, True


def _even(value: float) -> int:
    """Rounds to an even number of pixels — h264 refuses odd dimensions."""
    return max(2, int(round(value / 2)) * 2)


def _keep_ranges(layout: dict, duration: float) -> list[tuple[float, float]]:
    """The stretches of the session that make it into the video.

    Mirrors ``Ranges.normalise`` in the browser. Absent or empty means keep everything —
    a layout from before this feature existed must still render.
    """
    raw = layout.get("ranges")
    if not raw:
        return [(0.0, duration)]
    clean = sorted(
        (max(0.0, float(r["from"])), min(duration, float(r["to"]))) for r in raw)
    merged: list[list[float]] = []
    for start, end in clean:
        if end - start <= 1e-6:
            continue
        if merged and start <= merged[-1][1] + 1e-6:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [(a, b) for a, b in merged] or [(0.0, duration)]


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

    # Whichever camera opens the main slot becomes the base, when that slot covers the
    # whole frame. Compositing an opaque full-frame image onto a black canvas costs as
    # much as the decode and the encode together - on a 30 second piece it was the
    # difference between 9.5 and 3.6 seconds - and it achieves nothing.
    opening_span = next((s for s in spans if s["slot"] == "main"), spans[0])
    base_clip = None
    if (rects.get(opening_span["slot"]) == [0, 0, 1, 1]
            and opening_span["from"] <= 1e-6
            and tuple(clips[opening_span["clip"]].get("width", 0)
                      for _ in (0,)) != (0,)):
        candidate = clips[opening_span["clip"]]
        if (candidate.get("width"), candidate.get("height")) == (width, height):
            base_clip = opening_span["clip"]

    args = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-progress", "pipe:1"]
    if base_clip is None:
        # Nothing fills the frame at the start, so a black canvas has to stand in.
        args += ["-f", "lavfi", "-t", f"{total:.3f}",
                 "-i", f"color=c=black:s={width}x{height}:r={fps}"]

    index = {}
    inputs = []
    seeked: set[str] = set()
    next_input = 0 if base_clip is not None else 1   # input 0 is the black canvas
    for clip_id in used:
        clip = clips[clip_id]
        offset = clip["offset_s"]
        source, seek, use_concat = _pick_source(
            clip, max(0.0, -offset), total, None)
        if source is None:
            raise RenderError(f"clip {clip_id} has several chunks but no concat list")
        if use_concat:
            args += ["-f", "concat", "-safe", "0"]

        # How the sync offset is applied depends on its sign, and getting this wrong is
        # silent. A clip that starts *before* session zero has to be seeked into: a
        # negative -itsoffset pushes its frames to negative timestamps, where ffmpeg
        # drops them, and the usual setpts=PTS-STARTPTS then re-zeros what survives -
        # quietly cancelling the correction and rendering the clip from its own first
        # frame. Seeking also skips the decode of everything before the entry point,
        # which is most of the cost on a preview from late in a session.
        if offset < 0:
            args += ["-ss", f"{seek:.3f}"]
            seeked.add(clip_id)
        else:
            args += ["-itsoffset", f"{offset:.3f}"]
        args += ["-i", str(source)]
        index[clip_id] = next_input
        next_input += 1
        inputs.append(str(source))

    overlay_index = None
    if overlay is not None:
        args += ["-i", str(overlay)]
        # Counted from next_input, not from the clip count: input 0 is the black canvas
        # only when no camera fills the frame, so the two do not line up.
        overlay_index = next_input
        next_input += 1
        inputs.append(str(overlay))

    steps = []
    if base_clip is None:
        label = "[0:v]"
    else:
        steps.append(f"[{index[base_clip]}:v]"
                     + ("setpts=PTS-STARTPTS" if base_clip in seeked else "null")
                     + "[base]")
        label = "[base]"

    for n, span in enumerate(spans):
        # The base camera's own opening window is already the canvas.
        if base_clip is not None and span is opening_span:
            continue
        x, y, w, h = rects.get(span["slot"], rects["main"])
        box_w, box_h = _even(w * width), _even(h * height)
        source = clips[span["clip"]]
        src = f"v{n}"
        timing = "setpts=PTS-STARTPTS" if span["clip"] in seeked else "null"
        if (source.get("width"), source.get("height")) == (box_w, box_h):
            # Already the right size: running the scaler would cost as much as the
            # decode for nothing.
            steps.append(f"[{index[span['clip']]}:v]{timing}[{src}]")
        else:
            steps.append(
                f"[{index[span['clip']]}:v]scale={box_w}:{box_h}:force_original_aspect_ratio=increase,"
                f"crop={box_w}:{box_h},{timing}[{src}]")
        nxt = f"b{n}"
        steps.append(
            f"{label}[{src}]overlay=x={int(x * width)}:y={int(y * height)}:"
            f"enable='between(t,{span['from']:.3f},{span['to']:.3f})'[{nxt}]")
        label = f"[{nxt}]"

    # Audio comes whole from the camera that opens the session — no mixing in v1.
    opening = spans[0]["clip"]
    audio_label = f"[{index[opening]}:a]"
    # Without trimming the audio never enters the graph, and a filter label is not a
    # valid -map target for a plain input stream.
    audio_map = f"{index[opening]}:a?"

    # Cut stretches out by trimming the finished composite and concatenating what is
    # left. Doing it here, after compositing, means the cuts apply to every camera and to
    # the overlay at once, without repeating the trim on each input.
    kept = _keep_ranges(layout, total)
    output_duration = sum(end - start for start, end in kept)
    if len(kept) > 1 or kept[0] != (0.0, total):
        # trim needs several reads of the same stream, so both are split first.
        steps.append(f"{label}split={len(kept)}"
                     + "".join(f"[sv{n}]" for n in range(len(kept))))
        steps.append(f"{audio_label}asplit={len(kept)}"
                     + "".join(f"[sa{n}]" for n in range(len(kept))))
        pieces = []
        for n, (start, end) in enumerate(kept):
            steps.append(f"[sv{n}]trim=start={start:.3f}:end={end:.3f},"
                         f"setpts=PTS-STARTPTS[kv{n}]")
            steps.append(f"[sa{n}]atrim=start={start:.3f}:end={end:.3f},"
                         f"asetpts=PTS-STARTPTS[ka{n}]")
            pieces.append(f"[kv{n}][ka{n}]")
        steps.append(f"{''.join(pieces)}concat=n={len(kept)}:v=1:a=1[cv][ca]")
        label, audio_map = "[cv]", "[ca]"

    # The overlay goes on last, after the trimming, because the browser already rendered
    # it against output time. Laying it on before the cuts would apply the range offset a
    # second time and slide the telemetry away from the picture.
    if overlay_index is not None:
        # The layer arrives as a double-height frame: colour on top, a greyscale matte of
        # the alpha channel below. No browser tested would encode real transparency, so
        # the two halves travel together in one file and are put back together here.
        steps.append(f"[{overlay_index}:v]crop={width}:{height}:0:0,setsar=1[ovc]")
        steps.append(f"[{overlay_index}:v]crop={width}:{height}:0:{height},setsar=1[ovm]")
        steps.append("[ovc][ovm]alphamerge[ov]")
        steps.append(f"{label}[ov]overlay=0:0[out]")
        label = "[out]"

    args += ["-filter_complex", ";".join(steps), "-map", label, "-map", audio_map]
    args += ["-c:a", AUDIO_CODEC, "-b:a", "192k"]
    args += ["-c:v", VIDEO_CODEC, "-b:v", bitrate, "-r", str(fps),
             "-t", f"{output_duration:.3f}", "-pix_fmt", "yuv420p", str(output)]
    return Plan(args=args, duration_s=output_duration, inputs=inputs)


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
