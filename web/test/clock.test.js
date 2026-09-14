const test = require('node:test');
const assert = require('node:assert');
const Clock = require('../js/clock.js');

const LAPS = [
  { n: 1, t_start: 10, t_end: 40 },
  { n: 2, t_start: 40, t_end: 70 },
  { n: 3, t_start: 70, t_end: 100 },
];

test('seeking clamps at both ends', () => {
  const clock = Clock.create(100, 60);
  assert.strictEqual(Clock.seek(clock, 50), 50);
  assert.strictEqual(Clock.seek(clock, -10), 0);
  assert.strictEqual(Clock.seek(clock, 999), 100);
});

test('time does not move while paused', () => {
  const clock = Clock.create(100, 60);
  Clock.advance(clock, 5);
  assert.strictEqual(clock.time, 0);
});

test('playback rate multiplies how time advances', () => {
  const clock = Clock.create(100, 60);
  Clock.play(clock);
  Clock.setRate(clock, 2);
  Clock.advance(clock, 3);
  assert.strictEqual(clock.time, 6);
});

test('playback stops itself at the end', () => {
  const clock = Clock.create(10, 60);
  Clock.play(clock);
  Clock.advance(clock, 20);
  assert.strictEqual(clock.time, 10);
  assert.strictEqual(clock.playing, false);
});

test('pressing play at the end starts over', () => {
  const clock = Clock.create(10, 60);
  Clock.seek(clock, 10);
  Clock.play(clock);
  assert.strictEqual(clock.time, 0);
  assert.strictEqual(clock.playing, true);
});

test('stepping by frames pauses playback', () => {
  const clock = Clock.create(100, 60);
  Clock.play(clock);
  Clock.step(clock, 1);
  assert.strictEqual(clock.playing, false);
  assert.ok(Math.abs(clock.time - 1 / 60) < 1e-9);
  Clock.step(clock, -1);
  assert.ok(Math.abs(clock.time) < 1e-9);
});

test('cycling the rate stays within the list', () => {
  const clock = Clock.create(100, 60);
  for (let i = 0; i < 10; i += 1) Clock.cycleRate(clock, 1);
  assert.strictEqual(clock.rate, Clock.RATES[Clock.RATES.length - 1]);
  for (let i = 0; i < 20; i += 1) Clock.cycleRate(clock, -1);
  assert.strictEqual(clock.rate, Clock.RATES[0]);
});

test('jumping forward lands on the next lap start', () => {
  const clock = Clock.create(120, 60);
  Clock.seek(clock, 25);
  assert.strictEqual(Clock.jumpLap(clock, LAPS, +1), 40);
  assert.strictEqual(Clock.jumpLap(clock, LAPS, +1), 70);
});

test('jumping forward from the last lap goes to the end', () => {
  const clock = Clock.create(120, 60);
  Clock.seek(clock, 80);
  assert.strictEqual(Clock.jumpLap(clock, LAPS, +1), 120);
});

test('jumping back first returns to the current lap start', () => {
  const clock = Clock.create(120, 60);
  Clock.seek(clock, 55);
  assert.strictEqual(Clock.jumpLap(clock, LAPS, -1), 40);   // start of lap 2
  assert.strictEqual(Clock.jumpLap(clock, LAPS, -1), 10);   // lap 1
  assert.strictEqual(Clock.jumpLap(clock, LAPS, -1), 0);    // then to the session start
});

test('jumping with no laps breaks nothing', () => {
  const clock = Clock.create(120, 60);
  Clock.seek(clock, 30);
  assert.strictEqual(Clock.jumpLap(clock, [], +1), 30);
});

test('listeners receive every time change', () => {
  const clock = Clock.create(100, 60);
  const seen = [];
  const off = Clock.onChange(clock, (t) => seen.push(t));
  Clock.seek(clock, 10);
  Clock.seek(clock, 20);
  off();
  Clock.seek(clock, 30);
  assert.deepStrictEqual(seen, [10, 20]);
});

test('seeking to the same point does not notify listeners', () => {
  const clock = Clock.create(100, 60);
  let calls = 0;
  Clock.onChange(clock, () => { calls += 1; });
  Clock.seek(clock, 10);
  Clock.seek(clock, 10);
  assert.strictEqual(calls, 1);
});

test('lap time formatting', () => {
  assert.strictEqual(Clock.formatTime(160.349), '2:40.349');
  assert.strictEqual(Clock.formatTime(5.5), '0:05.500');
  assert.strictEqual(Clock.formatTime(-1.25), '-0:01.250');
  assert.strictEqual(Clock.formatTime(null), '--:--.---');
  assert.strictEqual(Clock.formatTime(Infinity), '--:--.---');
});
