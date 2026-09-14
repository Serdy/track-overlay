const test = require('node:test');
const assert = require('node:assert');

const Widgets = require('../js/widgets/index.js');
global.Widgets = Widgets;
require('../js/widgets/speed.js');
require('../js/widgets/lean.js');
require('../js/widgets/accel.js');

/** Поддельный контекст canvas: записывает вызовы и ловит нечисловые координаты. */
function fakeCtx() {
  const calls = [];
  const record = (name) => (...args) => {
    for (const arg of args) {
      if (typeof arg === 'number' && !isFinite(arg)) {
        throw new Error(`${name}: нечисловой аргумент ${arg}`);
      }
    }
    calls.push({ name, args });
  };
  return {
    calls,
    save: record('save'), restore: record('restore'),
    beginPath: record('beginPath'), fill: record('fill'),
    rect: record('rect'), roundRect: record('roundRect'),
    fillRect: record('fillRect'), fillText: record('fillText'),
    set fillStyle(v) { calls.push({ name: 'fillStyle', args: [v] }); },
    set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
  };
}

const BOX = { x: 100, y: 200, w: 288, h: 102 };
const FRAME = { width: 1920, height: 1080 };

test('реестр знает все три виджета', () => {
  assert.deepStrictEqual(Widgets.ids().sort(), ['accel', 'lean', 'speed']);
  assert.strictEqual(Widgets.get('нет такого'), null);
});

test('позиция в долях кадра переводится в пиксели', () => {
  const box = Widgets.boxFor(Widgets.get('speed'), { pos: [0.5, 0.25], scale: 1 }, FRAME);
  assert.strictEqual(box.x, 960);
  assert.strictEqual(box.y, 270);
});

test('масштаб меняет размер, но не позицию', () => {
  const one = Widgets.boxFor(Widgets.get('speed'), { pos: [0.1, 0.1], scale: 1 }, FRAME);
  const two = Widgets.boxFor(Widgets.get('speed'), { pos: [0.1, 0.1], scale: 2 }, FRAME);
  assert.strictEqual(two.x, one.x);
  assert.strictEqual(two.w, one.w * 2);
});

test('одна и та же раскладка даёт пропорционально одинаковый бокс в любом разрешении', () => {
  const hd = Widgets.boxFor(Widgets.get('speed'), { pos: [0.04, 0.86] }, { width: 1920, height: 1080 });
  const uhd = Widgets.boxFor(Widgets.get('speed'), { pos: [0.04, 0.86] }, { width: 3840, height: 2160 });
  assert.strictEqual(uhd.x, hd.x * 2);
  assert.strictEqual(uhd.h, hd.h * 2);
});

for (const id of ['speed', 'lean', 'accel']) {
  test(`виджет ${id} рисует что-то осмысленное`, () => {
    const ctx = fakeCtx();
    Widgets.get(id).draw(ctx, BOX, { speed: 123, lean: -41.8, accel: -0.54, score: -0.7 });
    assert.ok(ctx.calls.some((c) => c.name === 'fillText'), 'виджет ничего не подписал');
  });

  test(`виджет ${id} переживает отсутствие данных`, () => {
    const ctx = fakeCtx();
    Widgets.get(id).draw(ctx, BOX, {});
    Widgets.get(id).draw(ctx, BOX, { speed: null, lean: null, accel: null, score: null });
  });

  test(`виджет ${id} переживает значения за пределами шкалы`, () => {
    const ctx = fakeCtx();
    Widgets.get(id).draw(ctx, BOX, { speed: 1e6, lean: 900, accel: -99, score: -50 });
    Widgets.get(id).draw(ctx, BOX, { speed: -5, lean: -900, accel: 99, score: 50 });
  });
}

test('полоса наклона не вылезает за пределы виджета', () => {
  const ctx = fakeCtx();
  Widgets.get('lean').draw(ctx, BOX, { lean: 900 });
  for (const call of ctx.calls.filter((c) => c.name === 'fillRect')) {
    const [x, , w] = call.args;
    assert.ok(x >= BOX.x - 1 && x + w <= BOX.x + BOX.w + 1,
              `полоса ${x}..${x + w} вышла за ${BOX.x}..${BOX.x + BOX.w}`);
  }
});

test('полоса разгона не вылезает за пределы виджета', () => {
  const ctx = fakeCtx();
  Widgets.get('accel').draw(ctx, BOX, { score: -50, accel: -9 });
  for (const call of ctx.calls.filter((c) => c.name === 'fillRect')) {
    const [x, , w] = call.args;
    assert.ok(x >= BOX.x - 1 && x + w <= BOX.x + BOX.w + 1);
  }
});

test('drawAll пропускает неизвестные типы, не роняя остальные', () => {
  const ctx = fakeCtx();
  Widgets.drawAll(ctx, [{ type: 'выдуманный', pos: [0, 0] }, { type: 'speed', pos: [0, 0] }],
                  FRAME, { speed: 100 });
  assert.ok(ctx.calls.some((c) => c.name === 'fillText'));
});
