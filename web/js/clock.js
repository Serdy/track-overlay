/**
 * clock.js — единственный источник текущего времени.
 *
 * Всё, что движется на экране — видео в каждом слоте, оверлей, бегунок, — берёт время
 * отсюда и только отсюда. Иначе слои разъезжаются: видео живёт своим `currentTime`,
 * а оверлей своим таймером, и на паузе или перемотке они расходятся.
 *
 * Модуль без DOM: тики извне, подписчики снаружи. Привязка к requestAnimationFrame и
 * к тегам <video> живёт в state.js.
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

  /** Продвигает время на прошедшие реальные секунды с учётом скорости. */
  function advance(clock, elapsedS) {
    if (!clock.playing) return clock.time;
    const next = clamp(clock, clock.time + elapsedS * clock.rate);
    clock.time = next;
    if (next >= clock.duration) clock.playing = false;   // доехали до конца
    notify(clock);
    return clock.time;
  }

  function play(clock) {
    if (clock.time >= clock.duration) clock.time = 0;    // с конца — снова с начала
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

  /** Шаг на несколько кадров; при шаге воспроизведение останавливается. */
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

  /** Прыжок к началу соседнего круга. */
  function jumpLap(clock, laps, direction) {
    const starts = laps.map((lap) => lap.t_start);
    if (!starts.length) return clock.time;
    if (direction > 0) {
      const next = starts.find((t) => t > clock.time + 0.01);
      return seek(clock, next === undefined ? clock.duration : next);
    }
    // Назад: сначала к началу текущего круга, повторно — к предыдущему.
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
