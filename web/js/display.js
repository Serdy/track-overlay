/**
 * display.js — turning noisy channels into numbers that hold still.
 *
 * A telemetry channel can be perfectly accurate and still unreadable on screen. Lean on
 * a straight sits near zero with a standard deviation of 2.4°, so rounding it to whole
 * degrees changes the digit **10 times a second** and a ±0.5° direction threshold flips
 * the LEFT/RIGHT label 4.7 times a second. The value is right; the display is unusable.
 *
 * Raising the threshold does not fix it — the value then hovers around the new threshold
 * instead. What fixes it is hysteresis: enter a state at one level and leave it at a
 * lower one, so the boundary can never chatter. The same trick `sr-track.js` uses for
 * brake onsets.
 *
 * Everything here is computed once per session over the whole array rather than per
 * frame. That is not only cheaper — it is what makes the preview and the export produce
 * identical pictures, because a per-frame filter with memory would depend on the order
 * frames were visited in, and scrubbing visits them out of order.
 */
const Display = (function () {

  const SM = (typeof SessionModel !== 'undefined')
    ? SessionModel : require('./session.js');

  // Lean thresholds, chosen from the data: 95% of straight-line samples sit under 4.5°,
  // so entering at 5° leaves straights alone, and leaving at 3° gives a 2° dead band.
  const LEAN_ENTER_DEG = 5.0;
  const LEAN_EXIT_DEG = 3.0;

  // The acceleration score suffers from the same thing, less violently: a plain ±0.08
  // threshold flips the POWER/BRAKING label 1.5 times a second while coasting.
  const SCORE_ENTER = 0.20;
  const SCORE_EXIT = 0.08;

  // Extra smoothing applied before rounding the lean number. Sticky rounding alone hides
  // the flicker but then skips values — on a real corner entry it steps 10, 12, 18, in
  // jumps of up to 6°. Half a second of window ahead of it halves the jump to 3° while
  // still preserving the peak of a corner (47° shown against 47.9° raw).
  const LEAN_SMOOTH_S = 0.3;

  /**
   * Which side a signed value is on: -1, 0 or +1, with a Schmitt trigger.
   *
   * A state is entered only above `enter` and left only below `exit`, so values drifting
   * around a single threshold cannot make it oscillate.
   */
  function sides(values, enter, exit) {
    const out = new Int8Array(values.length);
    let state = 0;
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (state === 0) {
        if (value >= enter) state = 1;
        else if (value <= -enter) state = -1;
      } else if (state > 0 && value < exit) {
        state = value <= -enter ? -1 : 0;
      } else if (state < 0 && value > -exit) {
        state = value >= enter ? 1 : 0;
      }
      out[i] = state;
    }
    return out;
  }

  /**
   * Rounds to whole units but only moves once the value has cleared the current step by
   * `slack`. Without it the digit flickers whenever the value sits on a boundary.
   */
  function stickyRound(values, slack) {
    const out = new Float64Array(values.length);
    let shown = Math.round(values[0] || 0);
    for (let i = 0; i < values.length; i += 1) {
      if (Math.abs(values[i] - shown) > 0.5 + slack) shown = Math.round(values[i]);
      out[i] = shown;
    }
    return out;
  }

  /** Centred moving average with the window given in seconds, not samples. */
  function smooth(values, rateHz, seconds) {
    const width = Math.max(1, Math.round(seconds * rateHz) | 1);
    if (width <= 1) return Float64Array.from(values);
    const half = (width - 1) / 2;
    const out = new Float64Array(values.length);
    for (let i = 0; i < values.length; i += 1) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j += 1) {
        sum += values[j];
        count += 1;
      }
      out[i] = sum / count;
    }
    return out;
  }

  /**
   * Prepares the lean readout: the side to label, and the number to print.
   *
   * Inside the dead band the number is pinned to zero rather than shown as noise — when
   * the bike is upright, "0°" is both calmer and more truthful than a digit that will not
   * settle.
   */
  function lean(samples, rateHz) {
    const eased = smooth(samples, rateHz || 25, LEAN_SMOOTH_S);
    const side = sides(eased, LEAN_ENTER_DEG, LEAN_EXIT_DEG);
    const magnitude = stickyRound(Array.from(eased, Math.abs), 0.5);
    const shown = new Float64Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      shown[i] = side[i] === 0 ? 0 : magnitude[i];
    }
    return { side, value: shown };
  }

  /** Which way the acceleration score points, steadied the same way. */
  function scoreSide(scores) {
    return sides(scores, SCORE_ENTER, SCORE_EXIT);
  }

  /** Nearest precomputed sample for a moment in time; no interpolation, by design. */
  function at(array, session, t) {
    if (!array || !array.length) return 0;
    const index = Math.round(SM.positionAt(session, t));
    return array[Math.min(Math.max(index, 0), array.length - 1)];
  }

  return { LEAN_ENTER_DEG, LEAN_EXIT_DEG, SCORE_ENTER, SCORE_EXIT, LEAN_SMOOTH_S,
           sides, stickyRound, smooth, lean, scoreSide, at };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Display;
} else {
  window.Display = Display;
}
