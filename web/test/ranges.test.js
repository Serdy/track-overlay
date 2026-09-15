const test = require('node:test');
const assert = require('node:assert');
const Ranges = require('../js/ranges.js');

const D = 100;
const whole = () => Ranges.full(D);

test('an untouched session is one range covering everything', () => {
  assert.deepStrictEqual(whole(), [{ from: 0, to: 100 }]);
  assert.strictEqual(Ranges.total(whole()), 100);
});

test('trimming the front leaves one range', () => {
  const kept = Ranges.cut(whole(), 0, 30, D);
  assert.deepStrictEqual(kept, [{ from: 30, to: 100 }]);
  assert.strictEqual(Ranges.total(kept), 70);
});

test('trimming the tail leaves one range', () => {
  assert.deepStrictEqual(Ranges.cut(whole(), 80, 100, D), [{ from: 0, to: 80 }]);
});

test('cutting the middle splits a range in two', () => {
  const kept = Ranges.cut(whole(), 40, 60, D);
  assert.deepStrictEqual(kept, [{ from: 0, to: 40 }, { from: 60, to: 100 }]);
  assert.strictEqual(Ranges.total(kept), 80);
});

test('several cuts accumulate', () => {
  let kept = Ranges.cut(whole(), 0, 10, D);
  kept = Ranges.cut(kept, 40, 50, D);
  kept = Ranges.cut(kept, 90, 100, D);
  assert.deepStrictEqual(kept, [{ from: 10, to: 40 }, { from: 50, to: 90 }]);
});

test('a cut given backwards works the same', () => {
  assert.deepStrictEqual(Ranges.cut(whole(), 60, 40, D), Ranges.cut(whole(), 40, 60, D));
});

test('a cut spanning a whole range removes it', () => {
  const kept = Ranges.cut(whole(), 40, 60, D);
  assert.deepStrictEqual(Ranges.cut(kept, 0, 45, D), [{ from: 60, to: 100 }]);
});

test('a cut outside everything changes nothing', () => {
  const kept = Ranges.cut(whole(), 20, 40, D);
  assert.deepStrictEqual(Ranges.cut(kept, 25, 35, D), kept);
});

test('keepOnly trims to a selection', () => {
  assert.deepStrictEqual(Ranges.keepOnly(whole(), 25, 75, D), [{ from: 25, to: 75 }]);
});

test('keepOnly across a hole keeps both sides of it', () => {
  const kept = Ranges.cut(whole(), 40, 60, D);
  assert.deepStrictEqual(Ranges.keepOnly(kept, 20, 80, D),
                         [{ from: 20, to: 40 }, { from: 60, to: 80 }]);
});

test('touching stretches are folded into one', () => {
  assert.deepStrictEqual(
    Ranges.normalise([{ from: 0, to: 40 }, { from: 40, to: 70 }], D),
    [{ from: 0, to: 70 }]);
});

test('overlapping stretches are folded too', () => {
  assert.deepStrictEqual(
    Ranges.normalise([{ from: 0, to: 50 }, { from: 30, to: 70 }], D),
    [{ from: 0, to: 70 }]);
});

test('an empty stretch is dropped', () => {
  assert.deepStrictEqual(Ranges.normalise([{ from: 20, to: 20 }], D), []);
});

test('output time maps back to session time', () => {
  const kept = Ranges.cut(whole(), 40, 60, D);      // 0-40 then 60-100
  assert.strictEqual(Ranges.toSession(kept, 0), 0);
  assert.strictEqual(Ranges.toSession(kept, 39), 39);
  assert.strictEqual(Ranges.toSession(kept, 40), 60);   // straight over the hole
  assert.strictEqual(Ranges.toSession(kept, 50), 70);
});

test('session time maps forward to output time', () => {
  const kept = Ranges.cut(whole(), 40, 60, D);
  assert.strictEqual(Ranges.toOutput(kept, 10), 10);
  assert.strictEqual(Ranges.toOutput(kept, 70), 50);
});

test('a moment that was cut has no output time', () => {
  const kept = Ranges.cut(whole(), 40, 60, D);
  assert.strictEqual(Ranges.toOutput(kept, 50), null);
  assert.strictEqual(Ranges.isKept(kept, 50), false);
  assert.strictEqual(Ranges.isKept(kept, 10), true);
});

test('the two mappings are inverses wherever the session is kept', () => {
  const kept = Ranges.cut(Ranges.cut(whole(), 10, 20, D), 60, 75, D);
  for (const t of [0, 5, 25, 40, 59, 80, 99]) {
    assert.strictEqual(Ranges.toSession(kept, Ranges.toOutput(kept, t)),
                       t, `round trip failed at ${t}`);
  }
});

test('output time past the end lands on the last kept moment', () => {
  const kept = Ranges.cut(whole(), 80, 100, D);
  assert.strictEqual(Ranges.toSession(kept, 999), 80);
});

test('gaps are what the timeline greys out', () => {
  const kept = Ranges.cut(Ranges.cut(whole(), 0, 10, D), 40, 60, D);
  assert.deepStrictEqual(Ranges.gaps(kept, D),
                         [{ from: 0, to: 10 }, { from: 40, to: 60 }]);
});

test('an untouched session has no gaps', () => {
  assert.deepStrictEqual(Ranges.gaps(whole(), D), []);
});

test('a tail gap is reported too', () => {
  assert.deepStrictEqual(Ranges.gaps(Ranges.cut(whole(), 90, 100, D), D),
                         [{ from: 90, to: 100 }]);
});

test('laps only keeps from the first lap start to the last lap end', () => {
  const laps = [{ t_start: 20, t_end: 45 }, { t_start: 45, t_end: 70 }];
  assert.deepStrictEqual(Ranges.lapsOnly(laps, D), [{ from: 20, to: 70 }]);
});

test('laps only with no laps keeps the whole session', () => {
  assert.deepStrictEqual(Ranges.lapsOnly([], D), whole());
});

test('two sets of kept stretches can be compared', () => {
  assert.ok(Ranges.same([{ from: 10, to: 20 }], [{ from: 10, to: 20 }]));
  assert.ok(Ranges.same([{ from: 10, to: 20 }], [{ from: 10.0004, to: 20 }]));
  assert.ok(!Ranges.same([{ from: 10, to: 20 }], [{ from: 10, to: 21 }]));
  assert.ok(!Ranges.same([{ from: 10, to: 20 }],
                         [{ from: 10, to: 15 }, { from: 16, to: 20 }]));
});

test('a trim to the laps is recognised as one', () => {
  const laps = [{ t_start: 14, t_end: 180 }, { t_start: 180, t_end: 340 }];
  assert.ok(Ranges.same(Ranges.lapsOnly(laps, 600), Ranges.lapsOnly(laps, 600)));
  assert.ok(!Ranges.same(Ranges.lapsOnly(laps, 600), Ranges.full(600)));
});
