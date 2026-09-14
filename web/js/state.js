/**
 * state.js — связывает чистые модули с DOM.
 *
 * Вся логика времени живёт в clock.js, вся работа с данными — в session.js. Здесь
 * только провода: подписки, обработчики и обновление элементов. Поэтому модуль и не
 * покрыт юнит-тестами — покрывать в нём нечего.
 */
(function () {
  const dom = {};
  let session = null;
  let clock = null;
  let videos = [];

  const READOUT = [
    { channel: 'speed', label: 'км/ч', digits: 0 },
    { channel: 'lean', label: 'наклон', digits: 1, suffix: '°' },
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
      dom['track-name'].textContent = 'не удалось загрузить сессию';
      return;
    }
    session = SessionModel.load(await response.json());
    clock = Clock.create(session.duration, 60);

    describe();
    buildReadout();
    buildLapMarks();
    buildSlots();
    wire();

    Clock.onChange(clock, render);
    render(0);
    requestAnimationFrame(tick);
  }

  function describe() {
    dom['track-name'].textContent = session.track || 'Сессия';
    const best = SessionModel.bestLap(session);
    dom['session-info'].textContent =
      `${session.laps.length} кругов` +
      (best ? ` · лучший ${Clock.formatTime(best.duration_s)}` : '');

    const clip = session.clips[0];
    dom['sync-info'].textContent = clip
      ? `сведение: ${clip.sync.method} (${clip.sync.correlation.toFixed(4)})`
      : 'видео не подключено';
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

  /** По тегу <video> на клип. Превью играет по прокси, если он есть. */
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
      ? `круг ${lap.n} · ${Clock.formatTime(SessionModel.lapTime(session, time))}`
      : 'вне круга';

    for (const item of READOUT) {
      const value = SessionModel.sampleAt(session, item.channel, time);
      const node = dom.readout.querySelector(`[data-channel="${item.channel}"]`);
      node.textContent = value === null
        ? '—' : value.toFixed(item.digits) + (item.suffix || '');
    }

    syncVideos(time);
  }

  /**
   * Видео ведётся часами, а не наоборот. На воспроизведении даём ему играть самому и
   * подтягиваем, только когда оно уехало заметно, — иначе постоянные присваивания
   * currentTime дёргают картинку.
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

      // Переход между чанками: меняем источник и встаём на нужное место в новом файле.
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
