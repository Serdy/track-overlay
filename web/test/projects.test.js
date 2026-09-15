const test = require('node:test');
const assert = require('node:assert');

const Projects = require('../js/projects.js');

const BUILT = {
  name: 'slovakia-ring', title: 'Slovakia Ring', built: true, track: 'Slovakia Ring',
  laps: 8, best_s: 160.349, duration_s: 1620, videos: 3, telemetry: 2,
};
const EMPTY = { name: 'new-day', title: 'New day', built: false, videos: 0, telemetry: 0 };

test('a built project reads as a session', () => {
  assert.strictEqual(Projects.statusOf(BUILT), 'built');
  assert.strictEqual(Projects.describe(BUILT),
    'Slovakia Ring · 8 laps · best 2:40.349 · 27 min');
  assert.ok(Projects.canOpen(BUILT));
});

test('an unbuilt project reads as a pile of files', () => {
  const ready = { ...EMPTY, videos: 3, telemetry: 2 };
  assert.strictEqual(Projects.statusOf(ready), 'ready to build');
  assert.strictEqual(Projects.describe(ready), '3 video files, 2 telemetry files');
  assert.ok(Projects.canBuild(ready));
  assert.ok(!Projects.canOpen(ready));
});

test('video without telemetry cannot be built', () => {
  const video = { ...EMPTY, videos: 1 };
  assert.strictEqual(Projects.statusOf(video), 'needs telemetry');
  assert.ok(!Projects.canBuild(video));
});

test('an empty project says so', () => {
  assert.strictEqual(Projects.describe(EMPTY), 'empty — add some files');
});

test('an unreadable session is called out rather than shown as built', () => {
  const broken = { ...BUILT, broken: true };
  assert.strictEqual(Projects.statusOf(broken), 'broken');
  assert.ok(!Projects.canOpen(broken));
  assert.match(Projects.describe(broken), /build it again/);
});

test('lap times read the way they are spoken', () => {
  assert.strictEqual(Projects.lapTime(160.349), '2:40.349');
  assert.strictEqual(Projects.lapTime(59.5), '0:59.500');
  assert.strictEqual(Projects.lapTime(0), '');
});

test('durations round to something a person would say', () => {
  assert.strictEqual(Projects.duration(1620), '27 min');
  assert.strictEqual(Projects.duration(7800), '2 h 10 min');
  assert.strictEqual(Projects.duration(0), '');
});

test('a title has to carry something a folder name can be made of', () => {
  assert.strictEqual(Projects.titleError('Slovakia Ring'), null);
  assert.match(Projects.titleError(''), /give the project a name/);
  assert.match(Projects.titleError('   '), /give the project a name/);
  assert.match(Projects.titleError('!!!'), /letters or digits/);
  assert.match(Projects.titleError('x'.repeat(65)), /too long/);
});

test('the folder name is shown before the server invents it', () => {
  assert.strictEqual(Projects.slugify('Slovakia Ring, 12 September'),
    'slovakia-ring-12-september');
  assert.strictEqual(Projects.slugify('  spaced  out  '), 'spaced-out');
  assert.strictEqual(Projects.slugify('Portimão morning'), 'portimao-morning');
});
