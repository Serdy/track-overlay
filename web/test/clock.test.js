const test = require('node:test');
const assert = require('node:assert');
const Clock = require('../js/clock.js');

const LAPS = [
  { n: 1, t_start: 10, t_end: 40 },
  { n: 2, t_start: 40, t_end: 70 },
  { n: 3, t_start: 70, t_end: 100 },
];

test('перемотка зажимается по краям', () => {
  const clock = Clock.create(100, 60);
  assert.strictEqual(Clock.seek(clock, 50), 50);
  assert.strictEqual(Clock.seek(clock, -10), 0);
  assert.strictEqual(Clock.seek(clock, 999), 100);
});

test('на паузе время не идёт', () => {
  const clock = Clock.create(100, 60);
  Clock.advance(clock, 5);
  assert.strictEqual(clock.time, 0);
});

test('скорость воспроизведения умножает ход времени', () => {
  const clock = Clock.create(100, 60);
  Clock.play(clock);
  Clock.setRate(clock, 2);
  Clock.advance(clock, 3);
  assert.strictEqual(clock.time, 6);
});

test('на конце воспроизведение останавливается само', () => {
  const clock = Clock.create(10, 60);
  Clock.play(clock);
  Clock.advance(clock, 20);
  assert.strictEqual(clock.time, 10);
  assert.strictEqual(clock.playing, false);
});

test('повторный play с конца начинает сначала', () => {
  const clock = Clock.create(10, 60);
  Clock.seek(clock, 10);
  Clock.play(clock);
  assert.strictEqual(clock.time, 0);
  assert.strictEqual(clock.playing, true);
});

test('покадровый шаг ставит на паузу', () => {
  const clock = Clock.create(100, 60);
  Clock.play(clock);
  Clock.step(clock, 1);
  assert.strictEqual(clock.playing, false);
  assert.ok(Math.abs(clock.time - 1 / 60) < 1e-9);
  Clock.step(clock, -1);
  assert.ok(Math.abs(clock.time) < 1e-9);
});

test('переключение скоростей не выходит за список', () => {
  const clock = Clock.create(100, 60);
  for (let i = 0; i < 10; i += 1) Clock.cycleRate(clock, 1);
  assert.strictEqual(clock.rate, Clock.RATES[Clock.RATES.length - 1]);
  for (let i = 0; i < 20; i += 1) Clock.cycleRate(clock, -1);
  assert.strictEqual(clock.rate, Clock.RATES[0]);
});

test('прыжок вперёд встаёт на начало следующего круга', () => {
  const clock = Clock.create(120, 60);
  Clock.seek(clock, 25);
  assert.strictEqual(Clock.jumpLap(clock, LAPS, +1), 40);
  assert.strictEqual(Clock.jumpLap(clock, LAPS, +1), 70);
});

test('прыжок вперёд с последнего круга уходит в конец', () => {
  const clock = Clock.create(120, 60);
  Clock.seek(clock, 80);
  assert.strictEqual(Clock.jumpLap(clock, LAPS, +1), 120);
});

test('прыжок назад сначала возвращает на начало текущего круга', () => {
  const clock = Clock.create(120, 60);
  Clock.seek(clock, 55);
  assert.strictEqual(Clock.jumpLap(clock, LAPS, -1), 40);   // начало круга 2
  assert.strictEqual(Clock.jumpLap(clock, LAPS, -1), 10);   // круг 1
  assert.strictEqual(Clock.jumpLap(clock, LAPS, -1), 0);    // дальше — в начало сессии
});

test('прыжок без кругов ничего не ломает', () => {
  const clock = Clock.create(120, 60);
  Clock.seek(clock, 30);
  assert.strictEqual(Clock.jumpLap(clock, [], +1), 30);
});

test('подписчики получают каждое изменение времени', () => {
  const clock = Clock.create(100, 60);
  const seen = [];
  const off = Clock.onChange(clock, (t) => seen.push(t));
  Clock.seek(clock, 10);
  Clock.seek(clock, 20);
  off();
  Clock.seek(clock, 30);
  assert.deepStrictEqual(seen, [10, 20]);
});

test('повторная перемотка в ту же точку подписчиков не дёргает', () => {
  const clock = Clock.create(100, 60);
  let calls = 0;
  Clock.onChange(clock, () => { calls += 1; });
  Clock.seek(clock, 10);
  Clock.seek(clock, 10);
  assert.strictEqual(calls, 1);
});

test('форматирование времени круга', () => {
  assert.strictEqual(Clock.formatTime(160.349), '2:40.349');
  assert.strictEqual(Clock.formatTime(5.5), '0:05.500');
  assert.strictEqual(Clock.formatTime(-1.25), '-0:01.250');
  assert.strictEqual(Clock.formatTime(null), '--:--.---');
  assert.strictEqual(Clock.formatTime(Infinity), '--:--.---');
});
