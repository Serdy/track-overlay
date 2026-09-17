# Project calibration — track-overlay

## What this software is

A local, single-user tool that burns RaceBox telemetry onto GoPro onboard footage and renders one
MP4. Python assembles and renders; a plain-JavaScript editor in the browser previews, arranges and
draws the overlay layer; ffmpeg does every heavy thing to video. There is no database, no
authentication and no multi-user story: it binds loopback and reads the disk it is given.

Blast radius is a wrong video file and wasted minutes of rendering, never money, safety or other
people's data. Weigh findings against that. A crash with a clear message is a nuisance; a render that
looks right and is silently out of sync is the expensive failure.

## What a real failure looks like here

These are the shapes that have actually cost hours in this repository. Rank a finding by how close it
comes to one of them, not by how unusual the code looks.

- **The preview and the render disagree.** `paintOverlay` in `web/js/state.js` is called by both. Any
  dependency on wall-clock time, window size, playback state, or anything not derived from session
  time makes the finished file differ from what was arranged, and the difference is only visible
  after a multi-minute render.
- **A sync correction that does not reach ffmpeg.** `render.build_plan` reads `clip["offset_s"]` from
  `session.json`. A correction stored anywhere else is preview-only, which is a defect that looks
  like a working feature.
- **Two of the three clocks confused.** Session time (seconds from `session.start_utc`), output time
  (what the finished video shows, which differs the moment anything is cut) and graph time (what
  ffmpeg's filters see, starting at the first kept moment). Mixing any two has produced a window
  rendered from the beginning of the session and a composite doing seven times the work.
- **ffmpeg seeking done wrong.** A negative `-itsoffset` pushes frames to negative timestamps, ffmpeg
  drops them, and `setpts=PTS-STARTPTS` re-zeros the survivors — silently cancelling the correction.
  `-ss` for negative offsets, `-itsoffset` for positive, `setpts` only on seeked inputs.
- **Pixels where fractions belong.** Layout positions are fractions of the frame; `Widgets.boxFor` is
  the single conversion to pixels. A pixel constant in layout or widget code breaks the render at a
  resolution nobody tested.
- **A path from outside becoming a filesystem path anywhere but `projects.read`.** That function
  proves containment within the data root; handlers must not join paths themselves.
- **Something that reads as working but is quietly not there** — a panel hidden by an attribute a CSS
  `display:` rule outranks, an asset URL that 404s in silence, a widget synced and never drawn.

## Scope and conventions that are deliberate

Do not report these as defects. If a finding rests on one of them, it is wrong.

- **No build step, no bundler, no npm, in `web/`.** Plain `<script>` tags in `web/index.html` load in
  order; each module is an IIFE assigned to a global, ending in a dual export (`module.exports` under
  node, `window.X` in the browser) so the same file is unit-tested and shipped. Proposing modules,
  TypeScript, a bundler or a framework is out of scope.
- **`state.js` and `home.js` hold DOM wiring and have no tests, by design.** Logic belongs in the
  pure modules beside them, which are tested. "Add tests for state.js" is not a finding; "this logic
  should have gone in a pure module" is.
- **Standard library only on the Python side**, plus numpy. No web framework, no ORM, no async
  runtime. `http.server` is the deliberate choice for a loopback tool.
- **Comment style is dense and explanatory on purpose** in source files: comments say why, and name
  the failure that motivated the code. Do not propose thinning them. Infrastructure and config files
  (Dockerfile, CI YAML) are the opposite — comments there only for a workaround, an ordering
  constraint or a hidden invariant.
- **Everything in the repository is in English, commit messages included.**
- **Binding loopback with no authentication is the design**, not an oversight. Findings about
  authentication, CSRF, rate limiting or multi-tenancy do not apply. A path-traversal escape from the
  data root does.
- **The parsers are reverse-engineered** from real files, not from specifications. Sanity windows and
  magic constants in `ingest/` are load-bearing and were derived from data; treat them as intentional
  unless the finding shows a specific file they misread.

## Reporting bar

- **major** — one of the failure shapes above, or anything that silently produces a wrong video, loses
  a person's work, or escapes the data root.
- **minor** — a real defect with a bounded, visible consequence: a wrong message, a crash with a
  traceback, a case that cannot occur today but will when a second camera or a third slot arrives.
- Do not raise style, naming, structure or "consider extracting" without a consequence attached.
- Do not raise the absence of a feature that was deliberately left out — a third camera slot, drift
  compensation, audio mixing between cameras, a generic CSV importer, map tiles.
- Test coverage is worth raising only for logic that could silently produce a wrong video; the suites
  are `uv run pytest` and `node --test web/test/*.test.js`.
- Finding nothing is a valid answer.
