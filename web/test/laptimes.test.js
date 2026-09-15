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

test('a finished lap becomes a distance-to-time curve', () => {
  const s = session();
  const model = LapTimes.build(s);
  const best = LapTimes.bestBy(model, Infinity);
  assert.strictEqual(best.lap.n, 1);             // the quickest lap is the fastest one
  assert.ok(best.curve.s.length > 100);
  // Halfway round it is halfway through its time, at a steady speed.
  const half = LapTimes.timeAt(best.curve, 500);
  assert.ok(Math.abs(half - best.lap.duration_s / 2) < 0.2, `got ${half}`);
});

test('there is no best lap until one has been finished', () => {
  const s = session();
  const model = LapTimes.build(s);
  const early = LapTimes.stateAt(model, s, s.laps[0].t_start + 5);
  assert.strictEqual(early.best, null);
  assert.strictEqual(early.delta, null);         // nothing to be up or down against
});

test('the first lap finished is the best, however slow', () => {
  const s = session({ speeds: [5, 10, 8] });     // the opening lap is the slowest of all
  const model = LapTimes.build(s);
  const onLapTwo = LapTimes.stateAt(model, s, s.laps[1].t_start + 5);
  assert.strictEqual(onLapTwo.best.n, 1);
});

test('the best changes as a quicker lap is completed, not before', () => {
  const s = session({ speeds: [5, 10, 8] });
  const model = LapTimes.build(s);
  // Lap 2 is quicker, but only counts once it has ended.
  assert.strictEqual(LapTimes.stateAt(model, s, s.laps[1].t_end - 1).best.n, 1);
  assert.strictEqual(LapTimes.stateAt(model, s, s.laps[2].t_start + 1).best.n, 2);
});

test('the delta is measured at equal distance, not equal time', () => {
  const s = session();
  const model = LapTimes.build(s);
  const slow = s.laps[1];                        // 8 m/s against lap one's 10 m/s

  // A third of the way round the slow lap: it took longer to get there, so it is down.
  const at = slow.t_start + slow.duration_s / 3;
  const state = LapTimes.stateAt(model, s, at);
  assert.ok(state.delta > 0, `expected a loss, got ${state.delta}`);
  // And by the end the loss is the whole difference between the laps.
  const end = LapTimes.stateAt(model, s, slow.t_end - 0.2);
  const reference = LapTimes.bestBy(model, slow.t_start).lap;
  assert.ok(Math.abs(end.delta - (slow.duration_s - reference.duration_s)) < 1,
            `got ${end.delta}`);
});

test('a lap is never its own reference', () => {
  // Otherwise the quickest lap of the session would read a flat zero all the way round,
  // which says nothing at all.
  const s = session({ speeds: [10, 5] });
  const model = LapTimes.build(s);
  const onBest = LapTimes.stateAt(model, s, s.laps[0].t_start + 5);
  assert.strictEqual(onBest.best, null);
  assert.strictEqual(onBest.delta, null);
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
  assert.strictEqual(state.best, null);          // nothing has been finished yet
});

test('the delta holds still between grid steps', () => {
  // A number that twitches every frame cannot be read at a glance, and a glance is the
  // only way it ever gets read.
  const s = session({ speeds: [10, 8] });
  const model = LapTimes.build(s);
  // Just inside a step, so every offset below stays within the same one.
  const at = Math.floor((s.laps[1].t_start + 20) / LapTimes.STEP) * LapTimes.STEP + 0.01;
  const held = LapTimes.stateAt(model, s, at).delta;
  for (const step of [0.02, 0.08, LapTimes.STEP - 0.02]) {
    assert.strictEqual(LapTimes.stateAt(model, s, at + step).delta, held);
  }
});

test('the delta does move on to the next grid step', () => {
  const s = session({ speeds: [10, 8] });
  const model = LapTimes.build(s);
  const at = Math.floor((s.laps[1].t_start + 20) / LapTimes.STEP) * LapTimes.STEP + 0.01;
  assert.notStrictEqual(LapTimes.stateAt(model, s, at + LapTimes.STEP).delta,
                        LapTimes.stateAt(model, s, at).delta);
});

test('noise in the distance channel does not reach the delta', () => {
  const clean = session({ speeds: [10, 8] });
  const noisy = session({ speeds: [10, 8] });
  const samples = noisy.channels.dist.samples;
  for (let i = 0; i < samples.length; i += 1) samples[i] += (i % 2 ? 0.6 : -0.6);

  const at = clean.laps[1].t_start + 20;
  const a = LapTimes.stateAt(LapTimes.build(clean), clean, at).delta;
  const b = LapTimes.stateAt(LapTimes.build(noisy), noisy, at).delta;
  assert.ok(Math.abs(a - b) < 0.1, `smoothing let ${Math.abs(a - b)}s of jitter through`);
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


test('the lap list puts the lap in progress on top, finished laps under it', () => {
  const s = session({ speeds: [10, 8, 9] });
  const model = LapTimes.build(s);
  const rows = LapTimes.boardAt(model, s.laps[2].t_start + 10);

  assert.deepStrictEqual(rows.map((row) => row.n), [3, 2, 1]);
  assert.strictEqual(rows[0].running, true);
  assert.ok(Math.abs(rows[0].time - 10) < 0.2);
  assert.strictEqual(rows[1].time, s.laps[1].duration_s);
});

test('the lap list never shows a lap that has not started', () => {
  const s = session({ speeds: [10, 8, 9] });
  const model = LapTimes.build(s);
  assert.deepStrictEqual(LapTimes.boardAt(model, s.laps[0].t_start + 1).map((r) => r.n), [1]);
});

test('the best lap so far is marked, and never the running one', () => {
  const s = session({ speeds: [8, 10, 9] });     // lap two is the quickest
  const model = LapTimes.build(s);
  const rows = LapTimes.boardAt(model, s.laps[2].t_start + 5);
  assert.deepStrictEqual(rows.filter((row) => row.best).map((row) => row.n), [2]);
  assert.strictEqual(rows[0].best, false);
});

test('the lap list is capped at what fits', () => {
  const s = session({ speeds: [10, 9, 8, 7, 6, 5, 9] });
  const model = LapTimes.build(s);
  assert.strictEqual(LapTimes.boardAt(model, s.laps[6].t_start + 1, 5).length, 5);
});

test('lap list times carry thousandths', () => {
  assert.strictEqual(LapTimes.format(147.795, 3), '2:27.795');
  assert.strictEqual(LapTimes.format(23.008, 3), '23.008');
});
