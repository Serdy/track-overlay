/**
 * state.js — wires the pure modules to the DOM.
 *
 * All time logic lives in clock.js, all data handling in session.js. What is left here
 * is plumbing: subscriptions, event handlers and element updates. That is also why this
 * module has no unit tests — there is nothing in it to test.
 */
(function () {
  const dom = {};
  let session = null;
  let clock = null;
  let videos = [];
  let scores = null;
  let layout = null;

  // Default layout. Positions are fractions of the frame — that is exactly what lets
  // the preview and the render agree across different output resolutions.
  const DEFAULT_LAYOUT = {
    widgets: [
      { type: 'speed', pos: [0.030, 0.845], scale: 1 },
      { type: 'lean',  pos: [0.030, 0.725], scale: 1 },
      { type: 'accel', pos: [0.820, 0.845], scale: 1 },
      { type: 'map',   pos: [0.820, 0.500], scale: 1 },
    ],
  };

  const READOUT = [
    { channel: 'speed', label: 'km/h', digits: 0 },
    { channel: 'lean', label: 'lean', digits: 1, suffix: '°' },
    { channel: 'accel', label: 'G', digits: 2 },
  ];

  function bind() {
    for (const id of ['track-name', 'session-info', 'sync-info', 'slots', 'overlay',
                      'empty', 'readout', 'play', 'prev-lap', 'next-lap', 'rate',
                      'timeline', 'lap-marks', 'playhead', 'clock-time', 'lap-label']) {
      dom[id] = document.getElementById(id);
    }
  }

  async function boot() {
    bind();
    const response = await fetch('/api/session');
    if (!response.ok) {
      dom['track-name'].textContent = 'failed to load the session';
      return;
    }
    session = SessionModel.load(await response.json());
    clock = Clock.create(session.duration, 60);
    // The acceleration score is computed once for the whole session: it is a pass over
    // forty thousand samples, not something to redo on every frame.
    scores = Scoring.scoreSession(session);
    layout = DEFAULT_LAYOUT;

    describe();
    buildReadout();
    buildLapMarks();
    buildSlots();
    wire();

    Clock.onChange(clock, render);
    window.addEventListener('resize', resizeOverlay);
    resizeOverlay();
    render(0);
    requestAnimationFrame(tick);
  }

  function describe() {
    dom['track-name'].textContent = session.track || 'Session';
    const best = SessionModel.bestLap(session);
    dom['session-info'].textContent =
      `${session.laps.length} laps` +
      (best ? ` · best ${Clock.formatTime(best.duration_s)}` : '');

    const clip = session.clips[0];
    dom['sync-info'].textContent = clip
      ? `sync: ${clip.sync.method} (${clip.sync.correlation.toFixed(4)})`
      : 'no video attached';
    dom.empty.style.display = session.clips.length ? 'none' : 'grid';
  }

  function buildReadout() {
    dom.readout.innerHTML = '';
    for (const item of READOUT) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.innerHTML = `<b data-channel="${item.channel}">—</b><span>${item.label}</span>`;
      dom.readout.appendChild(cell);
    }
  }

  function buildLapMarks() {
    dom['lap-marks'].innerHTML = '';
    for (const lap of session.laps) {
      const mark = document.createElement('i');
      mark.style.left = `${(lap.t_start / session.duration) * 100}%`;
      if (lap.best) mark.classList.add('best');
      dom['lap-marks'].appendChild(mark);
    }
  }

  /** One <video> tag per clip. The preview plays the proxy when one exists. */
  function buildSlots() {
    dom.slots.innerHTML = '';
    videos = session.clips.map((clip, index) => {
      const element = document.createElement('video');
      element.preload = 'auto';
      element.muted = true;
      element.playsInline = true;
      Object.assign(element.style,
        index === 0 ? { inset: '0', width: '100%', height: '100%' }
                    : { right: '2%', top: '4%', width: '26%', height: '26%' });
      dom.slots.appendChild(element);
      return { clip, element, chunk: -1 };
    });
  }

  function wire() {
    dom.play.addEventListener('click', () => Clock.toggle(clock));
    dom['prev-lap'].addEventListener('click', () => Clock.jumpLap(clock, session.laps, -1));
    dom['next-lap'].addEventListener('click', () => Clock.jumpLap(clock, session.laps, +1));
    dom.rate.addEventListener('click', () => Clock.cycleRate(clock, +1));

    dom.timeline.addEventListener('pointerdown', (event) => {
      const scrub = (e) => {
        const box = dom.timeline.getBoundingClientRect();
        const ratio = (e.clientX - box.left) / box.width;
        Clock.seek(clock, ratio * session.duration);
      };
      scrub(event);
      const move = (e) => scrub(e);
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    window.addEventListener('keydown', (event) => {
      const actions = {
        ' ': () => Clock.toggle(clock),
        ArrowRight: () => Clock.step(clock, event.shiftKey ? 10 : 1),
        ArrowLeft: () => Clock.step(clock, event.shiftKey ? -10 : -1),
        ArrowUp: () => Clock.jumpLap(clock, session.laps, -1),
        ArrowDown: () => Clock.jumpLap(clock, session.laps, +1),
      };
      const action = actions[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
    });
  }

  /** The overlay canvas is kept in physical device pixels, or everything looks soft. */
  function resizeOverlay() {
    const canvas = dom.overlay;
    const box = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(box.width * dpr));
    canvas.height = Math.max(1, Math.round(box.height * dpr));
    if (clock) render(clock.time);
  }

  // Map geometry is static, so it is computed once and refreshed only when the canvas
  // size or the layout changes.
  let mapPrepared = null;
  let mapKey = '';

  function prepareMap(frame) {
    const placement = layout.widgets.find((w) => w.type === 'map');
    if (!placement) return null;
    const widget = Widgets.get('map');
    const box = Widgets.boxFor(widget, placement, frame);
    const key = `${frame.width}x${frame.height}:${placement.pos.join(',')}:${placement.scale}`;
    if (key !== mapKey) {
      mapKey = key;
      mapPrepared = widget.prepare(session, box);
    }
    return mapPrepared;
  }

  /** The trail behind the dot: the last few seconds of the track. */
  function trailFor(time) {
    const widget = Widgets.get('map');
    const step = 1 / 5;                       // five points per second is plenty
    const points = [];
    for (let t = Math.max(0, time - widget.TRAIL_S); t <= time; t += step) {
      const lat = SessionModel.sampleAt(session, 'lat', t);
      const lon = SessionModel.sampleAt(session, 'lon', t);
      if (lat !== null && lon !== null) points.push([lat, lon]);
    }
    return points;
  }

  function drawOverlay(time) {
    const canvas = dom.overlay;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!layout) return;

    const score = Scoring.scoreAt(scores, session, time);
    const frame = { width: canvas.width, height: canvas.height };
    const data = SessionModel.sampleMany(session, ['speed', 'lean', 'accel', 'lat', 'lon'], time);
    data.score = score;
    data.scoreColor = SR_TRACK.scoreToColor(score, SR_TRACK.DEFAULT_CFG);
    data.map = prepareMap(frame);
    data.trail = trailFor(time);

    Widgets.drawAll(ctx, layout.widgets, frame, data);
  }

  let lastFrame = 0;

  function tick(now) {
    const elapsed = lastFrame ? (now - lastFrame) / 1000 : 0;
    lastFrame = now;
    if (clock.playing) Clock.advance(clock, Math.min(elapsed, 0.25));
    requestAnimationFrame(tick);
  }

  function render(time) {
    dom['clock-time'].textContent = Clock.formatTime(time);
    dom.play.textContent = clock.playing ? '❚❚' : '▶';
    dom.rate.textContent = `${clock.rate}×`;
    dom.playhead.style.left = `${(time / session.duration) * 100}%`;

    const lap = SessionModel.lapAt(session, time);
    dom['lap-label'].textContent = lap
      ? `lap ${lap.n} · ${Clock.formatTime(SessionModel.lapTime(session, time))}`
      : 'out lap';

    for (const item of READOUT) {
      const value = SessionModel.sampleAt(session, item.channel, time);
      const node = dom.readout.querySelector(`[data-channel="${item.channel}"]`);
      node.textContent = value === null
        ? '—' : value.toFixed(item.digits) + (item.suffix || '');
    }

    drawOverlay(time);
    syncVideos(time);
  }

  /**
   * The clock drives the video, not the other way round. While playing we let the
   * element run on its own and only pull it back when it has drifted noticeably —
   * assigning currentTime on every frame makes the picture stutter.
   */
  function syncVideos(time) {
    for (const slot of videos) {
      const { clip, element } = slot;
      const position = SessionModel.chunkAt(clip, time);
      if (position === null) {
        element.style.visibility = 'hidden';
        if (!element.paused) element.pause();
        continue;
      }
      element.style.visibility = 'visible';

      // Crossing into another chunk: swap the source and land at the right spot.
      if (position.index !== slot.chunk) {
        slot.chunk = position.index;
        element.src = `/media/${clip.id}/${position.index}` +
                      (clip.proxy ? '?proxy=1' : '');
        element.currentTime = position.time;
      }
      const local = position.time;

      if (!clock.playing) {
        if (!element.paused) element.pause();
        if (Math.abs(element.currentTime - local) > 0.02) element.currentTime = local;
        continue;
      }
      if (element.playbackRate !== clock.rate) element.playbackRate = clock.rate;
      if (element.paused) element.play().catch(() => {});
      if (Math.abs(element.currentTime - local) > 0.15) element.currentTime = local;
    }
  }

  window.addEventListener('DOMContentLoaded', boot);
}());
