# Footage from a camera that has no GPS

## Overview

Every camera but a GoPro arrives without satellite time and without a speed series, which
is what the first two rungs of the sync ladder are built on. Insta360 is the one people
keep asking for — it came up on Facebook the day the repository went public — but the
question is the general one: a phone, a second-hand action cam, a DSLR on a tripod at the
apex.

Nothing here is decided and nothing is being built yet. This is what reconnaissance on
30 September 2026 established, written down so the experiment can be run the moment a
session exists with **both** an Insta360 recording and a RaceBox export of the same ride.
The file we had was a forest ride with no logger, so the last question — does the
correlation actually land — is still open.

## What is already true

**The pipeline tolerates a video without GPS, except for its name.** `_load_chunk` catches
`GpmfError` and carries on, `_check_joints` skips the joint check when there is no
satellite time, and `sync.align` falls back to `manual`. The one hard refusal is upstream:

```
src/trackoverlay/ingest/clips.py:162
    raise ClipError(f"{path.name}: the name does not look like a GoPro file")
```

**With no GPS the clip is pinned to session zero.** `sync.align` computes
`naive = video_times[0] - session_start_utc`, and with no samples that is `0.0`. The sync
panel's slider spans ±5 s, so a video that started three minutes into the session cannot
be brought into place by hand at all.

**The 360 part is not a problem.** Insta360 Studio exports a flat, reframed MP4. Spherical
projection never reaches us.

## What the file said

One `.insv` from an Insta360 X4, firmware v1.9.21, 19 minutes, 19.7 GB, dual 2880×2880
HEVC. The proprietary trailer sits after the MP4 boxes and is found by the magic string
`8db42d694ccc418790edff439fe026bf` in the last 32 bytes; the 8 bytes before it give its
length, counted from the trailer start to the end of the file:

```
mp4 ends          19,646,826,192
trailer length        51,118,701   = to EOF, magic included
```

`exiftool` 13.55 reads it (`-ee -a -api largefilesupport=1`). Two streams:

| stream | rate | step | contents |
| :--- | :--- | :--- | :--- |
| IMU | 1000 Hz | 1.000 ms | angular velocity rad/s, accelerometer g |
| frames | 29.97 Hz | 33.368 ms | one timestamp per video frame |

**Both streams are on one clock**, which is the finding that matters: the IMU starts at
9222.86 ms and the frame stamps at 9206.85 ms. Mapping a gyro sample to a video frame is
exact — there is nothing to estimate inside the file. Only one offset is unknown, the one
between the camera and the logger, and finding a single offset from two series is what
`sync.py` already does.

Sanity of the values: gyro up to 105 °/s on a forest trail, accelerometer magnitude a
median of 1.76 g (p5 0.81, p95 3.14) — bumpy, and plainly in g.

**The camera clock is sound**, unlike a GoPro's. `creation_time` is `2026-05-02T12:11:53Z`
against a filename of `VID_20260502_141153`, which is CEST on the same instant. The GoPro
in `data/` claims 2016 for a 2026 recording, because it takes time from satellites and
never bothers with its own clock. So for an Insta360 the container timestamp is a usable
coarse anchor — seconds out, not years.

## Why the gyro is the right signal, if it can be had

Measured on the committed Slovakia session, 27 minutes at 25 Hz — how far the match can
slide before it decays, which is what sets how finely an offset can be located:

```
speed, which is what sync uses today     0.9 after  2200 ms
lean angle                                          1080 ms
roll rate                                             80 ms
RaceBox's own gyro                                   320 ms
```

Roll rate is between 7 and 27 times sharper than speed. Speed already aligns to better
than a frame at 60 fps, so there is room to spare.

The comparison would be **gyro against gyro** — the camera's IMU against `GyroX/Y/Z`,
which the RaceBox CSV already carries and `ingest/racebox.py` already reads. Two sensors
on one rigid body see the same rotation. Nothing is integrated, so gyro drift, which
ruins most uses of these sensors, never enters.

Two things that cost an hour each to learn, recorded so they are not learned twice:

- **Filter both sides the same or the answer is noise.** The logger's gyro against the
  roll rate we derive from the trajectory correlates 0.31 raw, because our lean is
  smoothed over 0.4 s and a sensor is not. At matched bandwidth it is **0.85**.
- **The mounting angle solves itself.** The camera's axes are not the bike's, but the
  right combination of the three is a least-squares fit, done once per session. On the
  RaceBox the fit returned `[0.92, 0.02, 0.13]`, so that sensor sits almost square.
- One guess that was wrong: that a leaning bike's roll axis mostly reads the yaw it is
  turning at. Fitted, that term contributes 0.002. It is not there.

## What stands in the way

1. **The export loses the trailer.** We cannot render from a 19.7 GB dual-fisheye file, so
   the picture has to come from the Studio export while the IMU comes from the original.
   That needs both files, and needs the export not to have been trimmed — otherwise the
   offset is measured against a file that no longer matches it frame for frame. Comparing
   durations catches the ordinary case.
2. **exiftool stops at 20,000 IMU records**, which is 20 seconds of a 19-minute ride.
   `-ee3` does not lift it. Twenty seconds is probably enough to correlate against, but
   anything more needs our own reader for the trailer, and its internal record layout was
   not cracked — three guesses, three piles of garbage. That is a day's work, not an hour.

## The experiment, when the files exist

Needs one session recorded on both: an Insta360 `.insv`, its Studio export, and the
RaceBox CSV of the same ride. A few laps is plenty.

1. Pull the IMU with exiftool, pair it by document number — the tags come back grouped by
   kind, not interleaved, so pairing by line order is wrong and silently plausible.
2. Resample both gyros onto a common grid and cross-correlate, the same shape as
   `sync.robust_offset`: a median across windows, with the peak refined between samples.
   Fit the three-axis mix first, on a middle stretch where the bike is working.
3. Compare the answer against the truth: put the export into a project beside the GoPro
   recording of the same session if one exists, or confirm by eye in the sync panel on a
   braking point. Anything under a frame at 60 fps means it works.
4. Then, and only then, decide whether this is worth building. If the correlation is as
   sharp as the numbers above suggest, it is the best sync in the tool, better than the
   one used for GoPro.

## The cheap path, if the experiment disappoints

Worth keeping in mind, because it needs no metadata from any camera and makes the tool
work with every one of them:

- Accept foreign file names as a single-chunk clip.
- Take the container timestamp as the coarse anchor when there is no satellite time.
- **Mark one moment.** The telemetry already knows every crossing of the start/finish
  line, from `laps.find_crossings`. Scrub to the frame where the line goes under the
  wheel, press a button, and the offset follows from a single click. It checks itself for
  free: jump to the next crossing, and the picture is either on the line or it is not.
