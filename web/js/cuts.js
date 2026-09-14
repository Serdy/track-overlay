/**
 * cuts.js — which camera sits in which slot, and when that changes.
 *
 * The list is sparse: only the moments where the arrangement **changes** are stored, and
 * it holds between them. That shape is not an optimisation, it is what makes the render
 * simple — every entry maps one-to-one onto an `enable='between(t,a,b)'` window in the
 * ffmpeg filter graph.
 *
 * DOM-free, so the same code answers "what is on screen at 6:11" in the preview, in the
 * graph generator and in tests.
 */
const Cuts = (function () {

  const EPS = 1e-6;

  /** The opening arrangement: first clip in the main slot, second as the inset. */
  function initial(clipIds) {
    const [main = null, pip = null] = clipIds;
    return [{ t: 0, main, pip }];
  }

  function sorted(cuts) {
    return [...cuts].sort((a, b) => a.t - b.t);
  }

  /** The arrangement in force at a given moment. */
  function resolveAt(cuts, t) {
    let current = null;
    for (const cut of sorted(cuts)) {
      if (cut.t <= t + EPS) current = cut;
      else break;
    }
    // Before the first entry nothing is defined; fall back to the earliest one so the
    // preview is never blank.
    return current || sorted(cuts)[0] || null;
  }

  /** Inserts an arrangement, replacing any entry already sitting at that moment. */
  function add(cuts, cut) {
    const kept = cuts.filter((existing) => Math.abs(existing.t - cut.t) > EPS);
    return sorted([...kept, cut]);
  }

  /**
   * Swaps the main view and the inset from this moment on.
   *
   * Returns the list unchanged when there is nothing to swap — a single camera, or an
   * arrangement that already matches what a swap would produce.
   */
  function swapAt(cuts, t) {
    const current = resolveAt(cuts, t);
    if (!current || !current.pip || current.main === current.pip) return cuts;
    return add(cuts, { t, main: current.pip, pip: current.main });
  }

  /**
   * Swaps the cameras for a stretch and puts them back afterwards.
   *
   * This is the operation people actually reach for — "show the other angle through this
   * corner" — rather than two separate swaps. Doing it as two calls to :func:`swapAt`
   * would not work: entries hold an absolute arrangement, so the second call would read
   * the already-swapped state and change nothing.
   */
  function swapRange(cuts, from, to) {
    const before = resolveAt(cuts, from);
    if (!before || !before.pip || before.main === before.pip) return cuts;
    let out = add(cuts, { t: from, main: before.pip, pip: before.main });
    // Everything the stretch covered is replaced, then the original arrangement resumes.
    out = out.filter((cut) => cut.t <= from + EPS || cut.t >= to - EPS);
    return add(out, { t: to, main: before.main, pip: before.pip });
  }

  /** Removes the entry nearest to the given moment, but never the opening one. */
  function removeNear(cuts, t, tolerance) {
    const candidates = cuts.filter((cut) => cut.t > EPS && Math.abs(cut.t - t) <= tolerance);
    if (!candidates.length) return cuts;
    const nearest = candidates.reduce((a, b) =>
      Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b);
    return cuts.filter((cut) => cut !== nearest);
  }

  /** Drops entries that change nothing relative to the one before them. */
  function simplify(cuts) {
    const out = [];
    for (const cut of sorted(cuts)) {
      const previous = out[out.length - 1];
      if (previous && previous.main === cut.main && previous.pip === cut.pip) continue;
      out.push(cut);
    }
    return out;
  }

  /**
   * Expands the sparse list into explicit windows: one entry per slot occupancy with a
   * start and an end. This is the shape the ffmpeg graph generator consumes.
   */
  function windows(cuts, duration) {
    const list = simplify(cuts);
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const from = list[i].t;
      const to = i + 1 < list.length ? list[i + 1].t : duration;
      if (to - from <= EPS) continue;
      for (const slot of ['main', 'pip']) {
        if (list[i][slot]) out.push({ slot, clip: list[i][slot], from, to });
      }
    }
    return out;
  }

  return { initial, resolveAt, add, swapAt, swapRange, removeNear, simplify, windows };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Cuts;
} else {
  window.Cuts = Cuts;
}
