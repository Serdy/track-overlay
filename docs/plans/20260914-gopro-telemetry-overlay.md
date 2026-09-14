# Overlaying RaceBox telemetry onto GoPro video

## Overview

A local tool that takes footage from one or more GoPro cameras plus telemetry from a
RaceBox logger, aligns them in time, and produces a **finished MP4** with the overlay
burned in. The video half of RaceChrono, but running on a computer rather than a phone,
and therefore substantially faster.

The problem it solves: today the only ways to put telemetry onto onboard footage are a
mobile app (slow, limited layout) or hand work in a video editor (long and not
repeatable). The tool does it in one pass, with a layout preset that can be reused.

Acceptance criteria:

1. Session 3429 (three GoPro chunks plus the RaceBox CSV) yields an MP4 with four widgets
2. Two or three cameras appear at once (PiP), and the main view and inset can be swapped
   at arbitrary points during the session
3. The picture in the browser preview matches the rendered file
4. Telemetry and video are aligned to better than one frame at 60 fps

## Context (from discovery)

- **The project starts empty**: only `data/` with test footage and `tools/` with two
  reconnaissance scripts. Git is not initialised.
- **`tools/gopro_dates.py`** — a working GPMF parser: locates the `gpmd` stream through
  ffprobe, walks the KLV, reads `GPSU`/`GPSF`, repairs file dates. Moves into
  `ingest/gpmf.py`.
- **`tools/sync_check.py`** — a working cross-correlation: contains `gopro_speed()`
  (GPS5 plus SCAL plus spreading samples across `GPSU` stamps) and `racebox_speed()`.
  Moves into `ingest/` and `sync.py`.
- **`serious-racing/userscripts/src/sr-track.js`** — 1309 lines of DOM-free maths with
  unit tests. Supplies acceleration/braking, brake-point detection and corner detection.
- **`DDA_Reader`** — reference material: central difference for longitudinal G
  (`dda_core.py`), gate auto-detection (`_detect_and_segment_laps`), the alpha pipeline
  (`viewer/js/video_export.js`), video-to-telemetry sync (`viewer/js/video_player.js`).
- Environment: macOS, ffmpeg 7.1.1, node v26, uv 0.5.12.

## Development Approach

- **testing approach**: conventional — implementation first, tests after. For binary
  format parsers that is the only sane order: the expected result is not known until it
  has been seen in the data.
- finish each task completely before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new or updated tests**
  - tests are not optional, they are a required part of the checklist
  - unit tests for new functions
  - unit tests for modified functions
  - tests for new code paths
  - existing tests updated when behaviour changes
  - cover both the success and the failure case
- **CRITICAL: all tests must pass before the next task starts, no exceptions**
- **CRITICAL: update this plan file when the scope changes**
- run tests after each change
- keep backward compatibility

## Testing Strategy

- **unit tests**: required in every task, see Development Approach
- **Python**: `pytest`, run through `uv run pytest`
- **JavaScript**: the built-in `node:test`, run as `node --test web/test/*.test.js`
- **fixtures**: real files from `data/`. Large MP4s never enter the tests — extracted
  `gpmd` streams go into `tests/fixtures/` instead (a few hundred KB each), and the CSVs
  are trimmed to short slices.
- **e2e**: the project has no UI-based e2e framework. Instead there is a golden smoke
  test: render 10 seconds of session 3429 and compare checksums of key frames.

## Progress Tracking

- mark finished items `[x]` as soon as they are done
- add newly discovered tasks with a ➕ prefix
- flag problems and blockers with a ⚠️ prefix
- update the plan if the implementation departs from the original scope
- keep the plan in step with the work actually done

## Solution Overview

**The browser draws and shows, ffmpeg splices.** Chosen out of three options (all-Python
with Skia, all-browser with WebCodecs, and this hybrid).

```
RaceBox CSV ──┐
              ├──→ sync ──→ session.json ──┐
GoPro MP4/LRV ┘        (one time axis)      │
                                            ▼
                                   ┌─────────────────┐
                                   │   web editor    │  preview, layout,
                                   │   (browser)     │  switch points
                                   └────────┬────────┘
                                            │
                            layout.json + overlay.webm (RGBA)
                                            │
     full-resolution source MP4s ───────────┴──→ ffmpeg ──→ out.mp4
```

Key decisions and the reasoning behind them:

- **Preview through `<video>` tags rather than a hand-written decoder.** The most
  expensive part of an editor — decoding and synchronised scrubbing of several streams —
  comes free from the browser. Playback uses GoPro's `.LRV` proxies, which keeps
  scrubbing responsive on 4K footage.
- **The overlay is drawn once, by one piece of code.** The same canvas that runs in the
  preview feeds frames to WebCodecs. A mismatch between "what the preview showed" and
  "what the render produced" is impossible by construction.
- **Heavy video is touched only by ffmpeg.** The browser encodes the overlay alone — a
  small RGBA layer with no source underneath. That is why the GoPro codec (H.264 here,
  sometimes HEVC) never matters.
- **Normalised 0..1 coordinates throughout the layout.** The preview draws on an element
  of arbitrary size while the render works at full resolution; the only thing they can
  share is fractions, never pixels.
- **Telemetry lives in a dict of channels, not fields of a class.** In `DDA_Reader` the
  fields are baked into `DDARecord.__slots__`, which is why in its whole history it never
  grew a second data source. That mistake is not repeated here — but neither is a plugin
  system built.

## Technical Details

### Synchronisation (verified against real data)

A three-rung ladder:

1. **UTC from the satellites** — the coarse anchor. Both GoPro (`GPSU`) and RaceBox (the
   `Time` column) provide absolute time.
2. **Speed cross-correlation** — the fine alignment. GPS5 speed from the GoPro against
   the `Speed` column from RaceBox.
3. **A manual slider** — for sources without UTC and for cases where the automation misses.

Measured on session 3429 (27 minutes of overlap):

| Quantity | Value |
| :--- | :--- |
| Correlation at zero lag | +0.9606 |
| Peak correlation | +0.9997 |
| Lag at the peak | +1.40 s |
| Spread across 8 windows | +1.30…+1.40 (the grid step, not drift) |

Conclusions baked into the implementation:

- UTC shares one axis on both devices: no leap-second or timezone trouble
- **Cross-correlation is mandatory**: 1.4 s is 84 frames at 60 fps
- **No clock-drift compensation** — over 27 minutes there is none
- **Refine the peak sub-sample** with a parabola through three points: on a 10 Hz grid
  the resolution is 0.1 s, which is 6 frames — not good enough

### The `session.json` format

The contract between Python and the browser. Python knows nothing about drawing, the
browser nothing about parsing formats.

```json
{
  "session": { "start_utc": "2026-09-12T12:29:35.340Z", "track": "Slovakia Ring" },
  "channels": {
    "speed":  { "role": "speed",      "unit": "km/h", "samples": [] },
    "lean":   { "role": "lean",       "unit": "deg",  "samples": [] },
    "accel":  { "role": "accel_long", "unit": "g",    "samples": [] },
    "lat":    { "role": "lat",        "unit": "deg",  "samples": [] },
    "lon":    { "role": "lon",        "unit": "deg",  "samples": [] }
  },
  "laps":  [ { "n": 1, "t_start": 120.4, "t_end": 281.1, "best": false } ],
  "gates": [ { "id": "sf", "lat": 48.0555, "lon": 17.5665, "bearing": 272.4 } ],
  "envelope": { "left": [], "right": [] },
  "clips": [
    { "id": "cam_front", "files": ["GH013429.MP4", "GH023429.MP4"],
      "chunks": [707.7, 707.7], "offset_s": 0.0, "duration_s": 1733.7,
      "proxy": ["GL013429.LRV"] }
  ]
}
```

Times inside `session.json` are seconds from `session.start_utc`, not absolute stamps.
The sample grid is uniform by construction, so sample *i* sits at exactly `i / rate_hz`.

### The `layout.json` format

```json
{
  "output": { "width": 1920, "height": 1080, "fps": 60 },
  "slots":  [ { "id": "main", "rect": [0, 0, 1, 1] },
              { "id": "pip",  "rect": [0.72, 0.04, 0.26, 0.26] } ],
  "cuts":   [ { "t": 0.0,   "main": "cam_front", "pip": "cam_rear"  },
              { "t": 184.2, "main": "cam_rear",  "pip": "cam_front" } ],
  "widgets":[ { "type": "speed", "pos": [0.04, 0.86], "scale": 1.0 } ]
}
```

`cuts` is a sparse list: only the moments where the arrangement **changes** are stored,
and it holds between them. That shape maps one-to-one onto `enable='between(t,a,b)'` in
ffmpeg.

### The ffmpeg filter graph

The base is a black frame of the output size. Every "camera + time window + slot" triple
becomes an identical overlay filter, so the graph generator is an ordinary loop:

```
[black] ← cam_front (0–184s,  slot main, scale 1920x1080)
        ← cam_rear  (0–184s,  slot pip,  scale 500x281)
        ← cam_rear  (184s–…,  slot main)
        ← cam_front (184s–…,  slot pip)
        ← overlay.webm (the whole clip)
        → h264_videotoolbox
```

GoPro chunks are joined beforehand with the `concat` demuxer, sync offsets are applied
through `-itsoffset` on the input, and audio is taken whole from one chosen camera.

### Deriving the channels

- **Speed** — straight from GPS, the only honestly measured channel
- **Acceleration/braking** — from the RaceBox `GForceX` column or by central difference
  of speed. Decide by comparing both on session 3429 data
- **Lean angle** — derived from the trajectory: `lean = atan(v · dpsi/dt / g)`. It cannot
  be taken off the accelerometer: in a steady corner the machine leans exactly enough for
  the resultant force to align with its own vertical axis, so a sensor bolted to it reads
  near zero. The trajectory estimate also does not care how the logger is mounted. Check
  it against RaceBox's own `LeanAngle` column.
- **Lap envelope** — averaging by time or by sample index is **wrong**: laps differ in
  duration. The right way is to parameterise a reference lap by distance `s`, project the
  other laps onto it (Frenet coordinates) to get "position along the track" and "lateral
  offset", and average the lateral offset at equal `s`. The same machinery is needed for
  lap comparison.

### Explicitly out of scope for v1

- transitions, effects, audio mixing, any cutting beyond swapping slots
- satellite imagery under the map, tiles, Leaflet, any network call during a render
- data sources beyond RaceBox and GoPro; a generic CSV adapter; YAML column mapping; a
  role-resolution map for overlapping sources
- clock-drift compensation
- the 202 Hz ACCL/GYRO streams from the GoPro

## What Goes Where

- **Implementation Steps** (`[ ]`): everything done inside this repository — code, tests,
  documentation
- **Post-Completion** (no checkboxes): manual picture-quality checks, exporting a second
  data set, testing against footage from other cameras

## Implementation Steps

### Task 1: Project skeleton and environment

**Files:**
- Create: `pyproject.toml`
- Create: `.python-version`
- Create: `.gitignore`
- Create: `README.md`
- Create: `src/trackoverlay/__init__.py`

- [x] `git init` and a first commit carrying the current `tools/` and `docs/`
- [x] `uv init` plus `uv python pin 3.12` (the system 3.12 is too new for some wheels)
- [x] `pyproject.toml`: `numpy` as a dependency, `pytest` as a dev dependency, a CLI entry point
- [x] `.gitignore`: `data/*.MP4`, `out/`, `__pycache__/`, `.venv/`, but **not** `data/*.csv`
      and `data/*.vbo` — those are small and serve as fixtures
- [x] verify `uv run python -c "import numpy"` and `uv run pytest --version`

### Task 2: GPMF parser

**Files:**
- Create: `src/trackoverlay/ingest/gpmf.py`
- Create: `tests/fixtures/gpmd_3429_ch1_head.bin`
- Create: `tests/test_gpmf.py`
- Modify: `tools/gopro_dates.py` (switch it onto the shared module)

- [x] move the ffprobe stream lookup and the ffmpeg extraction out of `tools/`
- [x] KLV parsing with recursion into nested containers (`STRM`), types from the `FMT` table
- [x] `read_gps(path)` returning `(t_utc, lat, lon, alt, speed_kmh, fix)` samples with
      `SCAL` applied and block samples spread across consecutive `GPSU` stamps
- [x] `read_window(path)` returning the first and last UTC stamp, to bound the recording
- [x] cut a fixture: extract `gpmd` from `GH013429.MP4` into `tests/fixtures/`
- [x] tests: the fixture parses to the expected block count, `fix=3` everywhere, first
      stamp `2026-09-12T12:29:35.340Z`, coordinates near `48.055, 17.571`
- [x] failure tests: a file with no `gpmd` stream, a truncated KLV buffer
- [x] run the tests — they must pass before task 3

### Task 3: Detecting and joining GoPro chunks

**Files:**
- Create: `src/trackoverlay/ingest/clips.py`
- Create: `tests/test_clips.py`

- [x] `discover(paths)` grouping by the recording number in the name (`GH`**`01`**`3429`
      is chunk 01 of recording 3429), sorted by chunk index
- [x] **check the joint against `GPSU`, not the names**: the gap between one chunk's last
      stamp and the next one's first must fit inside one stamp interval (0.99 s in the
      verified data, where stamps arrive at 1 Hz)
- [x] a `Clip` carrying `files`, `start_utc`, `duration_s` and `proxy` (the `.LRV` beside it)
- [x] generate the list file for ffmpeg's `concat` demuxer
- [x] tests: the three files of session 3429 assemble into one clip of about 1733 s
- [x] failure tests: a missing middle chunk, chunks of different recordings in one group,
      a gap beyond tolerance
- [x] run the tests — they must pass before task 4

### Task 4: RaceBox parser

**Files:**
- Create: `src/trackoverlay/ingest/racebox.py`
- Create: `tests/fixtures/racebox_lean_head.csv`
- Create: `tests/test_racebox.py`

- [x] read the CSV: `Time` as ISO 8601 UTC with milliseconds, the rest as numbers
- [x] detect the two export variants from the header: with `LeanAngle` (Bike Mode on) and
      with `GForceY` (off)
- [x] `merge(lean_csv, cornering_csv)` folding two exports of one session together by
      `Time`, so that both `LeanAngle` and `GForceY` are available
- [x] optional `.vbo` reading for the `heading` column the CSV lacks. Mind the format's
      quirks: `HHMMSS.ss` time, coordinates in arc minutes, and **longitude with the
      opposite sign** to the CSV
- [x] cut fixtures: the first couple of thousand rows of both exports
- [x] tests: 40419 rows, a 40 ms step (25 Hz), first stamp `2026-09-12T12:31:30.120Z`,
      laps 0–8, merging two files yielding both channels
- [x] failure tests: mismatched timestamps on merge, an unknown header
- [x] VBO tests: coordinates after conversion match the CSV to within 1e-6
- [x] run the tests — they must pass before task 5

### Task 5: Channel model and derived quantities

**Files:**
- Create: `src/trackoverlay/telemetry.py`
- Create: `tests/test_telemetry.py`

- [x] `Channel` (name, role, unit, samples) and `Telemetry` as a dict of channels —
      **not** a class with fixed fields
- [x] `heading_rate()` — the derivative of heading, unwrapped across the 360° boundary
- [x] `lean_from_trajectory(speed, heading_rate)` = `atan(v · dpsi/dt / g)`, suppressed at
      low speed where heading is noise
- [x] `accel_long()` both ways: from `GForceX` and by central difference of speed (with
      `dda_core.py` from `DDA_Reader` as the model)
- [x] `cumulative_distance()` by the haversine formula
- [x] synthetic tests: a steady turn of radius R at speed v gives the expected lean angle;
      heading unwraps across 359°→1°
- [x] real-data test: the computed lean correlates with RaceBox `LeanAngle` at no worse
      than 0.9, with a median disagreement under 3°
- [x] failure tests: an empty channel, a single sample, zero speed
- [x] run the tests — they must pass before task 6

### Task 6: Synchronisation

**Files:**
- Create: `src/trackoverlay/sync.py`
- Create: `tests/test_sync.py`
- Modify: `tools/sync_check.py` (switch it onto the shared module)

- [x] `coarse_utc()` — alignment by absolute stamps and the overlap window
- [x] `cross_correlate()` — resample both speed series onto a common 10 Hz grid,
      normalise, and sweep lags within ±60 s
- [x] **sub-sample peak refinement with a parabola through three points** — without it the
      resolution is 0.1 s, or 6 frames at 60 fps
- [x] `SyncResult` carrying `offset_s`, `correlation` and `method` (`utc`/`xcorr`/`manual`)
- [x] degradation: when the video has no valid GPS (as in session 3430), return the UTC
      result flagged for manual adjustment rather than failing
- [x] synthetic tests: an artificial 1.234 s shift is recovered to better than 0.02 s
- [x] real-data test: session 3429 gives a lag between 1.3 and 1.5 s at a correlation
      above 0.99
- [x] failure tests: an overlap under 60 s, a series of all zeros, no GPS on one side
- [x] run the tests — they must pass before task 7

### Task 7: Laps, gates and the envelope

**Files:**
- Create: `src/trackoverlay/laps.py`
- Create: `tests/test_laps.py`

- [x] `detect_start_finish()` — find the point the track crosses most often at a similar
      heading (with `_detect_and_segment_laps` from `dda_core.py` as the model)
- [x] `split_laps()` — split into laps at gate crossings, with a time hysteresis
- [x] `frenet_project(reference, points)` — project points onto a reference lap
      parameterised by distance, returning `(s, lateral offset)`
- [x] `envelope(laps)` — the envelope of all laps through the Frenet projection: minimum
      and maximum lateral offset at equal `s`. **Never average by time or index**
- [x] cross-check against the RaceBox `Lap` column as an independent source of truth
- [x] synthetic tests: a perfect circle gives a closed envelope of zero width; two laps
      2 m apart give a band 2 m wide
- [x] real-data test: session 3429 gives 8 laps with a best of 160.34 s (±0.5 s), matching
      the RaceBox `Lap` column
- [x] failure tests: a track shorter than one lap, a track with no gate crossings
- [x] run the tests — they must pass before task 8

### Task 8: Assembling session.json and the CLI

**Files:**
- Create: `src/trackoverlay/session.py`
- Create: `src/trackoverlay/cli.py`
- Create: `tests/test_session.py`

- [x] `build_session(racebox_files, video_files)` — the whole pipeline from parsers through
      synchronisation, laps and the envelope
- [x] serialise to `session.json` per the Technical Details schema; times inside are
      seconds from `session.start_utc`, not absolute stamps
- [ ] CLI `trackoverlay build data/*.csv data/GH0?3429.MP4 -o out/session.json`
- [x] clear error messages: no overlap, no `gpmd` found, mismatched sessions
- [x] tests: a full run of session 3429 yields valid JSON with every expected key, 8 laps
      and one clip of three files
- [x] failure tests: CSV and video from different days, an empty file list
- [x] run the tests — they must pass before task 9

### Task 9: The local HTTP server

**Files:**
- Create: `src/trackoverlay/server.py`
- Create: `tests/test_server.py`
- Modify: `src/trackoverlay/cli.py`

- [x] serve statics from `web/` and `session.json` at `/api/session`
- [x] **serve video with range request support** — without it scrubbing in the browser does
      not work at all
- [x] prefer the `.LRV` proxy for preview requests and the full file for rendering
- [x] `POST /api/layout` saving `layout.json` to disk
- [ ] CLI `trackoverlay serve out/session.json`, opening a browser
- [x] tests: a range request returns 206 with the right slice; a request past the end gives 416
- [x] failure tests: a request for a file outside the allowed directory (path traversal),
      a missing file
- [x] run the tests — they must pass before task 10

### Task 10: Editor skeleton and the master clock

**Files:**
- Create: `web/index.html`
- Create: `web/style.css`
- Create: `web/js/session.js`
- Create: `web/js/clock.js`
- Create: `web/test/clock.test.js`

- [x] load `session.json`, parse the channels, keep shared state in one module
- [x] a `<video>` tag bound to the session clip
- [x] the master clock: the single source of the current time, setting the video
      `currentTime` and triggering the overlay redraw
- [x] transport: play/pause, timeline scrubbing, frame stepping, playback rate
- [x] `sampleAt(channel, t)` — sample a channel at an arbitrary moment, interpolated
- [x] `node:test` coverage of `clock.js` and `sampleAt`: range edges, interpolation between
      samples, queries before the start and past the end
- [x] run the tests — they must pass before task 11

### Task 11: Speed, lean and acceleration widgets

**Files:**
- Create: `web/js/sr-track.js` (ported from serious-racing)
- Create: `web/js/widgets/speed.js`
- Create: `web/js/widgets/lean.js`
- Create: `web/js/widgets/accel.js`
- Create: `web/js/widgets/index.js`
- Create: `web/test/widgets.test.js`

- [x] port `sr-track.js` from `serious-racing` unchanged, along with its unit tests
- [x] **rescale the constants for 25 Hz through `makeCfg(override)`**: some are expressed
      in samples at 10 Hz (`ONSET_MIN_SAMPLES: 4` is 0.4 s, which is 10 samples at 25 Hz)
- [x] an adapter from `session.json` channels to the expected row shape
      `[lat, lng, speed(mph), cumDist(m), longAccel(m/s²), lean(°)]`
- [x] a shared widget interface: `draw(ctx, box, data)`, drawing in normalised coordinates
      with no DOM access inside
- [x] three widgets: a digital speed readout, a left/right lean indicator, and an
      acceleration/braking bar built on `computeScore` and `scoreToColor`
- [x] tests: the ported `sr-track` tests pass; the rescaled constants give the same brake
      point count on equivalent data
- [x] widget tests: `draw` survives edge values (no data, zero speed, lean off the scale)
- [x] run the tests — they must pass before task 12

### Task 12: The map widget

**Files:**
- Create: `web/js/widgets/map.js`
- Create: `web/test/map.test.js`

- [x] project coordinates into a local plane using the track bounding box, preserving the
      aspect ratio
- [x] draw the lap envelope as a pale band — a static layer, rendered once into an
      offscreen canvas and reused
- [x] the current lap line on top of the envelope, plus the position dot
- [x] **no tiles, no Leaflet, no network calls** — rendering has to work offline
- [x] tests: the projection preserves the aspect ratio; a point at the start of the track
      lands in the right place on the envelope; repeat calls do not redraw the static layer
- [x] failure tests: a track of one point, a degenerate bounding box
- [x] run the tests — they must pass before task 13

### Task 13: Multiple cameras, slots and PiP

**Files:**
- Modify: `web/js/state.js`
- Create: `web/js/slots.js`
- Create: `web/test/slots.test.js`
- Modify: `web/index.html`

- [x] one `<video>` tag per slot, positioned absolutely from the `rect` in `layout.json`
- [x] playback through the `.LRV` proxies; full resolution is never used in the preview
- [x] every clip loaded but only the visible ones playing, all driven by the master clock
- [x] account for each clip's individual `offset_s` when setting `currentTime`
- [ ] drag and resize the PiP with the mouse, storing the result in normalised coordinates
- [ ] tests: converting normalised coordinates to pixels and back at different container
      sizes; setting time with a clip offset applied
- [ ] failure tests: a clip shorter than the timeline, a missing proxy file
- [ ] run the tests — they must pass before task 14

### Task 14: Camera switch points

**Files:**
- Create: `web/js/cuts.js`
- Create: `web/test/cuts.test.js`
- Modify: `web/index.html`

- [x] model `cuts` as a sparse list: only the moments where the arrangement changes
- [x] `resolveAt(t)` — which camera is in which slot at a given moment
- [x] a timeline strip with switch markers, adding one at the playhead by a hotkey,
      dragging and deleting markers
- [x] a one-button "swap main and inset" action
- [x] tests: `resolveAt` before the first switch, exactly on a boundary, after the last;
      inserting a switch in the middle leaves its neighbours intact
- [x] failure tests: two switches at the same timestamp, a reference to a missing clip
- [x] run the tests — they must pass before task 15

### Task 15: Widget layout and saving layout.json

**Files:**
- Create: `web/js/layout.js`
- Create: `web/test/layout.test.js`
- Modify: `web/index.html`

- [ ] drag widgets with the mouse and change their scale
- [ ] a manual sync-adjustment slider on top of the automatic result
- [ ] choose the output resolution, defaulting to the main camera's
- [x] save and load `layout.json` through `POST /api/layout`
- [ ] validation: coordinates within 0..1, `cuts` referencing existing clips
- [ ] tests: a save/load round trip loses nothing; validation catches out-of-range
      coordinates and broken references
- [ ] run the tests — they must pass before task 16

### Task 16: Exporting the overlay through WebCodecs

**Files:**
- Create: `web/js/export_overlay.js`
- Create: `web/test/export_overlay.test.js`

- [ ] render overlay frames into a canvas at output resolution, stepping by `1/fps`
- [ ] encode to VP9 with alpha through `VideoEncoder`, muxed into WebM
- [ ] **fallback path**: if ffmpeg refuses VP9 alpha, emit a colour plus luma matte pair
      and recombine through `alphamerge` (with `viewer/js/video_export.js` from
      `DDA_Reader` as the model)
- [ ] backpressure control: never queue more than N frames, and show progress
- [ ] send the result to the server and verify ffmpeg reads the file and sees the alpha
- [ ] tests: frame count from duration and fps; backpressure logic against a stub encoder;
      choosing the main or fallback path from a probe result
- [ ] failure tests: WebCodecs unavailable, the encoder erroring mid-run
- [ ] run the tests — they must pass before task 17

### Task 17: The ffmpeg graph generator

**Files:**
- Create: `src/trackoverlay/render.py`
- Create: `tests/test_render.py`
- Modify: `src/trackoverlay/cli.py`

- [ ] build the graph: a black base of the output size, then one identical overlay per
      "camera + time window + slot" triple with `enable='between(t,a,b)'`
- [ ] join chunks with the `concat` demuxer, apply offsets through `-itsoffset`
- [ ] lay `overlay.webm` on as the final layer
- [ ] audio: one chosen camera's track whole, with no mixing
- [ ] encode with `h264_videotoolbox`, quality settings exposed as options
- [ ] CLI `trackoverlay render out/session.json out/layout.json -o out/final.mp4`
- [ ] tests: the graph for one switch has the expected overlay node count and correct
      `enable` windows; a graph with no switches collapses to a single overlay
- [ ] failure tests: an empty `cuts` list, a slot with no camera assigned, a missing file
- [ ] run the tests — they must pass before task 18

### Task 18: The export button and progress

**Files:**
- Modify: `src/trackoverlay/server.py`
- Modify: `web/js/layout.js`
- Create: `web/js/export_ui.js`
- Create: `tests/test_export_flow.py`

- [ ] `POST /api/render` — launch ffmpeg in the background and return a job id
- [ ] `GET /api/render/<id>` — progress parsed out of the ffmpeg output, plus the exit code
- [ ] an export button in the UI: render the overlay in the browser, then run ffmpeg, then
      show the path to the finished file
- [ ] cancelling a running render
- [ ] a golden smoke test: render 10 seconds of session 3429 end to end
- [ ] tests: parsing progress from ffmpeg output; behaviour on a non-zero exit code;
      cancellation killing the process
- [ ] run the tests — they must pass before task 19

### Task 19: Verify acceptance criteria

- [ ] verify every requirement from the Overview is implemented
- [ ] render the full session 3429 with two cameras and at least one switch
- [ ] compare a frame from the preview against the same frame of the rendered file — the
      layout must match pixel for pixel, antialiasing aside
- [ ] check sync accuracy: on a braking frame the widget reading must match what is
      happening in the picture
- [ ] check degradation on session 3430 (video with no GPS): the tool does not fail and
      offers manual adjustment
- [ ] check the edge cases: one camera, zero switches, a clip shorter than the timeline
- [ ] run the whole suite: `uv run pytest && node --test web/test/*.test.js`
- [ ] measure the render time for a 20-minute session and record it in the README

### Task 20: [Final] Update documentation

- [ ] write the `README.md`: installation, the full cycle from files to a finished MP4,
      example commands
- [ ] create a `CLAUDE.md` with the architectural invariants: normalised coordinates, the
      `session.json` contract, why the overlay is drawn only in the browser, where the sync
      correction comes from
- [ ] document the `layout.json` format for hand editing
- [ ] move this plan into `docs/plans/completed/`

## Post-Completion

*Items needing manual intervention or external systems — no checkboxes, informational only*

**Manual checks:**

- judge widget legibility on real onboard footage in motion
- check in sun and shade: overlay contrast against bright tarmac and under trees
- render time on long material: the 74 minutes shot across two days

**Data worth collecting:**

- export the RaceBox session for 3431 (13.09, 08:58) — a second independent set for
  verifying synchronisation, where the video also has clean GPS
- check whether the app holds a session for 12.09 around 16:32 (video 3430, no GPS) —
  the only way to genuinely test the fallback to manual adjustment
- shoot with two cameras at once: all existing footage is single-camera, and PiP and
  switching cannot be verified against it

**External dependencies:**

- behaviour on HEVC footage: everything shot so far is H.264, but GoPro writes HEVC at
  4K60 and above. The architecture allows for it (the browser never decodes the source),
  but it is worth confirming
- other GoPro generations: newer models emit a `GPS9` stream instead of `GPS5`, with a
  different structure
