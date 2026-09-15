# Projects: the whole path from files to editor, inside the UI

## Overview

The tool did all the work but had to be entered from a terminal. Getting to the editor
meant assembling a session by hand (`trackoverlay build data/*.csv data/GH0?3429.MP4`)
and only then running `serve` — and the server refused to start without a finished
`session.json`, so the **Files** button in the editor was a door that could not be reached
without first going round the outside.

This removes that. `uv run trackoverlay` opens a browser on a project list; from there a
project is created, pointed at files, built with a progress bar, checked for sync, and
edited. The terminal is never needed.

It also fixes a real defect found on the way: the `#nudge` slider wrote `layout.nudge_s`
and moved only the `<video>` elements in the preview, while `render.build_plan` reads
`clip["offset_s"]` from `session.json`. A manual sync adjustment never reached the export.

Acceptance criteria:

1. The tool starts with no session and shows what projects exist
2. A project is a folder under `data/`; files added to it are never copied
3. Building reports the stage it is on, not a bar frozen at 10%
4. The sync step shows the offset, its correlation, and a braking frame to judge it by
5. A confirmed correction reaches ffmpeg and survives a rebuild
6. Two browser tabs on two projects cannot write into each other's files

## Development approach

Regular: code, then tests. Every task ends with `uv run pytest` and
`node --test web/test/*.test.js` passing.

## Solution overview

**A project is a folder.** `data/<name>/` holds `project.json` (title, circuit, paths to
sources kept elsewhere, the confirmed sync correction), whatever sources were dropped in,
`session.json`, `layout.json`, and an `out/` directory for everything produced. Sources
are the readable files in the folder plus the registered paths; `out/` is skipped by that
scan, or the rendered `final.mp4` would come back round as an input.

**The project is in the URL, not on the server.** `/p/<name>/api/session` rather than a
mutable "current project". A `<video>` tag issues range requests for minutes, and a
`ThreadingHTTPServer` answers each in its own thread; a switchable current project could
redirect a playing clip into another project's footage, and a stale tab's `POST
/api/layout` would write into the wrong folder. The cost is small: eight URLs in the
browser gain a prefix computed once from `location.pathname`. Job polling stays global, so
`export_ui.js` needs nothing.

**The manual sync correction has one owner each way.** `project.json` keeps what the person
decided, because every rebuild rewrites `session.json`; `session.json` keeps the total in
`offset_s`, because that is the number ffmpeg reads. `sync.align()` already accepted a
`manual_s` argument that nothing passed — wiring it through is what makes a correction
survive a rebuild.

## Implementation steps

### Task 1: The project model

**Files:**
- Create: `src/trackoverlay/projects.py`
- Create: `tests/test_projects.py`

- [x] `Project` dataclass with artifact paths (`session_path`, `layout_path`, `out_dir`)
- [x] `discover` / `read` / `create` / `sources` / `add_sources` / `remove_source`
- [x] name validation and containment in one place, so no handler joins paths itself
- [x] `migrate`: adopt a folder built before projects existed, fold `layout.nudge_s` into
      the session, move old renders into `out/`
- [x] tests for naming, sources, escapes, the confirmed correction and migration

### Task 2: A server that starts without a session

**Files:**
- Modify: `src/trackoverlay/server.py`, `tests/test_server.py`

- [x] `make_server(data_root, *, project=None, session_path=None)`; the class holds only
      `data_root` and an optional bound project, both fixed for its lifetime
- [x] `/p/<name>/…` routing through one resolver; project list routes at the server level
- [x] `MediaCache` keyed by the session file's mtime, replacing the whitelist that the
      build thread used to reach back and mutate
- [x] `/api/sources`, `/api/sync`, `/api/project`; outputs resolve inside `out/`
- [x] stamp asset URLs rooted — from `/p/<name>/` a relative `js/state.js` 404s in silence
- [x] the build thread captures values, not `self`, which is dead by the time it runs
- [x] one build at a time per project
- [x] tests: two projects at once, name escapes, an unbuilt project, the legacy mode

### Task 3: The command line opens the browser

**Files:**
- Modify: `src/trackoverlay/cli.py`

- [x] `trackoverlay` with no subcommand serves the data directory
- [x] `serve --data`, `--project`, and an optional session path for the old way in

### Task 4: Honest build progress

**Files:**
- Modify: `src/trackoverlay/session.py`, `src/trackoverlay/ingest/clips.py`
- Modify: `tests/test_session.py`, `tests/test_clips.py`

- [x] `build_session(..., on_progress)` weighted by where the minutes go: 0.10–0.85 is
      reading video chunks
- [x] `Chunk.gpmd` carries the extracted stream, so alignment stops extracting it a second
      time from a four gigabyte file
- [x] `Job.stage` reaches the browser
- [x] tests: progress is monotonic and reaches 1.0; the stream is extracted once

### Task 5: The project list

**Files:**
- Create: `web/projects.html`, `web/js/projects.js`, `web/js/home.js`
- Create: `web/test/projects.test.js`
- Modify: `web/style.css`

- [x] cards: title, what the project holds or what the session came to, Open / Set up
- [x] creating a project, with the folder name shown while typing
- [x] `[hidden] { display: none !important }` — `display:` rules outranking the attribute
      had already cost one silent bug where an invisible panel ate every click
- [x] tests for the card text and title validation

### Task 6: The project panel in the editor

**Files:**
- Modify: `web/index.html`, `web/js/state.js`

- [x] the old picker becomes the project's own files, with Add files… and Remove
- [x] the circuit name, which used to be reachable only as a CLI flag
- [x] a progress bar with the stage during a build
- [x] an unbuilt project opens this panel instead of failing to load a session

### Task 7: The sync step

**Files:**
- Modify: `web/index.html`, `web/js/state.js`, `web/style.css`

- [x] a panel beside the picture, opened automatically until the sync is confirmed
- [x] per clip: method, correlation, a slider measured from the automatic baseline
- [x] jump to the hardest braking, with the speed trace drawn under the frame
- [x] confirming writes through `/api/sync` to both files
- [x] `layout.nudge_s` and `applyNudge` removed — one correction, one owner

### Task 8: Data, CI and documentation

**Files:**
- Modify: `.github/workflows/ci.yml`, `README.md`, `tests/conftest.py`, `.gitignore`

- [x] the committed telemetry moves into `data/slovakia-ring-2026-09-12/`
- [x] CI builds from there
- [x] README rewritten around `uv run trackoverlay`
- [x] full suite green

### Task 9: Verify acceptance criteria

- [x] the project list serves with no session anywhere
- [x] a real build of the 3429 session (three chunks, 9.8 GB) through the UI
- [x] the sync panel opens by itself, jumps to a braking point at −0.97 G
- [x] a +0.5 s correction lands in both files and survives a rebuild
- [x] a ten second export writes into the project's `out/` and downloads
