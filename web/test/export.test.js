const test = require('node:test');
const assert = require('node:assert');

const OverlayExport = require('../js/export_overlay.js');
const ExportUI = require('../js/export_ui.js');

/** Stands in for VideoEncoder.isConfigSupported with a fixed answer per codec. */
function stubEncoder(accepted, options = {}) {
  global.VideoEncoder = {
    isConfigSupported: async (config) => {
      if (config.codec === 'throws') throw new Error('unknown codec');
      const known = accepted.includes(config.codec);
      // A browser without a hardware encoder reports no support for that request
      // specifically, rather than quietly handing back a software one.
      if (config.hardwareAcceleration === 'prefer-hardware' && options.hardwareOnly === false) {
        return { supported: false, config };
      }
      return { supported: known, config };
    },
  };
}

test('hardware H.264 is preferred over everything else', async () => {
  // Apple Silicon has no hardware VP9 encoder, so libvpx runs across several cores:
  // 380-430% CPU against 50-95% for hardware H.264, at the same throughput.
  stubEncoder(['avc1.640033', 'vp09.00.10.08', 'vp8']);
  const picked = await OverlayExport.pickCodec(1920, 2160, 60);
  assert.strictEqual(picked.codec, 'avc1.640033');
  assert.strictEqual(picked.container, 'mp4');
  assert.strictEqual(picked.config.hardwareAcceleration, 'prefer-hardware');
});

test('without a hardware encoder H.264 is still tried in software', async () => {
  stubEncoder(['avc1.640033'], { hardwareOnly: false });
  const picked = await OverlayExport.pickCodec(1920, 2160, 60);
  assert.strictEqual(picked.codec, 'avc1.640033');
});

test('with no H.264 at all it falls through to VP9', async () => {
  stubEncoder(['vp09.00.10.08', 'vp8']);
  const picked = await OverlayExport.pickCodec(1920, 2160, 60);
  assert.strictEqual(picked.codec, 'vp09.00.10.08');
  assert.strictEqual(picked.container, 'webm');
  assert.strictEqual(picked.track, 'V_VP9');
});

test('and then to VP8', async () => {
  stubEncoder(['vp8']);
  const picked = await OverlayExport.pickCodec(1920, 2160, 60);
  assert.strictEqual(picked.track, 'V_VP8');
});

test('no usable codec is an explicit failure, not a silent one', async () => {
  stubEncoder([]);
  await assert.rejects(() => OverlayExport.pickCodec(1920, 2160, 60),
                       /cannot encode H.264, VP9 or VP8/);
});

test('H.264 is asked for at level 5.1 or above', () => {
  // The doubled frame height exceeds what level 4.0 allows, and the browser then reports
  // no support at all rather than falling back to a higher level.
  for (const candidate of OverlayExport.CANDIDATES) {
    if (!candidate.codec.startsWith('avc1')) continue;
    const level = parseInt(candidate.codec.slice(-2), 16);
    assert.ok(level >= 0x33, `${candidate.codec} is below level 5.1`);
  }
});

test('the chosen config carries the doubled height', async () => {
  // Colour on top, matte below — the encoder sees one frame of twice the output height.
  stubEncoder(['vp09.00.10.08']);
  const picked = await OverlayExport.pickCodec(1920, 2160, 60);
  assert.strictEqual(picked.config.height, 2160);
  assert.strictEqual(picked.config.width, 1920);
});

test('support detection needs all three WebCodecs pieces', () => {
  const saved = [global.VideoEncoder, global.VideoFrame, global.OffscreenCanvas];
  global.VideoEncoder = {}; global.VideoFrame = {}; global.OffscreenCanvas = {};
  assert.strictEqual(OverlayExport.supported(), true);
  delete global.OffscreenCanvas;
  assert.strictEqual(OverlayExport.supported(), false);
  [global.VideoEncoder, global.VideoFrame, global.OffscreenCanvas] = saved;
});

// --- following a render job --------------------------------------------------

function stubFetch(states) {
  let call = 0;
  global.fetch = async () => ({
    ok: true,
    json: async () => states[Math.min(call++, states.length - 1)],
  });
}

test('following a job reports progress until it finishes', async () => {
  stubFetch([
    { state: 'running', progress: 0.2 },
    { state: 'running', progress: 0.7 },
    { state: 'done', progress: 1, output: 'out/final.mp4' },
  ]);
  const seen = [];
  const job = await ExportUI.follow('abc', (p) => seen.push(p));
  assert.deepStrictEqual(seen, [0.2, 0.7, 1]);
  assert.strictEqual(job.output, 'out/final.mp4');
});

test('a failed job surfaces its message rather than hanging', async () => {
  stubFetch([{ state: 'failed', progress: 0.3, message: 'ffmpeg exited with 1' }]);
  await assert.rejects(() => ExportUI.follow('abc', () => {}), /ffmpeg exited with 1/);
});

test('a cancelled job is reported as cancelled', async () => {
  stubFetch([{ state: 'cancelled', progress: 0.5, message: '' }]);
  await assert.rejects(() => ExportUI.follow('abc', () => {}), /cancelled/);
});

test('an aborted signal stops the polling', async () => {
  stubFetch([{ state: 'running', progress: 0.1 }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => ExportUI.follow('abc', () => {}, controller.signal),
                       /cancelled/);
});

test('the two halves of the run add up to one', () => {
  assert.ok(ExportUI.OVERLAY_SHARE > 0 && ExportUI.OVERLAY_SHARE < 1);
});


// --- waiting for the encoder ------------------------------------------------

test('a queue below the limit does not wait at all', async () => {
  const encoder = { encodeQueueSize: 0 };
  await OverlayExport.drain(encoder);          // must resolve without a listener
});

test('draining waits on the dequeue event when there is one', async () => {
  let listener = null;
  const encoder = {
    encodeQueueSize: OverlayExport.QUEUE_LIMIT + 5,
    ondequeue: null,
    addEventListener: (_, fn) => { listener = fn; },
    removeEventListener: () => { listener = null; },
  };
  const waiting = OverlayExport.drain(encoder);
  assert.ok(listener, 'a dequeue listener should have been attached');
  encoder.encodeQueueSize = 0;
  listener();
  await waiting;
  assert.strictEqual(listener, null, 'the listener should be removed once drained');
});

test('the dequeue listener ignores a queue that is still too long', async () => {
  let listener = null;
  let removed = 0;
  const encoder = {
    encodeQueueSize: OverlayExport.QUEUE_LIMIT + 5,
    ondequeue: null,
    addEventListener: (_, fn) => { listener = fn; },
    removeEventListener: () => { removed += 1; },
  };
  const waiting = OverlayExport.drain(encoder);
  listener();                                   // still full
  assert.strictEqual(removed, 0);
  encoder.encodeQueueSize = 1;
  listener();
  await waiting;
  assert.strictEqual(removed, 1);
});

test('without dequeue it falls back to yielding', async () => {
  const encoder = { encodeQueueSize: OverlayExport.QUEUE_LIMIT + 1 };
  const waiting = OverlayExport.drain(encoder);
  encoder.encodeQueueSize = 0;
  await waiting;
});

test('yielding to the loop does not go through a timer', async () => {
  // setTimeout is clamped hard in a background tab; a MessageChannel round trip is not.
  const original = global.setTimeout;
  let used = false;
  global.setTimeout = (...args) => { used = true; return original(...args); };
  await OverlayExport.yieldToLoop();
  global.setTimeout = original;
  assert.strictEqual(used, false, 'yielding must not call setTimeout');
});

test('polling wakes as soon as the page is looked at again', async () => {
  // A hidden tab clamps timers to about a call a minute, so a finished render looked
  // stuck until the tab was touched.
  const listeners = [];
  global.document = {
    hidden: true,
    addEventListener: (name, fn) => listeners.push(fn),
    removeEventListener: () => {},
  };
  const slept = [];
  const realTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { slept.push(ms); return realTimeout(fn, 10_000); };

  let polls = 0;
  global.fetch = async () => ({
    ok: true,
    json: async () => (polls++ ? { state: 'done', progress: 1 } : { state: 'running', progress: 0.5 }),
  });

  const following = ExportUI.follow('abc', () => {});
  await new Promise((resolve) => realTimeout(resolve, 20));
  global.document.hidden = false;
  listeners.forEach((fn) => fn());                 // the tab comes back

  const job = await following;
  assert.strictEqual(job.state, 'done');
  assert.deepStrictEqual(slept, [ExportUI.POLL_MS]);
  global.setTimeout = realTimeout;
  delete global.document;
});
