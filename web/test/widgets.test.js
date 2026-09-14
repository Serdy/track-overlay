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

test('реестр знает виджеты и не выдумывает лишних', () => {
  // require карты стоит ниже по файлу, но выполняется при загрузке — до тел тестов.
  assert.deepStrictEqual(Widgets.ids().sort(), ['accel', 'lean', 'map', 'speed']);
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

// --- карта -------------------------------------------------------------------

require('../js/widgets/map.js');

const ENVELOPE = {
  left: [[48.000, 17.000], [48.010, 17.000], [48.010, 17.020], [48.000, 17.020]],
  right: [[48.001, 17.001], [48.009, 17.001], [48.009, 17.019], [48.001, 17.019]],
};
const MAP_SESSION = { envelope: ENVELOPE };
const MAP_BOX = { x: 0, y: 0, w: 200, h: 200 };

test('карта попала в реестр', () => {
  assert.ok(Widgets.get('map'));
});

test('проекция сохраняет пропорции трассы', () => {
  const map = Widgets.get('map');
  const bounds = map._bounds([ENVELOPE.left]);
  const project = map._makeProjection(MAP_BOX, bounds);
  const [x0, y0] = project(48.000, 17.000);
  const [x1, y1] = project(48.010, 17.020);

  // Градус долготы на широте 48° короче градуса широты в cos(48°) раз.
  const expected = (0.020 * Math.cos(48 * Math.PI / 180)) / 0.010;
  assert.ok(Math.abs(Math.abs(x1 - x0) / Math.abs(y1 - y0) - expected) < 0.01);
});

test('проекция переворачивает ось: север сверху', () => {
  const map = Widgets.get('map');
  const project = map._makeProjection(MAP_BOX, map._bounds([ENVELOPE.left]));
  assert.ok(project(48.010, 17.010)[1] < project(48.000, 17.010)[1]);
});

test('проекция вписывается в бокс с полями', () => {
  const map = Widgets.get('map');
  const project = map._makeProjection(MAP_BOX, map._bounds([ENVELOPE.left]));
  for (const [lat, lon] of ENVELOPE.left) {
    const [x, y] = project(lat, lon);
    assert.ok(x >= MAP_BOX.x && x <= MAP_BOX.x + MAP_BOX.w, `x=${x} вне бокса`);
    assert.ok(y >= MAP_BOX.y && y <= MAP_BOX.y + MAP_BOX.h, `y=${y} вне бокса`);
  }
});

test('вырожденный трек не роняет проекцию', () => {
  const map = Widgets.get('map');
  const project = map._makeProjection(MAP_BOX, map._bounds([[[48.0, 17.0]]]));
  const [x, y] = project(48.0, 17.0);
  assert.ok(isFinite(x) && isFinite(y));
});

test('prepare считает геометрию один раз', () => {
  const prepared = Widgets.get('map').prepare(MAP_SESSION, MAP_BOX);
  assert.strictEqual(prepared.left.length, ENVELOPE.left.length);
  assert.strictEqual(prepared.right.length, ENVELOPE.right.length);
});

test('без огибающей карта просто не рисуется', () => {
  const prepared = Widgets.get('map').prepare({ envelope: { left: [], right: [] } }, MAP_BOX);
  assert.strictEqual(prepared, null);
  const ctx = fakeCtx();
  Widgets.get('map').draw(ctx, MAP_BOX, { map: null });    // падения быть не должно
});

test('карта рисует полосу, след и точку', () => {
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

test('карта переживает отсутствие позиции и следа', () => {
  const ctx = fakeCtx();
  ctx.beginPath = () => {}; ctx.moveTo = () => {}; ctx.lineTo = () => {};
  ctx.closePath = () => {}; ctx.stroke = () => {}; ctx.arc = () => {};
  const prepared = Widgets.get('map').prepare(MAP_SESSION, MAP_BOX);
  Widgets.get('map').draw(ctx, MAP_BOX, { map: prepared, lat: null, lon: null, trail: [] });
});
