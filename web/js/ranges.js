/**
 * ranges.js — which parts of the session end up in the video.
 *
 * Stored as the stretches that are **kept**, not the ones cut out. Trimming a long in-lap
 * off the front is then one range, dropping something from the middle is two, and the
 * render is simply their concatenation. Modelling it the other way round — a list of
 * holes — would need the same mapping logic plus a subtraction step on top.
 *
 * The consequence to keep in mind is that output time and session time stop being the
 * same thing once anything is cut. Telemetry is always addressed in session time, while
 * the exported frames run in output time, so every crossing between the two goes through
 * `toSession` and `toOutput` rather than being assumed equal.
 */
const Ranges = (function () {

  const EPS = 1e-6;

  function full(duration) {
    return [{ from: 0, to: duration }];
  }

  /** Sorts, clamps and folds touching stretches into one. */
  function normalise(ranges, duration) {
    const clean = (ranges || [])
      .map((r) => ({ from: Math.max(0, r.from), to: Math.min(duration, r.to) }))
      .filter((r) => r.to - r.from > EPS)
      .sort((a, b) => a.from - b.from);

    const out = [];
    for (const range of clean) {
      const last = out[out.length - 1];
      if (last && range.from <= last.to + EPS) last.to = Math.max(last.to, range.to);
      else out.push({ ...range });
    }
    return out;
  }

  /** Removes a stretch, splitting a range in two when the cut lands inside one. */
  function cut(ranges, from, to, duration) {
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    const out = [];
    for (const range of ranges) {
      if (hi <= range.from + EPS || lo >= range.to - EPS) {
        out.push({ ...range });                      // untouched
        continue;
      }
      if (lo > range.from + EPS) out.push({ from: range.from, to: lo });
      if (hi < range.to - EPS) out.push({ from: hi, to: range.to });
    }
    return normalise(out, duration);
  }

  /** Throws everything outside the stretch away — the trim-to-selection case. */
  function keepOnly(ranges, from, to, duration) {
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    return normalise(ranges.map((range) => ({
      from: Math.max(range.from, lo),
      to: Math.min(range.to, hi),
    })), duration);
  }

  /** Length of the finished video. */
  function total(ranges) {
    return ranges.reduce((sum, range) => sum + (range.to - range.from), 0);
  }

  /** Output time to session time. */
  function toSession(ranges, outputTime) {
    let seen = 0;
    for (const range of ranges) {
      const length = range.to - range.from;
      if (outputTime < seen + length - EPS) return range.from + (outputTime - seen);
      seen += length;
    }
    const last = ranges[ranges.length - 1];
    return last ? last.to : 0;
  }

  /** Session time to output time, or null when that moment was cut out. */
  function toOutput(ranges, sessionTime) {
    let seen = 0;
    for (const range of ranges) {
      if (sessionTime >= range.from - EPS && sessionTime <= range.to + EPS) {
        return seen + (sessionTime - range.from);
      }
      seen += range.to - range.from;
    }
    return null;
  }

  function isKept(ranges, sessionTime) {
    return toOutput(ranges, sessionTime) !== null;
  }

  /** The stretches that were dropped — what the timeline needs to grey out. */
  function gaps(ranges, duration) {
    const out = [];
    let cursor = 0;
    for (const range of ranges) {
      if (range.from > cursor + EPS) out.push({ from: cursor, to: range.from });
      cursor = range.to;
    }
    if (duration > cursor + EPS) out.push({ from: cursor, to: duration });
    return out;
  }

  /**
   * Trims to the timed laps, dropping the ride out to the track and back.
   *
   * This is the case that actually comes up: the in-lap runs for minutes before the first
   * flying lap, and the cool-down after the last one is just as long.
   */
  function lapsOnly(laps, duration) {
    if (!laps || !laps.length) return full(duration);
    return normalise([{ from: laps[0].t_start, to: laps[laps.length - 1].t_end }], duration);
  }

  return { full, normalise, cut, keepOnly, total, toSession, toOutput, isKept, gaps, lapsOnly };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Ranges;
} else {
  window.Ranges = Ranges;
}
