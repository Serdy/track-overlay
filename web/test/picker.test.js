const test = require('node:test');
const assert = require('node:assert');
const Picker = require('../js/picker.js');

test('telemetry and video are told apart by extension', () => {
  assert.ok(Picker.isTelemetry('session.csv'));
  assert.ok(Picker.isTelemetry('session.VBO'));
  assert.ok(Picker.isVideo('GH013429.MP4'));
  assert.ok(!Picker.isVideo('notes.txt'));
  assert.ok(!Picker.isTelemetry('GH013429.MP4'));
});

test('a file with no extension confuses nothing', () => {
  assert.strictEqual(Picker.extension('README'), '');
  assert.ok(!Picker.isVideo('README'));
});

test('telemetry is required, video is not', () => {
  // Telemetry alone still gives a session the editor can show; video alone draws nothing.
  assert.strictEqual(Picker.missing(['/x/a.csv']), null);
  assert.match(Picker.missing(['/x/GH013429.MP4']), /RaceBox export/);
  assert.match(Picker.missing([]), /nothing chosen/);
});

test('the selection is described in plain words', () => {
  assert.strictEqual(
    Picker.describe(['/x/a.csv', '/x/b.vbo', '/x/GH013429.MP4', '/x/GH023429.MP4']),
    '2 video files, 2 telemetry files');
  assert.strictEqual(Picker.describe(['/x/a.csv']), '1 telemetry file');
  assert.strictEqual(Picker.describe([]), 'nothing chosen');
});
