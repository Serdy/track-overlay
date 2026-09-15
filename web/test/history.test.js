const test = require('node:test');
const assert = require('node:assert');

const History = require('../js/history.js');

test('undo returns the state before the edit', () => {
  let h = History.create();
  h = History.push(h, { widgets: ['a'] });
  const step = History.undo(h, { widgets: ['a', 'b'] });
  assert.deepStrictEqual(step.state, { widgets: ['a'] });
});

test('undo then redo comes back to where it was', () => {
  let h = History.create();
  h = History.push(h, { n: 1 });
  const back = History.undo(h, { n: 2 });
  assert.deepStrictEqual(back.state, { n: 1 });

  const forward = History.redo(back.history, back.state);
  assert.deepStrictEqual(forward.state, { n: 2 });
});

test('several steps unwind in order', () => {
  let h = History.create();
  h = History.push(h, { n: 1 });
  h = History.push(h, { n: 2 });
  const first = History.undo(h, { n: 3 });
  assert.deepStrictEqual(first.state, { n: 2 });
  assert.deepStrictEqual(History.undo(first.history, first.state).state, { n: 1 });
});

test('a fresh edit ends the redo line', () => {
  let h = History.create();
  h = History.push(h, { n: 1 });
  const back = History.undo(h, { n: 2 });
  assert.ok(History.canRedo(back.history));

  const edited = History.push(back.history, { n: 1 });
  assert.ok(!History.canRedo(edited));
});

test('nothing to undo returns null rather than an empty state', () => {
  const h = History.create();
  assert.strictEqual(History.undo(h, { n: 1 }), null);
  assert.strictEqual(History.redo(h, { n: 1 }), null);
  assert.ok(!History.canUndo(h));
});

test('an unchanged state does not fill the stack', () => {
  let h = History.create();
  h = History.push(h, { n: 1 });
  h = History.push(h, { n: 1 });
  assert.strictEqual(h.past.length, 1);
});

test('the stack stops growing at its limit, keeping the newest', () => {
  let h = History.create(3);
  for (const n of [1, 2, 3, 4, 5]) h = History.push(h, { n });
  assert.deepStrictEqual(h.past.map((f) => JSON.parse(f).n), [3, 4, 5]);
});

test('snapshots are copies, so later edits cannot reach back into them', () => {
  const layout = { widgets: [{ pos: [0, 0] }] };
  let h = History.create();
  h = History.push(h, layout);
  layout.widgets[0].pos[0] = 0.5;
  assert.deepStrictEqual(History.undo(h, layout).state.widgets[0].pos, [0, 0]);
});
