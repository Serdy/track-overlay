/**
 * Lap times: best, previous, current, and the live delta to the best.
 *
 * Laid out as a pit board read at speed - the labels small and dim, the numbers large,
 * and the delta last and largest, because it is the only one that changes meaning corner
 * by corner. Green for up on the best lap, red for down.
 */
(function (register) {
  register({
    id: 'laptime',
    title: 'Lap times',
    defaultSize: [0.46, 0.085],

    draw(ctx, box, data) {
      const W = (typeof Widgets !== 'undefined') ? Widgets : require('./index.js');
      const L = (typeof LapTimes !== 'undefined') ? LapTimes : require('../laptimes.js');
      const laps = data.laps || {};

      W.plate(ctx, box);
      const pad = box.h * 0.16;
      const top = box.y + box.h * 0.42;          // baseline for the labels
      const line = box.y + box.h * 0.86;         // baseline for the numbers
      const labelSize = box.h * 0.22;
      const valueSize = box.h * 0.52;

      // Three even columns for the times, then the delta in the space that is left.
      const columns = (box.w - pad * 2) / 3.7;
      const fields = [
        { name: 'Best', entry: laps.best },
        { name: 'Previous', entry: laps.previous },
        { name: 'Current', entry: laps.current },
      ];

      fields.forEach((field, i) => {
        const x = box.x + pad + columns * i;
        W.label(ctx, field.name, x, top, labelSize);
        const entry = field.entry;
        if (!entry) {
          W.value(ctx, '—', x, line, valueSize, W.DIM);
          return;
        }
        // The lap number rides small and high, the way a timing screen shows it.
        W.label(ctx, String(entry.n), x, line - valueSize * 0.52, labelSize * 0.9, W.DIM);
        W.value(ctx, L.format(entry.time), x + labelSize * 1.1, line, valueSize);
      });

      const delta = laps.delta;
      const colour = delta === null || delta === undefined ? W.DIM
        : (delta < -0.005 ? '#6fd36f' : (delta > 0.005 ? '#ff6b5e' : W.INK));
      W.label(ctx, 'Δ best', box.x + box.w - pad, top, labelSize, W.DIM, 'right');
      W.value(ctx, L.formatDelta(delta), box.x + box.w - pad, line, valueSize, colour, 'right');
    },
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
