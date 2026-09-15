/**
 * laptimes.js — current, previous and best lap, and the live delta between them.
 *
 * The delta is the part worth care. Comparing elapsed times directly would answer
 * "how long have I been going?", which says nothing until the lap ends. What a rider
 * reads mid-corner is the answer to "at this point on the track, am I up or down?", so
 * the comparison has to be made at equal **distance**, not at equal time.
 *
 * So the best lap is turned into a curve of distance travelled to time taken, and the
 * current lap is looked up in it at the distance covered so far. A lap two seconds
 * quicker reads −2.0 all the way round, rather than drifting from zero.
 *
 * Reference laps use distance rather than the GPS position itself because distance is
 * already a channel, is monotonic within a lap, and does not need a track model. It does
 * assume the same line is roughly followed; taking a wide line adds a little distance and
 * reads as a small loss, which is not wrong.
 */
const LapTimes = (function () {

  /**
   * Prepares the lookups once for a whole session.
   *
   * Everything here is a pass over the distance channel, and there is no reason to redo
   * it per frame - the reference lap only changes when the session does.
   */
  function build(session) {
    const laps = session.laps || [];
    const dist = session.channels && session.channels.dist;
    const best = laps.find((lap) => lap.best) || null;
    return {
      laps,
      best,
      // Distance-to-time for the best lap, or null when there is nothing to compare to.
      reference: best && dist ? curveFor(session, best) : null,
      rate: session.rate,
    };
  }

  /** The best lap as two parallel arrays: metres from the line, seconds since it. */
  function curveFor(session, lap) {
    const dist = session.channels.dist.samples;
    const rate = session.rate;
    const from = Math.max(0, Math.round(lap.t_start * rate));
    const to = Math.min(dist.length - 1, Math.round(lap.t_end * rate));
    if (to <= from) return null;

    const zero = dist[from];
    const s = [];
    const t = [];
    for (let i = from; i <= to; i += 1) {
      const travelled = dist[i] - zero;
      // Distance must climb for the lookup to work; GPS jitter can stall it for a sample.
      if (s.length && travelled <= s[s.length - 1]) continue;
      s.push(travelled);
      t.push((i - from) / rate);
    }
    return s.length > 1 ? { s, t } : null;
  }

  /** Seconds the reference lap had taken by this distance, interpolated. */
  function timeAt(reference, travelled) {
    if (!reference) return null;
    const { s, t } = reference;
    if (travelled <= s[0]) return t[0];
    if (travelled >= s[s.length - 1]) return null;   // past the end: nothing to compare

    let lo = 0;
    let hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= travelled) lo = mid; else hi = mid;
    }
    const span = s[hi] - s[lo];
    const frac = span > 0 ? (travelled - s[lo]) / span : 0;
    return t[lo] + (t[hi] - t[lo]) * frac;
  }

  /**
   * What the widget shows at one moment.
   *
   * `current` is null between laps - on the way out of the pits, or after the flag -
   * and so is `delta`, because there is nothing honest to compare.
   */
  function stateAt(model, session, time) {
    const laps = model.laps;
    const index = laps.findIndex((lap) => time >= lap.t_start && time < lap.t_end);
    const lap = index >= 0 ? laps[index] : null;
    const previous = index > 0 ? laps[index - 1] : null;

    const state = {
      best: model.best ? { n: model.best.n, time: model.best.duration_s } : null,
      previous: previous ? { n: previous.n, time: previous.duration_s } : null,
      current: lap ? { n: lap.n, time: time - lap.t_start } : null,
      delta: null,
    };
    if (!lap || !model.reference) return state;

    const dist = session.channels.dist.samples;
    const at = Math.min(dist.length - 1, Math.max(0, Math.round(time * model.rate)));
    const start = Math.min(dist.length - 1, Math.max(0, Math.round(lap.t_start * model.rate)));
    const reference = timeAt(model.reference, dist[at] - dist[start]);
    if (reference !== null) state.delta = (time - lap.t_start) - reference;
    // The best lap compared against itself is zero by construction; showing a jittering
    // ±0.01 there would only look like a fault.
    if (model.best && lap.n === model.best.n) state.delta = 0;
    return state;
  }

  /** "1:03.7" — minutes only when there are any, and tenths, as a pit board reads. */
  function format(seconds, digits = 1) {
    if (seconds === null || seconds === undefined) return '—';
    const sign = seconds < 0 ? '-' : '';
    const value = Math.abs(seconds);
    const minutes = Math.floor(value / 60);
    const rest = value - minutes * 60;
    if (!minutes) return `${sign}${rest.toFixed(digits)}`;
    return `${sign}${minutes}:${rest.toFixed(digits).padStart(digits ? digits + 3 : 2, '0')}`;
  }

  /** The delta, always signed, because "+0.4" and "0.4" mean opposite things at a glance. */
  function formatDelta(seconds, digits = 2) {
    if (seconds === null || seconds === undefined) return '—';
    const rounded = Number(seconds.toFixed(digits));
    return `${rounded > 0 ? '+' : (rounded < 0 ? '-' : '')}${Math.abs(rounded).toFixed(digits)}`;
  }

  return { build, curveFor, timeAt, stateAt, format, formatDelta };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = LapTimes;
else window.LapTimes = LapTimes;
