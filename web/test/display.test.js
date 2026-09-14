const test = require('node:test');
const assert = require('node:assert');
const Display = require('../js/display.js');

function changes(array) {
  let n = 0;
  for (let i = 1; i < array.length; i += 1) if (array[i] !== array[i - 1]) n += 1;
  return n;
}

/** Deterministic noise, so the test cannot flap. */
function noisy(count, amplitude, seed = 7) {
  let state = seed;
  return Array.from({ length: count }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return ((state / 2147483648) * 2 - 1) * amplitude;
  });
}

test('a value drifting around zero produces no side at all', () => {
  const sides = Display.sides(noisy(2000, 2.4), 5, 3);
  assert.strictEqual(changes(sides), 0);
  assert.ok(sides.every((s) => s === 0));
});

test('crossing the enter threshold sets the side', () => {
  const sides = Display.sides([0, 2, 4, 6, 8], 5, 3);
  assert.deepStrictEqual([...sides], [0, 0, 0, 1, 1]);
});

test('the side is held until the value falls below the exit threshold', () => {
  // Enters at 6, stays through 4 (above the 3 exit), leaves only at 2.
  const sides = Display.sides([6, 4, 3.5, 2, 0], 5, 3);
  assert.deepStrictEqual([...sides], [1, 1, 1, 0, 0]);
});

test('hysteresis kills chatter that a plain threshold produces', () => {
  // A value sitting exactly on a threshold: the classic flicker case.
  const wobble = Array.from({ length: 1000 }, (_, i) => 5 + (i % 2 ? 0.3 : -0.3));
  const plain = wobble.map((v) => (v > 5 ? 1 : 0));
  const sides = Display.sides(wobble, 5, 3);
  assert.ok(changes(plain) > 400, 'the plain threshold should chatter');
  assert.strictEqual(changes(sides), 1);
});

test('the side flips straight across without passing through neutral', () => {
  const sides = Display.sides([8, 0, -8], 5, 3);
  assert.deepStrictEqual([...sides], [1, 0, -1]);
  assert.deepStrictEqual([...Display.sides([8, -8], 5, 3)], [1, -1]);
});

test('sides are symmetric', () => {
  const up = [...Display.sides([0, 6, 4, 2], 5, 3)];
  const down = [...Display.sides([0, -6, -4, -2], 5, 3)];
  // `|| 0` normalises -0, which deepStrictEqual treats as different from 0.
  assert.deepStrictEqual(up, down.map((v) => -v || 0));
});

test('sticky rounding ignores movement inside the slack', () => {
  const values = [10, 10.4, 10.6, 10.4, 10.6];
  assert.deepStrictEqual([...Display.stickyRound(values, 0.5)], [10, 10, 10, 10, 10]);
});

test('sticky rounding needs a full unit of movement to follow', () => {
  // The dead band is 0.5 + slack wide, so a ramp of exactly one unit per sample updates
  // every other step. That is the price of suppressing noise of the same amplitude, and
  // it is why `lean` smooths before rounding — smoothing keeps the steps small enough
  // that the readout never skips a value visibly.
  assert.deepStrictEqual([...Display.stickyRound([10, 11, 12, 13], 0.5)], [10, 10, 12, 12]);
  assert.deepStrictEqual([...Display.stickyRound([10, 12, 14, 16], 0.5)], [10, 12, 14, 16]);
});

test('sticky rounding cuts flicker on a noisy boundary', () => {
  const wobble = noisy(2000, 0.6).map((v) => 10.5 + v);
  const plain = wobble.map(Math.round);
  assert.ok(changes(plain) > 500, 'plain rounding should flicker');
  assert.ok(changes(Display.stickyRound(wobble, 0.5)) < changes(plain) / 5);
});

test('lean readout stays at zero while upright', () => {
  // The measured spread on a straight is 2.4°, well inside the dead band.
  const out = Display.lean(noisy(2000, 2.4), 25);
  assert.ok(out.value.every((v) => v === 0));
  assert.ok(out.side.every((s) => s === 0));
});

test('lean readout tracks a real corner', () => {
  const corner = Array.from({ length: 200 }, (_, i) => Math.min(i * 0.5, 45));
  const out = Display.lean(corner, 25);
  assert.strictEqual(out.side[out.side.length - 1], 1);
  assert.ok(Math.abs(out.value[out.value.length - 1] - 45) <= 1);
});

test('lean readout keeps the direction of a left-hand corner', () => {
  const corner = Array.from({ length: 200 }, (_, i) => -Math.min(i * 0.5, 40));
  const out = Display.lean(corner, 25);
  assert.strictEqual(out.side[out.side.length - 1], -1);
  assert.ok(out.value.every((v) => v >= 0), 'the printed number is unsigned');
});

test('lean readout does not lose the peak of a corner', () => {
  const corner = Array.from({ length: 100 }, (_, i) => 48 * Math.sin((i / 99) * Math.PI));
  const out = Display.lean(corner, 25);
  assert.ok(Math.max(...out.value) >= 46);
});

test('at() clamps outside the session', () => {
  const session = { rate: 10, channels: { x: { samples: new Float64Array(5) } } };
  const array = Float64Array.from([1, 2, 3, 4, 5]);
  assert.strictEqual(Display.at(array, session, -99), 1);
  assert.strictEqual(Display.at(array, session, 99), 5);
  assert.strictEqual(Display.at(null, session, 0), 0);
  assert.strictEqual(Display.at(Float64Array.from([]), session, 0), 0);
});

test('an empty channel does not break the readout', () => {
  const out = Display.lean([], 25);
  assert.strictEqual(out.value.length, 0);
  assert.strictEqual(out.side.length, 0);
});


test('display smoothing keeps the corner peak', () => {
  const corner = Array.from({ length: 100 }, (_, i) => 48 * Math.sin((i / 99) * Math.PI));
  const eased = Display.smooth(corner, 25, Display.LEAN_SMOOTH_S);
  assert.ok(Math.max(...eased) > 47, 'smoothing must not shave the peak');
});

test('display smoothing cuts the step size on a ramp', () => {
  const ramp = Array.from({ length: 200 }, (_, i) => i * 0.5 + (i % 2 ? 1.5 : -1.5));
  const plain = Display.stickyRound(ramp.map(Math.abs), 0.5);
  const eased = Display.stickyRound(
    Array.from(Display.smooth(ramp, 25, Display.LEAN_SMOOTH_S), Math.abs), 0.5);
  const step = (a) => Math.max(...a.map((v, i) => (i ? Math.abs(v - a[i - 1]) : 0)));
  assert.ok(step([...eased]) < step([...plain]), 'smoothing should shrink the jumps');
});

test('smoothing with a window under one sample is a no-op', () => {
  const values = [1, 5, 2, 8];
  assert.deepStrictEqual([...Display.smooth(values, 25, 0)], values);
});
