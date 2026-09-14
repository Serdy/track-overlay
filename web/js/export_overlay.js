/**
 * export_overlay.js — rendering the telemetry layer to a video ffmpeg can composite.
 *
 * This is the half of the pipeline the browser owns. It never touches the source footage:
 * it encodes a small mostly-empty layer, not 4K video, which is why the GoPro codec is
 * irrelevant here and why the whole thing is quick.
 *
 * Frames are drawn by the very same `Widgets.drawAll` the preview calls. That single rule
 * is what keeps the export honest — there is no second drawing path that could drift.
 *
 * **On transparency.** WebCodecs advertises an `alpha: 'keep'` option, but no browser
 * tested here will actually encode it: VP9, VP8, H.264 and AV1 all report support only
 * with alpha switched off. So the layer is written as a frame of double height — colour
 * on top, a greyscale matte of the alpha channel below — and ffmpeg puts the two back
 * together with `alphamerge`. One encode and one file, so the halves cannot drift apart,
 * which is the failure mode of shipping them as two videos.
 *
 * The matte is built with canvas compositing rather than a pixel loop. Reading two
 * million pixels per frame in JavaScript would take longer than everything else combined.
 *
 * **On the codec.** H.264 comes first, and not for compatibility — for the hardware
 * encoder. Apple Silicon has no hardware VP9 encoder, so libvpx runs in software across
 * several cores: measured at 380-430% CPU against 50-95% for hardware H.264, for the same
 * throughput. H.264 has to be asked for at level 5.1 or above, because the doubled frame
 * height exceeds what level 4.0 allows and the browser then reports no support at all
 * rather than falling back.
 */
const OverlayExport = (function () {

  const QUEUE_LIMIT = 12;          // frames allowed in flight before we wait

  // Tried in order. Hardware first: the work then leaves the CPU almost entirely.
  const CANDIDATES = [
    { codec: 'avc1.640033', container: 'mp4', track: 'avc', hardware: true },
    { codec: 'avc1.640033', container: 'mp4', track: 'avc' },
    { codec: 'vp09.00.10.08', container: 'webm', track: 'V_VP9' },
    { codec: 'vp8', container: 'webm', track: 'V_VP8' },
  ];

  function supported() {
    return typeof VideoEncoder !== 'undefined'
      && typeof VideoFrame !== 'undefined'
      && typeof OffscreenCanvas !== 'undefined';
  }

  /** The first codec this browser will actually encode at the given size. */
  async function pickCodec(width, height, fps) {
    for (const candidate of CANDIDATES) {
      const config = {
        codec: candidate.codec, width, height, framerate: fps,
        bitrate: Math.round(width * height * fps * 0.02),
      };
      if (candidate.hardware) config.hardwareAcceleration = 'prefer-hardware';
      try {
        const probe = await VideoEncoder.isConfigSupported(config);
        if (probe.supported) return { ...candidate, config };
      } catch (error) {
        // An unknown codec string throws rather than reporting unsupported.
      }
    }
    throw new Error('this browser cannot encode H.264, VP9 or VP8');
  }

  /** A muxer for the chosen container, with the same interface either way. */
  function makeMuxer(chosen, width, height, fps) {
    if (chosen.container === 'mp4') {
      return new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: chosen.track, width, height, frameRate: fps },
        // The whole file is assembled in memory, so the index can go at the front —
        // ffmpeg then reads it without seeking to the end.
        fastStart: 'in-memory',
      });
    }
    return new WebMMuxer.Muxer({
      target: new WebMMuxer.ArrayBufferTarget(),
      video: { codec: chosen.track, width, height, frameRate: fps },
    });
  }

  /**
   * Yields to the event loop without going through a timer.
   *
   * `setTimeout` is clamped - to about 4 ms in a visible tab and to roughly one call a
   * second once the tab goes to the background - so an export driven by it all but stops
   * the moment you switch to another tab. A MessageChannel round trip is not clamped:
   * measured at 68,789 iterations against 49 for `setTimeout(0)` over the same 200 ms.
   */
  function yieldToLoop() {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        // Both ports are closed straight away: an open port is a live handle, and
        // leaving one per frame behind would leak them by the thousand.
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });
  }

  /**
   * Waits until the encoder has drained enough to take more work.
   *
   * Driven by the encoder's own `dequeue` event where the browser has it, which is both
   * exact and free of polling; otherwise by yielding until the queue comes down.
   */
  function drain(encoder) {
    if (encoder.encodeQueueSize <= QUEUE_LIMIT) return Promise.resolve();
    if ('ondequeue' in encoder) {
      return new Promise((resolve) => {
        const check = () => {
          if (encoder.encodeQueueSize > QUEUE_LIMIT) return;
          encoder.removeEventListener('dequeue', check);
          resolve();
        };
        encoder.addEventListener('dequeue', check);
        check();
      });
    }
    return (async () => {
      while (encoder.encodeQueueSize > QUEUE_LIMIT) await yieldToLoop();
    })();
  }

  /**
   * Stacks one drawn frame into colour over matte.
   *
   * The matte is the alpha channel as luminance: white fill masked by the overlay's own
   * alpha, then flattened onto black. Three canvas operations, all on the GPU side.
   */
  function stack(target, layer, scratch, width, height) {
    const ctx = target.getContext('2d', { alpha: false });
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height * 2);
    ctx.drawImage(layer, 0, 0);                      // colour over black

    const mask = scratch.getContext('2d');
    mask.globalCompositeOperation = 'source-over';
    mask.fillStyle = '#ffffff';
    mask.fillRect(0, 0, width, height);
    mask.globalCompositeOperation = 'destination-in';
    mask.drawImage(layer, 0, 0);                     // white carrying the layer's alpha
    mask.globalCompositeOperation = 'source-over';

    ctx.drawImage(scratch, 0, height);               // flattened onto black: alpha as grey
  }

  /**
   * Renders the overlay for a time range.
   *
   * `drawFrame(ctx, t, frame)` is supplied by the caller and is expected to be the same
   * routine the preview uses.
   */
  async function render({ width, height, fps, from, to, drawFrame, onProgress, signal }) {
    if (!supported()) throw new Error('this browser has no WebCodecs support');

    const chosen = await pickCodec(width, height * 2, fps);
    const layer = new OffscreenCanvas(width, height);
    const scratch = new OffscreenCanvas(width, height);
    const stacked = new OffscreenCanvas(width, height * 2);
    const layerCtx = layer.getContext('2d', { alpha: true });

    const muxer = makeMuxer(chosen, width, height * 2, fps);

    let failure = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (error) => { failure = error; },
    });
    encoder.configure(chosen.config);

    const total = Math.max(1, Math.round((to - from) * fps));
    for (let i = 0; i < total; i += 1) {
      if (failure) throw failure;
      if (signal && signal.aborted) {
        encoder.close();
        throw new Error('cancelled');
      }
      const t = from + i / fps;
      layerCtx.clearRect(0, 0, width, height);
      drawFrame(layerCtx, t, { width, height });
      stack(stacked, layer, scratch, width, height);

      const frame = new VideoFrame(stacked, {
        timestamp: Math.round((i / fps) * 1e6),
        duration: Math.round(1e6 / fps),
      });
      // A keyframe every two seconds keeps ffmpeg able to seek the layer.
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();

      await drain(encoder);
      // Yield anyway every so often, or a fast encoder means the loop never lets the
      // page breathe and the progress bar stops moving.
      if (i % 30 === 0) await yieldToLoop();
      if (onProgress && i % fps === 0) onProgress(i / total);
    }

    await encoder.flush();
    encoder.close();
    if (failure) throw failure;
    muxer.finalize();
    if (onProgress) onProgress(1);
    return new Blob([muxer.target.buffer], {
      type: chosen.container === 'mp4' ? 'video/mp4' : 'video/webm',
    });
  }

  return { QUEUE_LIMIT, CANDIDATES, supported, pickCodec, makeMuxer, stack,
           yieldToLoop, drain, render };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OverlayExport;
} else {
  window.OverlayExport = OverlayExport;
}
