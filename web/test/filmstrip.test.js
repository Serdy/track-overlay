const test = require('node:test');
const assert = require('node:assert');

const Filmstrip = require('../js/filmstrip.js');

test('the strip is filled with whole thumbnails', () => {
  const shots = Filmstrip.plan({ duration: 100, width: 640, thumbWidth: 64 });
  assert.strictEqual(shots.length, 10);
  assert.strictEqual(shots[0].x, 0);
  assert.strictEqual(shots[9].x + shots[9].width, 640);
});

test('each thumbnail is sampled in the middle of the stretch it stands for', () => {
  const [first, second] = Filmstrip.plan({ duration: 100, width: 200, thumbWidth: 100 });
  assert.strictEqual(first.t, 25);
  assert.strictEqual(second.t, 75);
});

test('a strip narrower than one thumbnail still gets one', () => {
  assert.strictEqual(Filmstrip.plan({ duration: 100, width: 20, thumbWidth: 64 }).length, 1);
});

test('nothing is planned without a duration or a width', () => {
  assert.deepStrictEqual(Filmstrip.plan({ duration: 0, width: 640 }), []);
  assert.deepStrictEqual(Filmstrip.plan({ duration: 100, width: 0 }), []);
});

test('shots are grouped by chunk, in chunk order', () => {
  const shots = Filmstrip.plan({ duration: 90, width: 300, thumbWidth: 100 });
  const groups = Filmstrip.byChunk(shots, (t) => ({ index: Math.floor(t / 30), time: t % 30 }));
  assert.deepStrictEqual(groups.map((g) => g.index), [0, 1, 2]);
  assert.strictEqual(groups[1].items.length, 1);
});

test('moments the camera did not record are dropped', () => {
  const shots = Filmstrip.plan({ duration: 100, width: 400, thumbWidth: 100 });
  const groups = Filmstrip.byChunk(shots, (t) => (t < 50 ? { index: 0, time: t } : null));
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].items.map((s) => s.t), [12.5, 37.5]);
});
