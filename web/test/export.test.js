const test = require('node:test');
const assert = require('node:assert');

const OverlayExport = require('../js/export_overlay.js');
const ExportUI = require('../js/export_ui.js');

/** Stands in for VideoEncoder.isConfigSupported with a fixed answer per codec. */
function stubEncoder(accepted) {
  global.VideoEncoder = {
    isConfigSupported: async (config) => {
      if (config.codec === 'throws') throw new Error('unknown codec');
      return { supported: accepted.includes(config.codec), config };
    },
  };
}

test('the first codec the browser accepts is chosen', async () => {
  stubEncoder(['vp09.00.10.08', 'vp8']);
  const picked = await OverlayExport.pickCodec(1920, 2160, 60);
  assert.strictEqual(picked.codec, 'vp09.00.10.08');
  assert.strictEqual(picked.muxer, 'V_VP9');
});

test('an unsupported codec falls through to the next', async () => {
  stubEncoder(['vp8']);
  const picked = await OverlayExport.pickCodec(1920, 2160, 60);
  assert.strictEqual(picked.codec, 'vp8');
  assert.strictEqual(picked.muxer, 'V_VP8');
});

test('no usable codec is an explicit failure, not a silent one', async () => {
  stubEncoder([]);
  await assert.rejects(() => OverlayExport.pickCodec(1920, 2160, 60),
                       /cannot encode VP9 or VP8/);
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
