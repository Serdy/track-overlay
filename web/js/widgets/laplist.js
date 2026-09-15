/**
 * The lap list: the lap being driven on top, finished laps under it.
 *
 * Colour carries the meaning, because at speed nobody reads four similar numbers and
 * compares them: yellow for the lap in progress, because it is still moving; the accent
 * for the best one so far; the rest plain. Times are given to a thousandth here, unlike
 * the board, since this is the list you scan afterwards to see which lap was which.
 */
(function (register) {
  // The lap in progress is still moving, so it is marked as provisional; the best one so
  // far gets a colour of its own, and the numbers stay quiet beside the times.
  const RUNNING = '#f5d76e';
  const BEST = '#ff7ae0';
  const NUMBER = 'rgba(120,200,255,0.9)';

  register({
    id: 'laplist',
    title: 'Lap list',
    defaultSize: [0.135, 0.245],

    draw(ctx, box, data) {
      const W = (typeof Widgets !== 'undefined') ? Widgets : require('./index.js');
      const L = (typeof LapTimes !== 'undefined') ? LapTimes : require('../laptimes.js');
      const rows = (data.lapList || []).slice(0, 5);

      W.plate(ctx, box);
      const pad = box.h * 0.07;
      const lineHeight = (box.h - pad * 2) / 6;      // a title plus five rows
      const size = lineHeight * 0.66;

      W.label(ctx, 'LAPS', box.x + pad * 1.6, box.y + pad + lineHeight * 0.75,
              size * 0.62, W.DIM);

      if (!rows.length) {
        W.value(ctx, '—', box.x + pad * 1.6, box.y + pad + lineHeight * 2, size, W.DIM);
        return;
      }

      rows.forEach((row, i) => {
        const y = box.y + pad + lineHeight * (i + 2);
        const colour = row.running ? RUNNING : (row.best ? BEST : W.INK);
        W.label(ctx, String(row.n), box.x + pad * 1.6, y, size * 0.8, NUMBER);
        W.value(ctx, L.format(row.time, 3), box.x + box.w - pad * 1.6, y, size, colour,
                'right');
      });
    },
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
