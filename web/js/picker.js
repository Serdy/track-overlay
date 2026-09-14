/**
 * picker.js — choosing source files without uploading them.
 *
 * The server already has the disk in front of it, so nothing is copied: the browser asks
 * for a directory listing and sends back the paths it wants. Pushing four gigabytes of
 * footage through HTTP to reach the same machine would be pure waste, and on a session's
 * worth of GoPro files it would be twenty-four.
 *
 * DOM-free apart from the panel it renders, and the sorting and grouping are exported so
 * they can be tested on their own.
 */
const Picker = (function () {

  const TELEMETRY = ['.csv', '.vbo'];
  const VIDEO = ['.mp4', '.mov'];

  function extension(name) {
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot).toLowerCase();
  }

  function isTelemetry(name) {
    return TELEMETRY.includes(extension(name));
  }

  function isVideo(name) {
    return VIDEO.includes(extension(name));
  }

  function humanSize(bytes) {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  }

  /**
   * What a chosen set is missing before a session can be built.
   *
   * Video alone is not enough - there would be nothing to draw - while telemetry alone
   * is perfectly usable, and produces a session the editor can show without a picture.
   */
  function missing(paths) {
    const names = paths.map((p) => p.split('/').pop());
    if (!names.length) return 'nothing chosen yet';
    if (!names.some(isTelemetry)) return 'a RaceBox export (.csv) is required';
    return null;
  }

  /** A short account of the selection, for the button to show. */
  function describe(paths) {
    const names = paths.map((p) => p.split('/').pop());
    const videos = names.filter(isVideo).length;
    const telemetry = names.filter(isTelemetry).length;
    const parts = [];
    if (videos) parts.push(`${videos} video file${videos > 1 ? 's' : ''}`);
    if (telemetry) parts.push(`${telemetry} telemetry file${telemetry > 1 ? 's' : ''}`);
    return parts.join(', ') || 'nothing chosen';
  }

  /**
   * Everything in a listing that belongs to the same GoPro recording as `name`.
   *
   * Picking one chunk almost always means wanting the rest: they are one recording split
   * at four gigabytes, and a session assembled from the first chunk alone would simply
   * stop partway through.
   */
  function sameRecording(name, files) {
    const match = /^(GH|GX|GP)(\d{2})(\d{4})\./i.exec(name);
    if (!match) return [name];
    const recording = match[3];
    return files
      .map((f) => f.name)
      .filter((other) => {
        const m = /^(GH|GX|GP)(\d{2})(\d{4})\./i.exec(other);
        return m && m[3] === recording;
      });
  }

  return { TELEMETRY, VIDEO, extension, isTelemetry, isVideo, humanSize,
           missing, describe, sameRecording };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Picker;
} else {
  window.Picker = Picker;
}
