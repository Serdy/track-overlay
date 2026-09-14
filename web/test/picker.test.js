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

test('sizes read the way a person would say them', () => {
  assert.strictEqual(Picker.humanSize(4_005_478_408), '4.0 GB');
  assert.strictEqual(Picker.humanSize(3_900_000), '4 MB');
  assert.strictEqual(Picker.humanSize(900), '1 KB');
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

test('picking one chunk offers the whole recording', () => {
  const files = [
    { name: 'GH013429.MP4' }, { name: 'GH023429.MP4' }, { name: 'GH033429.MP4' },
    { name: 'GH013430.MP4' }, { name: 'notes.csv' },
  ];
  assert.deepStrictEqual(Picker.sameRecording('GH023429.MP4', files),
                         ['GH013429.MP4', 'GH023429.MP4', 'GH033429.MP4']);
});

test('a file outside the GoPro naming stands alone', () => {
  const files = [{ name: 'holiday.mp4' }, { name: 'GH013429.MP4' }];
  assert.deepStrictEqual(Picker.sameRecording('holiday.mp4', files), ['holiday.mp4']);
});

test('recordings with the same chunk number but different numbers stay apart', () => {
  const files = [{ name: 'GH013429.MP4' }, { name: 'GH013430.MP4' }];
  assert.deepStrictEqual(Picker.sameRecording('GH013429.MP4', files), ['GH013429.MP4']);
});
