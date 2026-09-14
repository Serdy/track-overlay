/**
 * scoring.js — a wrapper over sr-track.js: units and sample rate.
 *
 * sr-track itself was carried over from the serious-racing project as-is, along with
 * its unit tests, and should not be edited. But it was written against that site's
 * data, which uses different conventions:
 *
 *   - speed in miles per hour, not km/h;
 *   - longitudinal acceleration in m/s², not g;
 *   - and above all a 10 Hz rate, baked into `DT: 0.1`.
 *
 * RaceBox delivers 25 Hz, that is 2.5 times more samples per second. Constants
 * expressed in samples must be multiplied by that ratio; constants in metres stay put.
 * The slew limiters are the special case: they are a per-sample step, so a higher rate
 * divides them instead.
 */
const Scoring = (function () {

  // Dependencies are resolved inside the closure: globals from sibling <script> tags
  // in the browser, plain require in node. They must not be declared outside — var
  // hoists even out of a branch that never runs and collides with the existing const.
  const SR = (typeof SR_TRACK !== 'undefined') ? SR_TRACK : require('./sr-track.js');
  const SM = (typeof SessionModel !== 'undefined') ? SessionModel : require('./session.js');

  const BASE_RATE = 10;              // the rate sr-track was written against
  const KMH_TO_MPH = 0.621371;
  const G_TO_MS2 = 9.80665;

  // Constants in samples: scale proportionally with the rate.
  const IN_SAMPLES = [
    'diffSpan', 'MIN_RUN', 'ONSET_MIN_SAMPLES',
    'CORNER_LEAN_SMOOTH_WIN', 'CORNER_LEAN_MIN_SAMPLES', 'CORNER_GAP_MERGE',
    'CORNER_SPEED_SMOOTH_WIN', 'CORNER_SPEED_MIN_SEP',
  ];

  // Per-sample limiters: the denser the samples, the smaller the step must be.
  const PER_SAMPLE = ['slewUp', 'slewDown', 'slew'];

  /** sr-track configuration rescaled to the session's sample rate. */
  function cfgForRate(rateHz) {
    const factor = rateHz / BASE_RATE;
    const override = { DT: 1 / rateHz };
    for (const key of IN_SAMPLES) {
      override[key] = Math.max(1, Math.round(SR.DEFAULT_CFG[key] * factor));
    }
    for (const key of PER_SAMPLE) {
      if (SR.DEFAULT_CFG[key] !== undefined) {
        override[key] = SR.DEFAULT_CFG[key] / factor;
      }
    }
    return override;
  }

  /**
   * Acceleration/braking score for the whole session, in the range -1..+1.
   *
   * Computed once on load: it is a pass over all forty thousand samples, which is not
   * something to do on every frame.
   */
  function scoreSession(session) {
    const speed = session.channels.speed;
    const accel = session.channels.accel;
    const lean = session.channels.lean;
    if (!speed || !accel || !lean) return null;

    const n = speed.samples.length;
    const speedMph = new Array(n);
    const accelMs2 = new Array(n);
    const leanDeg = new Array(n);
    for (let i = 0; i < n; i += 1) {
      speedMph[i] = speed.samples[i] * KMH_TO_MPH;
      accelMs2[i] = accel.samples[i] * G_TO_MS2;
      leanDeg[i] = lean.samples[i];
    }

    const cfg = cfgForRate(session.rate);
    const valid = SR.validity(accelMs2, speedMph, leanDeg, cfg);
    return Float64Array.from(SR.computeScore(accelMs2, speedMph, leanDeg, valid, cfg));
  }

  /** Score at an arbitrary moment, interpolated between samples. */
  function scoreAt(scores, session, t) {
    if (!scores || scores.length === 0) return 0;
    const pos = SM.positionAt(session, t);
    const i = Math.floor(pos);
    const next = Math.min(i + 1, scores.length - 1);
    return scores[i] * (1 - (pos - i)) + scores[next] * (pos - i);
  }

  /** Score colour: green under power, red under braking. */
  function colorFor(score, session) {
    return SR.scoreToColor(score, SR.DEFAULT_CFG
      ? Object.assign({}, SR.DEFAULT_CFG, cfgForRate(session.rate))
      : undefined);
  }

  return { BASE_RATE, cfgForRate, scoreSession, scoreAt, colorFor };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Scoring;
} else {
  window.Scoring = Scoring;
}
