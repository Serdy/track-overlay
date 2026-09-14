const test = require('node:test');
const assert = require('node:assert');
const SessionModel = require('../js/session.js');

function payload(overrides = {}) {
  return Object.assign({
    session: { start_utc: '2026-09-12T12:31:30Z', track: 'Slovakia Ring',
               duration_s: 4, rate_hz: 2 },
    channels: {
      speed: { role: 'speed', unit: 'km/h', samples: [0, 100, 200, 300, 400] },
      lean:  { role: 'lean',  unit: 'deg',  samples: [0, -10, 0, 10, 0] },
    },
    laps: [
      { n: 1, t_start: 0.5, t_end: 2.0, duration_s: 1.5, best: false },
      { n: 2, t_start: 2.0, t_end: 3.5, duration_s: 1.5, best: true },
    ],
    clips: [{ id: 'cam_1', offset_s: -1.0, duration_s: 6.0, files: ['a.mp4'] }],
  }, overrides);
}

test('loading converts channels to typed arrays', () => {
  const session = SessionModel.load(payload());
  assert.ok(session.channels.speed.samples instanceof Float64Array);
  assert.strictEqual(session.rate, 2);
  assert.strictEqual(session.track, 'Slovakia Ring');
});

test('sampling hits grid nodes exactly', () => {
  const session = SessionModel.load(payload());
  assert.strictEqual(SessionModel.sampleAt(session, 'speed', 0), 0);
  assert.strictEqual(SessionModel.sampleAt(session, 'speed', 1), 200);
  assert.strictEqual(SessionModel.sampleAt(session, 'speed', 2), 400);
});

test('values interpolate between nodes', () => {
  const session = SessionModel.load(payload());
  assert.strictEqual(SessionModel.sampleAt(session, 'speed', 0.25), 50);
  assert.strictEqual(SessionModel.sampleAt(session, 'speed', 0.75), 150);
});

test('out-of-range queries clamp instead of returning undefined', () => {
  const session = SessionModel.load(payload());
  assert.strictEqual(SessionModel.sampleAt(session, 'speed', -100), 0);
  assert.strictEqual(SessionModel.sampleAt(session, 'speed', 1e6), 400);
});

test('an unknown channel yields null, not a crash', () => {
  const session = SessionModel.load(payload());
  assert.strictEqual(SessionModel.sampleAt(session, 'rpm', 1), null);
});

test('an empty channel yields null', () => {
  const session = SessionModel.load(payload({
    channels: { speed: { role: 'speed', unit: 'km/h', samples: [] } },
  }));
  assert.strictEqual(SessionModel.sampleAt(session, 'speed', 0), null);
});

test('sampleMany returns several channels at once', () => {
  const session = SessionModel.load(payload());
  assert.deepStrictEqual(SessionModel.sampleMany(session, ['speed', 'lean'], 1),
                         { speed: 200, lean: 0 });
});

test('the lap is resolved from a point in time', () => {
  const session = SessionModel.load(payload());
  assert.strictEqual(SessionModel.lapAt(session, 1.0).n, 1);
  assert.strictEqual(SessionModel.lapAt(session, 2.0).n, 2);   // the boundary belongs to the next lap
  assert.strictEqual(SessionModel.lapAt(session, 0.1), null);  // out lap
  assert.strictEqual(SessionModel.lapAt(session, 9), null);
});

test('lap time is counted from the lap start', () => {
  const session = SessionModel.load(payload());
  assert.strictEqual(SessionModel.lapTime(session, 1.25), 0.75);
  assert.strictEqual(SessionModel.lapTime(session, 0.1), null);
});

test('exactly one lap is marked as best', () => {
  const session = SessionModel.load(payload());
  assert.strictEqual(SessionModel.bestLap(session).n, 2);
});

test('time inside a clip accounts for its offset', () => {
  const session = SessionModel.load(payload());
  const clip = SessionModel.clipById(session, 'cam_1');
  assert.strictEqual(SessionModel.clipTime(clip, 0), 1.0);     // the clip started before the session
  assert.strictEqual(SessionModel.clipTime(clip, 3), 4.0);
});

test('outside the clip duration the time is undefined', () => {
  const session = SessionModel.load(payload());
  const clip = SessionModel.clipById(session, 'cam_1');
  assert.strictEqual(SessionModel.clipTime(clip, -2), null);   // before the start
  assert.strictEqual(SessionModel.clipTime(clip, 100), null);  // after the end
});

test('the chunk is chosen by time inside the clip', () => {
  const clip = { offset_s: 0, duration_s: 300, chunks: [100, 100, 100] };
  assert.deepStrictEqual(SessionModel.chunkAt(clip, 50), { index: 0, time: 50 });
  assert.deepStrictEqual(SessionModel.chunkAt(clip, 150), { index: 1, time: 50 });
  assert.deepStrictEqual(SessionModel.chunkAt(clip, 250), { index: 2, time: 50 });
});

test('a chunk boundary belongs to the next file', () => {
  const clip = { offset_s: 0, duration_s: 300, chunks: [100, 100, 100] };
  assert.deepStrictEqual(SessionModel.chunkAt(clip, 100), { index: 1, time: 0 });
});

test('the clip offset is accounted for when picking a chunk', () => {
  const clip = { offset_s: -116, duration_s: 300, chunks: [100, 100, 100] };
  assert.deepStrictEqual(SessionModel.chunkAt(clip, -66), { index: 0, time: 50 });
  assert.deepStrictEqual(SessionModel.chunkAt(clip, 84), { index: 2, time: 0 });
});

test('outside the clip there is no chunk', () => {
  const clip = { offset_s: 0, duration_s: 300, chunks: [100, 100, 100] };
  assert.strictEqual(SessionModel.chunkAt(clip, -1), null);
  assert.strictEqual(SessionModel.chunkAt(clip, 999), null);
});

test('a clip without chunk splits behaves as a single file', () => {
  const clip = { offset_s: 0, duration_s: 300 };
  assert.deepStrictEqual(SessionModel.chunkAt(clip, 120), { index: 0, time: 120 });
});
