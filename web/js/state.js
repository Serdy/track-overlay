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
  let leanDisplay = null;
  let scoreSides = null;
  let layout = null;
  let segmentStart = null;      // set while a stretch is being marked out

  // Default layout. Positions are fractions of the frame — that is exactly what lets
  // the preview and the render agree across different output resolutions.
  const DEFAULT_LAYOUT = {
    widgets: [
      { type: 'speed', pos: [0.030, 0.845], scale: 1 },
      { type: 'lean',  pos: [0.030, 0.725], scale: 1 },
      { type: 'accel', pos: [0.820, 0.845], scale: 1 },
      { type: 'map',   pos: [0.820, 0.500], scale: 1 },
    ],
    slots: [
      { id: 'main', rect: [0, 0, 1, 1] },
      { id: 'pip', rect: [0.70, 0.04, 0.28, 0.28] },
    ],
  };

  const READOUT = [
    { channel: 'speed', label: 'km/h', digits: 0 },
    { channel: 'lean', label: 'lean', digits: 0, suffix: '°' },
    { channel: 'accel', label: 'G', digits: 2 },
  ];

  function bind() {
    for (const id of ['track-name', 'session-info', 'sync-info', 'slots', 'overlay',
                      'empty', 'readout', 'play', 'prev-lap', 'next-lap', 'rate',
                      'timeline', 'lap-marks', 'playhead', 'clock-time', 'lap-label',
                      'swap', 'segment', 'reset', 'cut-marks', 'pending-range']) {
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
    // Steadied once for the whole session: a per-frame filter with memory would depend
    // on the order frames are visited in, and scrubbing visits them out of order.
    leanDisplay = session.channels.lean
      ? Display.lean(session.channels.lean.samples, session.rate) : null;
    scoreSides = scores ? Display.scoreSide(scores) : null;
    layout = await loadLayout();

    describe();
    buildReadout();
    buildLapMarks();
    buildSlots();
    renderCutMarks();
    wire();

    Clock.onChange(clock, render);
    window.addEventListener('resize', resizeOverlay);
    resizeOverlay();
    render(0);
    requestAnimationFrame(tick);
  }

  /**
   * The saved layout if there is one, the default otherwise.
   *
   * Entries referring to clips the session no longer holds are dropped: a layout saved
   * against a different set of cameras must not leave empty slots behind.
   */
  async function loadLayout() {
    const known = new Set(session.clips.map((clip) => clip.id));
    const fallback = Object.assign({}, DEFAULT_LAYOUT,
                                   { cuts: Cuts.initial([...known]) });
    try {
      const response = await fetch('/api/layout');
      if (!response.ok) return fallback;
      const saved = await response.json();
      const cuts = (saved.cuts || []).filter(
        (cut) => known.has(cut.main) && (cut.pip === null || known.has(cut.pip)));
      if (!cuts.length) return fallback;
      return Object.assign({}, fallback, saved, { cuts: Cuts.simplify(cuts) });
    } catch (error) {
      return fallback;
    }
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

  /**
   * One <video> tag per clip. Which slot a tag occupies is decided by the arrangement in
   * force, not by the order the clips arrived in — that is the whole point of cuts.
   */
  function buildSlots() {
    dom.slots.innerHTML = '';
    videos = session.clips.map((clip) => {
      const element = document.createElement('video');
      element.preload = 'auto';
      element.muted = true;
      element.playsInline = true;
      dom.slots.appendChild(element);
      return { clip, element, chunk: -1, slot: null };
    });
  }

  function slotRect(slotId) {
    const slot = (layout.slots || []).find((s) => s.id === slotId);
    return slot ? slot.rect : [0, 0, 1, 1];
  }

  /** Places a tag into a slot, or hides it when it is in none. */
  function placeInSlot(entry, slotId) {
    if (entry.slot === slotId) return;
    entry.slot = slotId;
    if (!slotId) {
      entry.element.style.display = 'none';
      return;
    }
    const [x, y, w, h] = slotRect(slotId);
    Object.assign(entry.element.style, {
      display: 'block',
      left: `${x * 100}%`,
      top: `${y * 100}%`,
      width: `${w * 100}%`,
      height: `${h * 100}%`,
      zIndex: slotId === 'main' ? '1' : '2',
      borderRadius: slotId === 'main' ? '0' : '6px',
      boxShadow: slotId === 'main' ? 'none' : '0 2px 14px rgba(0,0,0,0.55)',
    });
  }

  function renderCutMarks() {
    dom['cut-marks'].innerHTML = '';
    dom.reset.disabled = layout.cuts.length <= 1;
    for (const cut of layout.cuts) {
      if (cut.t <= 0) continue;                  // the opening entry is not a change
      const mark = document.createElement('i');
      mark.style.left = `${(cut.t / session.duration) * 100}%`;
      mark.title = `${Clock.formatTime(cut.t)} — click to remove`;
      mark.addEventListener('pointerdown', (event) => {
        event.stopPropagation();                 // do not scrub while deleting
        layout.cuts = Cuts.removeNear(layout.cuts, cut.t, 0.01);
        renderCutMarks();
        saveLayout();
        render(clock.time);
      });
      dom['cut-marks'].appendChild(mark);
    }
  }

  /**
   * Throws away every camera switch and returns to the opening arrangement.
   *
   * Widget placement is deliberately left alone: a person reaching for reset wants the
   * cutting undone, not the overlay they spent time positioning.
   */
  function resetCuts() {
    if (layout.cuts.length <= 1) return;
    if (!window.confirm(`Discard ${layout.cuts.length - 1} camera switch(es)?`)) return;
    layout.cuts = Cuts.initial(session.clips.map((clip) => clip.id));
    segmentStart = null;
    dom.segment.classList.remove('armed');
    renderCutMarks();
    saveLayout();
    render(clock.time);
  }

  function swapFromPlayhead() {
    layout.cuts = Cuts.swapAt(layout.cuts, clock.time);
    renderCutMarks();
    saveLayout();
    render(clock.time);
  }

  /** Two clicks: the first marks the start of a stretch, the second closes it. */
  function toggleSegment() {
    if (segmentStart === null) {
      segmentStart = clock.time;
      dom.segment.classList.add('armed');
      return updatePending();
    }
    const [from, to] = [segmentStart, clock.time].sort((a, b) => a - b);
    segmentStart = null;
    dom.segment.classList.remove('armed');
    updatePending();
    if (to - from < 0.2) return;                 // too short to mean anything
    layout.cuts = Cuts.swapRange(layout.cuts, from, to);
    renderCutMarks();
    saveLayout();
    render(clock.time);
  }

  function updatePending() {
    const strip = dom['pending-range'];
    if (segmentStart === null) {
      strip.hidden = true;
      return;
    }
    const [from, to] = [segmentStart, clock.time].sort((a, b) => a - b);
    strip.hidden = false;
    strip.style.left = `${(from / session.duration) * 100}%`;
    strip.style.width = `${((to - from) / session.duration) * 100}%`;
  }

  let saveTimer = null;

  function saveLayout() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch('/api/layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(layout),
      }).catch(() => {});
    }, 400);
  }

  function wire() {
    dom.play.addEventListener('click', () => Clock.toggle(clock));
    dom['prev-lap'].addEventListener('click', () => Clock.jumpLap(clock, session.laps, -1));
    dom['next-lap'].addEventListener('click', () => Clock.jumpLap(clock, session.laps, +1));
    dom.rate.addEventListener('click', () => Clock.cycleRate(clock, +1));
    dom.swap.addEventListener('click', swapFromPlayhead);
    dom.segment.addEventListener('click', toggleSegment);
    dom.reset.addEventListener('click', resetCuts);

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
        s: swapFromPlayhead,
        d: toggleSegment,
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
    if (leanDisplay) {
      data.leanValue = Display.at(leanDisplay.value, session, time);
      data.leanSide = Display.at(leanDisplay.side, session, time);
    }
    if (scoreSides) data.scoreSide = Display.at(scoreSides, session, time);
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
      const value = item.channel === 'lean' && leanDisplay
        ? Display.at(leanDisplay.value, session, time)
        : SessionModel.sampleAt(session, item.channel, time);
      const node = dom.readout.querySelector(`[data-channel="${item.channel}"]`);
      node.textContent = value === null
        ? '—' : value.toFixed(item.digits) + (item.suffix || '');
    }

    updatePending();
    drawOverlay(time);
    syncVideos(time);
  }

  /**
   * The clock drives the video, not the other way round. While playing we let the
   * element run on its own and only pull it back when it has drifted noticeably —
   * assigning currentTime on every frame makes the picture stutter.
   */
  function syncVideos(time) {
    const arrangement = Cuts.resolveAt(layout.cuts, time) || {};
    for (const slot of videos) {
      const { clip, element } = slot;
      const inSlot = arrangement.main === clip.id ? 'main'
                   : (arrangement.pip === clip.id ? 'pip' : null);
      placeInSlot(slot, inSlot);
      if (!inSlot) {
        if (!element.paused) element.pause();
        continue;
      }
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
