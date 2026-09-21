# Internals

The command line, the diagnostic tools, the tests, and the few things that were harder
than they look. The [README](../README.md) covers using the tool itself.

## The command line

Everything the editor does can be done from a terminal, and that is what CI runs:

```bash
uv run trackoverlay build data/slovakia-ring-2026-09-12/*.csv \
    data/slovakia-ring-2026-09-12/*.MP4 \
    --track "Slovakia Ring" -o data/slovakia-ring-2026-09-12/session.json
```

```
session: 25.0 Hz, 40420 samples, 8 laps, best 2:40.349
  ✓ cam_3429: starts -116.14 s, 28.9 min, sync xcorr (corr 0.9997)
  ✓ cam_3446: starts -115.26 s, 11.8 min, sync xcorr (corr 0.9976)
written: data/slovakia-ring-2026-09-12/session.json
```

The tick means the video was aligned by correlating its own GPS speed against the
logger's. A `!` means it fell back to UTC alone — which happens when the camera never
caught satellites, and is still workable from the sync panel.

## Tools

```bash
# Recover the real recording time from GPS and repair the file dates.
uv run python tools/gopro_dates.py --apply data/*/GH*.MP4

# Show how video and telemetry line up, and whether the offset drifts.
uv run python tools/sync_check.py data/*/*.csv data/*/GH*.MP4
```

```
telemetry: 40419 rows, 25.0 Hz, start 12.09 12:31:30 UTC

recording 3429: method xcorr correction -1.36s corr 0.9997 overlap 26.9min
    across 8 windows: median -1.36s, 8 within 0.1s, worst deviation 0.02s
```

## Harder than they look

**Compositing cost.** Full-frame work in the filter graph costs as much as the decode and
the encode together. Scaling a 1920x1080 clip to 1920x1080 is not free, and neither is
laying an opaque full-frame image onto a black canvas - on a 30 second piece the two
together were the difference between 9.5 and 3.6 seconds. So the camera that opens the
main slot becomes the canvas rather than being composited onto one, and a clip that
already matches its slot skips the scaler entirely.

**Seeking, not offsetting.** A clip that starts before session zero has to be seeked into
with `-ss`. A negative `-itsoffset` pushes its frames to negative timestamps, where ffmpeg
drops them, and the usual `setpts=PTS-STARTPTS` then re-zeros whatever survives - quietly
cancelling the sync correction and rendering the clip from its own first frame. The
symptom is a video that looks fine until you notice the telemetry does not match the
picture.

**Synchronisation.** Both devices write UTC, so a coarse alignment is free — but it is
not enough. On the session in `data/` the correlation peak sits 1.4 s away from where UTC
puts it, and 1.4 s is 84 frames at 60 fps. The offset itself is rock steady across 27
minutes, so no drift compensation is needed; what is needed is sub-sample refinement of
the correlation peak, because a 10 Hz search grid only resolves to 6 frames. The offset
is taken as a median across windows, since a stretch of unreliable GPS speed — pulling
away from a standstill on a fresh fix — otherwise drags the whole estimate.

**Three clocks.** Session time is seconds from the start of the logging; output time is
what the finished video shows, and the two part company the moment anything is cut; graph
time is what ffmpeg's filters see, and it starts at the first moment kept. Every
synchronisation bug here has been a confusion of two of the three. A window late in the
session clamped by an *output* length collapsed to nothing and rendered the opening
minutes under the overlay of the chosen lap. Composing from zero and trimming afterwards
did seven times the work for a lap exported from sixteen minutes in — and the progress bar
sat still throughout, because output time does not begin to move until the trim starts
producing frames.

**Transparency.** WebCodecs advertises an `alpha: 'keep'` option that no browser tested
here will actually encode; VP9, VP8, H.264 and AV1 all report support only with alpha
off. So the overlay is written as a frame of double height, colour on top and a greyscale
matte below, and ffmpeg puts them back together with `alphamerge`. One encode and one
file, so the halves cannot drift apart.

The codec matters more than it looks. Apple Silicon has no hardware VP9 encoder, so
libvpx runs in software across several cores — 380-430% CPU against 50-95% for hardware
H.264, at the same throughput. H.264 has to be asked for at level 5.1 or above, because
the doubled frame height exceeds what level 4.0 allows and the browser then reports no
support at all rather than quietly picking a higher level.

## Tests

```bash
uv run pytest && node --test web/test/*.test.js
```

Tests that need the source video skip themselves when it is absent. The MP4s are far too
large for a repository, but the RaceBox exports are not — so most of the suite, including
lap detection against real data from a real track day, runs anywhere.

JavaScript tests are launched through a glob rather than a directory: node 22 and later
try to load `web/test/` as a module.

## Layout

```
src/trackoverlay/
  ingest/gpmf.py      KLV parsing of the GPMF stream
  ingest/clips.py     grouping GoPro chunks, checking the joints
  ingest/racebox.py   the CSV and VBO exports
  telemetry.py        channels and the quantities derived from them
  sync.py             UTC, then cross-correlation, then a manual slider
  laps.py             gates, laps, and the envelope of trajectories
  session.py          assembling session.json
  projects.py         a folder per track day: sources, artifacts, the confirmed sync
  render.py           the ffmpeg filter graph
  server.py           project routes, range requests, and launching renders
web/
  projects.html       the project list; index.html is the editor
  js/clock.js         the single source of the current time
  js/session.js       the session model and channel sampling
  js/cuts.js          which camera is in which slot, and when that changes
  js/ranges.js        which parts of the session reach the video
  js/display.js       turning noisy channels into numbers that hold still
  js/laptimes.js      lap times and the delta measured at equal distance
  js/history.js       undo and redo over layout snapshots
  js/filmstrip.js     where the timeline thumbnails go, and in what order
  js/widgets/         speed, lean bar and dial, acceleration, map, lap board, lap list
  js/export_overlay.js  the telemetry layer, through WebCodecs
```
