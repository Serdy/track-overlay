const test = require('node:test');
const assert = require('node:assert');
const SR_TRACK = require('../js/sr-track.js');
const SessionModel = require('../js/session.js');
const Scoring = require('../js/scoring.js');

test('константы в сэмплах масштабируются вместе с частотой', () => {
  const cfg = Scoring.cfgForRate(25);
  assert.strictEqual(cfg.DT, 0.04);
  assert.strictEqual(cfg.diffSpan, Math.round(SR_TRACK.DEFAULT_CFG.diffSpan * 2.5));
  assert.strictEqual(cfg.ONSET_MIN_SAMPLES, 10);      // 0.4 с при 25 Гц
  assert.strictEqual(cfg.CORNER_SPEED_MIN_SEP, 25);   // 1.0 с при 25 Гц
});

test('ограничители на сэмпл наоборот уменьшаются', () => {
  // Это шаг оценки за сэмпл: чаще сэмплы — меньше шаг, иначе реакция станет резче.
  const cfg = Scoring.cfgForRate(25);
  assert.ok(Math.abs(cfg.slewUp - SR_TRACK.DEFAULT_CFG.slewUp / 2.5) < 1e-9);
  assert.ok(Math.abs(cfg.slewDown - SR_TRACK.DEFAULT_CFG.slewDown / 2.5) < 1e-9);
});

test('на родной частоте конфигурация не меняется', () => {
  const cfg = Scoring.cfgForRate(Scoring.BASE_RATE);
  assert.strictEqual(cfg.DT, 0.1);
  assert.strictEqual(cfg.diffSpan, SR_TRACK.DEFAULT_CFG.diffSpan);
  assert.strictEqual(cfg.slewUp, SR_TRACK.DEFAULT_CFG.slewUp);
});

test('константы в метрах не трогаются', () => {
  const cfg = Scoring.cfgForRate(25);
  assert.strictEqual(cfg.ONSET_MIN_DIST, undefined);        // не переопределяем
  assert.strictEqual(cfg.CORNER_MATCH_WINDOW, undefined);
});

function synthetic(pattern) {
  // Скорость в км/ч, ускорение в g, наклон в градусах — как в session.json.
  const n = pattern.length;
  return SessionModel.load({
    session: { start_utc: 'x', duration_s: n / 25, rate_hz: 25 },
    channels: {
      speed: { role: 'speed', unit: 'km/h', samples: pattern.map((p) => p.speed) },
      accel: { role: 'accel_long', unit: 'g', samples: pattern.map((p) => p.accel) },
      lean: { role: 'lean', unit: 'deg', samples: pattern.map(() => 0) },
    },
    laps: [],
  });
}

test('торможение даёт отрицательную оценку, разгон положительную', () => {
  const braking = Array.from({ length: 200 }, (_, i) => ({ speed: 200 - i * 0.5, accel: -0.8 }));
  const pushing = Array.from({ length: 200 }, (_, i) => ({ speed: 60 + i * 0.5, accel: +0.6 }));

  const brakeScores = Scoring.scoreSession(synthetic(braking));
  const pushScores = Scoring.scoreSession(synthetic(pushing));
  const tail = (a) => Array.from(a.slice(-50)).reduce((s, v) => s + v, 0) / 50;

  assert.ok(tail(brakeScores) < -0.3, `ожидалась отрицательная оценка, вышло ${tail(brakeScores)}`);
  assert.ok(tail(pushScores) > +0.3, `ожидалась положительная оценка, вышло ${tail(pushScores)}`);
});

test('без нужных каналов оценка не считается, но и не падает', () => {
  const session = SessionModel.load({
    session: { start_utc: 'x', duration_s: 1, rate_hz: 25 },
    channels: { speed: { role: 'speed', unit: 'km/h', samples: [1, 2] } },
    laps: [],
  });
  assert.strictEqual(Scoring.scoreSession(session), null);
});

test('выборка оценки интерполируется и зажимается по краям', () => {
  const scores = Float64Array.from([0, 1, 0]);
  const session = SessionModel.load({
    session: { start_utc: 'x', duration_s: 1, rate_hz: 2 },
    channels: { speed: { role: 'speed', unit: 'km/h', samples: [0, 0, 0] } },
    laps: [],
  });
  assert.strictEqual(Scoring.scoreAt(scores, session, 0.25), 0.5);
  assert.strictEqual(Scoring.scoreAt(scores, session, -5), 0);
  assert.strictEqual(Scoring.scoreAt(scores, session, 99), 0);
  assert.strictEqual(Scoring.scoreAt(null, session, 0), 0);
});
