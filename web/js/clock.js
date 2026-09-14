/**
 * clock.js — the single source of the current time.
 *
 * Everything that moves on screen — the video in each slot, the overlay, the playhead —
 * takes its time from here and nowhere else. Otherwise the layers drift apart: the
 * video runs on its own `currentTime` and the overlay on its own timer, and a pause or
 * a seek pulls them out of step.
 *
 * DOM-free: ticks come from outside, listeners live outside. The wiring to
 * requestAnimationFrame and to the <video> tags lives in state.js.
 */
const Clock = (function () {

  const RATES = [0.25, 0.5, 1, 2, 4];

  function create(duration, fps) {
    return {
      time: 0,
      duration: duration,
      fps: fps || 60,
      rate: 1,
      playing: false,
      listeners: [],
    };
  }

  function clamp(clock, t) {
    return Math.min(Math.max(t, 0), clock.duration);
  }

  function notify(clock) {
    for (const listener of clock.listeners) listener(clock.time, clock);
  }

  function onChange(clock, listener) {
    clock.listeners.push(listener);
    return () => {
      const i = clock.listeners.indexOf(listener);
      if (i >= 0) clock.listeners.splice(i, 1);
    };
  }

  function seek(clock, t) {
    const next = clamp(clock, t);
    if (next === clock.time) return clock.time;
    clock.time = next;
    notify(clock);
    return clock.time;
  }

  /** Advances time by the elapsed wall-clock seconds, scaled by playback rate. */
  function advance(clock, elapsedS) {
    if (!clock.playing) return clock.time;
    const next = clamp(clock, clock.time + elapsedS * clock.rate);
    clock.time = next;
    if (next >= clock.duration) clock.playing = false;   // reached the end
    notify(clock);
    return clock.time;
  }

  function play(clock) {
    if (clock.time >= clock.duration) clock.time = 0;    // from the end, start over
    clock.playing = true;
    notify(clock);
  }

  function pause(clock) {
    clock.playing = false;
    notify(clock);
  }

  function toggle(clock) {
    (clock.playing ? pause : play)(clock);
  }

  /** Steps by a number of frames; stepping stops playback. */
  function step(clock, frames) {
    clock.playing = false;
    return seek(clock, clock.time + frames / clock.fps);
  }

  function setRate(clock, rate) {
    clock.rate = rate;
    notify(clock);
  }

  function cycleRate(clock, direction) {
    const i = RATES.indexOf(clock.rate);
    const next = Math.min(Math.max((i < 0 ? 2 : i) + direction, 0), RATES.length - 1);
    setRate(clock, RATES[next]);
    return clock.rate;
  }

  /** Jumps to the start of an adjacent lap. */
  function jumpLap(clock, laps, direction) {
    const starts = laps.map((lap) => lap.t_start);
    if (!starts.length) return clock.time;
    if (direction > 0) {
      const next = starts.find((t) => t > clock.time + 0.01);
      return seek(clock, next === undefined ? clock.duration : next);
    }
    // Backwards: first to the start of the current lap, then to the previous one.
    const previous = starts.filter((t) => t < clock.time - 0.5).pop();
    return seek(clock, previous === undefined ? 0 : previous);
  }

  function formatTime(seconds) {
    if (seconds === null || seconds === undefined || !isFinite(seconds)) return '--:--.---';
    const sign = seconds < 0 ? '-' : '';
    const abs = Math.abs(seconds);
    const minutes = Math.floor(abs / 60);
    const rest = abs - minutes * 60;
    return `${sign}${minutes}:${rest.toFixed(3).padStart(6, '0')}`;
  }

  return {
    RATES, create, seek, advance, play, pause, toggle, step,
    setRate, cycleRate, jumpLap, onChange, formatTime,
  };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Clock;
} else {
  window.Clock = Clock;
}
