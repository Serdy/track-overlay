# track-overlay

Overlays telemetry from a **RaceBox** logger onto onboard **GoPro** footage and produces
a finished MP4. Runs locally — no cloud, no phone.

Supports several cameras at once: a main view plus a picture-in-picture inset, with the
two swappable at arbitrary points during a session.

## Status

Work in progress. Plan: [`docs/plans/20260914-gopro-telemetry-overlay.md`](docs/plans/20260914-gopro-telemetry-overlay.md)

## How it works

The browser draws and shows, ffmpeg splices.

```
RaceBox CSV ──┐
              ├──→ sync ──→ session.json ──→ web editor ──┐
GoPro MP4/LRV ┘                                           │
                                   layout.json + overlay.webm
                                                          │
       full-resolution source MP4s ───────────────────────┴──→ ffmpeg ──→ out.mp4
```

The preview plays through `<video>` tags, so the browser handles the expensive part —
decoding and synchronised scrubbing of several streams. The overlay is drawn once, by
one piece of code, and the same canvas feeds both the preview and the export. Heavy
video is touched only by ffmpeg, which is why the GoPro codec never matters.

## Requirements

ffmpeg 7+, Python 3.12 (through `uv`), and a browser with WebCodecs support.

## Usage

```bash
uv sync                                                        # install

uv run trackoverlay build data/*.csv data/*.vbo data/GH*.MP4 -o out/session.json
uv run trackoverlay serve out/session.json                     # editor in the browser
```

`build` parses the RaceBox export and the GoPro GPMF stream, aligns them on one time
axis, detects the start/finish line, splits the session into laps and writes
`session.json`. `serve` opens the editor against that file.

### Editor controls

| Action | Key |
| :--- | :--- |
| Play / pause | Space |
| Step one frame | ← → (Shift for ten) |
| Jump between laps | ↑ ↓ |
| Playback rate | the `1×` button |
| Seek | click or drag the timeline |

## Utilities

```bash
# Recover the real recording time from GPS and repair the file dates.
# The GoPro clock drifts; satellite time inside the GPMF stream does not.
uv run python tools/gopro_dates.py --apply data/*.MP4

# Diagnose how video and telemetry line up, and whether the offset drifts.
uv run python tools/sync_check.py data/*.csv data/GH*.MP4
```

## Tests

```bash
uv run pytest && node --test web/test/*.test.js
```

JavaScript tests are launched through a glob rather than a directory: node 26 tries to
load `web/test/` as a module.

Tests that need the source video skip themselves when it is absent — the MP4 files are
not in the repository, but the RaceBox exports are, so most of the suite runs anywhere.
