const test = require('node:test');
const assert = require('node:assert');
const Cuts = require('../js/cuts.js');

const A = 'cam_a';
const B = 'cam_b';

function twoCams() {
  return Cuts.initial([A, B]);
}

test('the opening arrangement puts the first clip in the main slot', () => {
  assert.deepStrictEqual(twoCams(), [{ t: 0, main: A, pip: B }]);
});

test('a single camera leaves the inset empty', () => {
  assert.deepStrictEqual(Cuts.initial([A]), [{ t: 0, main: A, pip: null }]);
});

test('resolveAt holds the arrangement until the next change', () => {
  const cuts = Cuts.swapAt(twoCams(), 100);
  assert.strictEqual(Cuts.resolveAt(cuts, 0).main, A);
  assert.strictEqual(Cuts.resolveAt(cuts, 99.9).main, A);
  assert.strictEqual(Cuts.resolveAt(cuts, 100).main, B);
  assert.strictEqual(Cuts.resolveAt(cuts, 500).main, B);
});

test('a moment before the first entry still resolves', () => {
  const cuts = [{ t: 10, main: A, pip: B }];
  assert.strictEqual(Cuts.resolveAt(cuts, 0).main, A);
});

test('swapping exchanges the main view and the inset', () => {
  const cuts = Cuts.swapAt(twoCams(), 50);
  const after = Cuts.resolveAt(cuts, 60);
  assert.strictEqual(after.main, B);
  assert.strictEqual(after.pip, A);
});

test('swapping twice returns to the original arrangement', () => {
  let cuts = Cuts.swapAt(twoCams(), 50);
  cuts = Cuts.swapAt(cuts, 100);
  assert.strictEqual(Cuts.resolveAt(cuts, 150).main, A);
});

test('swapping with one camera changes nothing', () => {
  const single = Cuts.initial([A]);
  assert.deepStrictEqual(Cuts.swapAt(single, 50), single);
});

test('entries hold an absolute arrangement, not a swap operation', () => {
  // Inserting a swap before an existing entry does not flip that entry: it still names
  // the same cameras. Absolute is what the ffmpeg graph consumes, so that is what is
  // stored — and it is why swapping a stretch needs swapRange rather than two swapAt.
  let cuts = Cuts.swapAt(twoCams(), 200);
  cuts = Cuts.swapAt(cuts, 100);
  assert.strictEqual(Cuts.resolveAt(cuts, 50).main, A);
  assert.strictEqual(Cuts.resolveAt(cuts, 150).main, B);
  assert.strictEqual(Cuts.resolveAt(cuts, 250).main, B);   // the entry at 200 is untouched
});

test('swapRange swaps for a stretch and restores afterwards', () => {
  const cuts = Cuts.swapRange(twoCams(), 100, 200);
  assert.strictEqual(Cuts.resolveAt(cuts, 50).main, A);
  assert.strictEqual(Cuts.resolveAt(cuts, 150).main, B);
  assert.strictEqual(Cuts.resolveAt(cuts, 250).main, A);
});

test('swapRange restores the inset too, not just the main view', () => {
  const cuts = Cuts.swapRange(twoCams(), 100, 200);
  assert.strictEqual(Cuts.resolveAt(cuts, 150).pip, A);
  assert.strictEqual(Cuts.resolveAt(cuts, 250).pip, B);
});

test('swapRange replaces whatever the stretch covered', () => {
  let cuts = Cuts.swapAt(twoCams(), 150);       // a change inside the coming stretch
  cuts = Cuts.swapRange(cuts, 100, 200);
  assert.ok(cuts.every((cut) => cut.t <= 100 || cut.t >= 200));
  assert.strictEqual(Cuts.resolveAt(cuts, 150).main, B);
});

test('several stretches coexist', () => {
  let cuts = Cuts.swapRange(twoCams(), 100, 200);
  cuts = Cuts.swapRange(cuts, 400, 500);
  assert.strictEqual(Cuts.resolveAt(cuts, 150).main, B);
  assert.strictEqual(Cuts.resolveAt(cuts, 300).main, A);
  assert.strictEqual(Cuts.resolveAt(cuts, 450).main, B);
  assert.strictEqual(Cuts.resolveAt(cuts, 600).main, A);
});

test('swapRange with one camera changes nothing', () => {
  const single = Cuts.initial([A]);
  assert.deepStrictEqual(Cuts.swapRange(single, 100, 200), single);
});

test('windows from a stretch give three spans per slot', () => {
  const spans = Cuts.windows(Cuts.swapRange(twoCams(), 100, 200), 300);
  const main = spans.filter((s) => s.slot === 'main');
  assert.deepStrictEqual(main, [
    { slot: 'main', clip: A, from: 0, to: 100 },
    { slot: 'main', clip: B, from: 100, to: 200 },
    { slot: 'main', clip: A, from: 200, to: 300 },
  ]);
});

test('two changes at the same moment collapse into one', () => {
  let cuts = Cuts.swapAt(twoCams(), 100);
  cuts = Cuts.add(cuts, { t: 100, main: A, pip: B });
  assert.strictEqual(cuts.filter((c) => Math.abs(c.t - 100) < 1e-9).length, 1);
  assert.strictEqual(Cuts.resolveAt(cuts, 100).main, A);
});

test('entries stay in chronological order however they were added', () => {
  let cuts = Cuts.add(twoCams(), { t: 300, main: B, pip: A });
  cuts = Cuts.add(cuts, { t: 100, main: B, pip: A });
  assert.deepStrictEqual(cuts.map((c) => c.t), [0, 100, 300]);
});

test('removing takes the nearest entry but never the opening one', () => {
  let cuts = Cuts.swapAt(twoCams(), 100);
  cuts = Cuts.removeNear(cuts, 102, 5);
  assert.deepStrictEqual(cuts.map((c) => c.t), [0]);

  cuts = Cuts.removeNear(cuts, 0, 5);            // the opening entry survives
  assert.deepStrictEqual(cuts.map((c) => c.t), [0]);
});

test('removing does nothing when no entry is close enough', () => {
  const cuts = Cuts.swapAt(twoCams(), 100);
  assert.deepStrictEqual(Cuts.removeNear(cuts, 500, 5), cuts);
});

test('simplify drops entries that change nothing', () => {
  const cuts = [
    { t: 0, main: A, pip: B },
    { t: 50, main: A, pip: B },        // identical to the one before
    { t: 100, main: B, pip: A },
  ];
  assert.deepStrictEqual(Cuts.simplify(cuts).map((c) => c.t), [0, 100]);
});

test('windows expand the sparse list into explicit spans', () => {
  const cuts = Cuts.swapAt(twoCams(), 100);
  const spans = Cuts.windows(cuts, 300);
  assert.deepStrictEqual(spans, [
    { slot: 'main', clip: A, from: 0, to: 100 },
    { slot: 'pip', clip: B, from: 0, to: 100 },
    { slot: 'main', clip: B, from: 100, to: 300 },
    { slot: 'pip', clip: A, from: 100, to: 300 },
  ]);
});

test('windows skip an empty inset', () => {
  const spans = Cuts.windows(Cuts.initial([A]), 200);
  assert.deepStrictEqual(spans, [{ slot: 'main', clip: A, from: 0, to: 200 }]);
});

test('windows drop a zero-length span', () => {
  const cuts = Cuts.swapAt(twoCams(), 300);
  assert.ok(Cuts.windows(cuts, 300).every((span) => span.to > span.from));
});

test('a camera that turns up later is given the free inset', () => {
  const saved = [{ t: 0, main: 'cam_3429', pip: null }];
  assert.deepStrictEqual(Cuts.adopt(saved, ['cam_3429', 'cam_3446']),
    [{ t: 0, main: 'cam_3429', pip: 'cam_3446' }]);
});

test('adopting fills every arrangement whose inset is free', () => {
  const saved = [{ t: 0, main: 'a', pip: null }, { t: 60, main: 'a', pip: null }];
  assert.deepStrictEqual(Cuts.adopt(saved, ['a', 'b']).map((cut) => cut.pip), ['b', 'b']);
});

test('adopting leaves an arrangement that already uses both slots alone', () => {
  const saved = [{ t: 0, main: 'a', pip: 'b' }];
  assert.strictEqual(Cuts.adopt(saved, ['a', 'b']), saved);
  assert.deepStrictEqual(Cuts.adopt(saved, ['a', 'b', 'c']), saved);
});
