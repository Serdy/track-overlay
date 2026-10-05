/**
 * session.js — the session model and channel sampling.
 *
 * Deliberately DOM-free: it loads both in the browser and in node under tests.
 *
 * The telemetry grid is uniform by construction (Python rebuilds it while assembling
 * session.json), so sample number i sits at exactly i / rate. No searching along a
 * time axis is needed, which matters: sampling runs for every widget on every frame,
 * sixty times a second.
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

  /** Fractional sample index for a point in time. */
  function positionAt(session, t) {
    const last = channelLength(session) - 1;
    if (last < 0) return 0;
    return Math.min(Math.max(t * session.rate, 0), last);
  }

  function channelLength(session) {
    const first = Object.values(session.channels)[0];
    return first ? first.samples.length : 0;
  }

  /** Channel value at an arbitrary moment, linearly interpolated. */
  function sampleAt(session, name, t) {
    const channel = session.channels[name];
    if (!channel || channel.samples.length === 0) return null;
    const pos = positionAt(session, t);
    const i = Math.floor(pos);
    const next = Math.min(i + 1, channel.samples.length - 1);
    const frac = pos - i;
    return channel.samples[i] * (1 - frac) + channel.samples[next] * frac;
  }

  /** Several channels in one call — cheaper when done every frame. */
  function sampleMany(session, names, t) {
    const out = {};
    for (const name of names) out[name] = sampleAt(session, name, t);
    return out;
  }

  /** The lap containing this moment, or null for out/in laps. */
  function lapAt(session, t) {
    return session.laps.find((lap) => t >= lap.t_start && t < lap.t_end) || null;
  }

  function bestLap(session) {
    return session.laps.find((lap) => lap.best) || null;
  }

  /** Time since the current lap started — what the lap timer shows. */
  function lapTime(session, t) {
    const lap = lapAt(session, t);
    return lap ? t - lap.t_start : null;
  }

  function clipById(session, id) {
    return session.clips.find((clip) => clip.id === id) || null;
  }

  /**
   * Time inside a clip for a session moment. null means the clip has not started yet
   * or has already ended at that point.
   */
  function clipTime(clip, t) {
    const local = t - clip.offset_s;
    return local >= 0 && local <= clip.duration_s ? local : null;
  }

  /**
   * Which chunk of a clip to show, and from where.
   *
   * GoPro splits a long recording into 4 GB files, and one <video> tag plays only one
   * of them. So the source has to be switched as the timeline advances, and the time
   * inside a file is counted from that file's start, not the recording's.
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
