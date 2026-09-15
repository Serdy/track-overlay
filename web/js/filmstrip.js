/**
 * filmstrip.js — where the thumbnails along the timeline go, and in what order to grab
 * them.
 *
 * Only the arithmetic lives here. Grabbing a frame means seeking a <video> and drawing it,
 * which is slow — tens of milliseconds each — so the order matters: a chunk boundary costs
 * a source change and a fresh load, and visiting the strip left to right on a recording
 * split into three files would pay that on every other frame.
 */
const Filmstrip = (function () {

  /**
   * One shot per thumbnail-sized slice of the strip, sampled at the middle of each slice.
   *
   * The middle rather than the edge because a thumbnail stands for the stretch it covers,
   * and a frame from the very start of it sits next to the mark for the previous one.
   */
  function plan({ duration, width, thumbWidth = 64 }) {
    if (!(duration > 0) || !(width > 0)) return [];
    const count = Math.max(1, Math.floor(width / thumbWidth));
    const slice = width / count;
    const shots = [];
    for (let i = 0; i < count; i += 1) {
      shots.push({
        t: ((i + 0.5) / count) * duration,
        x: i * slice,
        width: slice,
      });
    }
    return shots;
  }

  /**
   * Groups shots by the chunk they fall in, dropping the moments the clip does not cover.
   *
   * `locate` is `SessionModel.chunkAt` bound to one clip: session time in, chunk index and
   * the time inside that chunk out, or null where the camera was not recording.
   */
  function byChunk(shots, locate) {
    const groups = new Map();
    for (const shot of shots) {
      const found = locate(shot.t);
      if (!found) continue;
      if (!groups.has(found.index)) groups.set(found.index, []);
      groups.get(found.index).push(Object.assign({}, shot, { time: found.time }));
    }
    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, items]) => ({ index, items }));
  }

  return { plan, byChunk };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = Filmstrip;
else window.Filmstrip = Filmstrip;
