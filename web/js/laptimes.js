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
 *
 * "Best" means the best lap **completed by now**, not the best of the session. A board
 * that already knows what the session is going to produce is a replay artefact: on lap
 * one there is nothing to be down against, and the delta has to appear when the first
 * lap does. It also keeps the reference honest, since the lap being driven is never
 * compared against itself.
 */
const LapTimes = (function () {

  // How the delta is held still: sampled on a quarter-second grid, averaged over the
  // half second behind it. Both in session time, so a frame always draws the same value.
  const STEP = 0.25;
  const SMOOTH_WINDOW = 0.5;
  const SMOOTH_SAMPLES = 5;

  /**
   * Prepares the lookups once for a whole session.
   *
   * Everything here is a pass over the distance channel, and there is no reason to redo
   * it per frame - the reference lap only changes when the session does.
   */
  function build(session) {
    const laps = session.laps || [];
    const dist = session.channels && session.channels.dist;
    return {
      laps,
      rate: session.rate,
      // One distance-to-time curve per lap. Which one is the reference depends on where
      // the playhead is, so they are all prepared once rather than rebuilt as laps end.
      curves: dist ? laps.map((lap) => curveFor(session, lap)) : laps.map(() => null),
    };
  }

  /**
   * The quickest lap finished by this moment, and its curve.
   *
   * A lap counts as finished when it ends, so the one being driven never becomes its own
   * reference - which would read zero all the way round and mean nothing.
   */
  function bestBy(model, time) {
    let best = null;
    let curve = null;
    model.laps.forEach((lap, i) => {
      if (lap.t_end > time) return;
      if (best === null || lap.duration_s < best.duration_s) {
        best = lap;
        curve = model.curves[i];
      }
    });
    return { lap: best, curve };
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
    const best = bestBy(model, time);

    const state = {
      best: best.lap ? { n: best.lap.n, time: best.lap.duration_s } : null,
      previous: previous ? { n: previous.n, time: previous.duration_s } : null,
      current: lap ? { n: lap.n, time: time - lap.t_start } : null,
      delta: null,
    };
    if (lap && best.curve) state.delta = steadyDelta(model, session, lap, best.curve, time);
    return state;
  }

  /**
   * The delta, held still enough to read.
   *
   * Raw, it is the difference of two noisy quantities and twitches by hundredths many
   * times a second - unreadable at a glance, which is the only way anyone reads it. Two
   * things settle it: the value is sampled on a fixed grid rather than every frame, and
   * each sample is the mean over a short window.
   *
   * Both are keyed to session time, never to the wall clock, so the same frame always
   * produces the same number. The preview and the render draw through this same code,
   * and a value that depended on when it was asked would make them disagree.
   */
  function steadyDelta(model, session, lap, curve, time) {
    const at = Math.floor(time / STEP) * STEP;
    let total = 0;
    let taken = 0;
    for (let i = 0; i < SMOOTH_SAMPLES; i += 1) {
      const moment = at - (i * SMOOTH_WINDOW) / SMOOTH_SAMPLES;
      if (moment < lap.t_start) break;
      const value = rawDelta(model, session, lap, curve, moment);
      if (value === null) continue;
      total += value;
      taken += 1;
    }
    return taken ? total / taken : null;
  }

  function rawDelta(model, session, lap, curve, time) {
    const dist = session.channels.dist.samples;
    const index = (t) => Math.min(dist.length - 1, Math.max(0, Math.round(t * model.rate)));
    const reference = timeAt(curve, dist[index(time)] - dist[index(lap.t_start)]);
    return reference === null ? null : (time - lap.t_start) - reference;
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

  return { STEP, build, curveFor, timeAt, bestBy, stateAt, format, formatDelta };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = LapTimes;
else window.LapTimes = LapTimes;
