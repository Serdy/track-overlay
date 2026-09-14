const test = require('node:test');
const assert = require('node:assert');
const Layout = require('../js/layout.js');

const SIZES = { speed: [0.15, 0.095], map: [0.17, 0.30] };
const CLIPS = ['cam_a', 'cam_b'];

function sample() {
  return {
    output: { width: 1920, height: 1080, fps: 60 },
    slots: [{ id: 'main', rect: [0, 0, 1, 1] }, { id: 'pip', rect: [0.7, 0.04, 0.28, 0.28] }],
    cuts: [{ t: 0, main: 'cam_a', pip: 'cam_b' }],
    widgets: [{ type: 'speed', pos: [0.03, 0.85], scale: 1 },
              { type: 'map', pos: [0.8, 0.5], scale: 1 }],
  };
}

test('a sound layout survives validation unchanged', () => {
  const result = Layout.validate(sample(), CLIPS, SIZES);
  assert.ok(result.ok);
  assert.deepStrictEqual(result.layout.widgets, sample().widgets);
});

test('a widget pushed off the frame is pulled back in', () => {
  const layout = sample();
  layout.widgets[0].pos = [1.5, -0.3];
  const result = Layout.validate(layout, CLIPS, SIZES);
  assert.ok(!result.ok);
  assert.deepStrictEqual(result.layout.widgets[0].pos, [1 - 0.15, 0]);
  assert.match(result.errors[0], /outside the frame/);
});

test('an absurd scale is clamped', () => {
  const layout = sample();
  layout.widgets[0].scale = 99;
  assert.strictEqual(Layout.validate(layout, CLIPS, SIZES).layout.widgets[0].scale,
                     Layout.MAX_SCALE);
});

test('a switch naming a camera that is gone is dropped', () => {
  const layout = sample();
  layout.cuts.push({ t: 100, main: 'cam_ghost', pip: null });
  const result = Layout.validate(layout, CLIPS, SIZES);
  assert.strictEqual(result.layout.cuts.length, 1);
  assert.match(result.errors.join(), /camera that is gone/);
});

test('losing every camera is reported, not hidden', () => {
  const result = Layout.validate(sample(), ['cam_other'], SIZES);
  assert.ok(!result.ok);
  assert.match(result.errors.join(), /no usable camera arrangement/);
});

test('a widget with no type is discarded', () => {
  const layout = sample();
  layout.widgets.push({ pos: [0.5, 0.5] });
  const result = Layout.validate(layout, CLIPS, SIZES);
  assert.strictEqual(result.layout.widgets.length, 2);
});

test('a nonsense output size falls back to a usable one', () => {
  const layout = sample();
  layout.output.width = 0;
  const result = Layout.validate(layout, CLIPS, SIZES);
  assert.strictEqual(result.layout.output.width, 1920);
  assert.match(result.errors.join(), /output.width/);
});

test('validation never mutates what it was given', () => {
  const layout = sample();
  const copy = JSON.parse(JSON.stringify(layout));
  layout.widgets[0].pos = [5, 5];
  copy.widgets[0].pos = [5, 5];
  Layout.validate(layout, CLIPS, SIZES);
  assert.deepStrictEqual(layout, copy);
});

test('an inset smaller than readable is grown back', () => {
  const rect = Layout.clampRect([0.5, 0.5, 0.01, 0.01]);
  assert.strictEqual(rect[2], Layout.MIN_PIP);
  assert.strictEqual(rect[3], Layout.MIN_PIP);
});

test('an inset is kept inside the frame', () => {
  assert.deepStrictEqual(Layout.clampRect([0.9, 0.9, 0.3, 0.3]), [0.7, 0.7, 0.3, 0.3]);
});

test('hit testing finds the widget under a point', () => {
  const hit = Layout.hitTest(sample(), SIZES, 0.05, 0.88);
  assert.strictEqual(hit.type, 'speed');
});

test('a point on nothing hits nothing', () => {
  assert.strictEqual(Layout.hitTest(sample(), SIZES, 0.5, 0.2), null);
});

test('overlapping widgets resolve to the topmost', () => {
  const layout = sample();
  layout.widgets[1].pos = [0.03, 0.85];       // straight on top of the speed widget
  assert.strictEqual(Layout.hitTest(layout, SIZES, 0.05, 0.88).type, 'map');
});

test('scale changes the area a widget covers for hit testing', () => {
  const layout = sample();
  const outside = Layout.hitTest(layout, SIZES, 0.2, 0.9);
  layout.widgets[0].scale = 2;
  assert.strictEqual(outside, null);
  assert.strictEqual(Layout.hitTest(layout, SIZES, 0.2, 0.9).type, 'speed');
});

test('moving a widget shifts it by the delta', () => {
  const moved = Layout.moveWidget(sample(), 0, 0.1, -0.05, SIZES);
  assert.deepStrictEqual(moved.widgets[0].pos.map((v) => +v.toFixed(3)), [0.13, 0.8]);
});

test('a widget cannot be dragged off the frame', () => {
  const moved = Layout.moveWidget(sample(), 0, 5, 5, SIZES);
  const [x, y] = moved.widgets[0].pos;
  assert.ok(x + 0.15 <= 1.0001 && y + 0.095 <= 1.0001);
});

test('moving accounts for the widget scale', () => {
  const layout = sample();
  layout.widgets[0].scale = 2;
  const moved = Layout.moveWidget(layout, 0, 5, 0, SIZES);
  assert.ok(moved.widgets[0].pos[0] + 0.3 <= 1.0001);
});

test('scaling stays within bounds', () => {
  let layout = sample();
  for (let i = 0; i < 20; i += 1) layout = Layout.scaleWidget(layout, 0, 1.5);
  assert.strictEqual(layout.widgets[0].scale, Layout.MAX_SCALE);
  for (let i = 0; i < 40; i += 1) layout = Layout.scaleWidget(layout, 0, 0.5);
  assert.strictEqual(layout.widgets[0].scale, Layout.MIN_SCALE);
});

test('moving an index that is not there changes nothing', () => {
  assert.deepStrictEqual(Layout.moveWidget(sample(), 99, 0.1, 0.1, SIZES), sample());
});

test('a slot rectangle can be set and is clamped', () => {
  const out = Layout.setSlotRect(sample(), 'pip', [0.9, 0.9, 0.5, 0.5]);
  assert.deepStrictEqual(out.slots[1].rect, [0.5, 0.5, 0.5, 0.5]);
});

test('setting an unknown slot changes nothing', () => {
  assert.deepStrictEqual(Layout.setSlotRect(sample(), 'nope', [0, 0, 1, 1]), sample());
});

test('a round trip through JSON loses nothing', () => {
  const original = Layout.validate(sample(), CLIPS, SIZES).layout;
  const restored = Layout.validate(JSON.parse(JSON.stringify(original)), CLIPS, SIZES);
  assert.ok(restored.ok);
  assert.deepStrictEqual(restored.layout, original);
});
