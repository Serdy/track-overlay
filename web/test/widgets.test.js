const test = require('node:test');
const assert = require('node:assert');

const Widgets = require('../js/widgets/index.js');
global.Widgets = Widgets;
require('../js/widgets/speed.js');
require('../js/widgets/lean.js');
require('../js/widgets/accel.js');
require('../js/widgets/laptime.js');
require('../js/widgets/laplist.js');
require('../js/widgets/leandial.js');

/** Fake canvas context: records calls and catches non-finite coordinates. */
function fakeCtx() {
  const calls = [];
  const record = (name) => (...args) => {
    for (const arg of args) {
      if (typeof arg === 'number' && !isFinite(arg)) {
        throw new Error(`${name}: non-finite argument ${arg}`);
      }
    }
    calls.push({ name, args });
  };
  return {
    calls,
    save: record('save'), restore: record('restore'),
    beginPath: record('beginPath'), fill: record('fill'),
    closePath: record('closePath'), stroke: record('stroke'),
    moveTo: record('moveTo'), lineTo: record('lineTo'), arc: record('arc'),
    rect: record('rect'), roundRect: record('roundRect'),
    fillRect: record('fillRect'), fillText: record('fillText'),
    set fillStyle(v) { calls.push({ name: 'fillStyle', args: [v] }); },
    set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
    set strokeStyle(v) { calls.push({ name: 'strokeStyle', args: [v] }); },
    set lineWidth(v) {},
  };
}

const BOX = { x: 100, y: 200, w: 288, h: 102 };
const FRAME = { width: 1920, height: 1080 };

test('the registry knows the widgets and invents none', () => {
  // The map require sits further down the file but runs on load, before any test body.
  assert.deepStrictEqual(Widgets.ids().sort(),
                         ['accel', 'laplist', 'laptime', 'lean', 'leandial', 'map',
                          'speed']);
  assert.strictEqual(Widgets.get('no such thing'), null);
});

test('a position in frame fractions converts to pixels', () => {
  const box = Widgets.boxFor(Widgets.get('speed'), { pos: [0.5, 0.25], scale: 1 }, FRAME);
  assert.strictEqual(box.x, 960);
  assert.strictEqual(box.y, 270);
});

test('scale changes the size but not the position', () => {
  const one = Widgets.boxFor(Widgets.get('speed'), { pos: [0.1, 0.1], scale: 1 }, FRAME);
  const two = Widgets.boxFor(Widgets.get('speed'), { pos: [0.1, 0.1], scale: 2 }, FRAME);
  assert.strictEqual(two.x, one.x);
  assert.strictEqual(two.w, one.w * 2);
});

test('the same layout yields a proportional box at any resolution', () => {
  const hd = Widgets.boxFor(Widgets.get('speed'), { pos: [0.04, 0.86] }, { width: 1920, height: 1080 });
  const uhd = Widgets.boxFor(Widgets.get('speed'), { pos: [0.04, 0.86] }, { width: 3840, height: 2160 });
  assert.strictEqual(uhd.x, hd.x * 2);
  assert.strictEqual(uhd.h, hd.h * 2);
});

for (const id of ['speed', 'lean', 'accel']) {
  test(`widget ${id} draws something meaningful`, () => {
    const ctx = fakeCtx();
    Widgets.get(id).draw(ctx, BOX, { speed: 123, lean: -41.8, accel: -0.54, score: -0.7 });
    assert.ok(ctx.calls.some((c) => c.name === 'fillText'), 'the widget drew no text');
  });

  test(`widget ${id} survives missing data`, () => {
    const ctx = fakeCtx();
    Widgets.get(id).draw(ctx, BOX, {});
    Widgets.get(id).draw(ctx, BOX, { speed: null, lean: null, accel: null, score: null });
  });

  test(`widget ${id} survives out-of-scale values`, () => {
    const ctx = fakeCtx();
    Widgets.get(id).draw(ctx, BOX, { speed: 1e6, lean: 900, accel: -99, score: -50 });
    Widgets.get(id).draw(ctx, BOX, { speed: -5, lean: -900, accel: 99, score: 50 });
  });
}

test('the lean bar stays inside the widget', () => {
  const ctx = fakeCtx();
  Widgets.get('lean').draw(ctx, BOX, { lean: 900 });
  for (const call of ctx.calls.filter((c) => c.name === 'fillRect')) {
    const [x, , w] = call.args;
    assert.ok(x >= BOX.x - 1 && x + w <= BOX.x + BOX.w + 1,
              `bar ${x}..${x + w} escaped ${BOX.x}..${BOX.x + BOX.w}`);
  }
});

test('the acceleration bar stays inside the widget', () => {
  const ctx = fakeCtx();
  ctx.roundRect = undefined;                 // exercise the rect fallback path
  Widgets.get('accel').draw(ctx, BOX, { score: -50 });
  for (const call of ctx.calls.filter((c) => c.name === 'fillRect' || c.name === 'rect')) {
    const [x, , w] = call.args;
    assert.ok(x >= BOX.x - 1 && x + w <= BOX.x + BOX.w + 1);
  }
});

test('the acceleration widget shows no number', () => {
  // A G reading at two decimals changed 17.6 times a second — 29% of frames at 60 fps.
  // The bar carries the same information without the flicker.
  const ctx = fakeCtx();
  Widgets.get('accel').draw(ctx, BOX, { score: 0.26, accel: 0.26, scoreSide: 1 });
  const texts = ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
  assert.deepStrictEqual(texts, ['POWER']);
  assert.ok(!texts.some((t) => /\d/.test(t)), 'no digits should be drawn');
});

test('the acceleration label names all three states', () => {
  const read = (scoreSide) => {
    const ctx = fakeCtx();
    Widgets.get('accel').draw(ctx, BOX, { score: 0, scoreSide });
    return ctx.calls.find((c) => c.name === 'fillText').args[0];
  };
  assert.strictEqual(read(1), 'POWER');
  assert.strictEqual(read(-1), 'BRAKING');
  assert.strictEqual(read(0), 'COASTING');
});

test('drawAll skips unknown types without dropping the rest', () => {
  const ctx = fakeCtx();
  Widgets.drawAll(ctx, [{ type: 'made-up', pos: [0, 0] }, { type: 'speed', pos: [0, 0] }],
                  FRAME, { speed: 100 });
  assert.ok(ctx.calls.some((c) => c.name === 'fillText'));
});

// --- map -------------------------------------------------------------------

require('../js/widgets/map.js');
require('../js/widgets/laptime.js');
require('../js/widgets/laplist.js');
require('../js/widgets/leandial.js');

const ENVELOPE = {
  left: [[48.000, 17.000], [48.010, 17.000], [48.010, 17.020], [48.000, 17.020]],
  right: [[48.001, 17.001], [48.009, 17.001], [48.009, 17.019], [48.001, 17.019]],
};
const MAP_SESSION = { envelope: ENVELOPE };
const MAP_BOX = { x: 0, y: 0, w: 200, h: 200 };

test('the map made it into the registry', () => {
  assert.ok(Widgets.get('map'));
});

test('the projection preserves the circuit aspect ratio', () => {
  const map = Widgets.get('map');
  const bounds = map._bounds([ENVELOPE.left]);
  const project = map._makeProjection(MAP_BOX, bounds);
  const [x0, y0] = project(48.000, 17.000);
  const [x1, y1] = project(48.010, 17.020);

  // At 48° a degree of longitude is cos(48°) times shorter than a degree of latitude.
  const expected = (0.020 * Math.cos(48 * Math.PI / 180)) / 0.010;
  assert.ok(Math.abs(Math.abs(x1 - x0) / Math.abs(y1 - y0) - expected) < 0.01);
});

test('the projection flips the axis: north is up', () => {
  const map = Widgets.get('map');
  const project = map._makeProjection(MAP_BOX, map._bounds([ENVELOPE.left]));
  assert.ok(project(48.010, 17.010)[1] < project(48.000, 17.010)[1]);
});

test('the projection fits inside the box with padding', () => {
  const map = Widgets.get('map');
  const project = map._makeProjection(MAP_BOX, map._bounds([ENVELOPE.left]));
  for (const [lat, lon] of ENVELOPE.left) {
    const [x, y] = project(lat, lon);
    assert.ok(x >= MAP_BOX.x && x <= MAP_BOX.x + MAP_BOX.w, `x=${x} outside the box`);
    assert.ok(y >= MAP_BOX.y && y <= MAP_BOX.y + MAP_BOX.h, `y=${y} outside the box`);
  }
});

test('a degenerate track does not break the projection', () => {
  const map = Widgets.get('map');
  const project = map._makeProjection(MAP_BOX, map._bounds([[[48.0, 17.0]]]));
  const [x, y] = project(48.0, 17.0);
  assert.ok(isFinite(x) && isFinite(y));
});

test('prepare computes the geometry once', () => {
  const prepared = Widgets.get('map').prepare(MAP_SESSION, MAP_BOX);
  assert.strictEqual(prepared.left.length, ENVELOPE.left.length);
  assert.strictEqual(prepared.right.length, ENVELOPE.right.length);
});

test('with no envelope the map simply draws nothing', () => {
  const prepared = Widgets.get('map').prepare({ envelope: { left: [], right: [] } }, MAP_BOX);
  assert.strictEqual(prepared, null);
  const ctx = fakeCtx();
  Widgets.get('map').draw(ctx, MAP_BOX, { map: null });    // must not throw
});

test('the map draws the band, the trail and the dot', () => {
  const ctx = fakeCtx();
  ctx.beginPath = () => {}; ctx.moveTo = () => {}; ctx.lineTo = () => {};
  ctx.closePath = () => {}; ctx.stroke = () => {}; ctx.arc = () => {};
  const prepared = Widgets.get('map').prepare(MAP_SESSION, MAP_BOX);
  Widgets.get('map').draw(ctx, MAP_BOX, {
    map: prepared, lat: 48.005, lon: 17.010,
    trail: [[48.004, 17.009], [48.005, 17.010]],
  });
  assert.ok(ctx.calls.some((c) => c.name === 'fillStyle'));
});

test('the map survives a missing position and trail', () => {
  const ctx = fakeCtx();
  ctx.beginPath = () => {}; ctx.moveTo = () => {}; ctx.lineTo = () => {};
  ctx.closePath = () => {}; ctx.stroke = () => {}; ctx.arc = () => {};
  const prepared = Widgets.get('map').prepare(MAP_SESSION, MAP_BOX);
  Widgets.get('map').draw(ctx, MAP_BOX, { map: prepared, lat: null, lon: null, trail: [] });
});


test('the lap board draws best, previous, current and the delta', () => {
  const ctx = fakeCtx();
  Widgets.get('laptime').draw(ctx, { x: 0, y: 0, w: 880, h: 90 }, {
    laps: {
      best: { n: 2, time: 63.74 },
      previous: { n: 3, time: 64.9 },
      current: { n: 4, time: 39.9 },
      delta: -3.76,
    },
  });
  const text = ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
  assert.ok(text.includes('1:03.7'), text.join(' '));
  assert.ok(text.includes('39.9'));
  assert.ok(text.includes('-3.76'));
  assert.ok(text.includes('Best') && text.includes('Previous') && text.includes('Current'));
});

test('the lap board holds its shape before the first lap is complete', () => {
  const ctx = fakeCtx();
  Widgets.get('laptime').draw(ctx, { x: 0, y: 0, w: 880, h: 90 }, {
    laps: { best: null, previous: null, current: { n: 1, time: 12.3 }, delta: null },
  });
  const text = ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
  assert.strictEqual(text.filter((t) => t === '—').length, 3);   // best, previous, delta
  assert.ok(text.includes('12.3'));
});

test('a lap board with no data at all still draws', () => {
  const ctx = fakeCtx();
  Widgets.get('laptime').draw(ctx, { x: 0, y: 0, w: 880, h: 90 }, {});
  assert.ok(ctx.calls.length > 0);
});


test('the lap list draws a row per lap, the running one marked apart', () => {
  const ctx = fakeCtx();
  Widgets.get('laplist').draw(ctx, { x: 0, y: 0, w: 260, h: 260 }, {
    lapList: [
      { n: 4, time: 23.008, running: true, best: false },
      { n: 3, time: 147.795, running: false, best: false },
      { n: 2, time: 147.565, running: false, best: true },
      { n: 1, time: 148.84, running: false, best: false },
    ],
  });
  const text = ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
  assert.ok(text.includes('23.008') && text.includes('2:27.795'));
  assert.deepStrictEqual(text.filter((t) => ['1', '2', '3', '4'].includes(t)),
                         ['4', '3', '2', '1']);

  // The running lap and the best one are drawn in colours of their own.
  const colours = ctx.calls.filter((c) => c.name === 'fillStyle').map((c) => c.args[0]);
  assert.strictEqual(new Set(colours).size >= 4, true, colours.join(' '));
});

test('a lap list with nothing in it yet still draws', () => {
  const ctx = fakeCtx();
  Widgets.get('laplist').draw(ctx, { x: 0, y: 0, w: 260, h: 260 }, { lapList: [] });
  const text = ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
  assert.ok(text.includes('—'));
});


test('the lean dial fills the side the bike is leaning', () => {
  const right = fakeCtx();
  Widgets.get('leandial').draw(right, BOX, { leanValue: 40, leanSide: 1 });
  const rightArc = right.calls.find((c) => c.name === 'arc');

  const left = fakeCtx();
  Widgets.get('leandial').draw(left, BOX, { leanValue: 40, leanSide: -1 });
  const leftArc = left.calls.find((c) => c.name === 'arc');

  // Both sweep from upright; the sector that gets filled is on opposite sides of it.
  assert.ok(rightArc.args[3] < rightArc.args[4]);
  assert.ok(leftArc.args[3] < leftArc.args[4]);
  assert.notDeepStrictEqual(rightArc.args.slice(3), leftArc.args.slice(3));
});

test('upright draws no sector at all', () => {
  const ctx = fakeCtx();
  Widgets.get('leandial').draw(ctx, BOX, { leanValue: 0, leanSide: 0 });
  // The outline arc is still there; the filled one is not, so there is no closePath.
  assert.ok(!ctx.calls.some((c) => c.name === 'closePath'));
  assert.ok(ctx.calls.some((c) => c.name === 'arc'));
});

test('the dial says LEAN until the angle earns the joke', () => {
  const ordinary = fakeCtx();
  Widgets.get('leandial').draw(ordinary, BOX, { leanValue: 45, leanSide: 1 });
  const text = (ctx) => ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
  assert.ok(text(ordinary).includes('LEAN'));
  assert.ok(text(ordinary).includes('45°'));

  const heroic = fakeCtx();
  Widgets.get('leandial').draw(heroic, BOX, { leanValue: 53, leanSide: -1 });
  assert.ok(text(heroic).includes('ALMOST MÁRQUEZ'));
  assert.ok(!text(heroic).includes('LEAN'));
});

test('a dial with no lean data still draws', () => {
  const ctx = fakeCtx();
  Widgets.get('leandial').draw(ctx, BOX, {});
  assert.ok(ctx.calls.some((c) => c.name === 'fillText'));
});

test('an angle past the end of the fan does not run off it', () => {
  const ctx = fakeCtx();
  Widgets.get('leandial').draw(ctx, BOX, { leanValue: 200, leanSide: 1 });
  const arc = ctx.calls.find((c) => c.name === 'arc');
  assert.ok(arc.args[4] - arc.args[3] <= Math.PI / 3 + 1e-9);
});
