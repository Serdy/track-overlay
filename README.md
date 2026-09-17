# track-overlay

[![tests](https://github.com/Serdy/track-overlay/actions/workflows/ci.yml/badge.svg)](https://github.com/Serdy/track-overlay/actions/workflows/ci.yml)
[![image](https://github.com/Serdy/track-overlay/actions/workflows/image.yml/badge.svg)](https://github.com/Serdy/track-overlay/pkgs/container/track-overlay)

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
- Keeps a project per track day, so a session is assembled once and reopened later
- Renders the lot into a single MP4, hardware-encoded where the machine has an encoder —
  the whole session, a short preview, or the best lap on its own

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
docker run --rm -p 127.0.0.1:8712:8712 -v "$PWD/data:/data" ghcr.io/serdy/track-overlay
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

If footage a built session names has since been moved or deleted, the panel says which
camera it belonged to and offers to drop it; nothing downstream will run until it is gone
or back, and the export says so before it encodes anything.

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
shows the method and correlation and jumps to the hardest braking point, where the
readouts under the picture are at their most telling: at a braking marker the telemetry
and the frame agree or they visibly do not. The slider shifts one camera, **Next braking**
moves to another one to check against, and **Looks right** confirms it.

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

Press **Export** to compose. Start with the 10-second option to check the layout before
committing to a full session, or pick **best lap** — that renders the quickest lap with
four seconds of approach and the same again of run-off, which is the clip worth sending
to anyone. Only what is kept is composed: a lap from twenty minutes in starts there rather
than being composed from the beginning and cut afterwards.

The tab can be left in the background. The overlay is driven by encoder events rather than
timers, which browsers clamp to about one call a second once a tab stops being visible,
and the progress of the ffmpeg half wakes the moment the page is looked at again.

When it finishes, **Download** saves the file through the browser and **Show in Finder**
reveals it where it already is — which is usually what you want, since a finished render
runs to hundreds of megabytes and downloading writes a second copy onto the same disk.

The same thing from a terminal:

```bash
P=data/slovakia-ring-2026-09-12
uv run trackoverlay render "$P/session.json" "$P/layout.json" \
    --overlay "$P/out/overlay.mp4" -o "$P/out/final.mp4"
```

### Docker

```bash
docker run --rm -p 127.0.0.1:8712:8712 -v "$PWD/data:/data" ghcr.io/serdy/track-overlay
```

The image carries ffmpeg and the tool, and no data: `-v` decides which track days it can
see. Put the footage and the RaceBox exports in `data/<project>/`, or upload them through
the project panel — inside the container there is no file dialog, so the panel offers
**Upload files…** and a drop target instead.

The image is built for amd64 and arm64 on every push to `main` and published to the GitHub
Container Registry; `:latest` tracks `main`, and version tags are published for releases.

The port is published on loopback on purpose. There is no login on any of this — it reads
and writes the disk it is given and runs ffmpeg on request — so it belongs on the machine
in front of you, not on an address anyone else can reach.

Two things worth knowing. Rendering uses libx264 in the container, since VideoToolbox is
macOS-only and would fail rather than fall back — pass `-e TRACKOVERLAY_CODEC=h264_nvenc`
on a box with something faster. And a project folder is portable: a session built on the
host still plays and renders when mounted somewhere else, because files are looked for
beside the project when their recorded path is gone. Footage kept *outside* the project
folder does not travel, so mount it at the same path or keep it inside.

## Deeper in

[docs/internals.md](docs/internals.md) — the command line, the diagnostic tools, the
tests, the file layout, and notes on the parts that were harder than they look:
compositing cost, seeking against offsetting, the three clocks, synchronisation, and how
transparency survives a browser encoder.

## License

MIT — see [LICENSE](LICENSE).
