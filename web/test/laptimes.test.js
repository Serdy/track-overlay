const test = require('node:test');
const assert = require('node:assert');

const LapTimes = require('../js/laptimes.js');

/** A session of three laps at 10 Hz, each a kilometre, driven at a steady pace. */
function session({ speeds = [10, 8, 9] } = {}) {
  const rate = 10;
  const laps = [];
  const dist = [];
  let t = 0;
  let travelled = 0;
  for (let n = 0; n < speeds.length; n += 1) {
    const start = t;
    const step = speeds[n] / rate;              // metres per sample
    for (let s = 0; s < 1000 / speeds[n] * rate; s += 1) {
      dist.push(travelled);
      travelled += step;
      t += 1 / rate;
    }
    laps.push({ n: n + 1, t_start: start, t_end: t, duration_s: t - start, best: false });
  }
  const quickest = laps.reduce((a, b) => (a.duration_s <= b.duration_s ? a : b));
  quickest.best = true;
  return { rate, laps, channels: { dist: { samples: Float64Array.from(dist) } } };
}

test('the best lap becomes a distance-to-time curve', () => {
  const model = LapTimes.build(session());
  assert.strictEqual(model.best.n, 1);           // the quickest lap is the fastest one
  assert.ok(model.reference.s.length > 100);
  // Halfway round the best lap is halfway through its time, at a steady speed.
  const half = LapTimes.timeAt(model.reference, 500);
  assert.ok(Math.abs(half - model.best.duration_s / 2) < 0.2, `got ${half}`);
});

test('the delta is measured at equal distance, not equal time', () => {
  const s = session();
  const model = LapTimes.build(s);
  const slow = s.laps[1];                        // 8 m/s against the best lap's 10 m/s

  // A third of the way round the slow lap: it took longer to get there, so it is down.
  const at = slow.t_start + slow.duration_s / 3;
  const state = LapTimes.stateAt(model, s, at);
  assert.ok(state.delta > 0, `expected a loss, got ${state.delta}`);
  // And by the end the loss is the whole difference between the laps.
  const end = LapTimes.stateAt(model, s, slow.t_end - 0.2);
  assert.ok(Math.abs(end.delta - (slow.duration_s - model.best.duration_s)) < 1,
            `got ${end.delta}`);
});

test('the best lap reads zero against itself rather than jittering', () => {
  const s = session();
  const model = LapTimes.build(s);
  const best = s.laps[0];
  assert.strictEqual(LapTimes.stateAt(model, s, best.t_start + 5).delta, 0);
});

test('current, previous and best are reported together', () => {
  const s = session();
  const model = LapTimes.build(s);
  const state = LapTimes.stateAt(model, s, s.laps[2].t_start + 1);
  assert.strictEqual(state.current.n, 3);
  assert.strictEqual(state.previous.n, 2);
  assert.strictEqual(state.best.n, 1);
  assert.ok(Math.abs(state.current.time - 1) < 0.2);
});

test('between laps there is no current time and no delta', () => {
  const s = session();
  s.laps[0].t_start = 5;                         // an out lap before the timing starts
  const model = LapTimes.build(s);
  const state = LapTimes.stateAt(model, s, 1);
  assert.strictEqual(state.current, null);
  assert.strictEqual(state.delta, null);
  assert.strictEqual(state.best.n, 1);           // the board still shows the best lap
});

test('a session with no laps yields nothing to show', () => {
  const empty = { rate: 10, laps: [], channels: { dist: { samples: Float64Array.from([0]) } } };
  const state = LapTimes.stateAt(LapTimes.build(empty), empty, 1);
  assert.deepStrictEqual(state, { best: null, previous: null, current: null, delta: null });
});

test('lap times read like a pit board', () => {
  assert.strictEqual(LapTimes.format(63.74), '1:03.7');
  assert.strictEqual(LapTimes.format(160.349), '2:40.3');
  assert.strictEqual(LapTimes.format(39.9), '39.9');
  assert.strictEqual(LapTimes.format(null), '—');
});

test('the delta always carries its sign', () => {
  assert.strictEqual(LapTimes.formatDelta(-3.76), '-3.76');
  assert.strictEqual(LapTimes.formatDelta(0.4), '+0.40');
  assert.strictEqual(LapTimes.formatDelta(0), '0.00');
  assert.strictEqual(LapTimes.formatDelta(null), '—');
});
