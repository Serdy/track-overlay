/**
 * session.js — модель сессии и выборка каналов.
 *
 * Модуль намеренно не знает про DOM: он загружается и в браузере, и в node под тесты.
 *
 * Сетка телеметрии равномерная по построению (питон пересобирает её при сборке
 * session.json), поэтому момент сэмпла номер i — это ровно i / rate. Никакого поиска
 * по шкале времени не нужно, что важно: выборка идёт для каждого виджета на каждом
 * кадре, шестьдесят раз в секунду.
 */
const SessionModel = (function () {

  function load(payload) {
    const rate = payload.session.rate_hz;
    const channels = {};
    for (const [name, channel] of Object.entries(payload.channels || {})) {
      channels[name] = {
        role: channel.role,
        unit: channel.unit,
        samples: Float64Array.from(channel.samples),
      };
    }
    return {
      track: payload.session.track || '',
      startUtc: payload.session.start_utc,
      duration: payload.session.duration_s,
      rate,
      channels,
      laps: payload.laps || [],
      gates: payload.gates || [],
      envelope: payload.envelope || { left: [], right: [] },
      clips: payload.clips || [],
    };
  }

  /** Номер сэмпла (дробный) для момента времени. */
  function positionAt(session, t) {
    const last = channelLength(session) - 1;
    if (last < 0) return 0;
    return Math.min(Math.max(t * session.rate, 0), last);
  }

  function channelLength(session) {
    const first = Object.values(session.channels)[0];
    return first ? first.samples.length : 0;
  }

  /** Значение канала в произвольный момент, с линейной интерполяцией. */
  function sampleAt(session, name, t) {
    const channel = session.channels[name];
    if (!channel || channel.samples.length === 0) return null;
    const pos = positionAt(session, t);
    const i = Math.floor(pos);
    const next = Math.min(i + 1, channel.samples.length - 1);
    const frac = pos - i;
    return channel.samples[i] * (1 - frac) + channel.samples[next] * frac;
  }

  /** Сразу несколько каналов одним вызовом — так дешевле на каждом кадре. */
  function sampleMany(session, names, t) {
    const out = {};
    for (const name of names) out[name] = sampleAt(session, name, t);
    return out;
  }

  /** Круг, внутри которого лежит момент времени, или null для выездного участка. */
  function lapAt(session, t) {
    return session.laps.find((lap) => t >= lap.t_start && t < lap.t_end) || null;
  }

  function bestLap(session) {
    return session.laps.find((lap) => lap.best) || null;
  }

  /** Время от начала текущего круга — то, что показывает таймер. */
  function lapTime(session, t) {
    const lap = lapAt(session, t);
    return lap ? t - lap.t_start : null;
  }

  function clipById(session, id) {
    return session.clips.find((clip) => clip.id === id) || null;
  }

  /**
   * Время внутри клипа для момента сессии. null означает, что клип в этот момент
   * ещё не начался или уже кончился.
   */
  function clipTime(clip, t) {
    const local = t - clip.offset_s;
    return local >= 0 && local <= clip.duration_s ? local : null;
  }

  /**
   * Какой чанк клипа показывать и с какого места.
   *
   * Длинную запись GoPro режет на файлы по 4 ГБ, и один тег <video> играет только
   * один из них. Поэтому по ходу таймлайна источник приходится переключать, а время
   * внутри файла отсчитывать от его начала, а не от начала записи.
   */
  function chunkAt(clip, t) {
    const local = clipTime(clip, t);
    if (local === null) return null;
    const durations = clip.chunks || [clip.duration_s];
    let elapsed = 0;
    for (let i = 0; i < durations.length; i += 1) {
      if (local < elapsed + durations[i] || i === durations.length - 1) {
        return { index: i, time: Math.min(local - elapsed, durations[i]) };
      }
      elapsed += durations[i];
    }
    return null;
  }

  return {
    load, sampleAt, sampleMany, positionAt, channelLength,
    lapAt, bestLap, lapTime, clipById, clipTime, chunkAt,
  };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SessionModel;
} else {
  window.SessionModel = SessionModel;
}
