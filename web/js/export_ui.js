/**
 * export_ui.js — the export button and its progress.
 *
 * The run has two halves with very different costs. The browser renders the telemetry
 * layer, which is quick because the layer is small and mostly empty. ffmpeg then composes
 * the cameras and burns the layer in, which is where the real time goes. Progress is
 * therefore reported as a weighted pair rather than two bars.
 */
const ExportUI = (function () {

  // Roughly how the wall-clock time splits, so one bar moves at an even pace.
  const OVERLAY_SHARE = 0.35;
  const POLL_MS = 500;

  async function post(url, body, type) {
    const response = await fetch(url, {
      method: 'POST',
      headers: type ? { 'Content-Type': type } : {},
      body,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `${url} answered ${response.status}`);
    }
    return response.json();
  }

  /**
   * Waits, but wakes the moment the page is looked at again.
   *
   * ffmpeg carries on regardless - it is a process on the far side of a socket - but a
   * hidden tab has its timers clamped to about one call a minute, so coming back to the
   * page showed a bar frozen where it was left. Worse, a run that had finished meanwhile
   * looked stuck rather than done.
   */
  function pause(ms) {
    const page = typeof document !== 'undefined' ? document : null;
    if (!page) return new Promise((resolve) => setTimeout(resolve, ms));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        page.removeEventListener('visibilitychange', woken);
        resolve();
      };
      const woken = () => { if (!page.hidden) done(); };
      const timer = setTimeout(done, ms);
      page.addEventListener('visibilitychange', woken);
    });
  }

  /** Follows a render job until it stops, reporting its progress. */
  async function follow(id, onProgress, signal) {
    for (;;) {
      if (signal && signal.aborted) {
        await fetch(`/api/render/${id}/cancel`, { method: 'POST' }).catch(() => {});
        throw new Error('cancelled');
      }
      const job = await (await fetch(`/api/render/${id}`)).json();
      onProgress(job.progress, job);
      if (job.state === 'done') return job;
      if (job.state !== 'running') throw new Error(job.message || job.state);
      await pause(POLL_MS);
    }
  }

  /**
   * The whole run: render the layer, hand it over, compose, report where it landed.
   *
   * `duration` limits the render to the first N seconds, which is how a layout gets
   * checked without waiting for the full session.
   */
  async function run({ base = '', output, drawFrame, duration, name, kept, toSession,
                       onStage, onProgress, signal }) {
    const width = output.width;
    const height = output.height;
    const fps = output.fps;
    const to = duration || kept || output.duration;

    onStage('rendering the telemetry layer');
    // Frames run in output time while telemetry is addressed in session time, and the
    // two part company as soon as anything is cut out.
    const map = toSession || ((t) => t);
    const blob = await OverlayExport.render({
      width, height, fps, from: 0, to, signal,
      drawFrame: (ctx, t, frame) => drawFrame(ctx, map(t), frame),
      onProgress: (done) => onProgress(done * OVERLAY_SHARE),
    });

    onStage(`uploading the layer (${(blob.size / 1e6).toFixed(1)} MB)`);
    await post(`${base}/api/overlay`, blob, blob.type);

    onStage('composing with ffmpeg');
    const job = await post(`${base}/api/render`, JSON.stringify({ duration: to, name }),
                           'application/json');
    const finished = await follow(job.id,
      (done) => onProgress(OVERLAY_SHARE + done * (1 - OVERLAY_SHARE)), signal);

    onStage('done');
    onProgress(1);
    return finished.output;
  }

  return { OVERLAY_SHARE, POLL_MS, follow, run };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ExportUI;
} else {
  window.ExportUI = ExportUI;
}
