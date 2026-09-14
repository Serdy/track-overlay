/**
 * scoring.js — обёртка над sr-track.js: единицы и частота.
 *
 * Сам sr-track перенесён из проекта serious-racing как есть, вместе с юнит-тестами, и
 * правиться не должен. Но писался он под данные того сайта, а там своя система мер:
 *
 *   - скорость в милях в час, а не в км/ч;
 *   - продольное ускорение в м/с², а не в g;
 *   - и главное, частота 10 Гц, зашитая в `DT: 0.1`.
 *
 * RaceBox даёт 25 Гц, то есть в 2.5 раза больше сэмплов на ту же секунду. Константы,
 * заданные в сэмплах, надо умножить на это отношение, а заданные в метрах — оставить
 * как есть. Отдельный случай — ограничители скорости изменения оценки: это величина
 * «на сэмпл», поэтому при росте частоты она наоборот делится.
 */
const Scoring = (function () {

  // Зависимости разрешаются внутри замыкания: в браузере это глобали от соседних
  // тегов <script>, в node — обычный require. Объявлять их снаружи нельзя — var
  // всплывает даже из невыполненной ветки и конфликтует с уже объявленным const.
  const SR = (typeof SR_TRACK !== 'undefined') ? SR_TRACK : require('./sr-track.js');
  const SM = (typeof SessionModel !== 'undefined') ? SessionModel : require('./session.js');

  const BASE_RATE = 10;              // частота, под которую писался sr-track
  const KMH_TO_MPH = 0.621371;
  const G_TO_MS2 = 9.80665;

  // Константы в сэмплах: масштабируются пропорционально частоте.
  const IN_SAMPLES = [
    'diffSpan', 'MIN_RUN', 'ONSET_MIN_SAMPLES',
    'CORNER_LEAN_SMOOTH_WIN', 'CORNER_LEAN_MIN_SAMPLES', 'CORNER_GAP_MERGE',
    'CORNER_SPEED_SMOOTH_WIN', 'CORNER_SPEED_MIN_SEP',
  ];

  // Ограничители «на сэмпл»: чем чаще сэмплы, тем меньше должен быть шаг.
  const PER_SAMPLE = ['slewUp', 'slewDown', 'slew'];

  /** Конфигурация sr-track, пересчитанная под частоту сессии. */
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
   * Оценка разгона и торможения для всей сессии, диапазон -1..+1.
   *
   * Считается один раз при загрузке: это проход по всем сорока тысячам сэмплов, на
   * каждом кадре такое делать нельзя.
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

  /** Оценка в произвольный момент, с интерполяцией между сэмплами. */
  function scoreAt(scores, session, t) {
    if (!scores || scores.length === 0) return 0;
    const pos = SM.positionAt(session, t);
    const i = Math.floor(pos);
    const next = Math.min(i + 1, scores.length - 1);
    return scores[i] * (1 - (pos - i)) + scores[next] * (pos - i);
  }

  /** Цвет оценки: зелёный на разгоне, красный на торможении. */
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
