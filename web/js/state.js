/**
 * state.js — wires the pure modules to the DOM.
 *
 * All time logic lives in clock.js, all data handling in session.js. What is left here
 * is plumbing: subscriptions, event handlers and element updates. That is also why this
 * module has no unit tests — there is nothing in it to test.
 */
(function () {
  // Every project is addressed in the URL, so the page learns which one it is from its
  // own address rather than from the server holding a "current project".
  const BASE = window.location.pathname.replace(/\/+$/, '');
  const api = (path) => BASE + path;

  const dom = {};
  let session = null;
  let clock = null;
  let videos = [];
  let scores = null;
  let leanDisplay = null;
  let scoreSides = null;
  let layout = null;
  let segmentStart = null;      // set while a stretch is being marked out
  let segmentAction = null;     // what the second click will do: 'swap' or 'cut'
  let payload = null;           // the session as it came off the wire
  let project = null;           // the project this page is editing
  let syncClip = null;          // which camera the sync panel is adjusting
  let syncTimer = null;
  let brakingPoints = [];       // the frames worth checking the sync against
  let brakingAt = -1;
  let sound = false;            // only the main slot is ever unmuted

  // Default layout. Positions are fractions of the frame — that is exactly what lets
  // the preview and the render agree across different output resolutions.
  const DEFAULT_LAYOUT = {
    widgets: [
      { type: 'speed', pos: [0.030, 0.860], scale: 1 },
      { type: 'lean',  pos: [0.030, 0.745], scale: 1 },
      { type: 'accel', pos: [0.030, 0.675], scale: 1 },
      { type: 'map',   pos: [0.810, 0.620], scale: 1 },
    ],
    slots: [
      { id: 'main', rect: [0, 0, 1, 1] },
      { id: 'pip', rect: [0.70, 0.04, 0.28, 0.28] },
    ],
    output: { width: 1920, height: 1080, fps: 60 },
    ranges: null,               // null means the whole session
  };

  /** The stretches that reach the finished video. */
  function keptRanges() {
    return (layout && layout.ranges) || Ranges.full(session.duration);
  }

  const READOUT = [
    { channel: 'speed', label: 'km/h', digits: 0 },
    { channel: 'lean', label: 'lean', digits: 0, suffix: '°' },
    { channel: 'accel', label: 'G', digits: 2 },
  ];

  function bind() {
    for (const id of ['track-name', 'session-info', 'sync-info', 'slots', 'overlay',
                      'empty', 'readout', 'play', 'prev-lap', 'next-lap', 'rate',
                      'timeline', 'lap-marks', 'playhead', 'clock-time', 'lap-label',
                      'sound',
                      'swap', 'segment', 'cut', 'laps-only', 'reset',
                      'cut-marks', 'gap-marks', 'pending-range',
                      'resolution',
                      'sync-panel', 'sync-clip', 'sync-method', 'sync-slider',
                      'sync-value', 'sync-brake', 'sync-confirm', 'sync-graph',
                      'sync-saved', 'sync-later', 'open-sync',
                      'export', 'export-range', 'export-panel', 'export-stage',
                      'export-percent', 'export-fill', 'export-cancel', 'export-result',
                      'export-done', 'export-download', 'export-reveal', 'export-error',
                      'open-picker', 'picker', 'picker-close', 'picker-list',
                      'picker-add', 'picker-chosen', 'picker-build', 'picker-title',
                      'picker-track', 'picker-status', 'picker-build-id', 'home',
                      'picker-progress', 'picker-stage', 'picker-percent', 'picker-fill',
                      'no-session']) {
      dom[id] = document.getElementById(id);
    }
  }

  async function boot() {
    bind();
    wirePicker();
    const response = await fetch(api('/api/session'));
    if (!response.ok) {
      // A project that has not been built yet: show its files instead of an error. This
      // is the ordinary first visit, which is why the editor no longer refuses to start.
      dom['no-session'].hidden = false;
      dom['track-name'].textContent = 'not built yet';
      await openPicker();
      return;
    }
    payload = await response.json();
    session = SessionModel.load(payload);
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

    // Keep the automatic offset so the manual slider shifts from it, not from zero.
    for (const clip of session.clips) clip._baseOffset = clip.offset_s;

    describe();
    buildReadout();
    buildLapMarks();
    buildSlots();
    renderCutMarks();
    renderGapMarks();
    wire();

    // Only now, with the readout cells and video tags in place, is it safe to restore
    // anything that redraws.
    restoreSound();
    if (layout.output && layout.output.width) {
      dom.resolution.value = `${layout.output.width}x${layout.output.height}`;
    }

    Clock.onChange(clock, render);
    window.addEventListener('resize', resizeOverlay);
    resizeOverlay();
    render(0);
    requestAnimationFrame(tick);

    // Until a person has looked at it, the sync is the machine's guess and nothing more.
    if (!(payload.session || {}).sync_confirmed) openSync();
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
      const response = await fetch(api('/api/layout'));
      if (!response.ok) return fallback;
      const saved = await response.json();
      const cuts = (saved.cuts || []).filter(
        (cut) => known.has(cut.main) && (cut.pip === null || known.has(cut.pip)));
      if (!cuts.length) return fallback;
      // A camera added since this layout was saved has to be given somewhere to appear.
      const merged = Object.assign({}, fallback, saved,
                                   { cuts: Cuts.simplify(Cuts.adopt(cuts, [...known])) });
      const checked = Layout.validate(merged, [...known], widgetSizes());
      if (!checked.ok) console.warn('layout repaired:', checked.errors.join('; '));
      return checked.layout;
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
      // Muted here and decided per frame in syncVideos: two cameras play at once, and
      // two engine notes over each other are worse than none.
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

  function invalidateMap() {
    mapCache.clear();
  }

  function renderCutMarks() {
    dom['cut-marks'].innerHTML = '';
    dom.reset.disabled = layout.cuts.length <= 1
      && JSON.stringify(layout.widgets) === JSON.stringify(DEFAULT_LAYOUT.widgets)
      && Ranges.total(keptRanges()) >= session.duration - 0.01;
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

  /** Everything back to how it opens on a fresh session. */
  function resetLayout() {
    const switches = Math.max(0, layout.cuts.length - 1);
    const moved = JSON.stringify(layout.widgets) !== JSON.stringify(DEFAULT_LAYOUT.widgets);
    const trimmed = Ranges.total(keptRanges()) < session.duration - 0.01;
    if (!switches && !moved && !trimmed) return;

    const parts = [];
    if (switches) parts.push(`${switches} camera switch(es)`);
    if (trimmed) parts.push('the trimming');
    if (moved) parts.push('the widget placement');
    if (!window.confirm(`Discard ${parts.join(', ')}?`)) return;

    layout = Object.assign(JSON.parse(JSON.stringify(DEFAULT_LAYOUT)),
                           { cuts: Cuts.initial(session.clips.map((clip) => clip.id)) });
    segmentStart = null;
    segmentAction = null;
    dom.segment.classList.remove('armed');
    dom.cut.classList.remove('cutting');
    renderGapMarks();
    dom.resolution.value = `${layout.output.width}x${layout.output.height}`;

    invalidateMap();
    for (const slot of videos) slot.slot = null;
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

  /**
   * Two clicks mark out a stretch: the first sets its start, the second closes it and
   * applies whichever action was armed. Swapping cameras and cutting a piece out both
   * need the same gesture, so they share it.
   */
  function markSegment(action) {
    const button = action === 'cut' ? dom.cut : dom.segment;
    const armedClass = action === 'cut' ? 'cutting' : 'armed';

    if (segmentStart !== null && segmentAction !== action) {
      // Switching intent mid-selection: start over rather than guess.
      dom.segment.classList.remove('armed');
      dom.cut.classList.remove('cutting');
      segmentStart = null;
    }
    if (segmentStart === null) {
      segmentStart = clock.time;
      segmentAction = action;
      button.classList.add(armedClass);
      return updatePending();
    }

    const [from, to] = [segmentStart, clock.time].sort((a, b) => a - b);
    segmentStart = null;
    segmentAction = null;
    button.classList.remove(armedClass);
    updatePending();
    if (to - from < 0.2) return;                 // too short to mean anything

    if (action === 'cut') {
      layout.ranges = Ranges.cut(keptRanges(), from, to, session.duration);
      renderGapMarks();
    } else {
      layout.cuts = Cuts.swapRange(layout.cuts, from, to);
      renderCutMarks();
    }
    saveLayout();
    render(clock.time);
  }

  function trimToLaps() {
    layout.ranges = Ranges.lapsOnly(session.laps, session.duration);
    renderGapMarks();
    saveLayout();
    render(clock.time);
  }

  /** Greys out on the timeline whatever will not reach the video. */
  function renderGapMarks() {
    const ranges = keptRanges();
    dom['gap-marks'].innerHTML = '';
    for (const gap of Ranges.gaps(ranges, session.duration)) {
      const mark = document.createElement('i');
      mark.style.left = `${(gap.from / session.duration) * 100}%`;
      mark.style.width = `${((gap.to - gap.from) / session.duration) * 100}%`;
      dom['gap-marks'].appendChild(mark);
    }
    const kept = Ranges.total(ranges);
    dom['laps-only'].disabled = !session.laps.length;
    dom['session-info'].dataset.kept = kept < session.duration
      ? ` · ${Clock.formatTime(kept)} kept` : '';
    describeKept(kept);
  }

  function describeKept(kept) {
    const best = SessionModel.bestLap(session);
    dom['session-info'].textContent =
      `${session.laps.length} laps`
      + (best ? ` · best ${Clock.formatTime(best.duration_s)}` : '')
      + (kept < session.duration - 0.01 ? ` · ${Clock.formatTime(kept)} kept` : '');
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

  let exporting = null;
  let dragging = null;

  // --- the project's own files ------------------------------------------------

  /**
   * Loads what the project holds: the files it will build from, and what it knows.
   *
   * Sources are whatever sits in the project folder plus paths registered from the file
   * dialog. Nothing is copied — a track day is twenty gigabytes of footage, and the
   * server reads the same disk the camera card is on.
   */
  async function loadProject() {
    const response = await fetch(api('/api/project'));
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    project = await response.json();
    renderSources();
  }

  function renderSources() {
    const files = project.files || [];
    dom['picker-list'].innerHTML = '';
    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'Nothing here yet — use “Add files…”.';
      dom['picker-list'].appendChild(empty);
    }
    for (const path of files) {
      const name = path.split('/').pop();
      const row = document.createElement('div');
      row.innerHTML = `<span>${Picker.isVideo(name) ? '🎬' : '📈'}</span>`
        + `<span>${name}</span><span class="size">✕</span>`;
      row.title = path;
      row.querySelector('.size').addEventListener('click', () => removeSource(path));
      dom['picker-list'].appendChild(row);
    }
    dom['picker-title'].textContent = project.title || project.name;
    dom['picker-track'].value = project.track || '';
    dom['picker-chosen'].textContent = Picker.describe(files);
    const blocked = Picker.missing(files);
    dom['picker-build'].disabled = Boolean(blocked);
    dom['picker-build'].textContent = project.built ? 'Rebuild session' : 'Build session';
    dom['picker-build'].title = blocked || 'Assemble the session from these files';
  }

  async function editSources(body) {
    dom['picker-status'].textContent = '';
    try {
      const response = await fetch(api('/api/sources'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `the server answered ${response.status}`);
      project = result;
      renderSources();
    } catch (error) {
      dom['picker-status'].textContent = String(error.message || error);
    }
  }

  const removeSource = (path) => editSources({ remove: [path] });

  /**
   * Asks the server to open the system file dialog.
   *
   * A folder browser rendered in the page was the obvious thing to build and the wrong
   * thing to use: people already know their own file dialog, and it brings favourites,
   * search and network volumes that this would have had to reimplement badly.
   */
  async function addFiles() {
    dom['picker-add'].disabled = true;
    dom['picker-status'].textContent = 'waiting for the file dialog…';
    try {
      const response = await fetch('/api/choose', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `the server answered ${response.status}`);
      dom['picker-status'].textContent = (result.ignored || []).length
        ? `ignored, not a format this reads: ${result.ignored.join(', ')}`
        : '';
      if ((result.files || []).length) await editSources({ files: result.files });
    } catch (error) {
      dom['picker-status'].textContent = String(error.message || error);
    } finally {
      dom['picker-add'].disabled = false;
    }
  }

  async function buildSession() {
    dom['picker-build'].disabled = true;
    dom['picker-progress'].hidden = false;
    showBuild(0, 'starting');
    try {
      const started = await (await fetch(api('/api/build'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ track: dom['picker-track'].value.trim() }),
      })).json();
      if (started.error) throw new Error(started.error);

      const finished = await ExportUI.follow(started.id, (done, job) => {
        showBuild(done, (job && job.stage) || 'working');
      });
      showBuild(1, 'done');
      window.location.reload();
      return finished;
    } catch (error) {
      dom['picker-status'].textContent = String(error.message || error);
      dom['picker-progress'].hidden = true;
      renderSources();
    }
  }

  function showBuild(done, stage) {
    dom['picker-percent'].textContent = `${Math.round(done * 100)}%`;
    dom['picker-fill'].style.width = `${done * 100}%`;
    dom['picker-stage'].textContent = stage;
  }

  // --- checking the sync -------------------------------------------------------

  /**
   * The sync step, shown before the editor is trusted.
   *
   * Everything downstream rests on this one number, and the machine's answer is only as
   * good as the overlap it had to work with. So it is put in front of a person with the
   * picture beside it: at a hard braking point the two agree or they visibly do not.
   */
  function openSync() {
    if (!session.clips.length) return;
    dom['sync-panel'].hidden = false;
    dom['sync-clip'].innerHTML = '';
    for (const clip of session.clips) {
      const option = document.createElement('option');
      option.value = clip.id;
      option.textContent = clip.id;
      dom['sync-clip'].appendChild(option);
    }
    syncClip = session.clips[0].id;
    brakingPoints = findBraking();
    brakingAt = -1;
    renderSync();
    nextBraking();
  }

  function currentClip() {
    return session.clips.find((clip) => clip.id === syncClip) || session.clips[0];
  }

  function renderSync() {
    if (dom['sync-panel'].hidden) return;
    const clip = currentClip();
    const sync = clip.sync || {};
    const manual = clip.offset_s - autoOffset(clip);
    dom['sync-clip'].value = clip.id;
    dom['sync-method'].textContent =
      `${sync.method || 'unknown'} · correlation ${(sync.correlation || 0).toFixed(3)}`;
    dom['sync-method'].className = sync.reliable ? 'muted' : 'warn';
    dom['sync-slider'].value = String(manual);
    dom['sync-value'].textContent = `${manual >= 0 ? '+' : ''}${manual.toFixed(2)} s`;
    drawSyncGraph();
  }

  function autoOffset(clip) {
    // What the machine worked out, so the slider always measures from one baseline.
    return clip.auto_offset_s !== undefined ? clip.auto_offset_s : clip._baseOffset;
  }

  /** Moves one clip by hand, in the preview at once and on disk a moment later. */
  function setManual(seconds) {
    const clip = currentClip();
    clip.offset_s = autoOffset(clip) + seconds;
    dom['sync-value'].textContent = `${seconds >= 0 ? '+' : ''}${seconds.toFixed(2)} s`;
    syncVideos(clock.time);
    render(clock.time);
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => saveSync(clip.id, seconds), 400);
  }

  async function saveSync(clipId, seconds, confirmed) {
    try {
      const response = await fetch(api('/api/sync'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clip: clipId, manual_s: seconds, confirmed }),
      });
      if (!response.ok) throw new Error((await response.json()).error || 'could not save');
      dom['sync-saved'].textContent = 'saved';
    } catch (error) {
      dom['sync-saved'].textContent = String(error.message || error);
    }
  }

  async function confirmSync() {
    const clip = currentClip();
    clearTimeout(syncTimer);
    await saveSync(clip.id, clip.offset_s - autoOffset(clip), true);
    dom['sync-panel'].hidden = true;
    describe();
  }

  /** Where the rider braked hardest, worked out once — those are the frames to check. */
  function findBraking() {
    const accel = session.channels.accel;
    if (!accel) return [];
    const samples = accel.samples;
    const found = [];
    let best = null;
    for (let i = 0; i < samples.length; i += 1) {
      if (samples[i] < -0.35) {
        if (best === null || samples[i] < samples[best]) best = i;
      } else if (best !== null) {
        found.push({ t: best / session.rate, g: samples[best] });
        best = null;
      }
    }
    return found.sort((a, b) => a.g - b.g).slice(0, 12).sort((a, b) => a.t - b.t);
  }

  function nextBraking() {
    if (!brakingPoints.length) return;
    brakingAt = (brakingAt + 1) % brakingPoints.length;
    Clock.pause(clock);
    Clock.seek(clock, brakingPoints[brakingAt].t);
  }

  /** Speed either side of the playhead, to compare against what the frame shows. */
  function drawSyncGraph() {
    const canvas = dom['sync-graph'];
    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.clientWidth || 600;
    const height = canvas.height;
    const span = 6;                       // seconds either side
    const now = clock.time;

    ctx.clearRect(0, 0, width, height);

    // Scaled to the window, not to zero: the point is to see the shape of one braking
    // event, and against a 250 km/h axis a 60 km/h drop is a barely visible kink.
    let low = Infinity;
    let high = -Infinity;
    const at = (x) => SessionModel.sampleAt(
      session, 'speed', Math.max(0, now + (x / width - 0.5) * 2 * span)) || 0;
    for (let x = 0; x <= width; x += 1) {
      low = Math.min(low, at(x));
      high = Math.max(high, at(x));
    }
    const range = Math.max(5, high - low);

    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 1) {
      const y = height - ((at(x) - low) / range) * (height - 10) - 5;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = '#8b919c';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`${Math.round(high)} km/h`, 6, 13);
    ctx.fillText(`${Math.round(low)}`, 6, height - 5);

    ctx.strokeStyle = '#f5bc00';
    ctx.beginPath();
    ctx.moveTo(width / 2, 0);
    ctx.lineTo(width / 2, height);
    ctx.stroke();
  }

  /**
   * Turns the sound on or off, remembering the choice.
   *
   * Autoplay rules only allow unmuted playback after the page has been clicked, which by
   * this point it has - playback itself starts from a button.
   */
  function toggleSound() {
    sound = !sound;
    dom.sound.textContent = sound ? '🔊' : '🔇';
    dom.sound.classList.toggle('armed', sound);
    try {
      window.localStorage.setItem('trackoverlay.sound', sound ? '1' : '0');
    } catch (error) {
      // Private windows refuse storage; the setting simply will not be remembered.
    }
    syncVideos(clock.time);
  }

  function restoreSound() {
    try {
      sound = window.localStorage.getItem('trackoverlay.sound') === '1';
    } catch (error) {
      sound = false;
    }
    dom.sound.textContent = sound ? '🔊' : '🔇';
    dom.sound.classList.toggle('armed', sound);
  }

  /** Widget sizes as fractions of the frame, for hit testing and clamping. */
  function widgetSizes() {
    const sizes = {};
    for (const id of Widgets.ids()) sizes[id] = Widgets.get(id).defaultSize;
    return sizes;
  }

  /** Pointer position as a fraction of the stage, which is what the layout stores. */
  function framePoint(event) {
    const box = dom.overlay.getBoundingClientRect();
    return [(event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height];
  }

  function beginDrag(event) {
    const [x, y] = framePoint(event);
    const hit = Layout.hitTest(layout, widgetSizes(), x, y);
    const pip = (layout.slots || []).find((slot) => slot.id === 'pip');
    const onPip = pip && x >= pip.rect[0] && x <= pip.rect[0] + pip.rect[2]
                      && y >= pip.rect[1] && y <= pip.rect[1] + pip.rect[3];

    // A widget wins over the inset: it sits on top and is the smaller target.
    if (hit) dragging = { kind: 'widget', index: hit.index, x, y };
    else if (onPip) dragging = { kind: 'pip', x, y, rect: [...pip.rect] };
    else return;

    dom.overlay.classList.add('dragging');
    dom.overlay.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function continueDrag(event) {
    if (!dragging) return;
    const [x, y] = framePoint(event);
    const dx = x - dragging.x;
    const dy = y - dragging.y;
    if (dragging.kind === 'widget') {
      layout = Layout.moveWidget(layout, dragging.index, dx, dy, widgetSizes());
    } else {
      const r = dragging.rect;
      layout = Layout.setSlotRect(layout, 'pip', [r[0] + dx, r[1] + dy, r[2], r[3]]);
    }
    dragging.x = x;
    dragging.y = y;
    if (dragging.kind === 'pip') dragging.rect = [...layout.slots.find((s) => s.id === 'pip').rect];
    invalidateMap();
    for (const slot of videos) slot.slot = null;     // force the inset to be re-placed
    render(clock.time);
  }

  function endDrag(event) {
    if (!dragging) return;
    dragging = null;
    dom.overlay.classList.remove('dragging');
    if (event) dom.overlay.releasePointerCapture(event.pointerId);
    saveLayout();
  }

  /** The wheel resizes whatever is under the cursor. */
  function onWheel(event) {
    const [x, y] = framePoint(event);
    const hit = Layout.hitTest(layout, widgetSizes(), x, y);
    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    if (hit) {
      layout = Layout.scaleWidget(layout, hit.index, factor);
    } else {
      const pip = (layout.slots || []).find((slot) => slot.id === 'pip');
      if (!pip) return;
      const [px, py, pw, ph] = pip.rect;
      if (x < px || x > px + pw || y < py || y > py + ph) return;
      layout = Layout.setSlotRect(layout, 'pip',
        [px, py, pw * factor, ph * factor]);
      for (const slot of videos) slot.slot = null;
    }
    event.preventDefault();
    invalidateMap();
    render(clock.time);
    saveLayout();
  }

  /**
   * Draws one overlay frame at the output resolution.
   *
   * The export calls exactly this, and so does the preview — which is the reason the two
   * cannot end up showing different things.
   */
  function paintOverlay(ctx, time, frame) {
    const score = Scoring.scoreAt(scores, session, time);
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

  async function startExport() {
    if (exporting) return;
    const limit = Number(dom['export-range'].value);
    const output = Object.assign({ width: 1920, height: 1080, fps: 60 }, layout.output,
                                 { duration: session.duration });

    exporting = new AbortController();
    await flushLayout();
    dom['export-panel'].hidden = false;
    dom['export-done'].hidden = true;
    dom['export-error'].textContent = '';
    dom.export.disabled = true;
    Clock.pause(clock);

    const show = (done) => {
      dom['export-percent'].textContent = `${Math.round(done * 100)}%`;
      dom['export-fill'].style.width = `${done * 100}%`;
    };

    try {
      const ranges = keptRanges();
      const where = await ExportUI.run({
        base: BASE,
        output,
        toSession: (outputTime) => Ranges.toSession(ranges, outputTime),
        kept: Ranges.total(ranges),
        duration: limit || null,
        name: limit ? `preview_${limit}s.mp4` : 'final.mp4',
        drawFrame: paintOverlay,
        signal: exporting.signal,
        onStage: (text) => { dom['export-stage'].textContent = text; },
        onProgress: show,
      });
      const name = String(where).split('/').pop();
      dom['export-result'].textContent = `written: ${where}`;
      dom['export-download'].href = api(`/api/output/${encodeURIComponent(name)}`);
      dom['export-download'].setAttribute('download', name);
      dom['export-reveal'].dataset.name = name;
      dom['export-done'].hidden = false;
    } catch (error) {
      dom['export-stage'].textContent = 'failed';
      dom['export-error'].textContent = String(error.message || error);
    } finally {
      exporting = null;
      dom.export.disabled = false;
    }
  }


  let saveTimer = null;

  function writeLayout() {
    return fetch(api('/api/layout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    });
  }

  function saveLayout() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; writeLayout().catch(() => {}); }, 400);
  }

  /**
   * Writes the layout now, without waiting for the debounce.
   *
   * The export reads layout.json off disk, so a pending save has to land first. Waiting
   * for the timer is not safe: browsers throttle timers in a background tab, and an
   * export started from one would otherwise render a stale layout.
   */
  /**
   * Writes the layout now, whether or not anything was edited.
   *
   * The render reads it from disk, so on a project nobody has touched - the default
   * layout, straight after a build - there would otherwise be no file to read.
   */
  async function flushLayout() {
    clearTimeout(saveTimer);
    saveTimer = null;
    await writeLayout();
  }

  function wirePicker() {
    dom['open-picker'].addEventListener('click', openPicker);
    dom['picker-close'].addEventListener('click', () => { dom.picker.hidden = true; });
    dom['picker-add'].addEventListener('click', addFiles);
    dom['picker-build'].addEventListener('click', buildSession);
    dom.home.addEventListener('click', () => { window.location.href = '/'; });
    dom.picker.addEventListener('click', (event) => {
      if (event.target === dom.picker) dom.picker.hidden = true;
    });
  }

  async function openPicker() {
    dom.picker.hidden = false;
    // The stamp the page was served with, so a stale copy announces itself.
    const script = [...document.scripts].find((tag) => tag.src.includes('state.js'));
    dom['picker-build-id'].textContent = script && script.src.includes('?v=')
      ? `build ${script.src.split('?v=')[1]}` : 'build unstamped';
    dom['picker-status'].textContent = '';
    try {
      await loadProject();
    } catch (error) {
      dom['picker-status'].textContent = String(error.message || error);
    }
  }

  function wire() {
    dom.play.addEventListener('click', () => Clock.toggle(clock));
    dom['prev-lap'].addEventListener('click', () => Clock.jumpLap(clock, session.laps, -1));
    dom['next-lap'].addEventListener('click', () => Clock.jumpLap(clock, session.laps, +1));
    dom.rate.addEventListener('click', () => Clock.cycleRate(clock, +1));
    dom.sound.addEventListener('click', toggleSound);
    dom.swap.addEventListener('click', swapFromPlayhead);
    dom.segment.addEventListener('click', () => markSegment('swap'));
    dom.cut.addEventListener('click', () => markSegment('cut'));
    dom['laps-only'].addEventListener('click', trimToLaps);
    dom.reset.addEventListener('click', resetLayout);
    dom.export.addEventListener('click', startExport);

    dom['open-sync'].addEventListener('click', openSync);
    dom['sync-clip'].addEventListener('change', () => {
      syncClip = dom['sync-clip'].value;
      renderSync();
    });
    dom['sync-slider'].addEventListener('input',
                                        () => setManual(Number(dom['sync-slider'].value)));
    dom['sync-brake'].addEventListener('click', nextBraking);
    dom['sync-confirm'].addEventListener('click', confirmSync);
    dom['sync-later'].addEventListener('click', () => { dom['sync-panel'].hidden = true; });

    dom.overlay.classList.add('editing');
    dom.overlay.addEventListener('pointerdown', beginDrag);
    dom.overlay.addEventListener('pointermove', continueDrag);
    dom.overlay.addEventListener('pointerup', endDrag);
    dom.overlay.addEventListener('pointercancel', endDrag);
    dom.overlay.addEventListener('wheel', onWheel, { passive: false });

    dom.resolution.addEventListener('change', () => {
      const [w, h] = dom.resolution.value.split('x').map(Number);
      layout.output = Object.assign({}, layout.output, { width: w, height: h });
      saveLayout();
    });

    dom['export-cancel'].addEventListener('click', () => {
      if (exporting) exporting.abort();
    });

    dom['export-reveal'].addEventListener('click', async () => {
      const name = dom['export-reveal'].dataset.name;
      if (!name) return;
      await fetch(api('/api/reveal'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }).catch(() => {});
    });

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
        d: () => markSegment('swap'),
        x: () => markSegment('cut'),
        m: toggleSound,
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

  // Map geometry is static for a given frame size, so it is projected once and kept.
  // The cache is keyed by size because the preview and the export run at different
  // resolutions and both go through here.
  const mapCache = new Map();

  function prepareMap(frame) {
    const placement = layout.widgets.find((w) => w.type === 'map');
    if (!placement) return null;
    const key = `${frame.width}x${frame.height}:${placement.pos.join(',')}:${placement.scale}`;
    if (!mapCache.has(key)) {
      const widget = Widgets.get('map');
      mapCache.set(key, widget.prepare(session, Widgets.boxFor(widget, placement, frame)));
    }
    return mapCache.get(key);
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
    paintOverlay(ctx, time, { width: canvas.width, height: canvas.height });
  }

  let lastFrame = 0;

  function tick(now) {
    const elapsed = lastFrame ? (now - lastFrame) / 1000 : 0;
    lastFrame = now;
    if (clock.playing) {
      Clock.advance(clock, Math.min(elapsed, 0.25));
      const ranges = keptRanges();
      if (!Ranges.isKept(ranges, clock.time)) {
        // Jump the hole rather than playing through it: the preview is meant to show
        // what the export will show.
        const next = ranges.find((range) => range.from > clock.time);
        Clock.seek(clock, next ? next.from : session.duration);
      }
    }
    requestAnimationFrame(tick);
  }

  function render(time) {
    if (!dom['sync-panel'].hidden) drawSyncGraph();
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
      if (!node) continue;
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
      // The export takes its audio from whichever camera holds the main slot, so the
      // preview does the same - otherwise the sound would change on the way out.
      element.muted = !sound || inSlot !== 'main';
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
        element.src = api(`/media/${clip.id}/${position.index}`) +
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
