/**
 * home.js — the project list. Wiring only; every decision it draws comes from Projects.
 *
 * Like state.js this file has no unit tests, and for the same reason: there is nothing in
 * it but element lookups and event listeners.
 */
(function () {
  const dom = {};

  function bind() {
    for (const id of ['new-project', 'new-form', 'new-title', 'new-slug', 'new-cancel',
                      'new-create', 'cards', 'home-status']) {
      dom[id] = document.getElementById(id);
    }
  }

  async function load() {
    try {
      const response = await fetch('/api/projects');
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      render(await response.json());
    } catch (error) {
      dom['home-status'].textContent = String(error.message || error);
    }
  }

  function card(project) {
    const status = Projects.statusOf(project);
    const element = document.createElement('article');
    element.className = `card card-${status.split(' ')[0]}`;

    const head = document.createElement('div');
    head.className = 'card-head';
    head.innerHTML = `<strong>${project.title}</strong>`
      + `<span class="badge">${status}</span>`;

    const line = document.createElement('p');
    line.className = 'muted';
    line.textContent = Projects.describe(project);

    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const open = document.createElement('button');
    open.textContent = Projects.canOpen(project) ? 'Open' : 'Set up';
    open.addEventListener('click', () => {
      window.location.href = `/p/${encodeURIComponent(project.name)}/`;
    });
    const gap = document.createElement('span');
    gap.className = 'spacer';
    const folder = document.createElement('code');
    folder.className = 'muted';
    folder.textContent = project.name;
    foot.append(open, gap, folder);

    element.append(head, line, foot);
    return element;
  }

  function render(list) {
    dom.cards.innerHTML = '';
    if (!list.length) {
      dom['home-status'].textContent =
        'No projects yet. Make one, then point it at a RaceBox export and the GoPro files.';
      return;
    }
    dom['home-status'].textContent = '';
    for (const project of list) dom.cards.append(card(project));
  }

  async function create() {
    const title = dom['new-title'].value;
    const problem = Projects.titleError(title);
    if (problem) {
      dom['home-status'].textContent = problem;
      return;
    }
    dom['new-create'].disabled = true;
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      });
      const created = await response.json();
      if (!response.ok) throw new Error(created.error || `the server answered ${response.status}`);
      window.location.href = `/p/${encodeURIComponent(created.name)}/`;
    } catch (error) {
      dom['home-status'].textContent = String(error.message || error);
      dom['new-create'].disabled = false;
    }
  }

  function wire() {
    dom['new-project'].addEventListener('click', () => {
      dom['new-form'].hidden = false;
      dom['new-title'].focus();
    });
    dom['new-cancel'].addEventListener('click', () => {
      dom['new-form'].hidden = true;
      dom['home-status'].textContent = '';
    });
    dom['new-title'].addEventListener('input', () => {
      dom['new-slug'].textContent = Projects.slugify(dom['new-title'].value);
    });
    dom['new-title'].addEventListener('keydown', (event) => {
      if (event.key === 'Enter') create();
    });
    dom['new-create'].addEventListener('click', create);
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    wire();
    load();
  });
}());
