/**
 * projects.js — what a project card says, with no DOM in sight.
 *
 * The home screen has one job: answer "which of these can I open, and which still needs
 * something from me?" before anything is clicked. All of that is string work, so it lives
 * here where it can be tested, and home.js is left with nothing but wiring.
 */
const Projects = (function () {

  /** Where a project stands, as one of four words the screen can colour. */
  function statusOf(project) {
    if (project.broken) return 'broken';
    if (project.built) return 'built';
    if (!project.telemetry) return 'needs telemetry';
    return 'ready to build';
  }

  function canBuild(project) {
    return Boolean(project.telemetry) && !project.broken;
  }

  function canOpen(project) {
    return Boolean(project.built) && !project.broken;
  }

  /** "2:40.349", the way a lap time is read aloud. */
  function lapTime(seconds) {
    if (!seconds) return '';
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${(seconds - minutes * 60).toFixed(3).padStart(6, '0')}`;
  }

  function duration(seconds) {
    if (!seconds) return '';
    const minutes = Math.round(seconds / 60);
    return minutes >= 60
      ? `${Math.floor(minutes / 60)} h ${minutes % 60} min`
      : `${minutes} min`;
  }

  /** What the card shows under the title: the session if built, the files if not. */
  function describe(project) {
    if (project.broken) return 'the session file cannot be read — build it again';
    if (project.built) {
      const parts = [];
      if (project.track) parts.push(project.track);
      if (project.laps) parts.push(`${project.laps} lap${project.laps > 1 ? 's' : ''}`);
      if (project.best_s) parts.push(`best ${lapTime(project.best_s)}`);
      if (project.duration_s) parts.push(duration(project.duration_s));
      return parts.join(' · ');
    }
    const parts = [];
    if (project.videos) parts.push(`${project.videos} video file${project.videos > 1 ? 's' : ''}`);
    if (project.telemetry) {
      parts.push(`${project.telemetry} telemetry file${project.telemetry > 1 ? 's' : ''}`);
    }
    return parts.join(', ') || 'empty — add some files';
  }

  /**
   * Why a title will not do, or null if it will.
   *
   * The server has the last word, since only it knows what folders exist; this is here so
   * the obvious cases answer instantly instead of after a round trip.
   */
  function titleError(title) {
    const trimmed = (title || '').trim();
    if (!trimmed) return 'give the project a name';
    if (!/[a-zA-Z0-9]/.test(trimmed)) return 'the name needs letters or digits in it';
    if (trimmed.length > 64) return 'that name is too long';
    return null;
  }

  /** The folder name the server will derive, shown while typing so it is no surprise. */
  function slugify(title) {
    return (title || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/, '');
  }

  return { statusOf, canBuild, canOpen, describe, lapTime, duration, titleError, slugify };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = Projects;
else window.Projects = Projects;
