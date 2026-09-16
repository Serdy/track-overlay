# track-overlay

[![tests](https://github.com/Serdy/track-overlay/actions/workflows/ci.yml/badge.svg)](https://github.com/Serdy/track-overlay/actions/workflows/ci.yml)

Burns telemetry from a **RaceBox** logger into onboard **GoPro** footage and composes a
finished MP4. Several cameras at once, picture-in-picture, swappable mid-session. Runs
locally — no cloud, no phone, no upload.

![The editor, mid-corner](docs/editor.png)

## Why

Putting telemetry onto track-day footage today means one of two things: a mobile app,
which is slow and gives you the layout it feels like giving you, or hand work in a video
editor, which is long and not repeatable. This does it in one pass, with a layout preset
you set up once and reuse for every session of the day.

## What it does

- Reads the **GPMF** telemetry stream GoPro embeds in the MP4 — satellite time, position,
  speed, fix quality
- Reads the **RaceBox** CSV and VBO exports at 25 Hz
- Aligns the two on one timeline, to better than a frame at 60 fps
- Finds the start/finish line and splits the session into laps, with no external track
  database
- Draws six widgets: speed, lean angle, acceleration/braking, a map of the circuit built
  from your own GPS trace, a lap board (best, previous and current with a live delta) and
  a lap list. "Best" means the best lap finished by that point in the session, so both
  read the way they would have on the bike rather than knowing the session in advance
- Composes any number of cameras with picture-in-picture, lets you swap them over a
  stretch, and cut the ride out and back off the ends
- Renders the lot into a single MP4 with hardware encoding

## How it works

The browser draws and shows, ffmpeg splices.

```
RaceBox CSV ──┐
              ├──→ sync ──→ session.json ──┐
GoPro MP4/LRV ┘        (one timeline)       │
                                            ▼
                                   ┌─────────────────┐
                                   │   web editor    │  preview, layout,
                                   │   (browser)     │  switches, trimming
                                   └────────┬────────┘
                                            │
                            layout.json + overlay.webm
                                            │
     full-resolution source MP4s ───────────┴──→ ffmpeg ──→ out.mp4
```

Three decisions shape everything else:

**The preview plays through `<video>` tags.** The expensive half of an editor — decoding
and scrubbing several streams in step — comes free from the browser. Playback uses
GoPro's own `.LRV` proxies, so scrubbing stays responsive on 4K footage.

**The overlay is drawn once, by one piece of code.** The same canvas routine feeds the
preview and the exporter, so the two cannot drift apart. Every position in the layout is
a fraction of the frame, never a pixel — that is what lets a preview on a window of
whatever size and a render at full resolution produce the same picture.

**Only ffmpeg touches the heavy video.** The browser encodes a small, mostly empty
overlay layer. That is why the GoPro codec never matters and why the whole thing is
quick.

## Requirements

A browser with WebCodecs — Chrome, Edge or a recent Safari — and then either Docker, or
ffmpeg 7 with Python 3.12 through [uv](https://docs.astral.sh/uv/). The encoder is chosen
for the machine: VideoToolbox on macOS, libx264 elsewhere, or whatever
`TRACKOVERLAY_CODEC` names.

## Getting started

With Docker, nothing else to install:

```bash
docker run --rm -p 8712:8712 -v "$PWD/data:/data" ghcr.io/serdy/track-overlay
```

Or from a checkout:

```bash
uv sync
uv run trackoverlay
```

Either way, open <http://127.0.0.1:8712/> and everything happens there: making a project,
pointing it at files, building the session, checking the sync, arranging the layout and
exporting. Nothing has to be run from a terminal first.

### 1. Make a project

A project is a folder under `data/`, one per track day:

```
data/slovakia-ring-2026-09-12/
  project.json          the title, the circuit, files kept elsewhere, the confirmed sync
  RaceBox ….csv         small sources can simply live here
  session.json          what the build produced
  layout.json           the arrangement
  out/                  everything rendered: overlay.mp4, final.mp4, work/
```

Press **New project**, name it, then **Add files…**. That opens the macOS file dialog and
notes down the paths — nothing is copied, because the server reads the same disk the
camera card is on and pushing twenty-four gigabytes through a browser to reach it would
be pure waste. Files dropped into the folder by hand are picked up as well, so a project
can also be assembled in Finder.

Under Docker there is no dialog to open and the container's disk is not the disk the
footage is on, so the button becomes **Upload files…** — files can also be dropped onto
the panel. That copies them into the project folder, which is slow for a four gigabyte
chunk but is the only thing that can work there. Dropping them into `data/<project>/`
from outside is quicker and needs no upload at all.

Select every chunk of a GoPro recording (`GH013429.MP4`, `GH023429.MP4`, …): they are one
clip split at four gigabytes and are joined back together automatically. More files can be
added to a project later — a second camera, another chunk — and rebuilt.

RaceBox exports twice, because its **Bike Mode** setting replaces lateral acceleration
with lean angle rather than adding it. Export the session both ways and keep both files;
`merge` folds them into one set of channels. The VBO is optional — it carries a `heading`
column the CSV lacks, which makes the lean angle slightly cleaner.

If the GoPro clock has drifted and the file dates are nonsense, fix them from satellite
time:

```bash
uv run python tools/gopro_dates.py --apply data/*/GH*.MP4
```

### 2. Build, then check the sync

**Build session** reads the telemetry, pulls the GPS track out of each video chunk, aligns
the two and marks out the laps. Reading the chunks is where the time goes, so the bar
names the file it is on.

The editor then opens on the sync check, because everything downstream rests on that one
number and the machine's answer is only as good as the overlap it had to work with. It
shows the method and correlation, jumps to the hardest braking point, and draws the speed
trace under the picture: at a braking marker the two agree or they visibly do not. The
slider shifts one camera; **Looks right** confirms it.

A confirmed correction is kept in `project.json` and folded into `session.json`, which is
what the renderer reads — so unlike the old preview-only slider, it reaches the finished
video. It also survives a rebuild.

### 3. Arrange and export

Open a project from the list, or go straight to it:

```bash
uv run trackoverlay serve --project slovakia-ring-2026-09-12
```

| Action | How |
| :--- | :--- |
| Play / pause | Space |
| Step one frame | ← → (Shift for ten) |
| Jump between laps | ↑ ↓ |
| Move a widget or the inset | drag it |
| Resize one | wheel over it |
| Swap the cameras from here | `⇄` or S |
| Swap them over a stretch | `⇄ …` or D, twice: start then end |
| Cut a stretch out | `✂ …` or X, twice |
| Trim to the timed laps, and back | `laps` — lit while trimmed |
| Undo one change | `↶` or ⌘Z (⇧⌘Z to redo) |
| Undo all of it | `↺` |
| Sound from the main camera | `🔇` or M |
| Choose which widgets show | `⊞ widgets` |
| Check the sync again | `⇆ sync` |
| Back to the project list | `☰ Projects` |

Everything is saved to the project's `layout.json` as you go, and reloaded next time. The
timeline carries thumbnails from the opening camera, so a place worth cutting or swapping
at can be found by eye.

When it finishes, **Download** saves the file through the browser and **Show in Finder**
reveals it where it already is — which is usually what you want, since a finished render
runs to hundreds of megabytes and downloading writes a second copy onto the same disk.

Press **Export** to compose. Start with the 10-second option to check the layout before
committing to a full session, or pick **best lap** — that renders the quickest lap with
four seconds of approach and the same again of run-off, which is the clip worth sending
to anyone. The tab can be left in the background while it runs - the
render loop is driven by encoder events rather than timers, which browsers clamp to about
one call a second once a tab stops being visible. The same thing from a terminal:

```bash
P=data/slovakia-ring-2026-09-12
uv run trackoverlay render "$P/session.json" "$P/layout.json" \
    --overlay "$P/out/overlay.mp4" -o "$P/out/final.mp4"
```

### Docker

```bash
docker run --rm -p 8712:8712 -v "$PWD/data:/data" ghcr.io/serdy/track-overlay
```

The image carries ffmpeg and the tool, and no data: `-v` decides which track days it can
see. Put the footage and the RaceBox exports in `data/<project>/`, or upload them through
the project panel — inside the container there is no file dialog, so the panel offers
**Upload files…** and a drop target instead.

The image is built for amd64 and arm64 on every push to `main` and published to the GitHub
Container Registry; `:latest` tracks `main`, and version tags are published for releases.

Two things worth knowing. Rendering uses libx264 in the container, since VideoToolbox is
macOS-only and would fail rather than fall back — pass `-e TRACKOVERLAY_CODEC=h264_nvenc`
on a box with something faster. And a project folder is portable: a session built on the
host still plays and renders when mounted somewhere else, because files are looked for
beside the project when their recorded path is gone. Footage kept *outside* the project
folder does not travel, so mount it at the same path or keep it inside.

### From a script instead

The command line still does the same work, which is what CI runs:

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

## Two things that were harder than they look

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
  js/clock.js         the single source of the current time
  js/session.js       the session model and channel sampling
  js/cuts.js          which camera is in which slot, and when that changes
  js/ranges.js        which parts of the session reach the video
  js/display.js       turning noisy channels into numbers that hold still
  js/laptimes.js      lap times and the delta measured at equal distance
  js/history.js       undo and redo over layout snapshots
  js/filmstrip.js     where the timeline thumbnails go, and in what order
  js/widgets/         speed, lean, acceleration, map, lap board, lap list
  js/export_overlay.js  the telemetry layer, through WebCodecs
```

## Credits

The acceleration and braking score comes from
[serious-racing](https://github.com/Serdy/serious-racing) — `sr-track.js` was carried over
whole, with its constants rescaled from 10 Hz to 25 Hz. Some of the parsing approach and
the gate detection follow an earlier project of mine,
[DDA_Reader](https://github.com/slowfastguy/DDA_Reader), which does the same job for
Ducati's own logger.

## License

MIT — see [LICENSE](LICENSE).
