# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
uv sync                                   # set up
uv run trackoverlay                       # the whole tool: project list in a browser
uv run trackoverlay serve --host 0.0.0.0  # as the container image runs it

uv run pytest                             # Python tests
uv run pytest tests/test_sync.py -k xcorr # one file, one test
node --test web/test/*.test.js            # JavaScript tests (the glob is required:
                                          # node 22+ tries to load a directory as a module)

uv run trackoverlay build data/<project>/*.csv data/<project>/*.MP4 \
    --track "Slovakia Ring" -o data/<project>/session.json
uv run trackoverlay serve --project <name>
uv run trackoverlay render <session> <layout> --overlay <overlay> -o out.mp4

docker build -t track-overlay . && docker run --rm -p 8712:8712 -v "$PWD/data:/data" track-overlay
```

Tests needing the source video skip themselves; the RaceBox exports are committed, so lap
detection and synchronisation still run against real data. There is no linter.

## What the pieces are

```
RaceBox CSV/VBO ─┐
                 ├→ sync → session.json ─→ browser editor ─→ layout.json + overlay.mp4
GoPro MP4 (GPMF) ┘                                                      │
         full-resolution MP4s ──────────────────────────────────────────┴→ ffmpeg → final.mp4
```

Python assembles and renders; the browser previews, arranges and draws the overlay layer.
Only ffmpeg ever touches the heavy video.

## Invariants — breaking these breaks the tool quietly

**Layout is in fractions of the frame, never pixels.** The preview runs on an element of
whatever size and the render at full resolution; only fractions can mean the same thing in
both. `Widgets.boxFor` is the single conversion to pixels.

**The preview and the export draw through the same function.** `paintOverlay` in
`web/js/state.js` is called by both. Anything that reads the wall clock, the window size,
or state that only exists while playing will make them disagree — and the disagreement
shows up only in the finished file. This is why the lap delta is sampled on a grid in
*session* time (`LapTimes.STEP`), not smoothed per frame.

**`clip["offset_s"]` in session.json is the sync truth**, because `render.build_plan`
reads it. A correction that lives anywhere else never reaches the video. The human
decision is kept in `project.json` as well, because a rebuild rewrites the session.

**Time inside a session is seconds from `session.start_utc`.** Output time is not session
time once anything is cut: `Ranges.toSession` / `toOutput` convert, and the overlay is
drawn in output time while telemetry is addressed in session time. In `render.build_plan`
a third clock appears — graph time, which starts at the first kept moment. Mixing any two
of them is the shape every sync bug here has taken: a window clamped by an output length
rendered the opening minutes, and composing from zero before trimming did seven times the
work with a progress bar that never moved.

**`cuts` is a sparse list of arrangements, not of changes.** Each entry says what the
slots hold from that moment. It maps one-to-one onto ffmpeg's `enable='between(t,a,b)'`.

**Projects are addressed in the URL** (`/p/<name>/api/…`), never held as server state.
Two tabs on two projects would otherwise write into each other's files, and a `<video>`
issuing range requests for minutes would be redirected mid-playback.

**Only `projects.read` turns a name from outside into a path**, and every `Path` it
returns is proven to be inside the data root. Handlers do not join paths.

**Sources are never copied.** A track day is twenty gigabytes; the server reads the same
disk. `projects.resolve_source` looks for a file beside the project when its recorded path
is gone, which is what makes a folder portable between a host and a container.

**Lean angle comes from the trajectory**, `atan(v·dψ/dt / g)`, never from an
accelerometer: in a steady corner a bike leans until the resultant aligns with its own
vertical axis, and a sensor bolted to it reads about zero.

**The lap envelope is averaged along the path, never by time or sample index.** Laps have
different durations; `laps.build_envelope` projects into Frenet coordinates first.

**No browser encodes alpha.** The overlay layer is exported as a double-height frame —
colour over a greyscale matte — and recombined with ffmpeg's `alphamerge`.

**`-ss` for negative offsets, `-itsoffset` for positive.** A negative `-itsoffset` pushes
frames to negative timestamps, ffmpeg drops them, and `setpts=PTS-STARTPTS` re-zeros what
survives — silently cancelling the sync correction. `setpts` goes only on seeked inputs.

**The overlay is composited after range trimming**, or the range offset is applied twice.

**A single kept stretch is seeked to, never trimmed to.** The graph starts there, so there
is no trim or concat stage and the audio comes straight off the seeked input.

**Nothing downstream runs against footage that is gone.** The project panel, the export
and the render each refuse early and name the camera; only the render used to find out,
at the far end of an ffmpeg command line.

## Conventions

- Pure JS modules (`clock`, `cuts`, `ranges`, `layout`, `display`, `laptimes`, `history`,
  `filmstrip`, `projects`, `picker`, `scoring`, widgets) end with a dual export:
  `module.exports` under node, a `window` global in the browser. They are unit-tested.
  `state.js` and `home.js` hold the DOM wiring and have no tests — there is nothing in
  them to test. Keep new logic on the pure side.
- Adding a `web/js/*.js` file means adding a `<script>` to `web/index.html`; load order
  matters, and `state.js` is last.
- Widgets register themselves into `Widgets`; the widget menu is built from that registry.
  Nothing adds a widget back into a layout that lacks it — unticking has to stick. A
  camera the session gains later is different: `Cuts.adopt` gives it the free inset, or it
  would be synced and invisible.
- The server stamps `?v=<mtime>` onto assets and serves them `no-store`. Stamped URLs are
  rooted: from `/p/<name>/` a relative one resolves inside the project and 404s in silence.
- CSS: `[hidden] { display: none !important }` is load-bearing. A `display:` rule outranks
  the attribute, and an invisible panel that still covers the page eats every click.
- Everything in the repository is in English, commit messages included.

## Data

`data/<project>/` is one track day: sources, `session.json`, `layout.json`, and `out/` for
everything rendered. Only the RaceBox exports of the sample project are committed; video,
session and layout are ignored.
