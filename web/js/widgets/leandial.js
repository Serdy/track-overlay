/**
 * Lean angle as a fan, which reads at a glance where a bar does not: the filled sector
 * points the way the bike is leaning, and its width is the angle.
 *
 * Same steadied value as the bar widget, from `display.js`, and for the same reason —
 * `draw` holds no state, so the preview and the export cannot disagree.
 */
(function (register) {
  const MAX_DEG = 60;             // how far the fan opens each way
  const TICK_DEG = 10;            // a mark every ten degrees

  // Márquez corners at somewhere past sixty. This is a joke, so the number is set where a
  // good track-day corner reaches rather than where the comparison would be fair.
  const MARQUEZ_DEG = 40;

  const UP = -Math.PI / 2;        // canvas angles run clockwise from due east

  register({
    id: 'leandial',
    title: 'Lean dial',
    defaultSize: [0.105, 0.175],
    defaultPos: [0.035, 0.28],

    draw(ctx, box, data) {
      const W = (typeof Widgets !== 'undefined') ? Widgets : require('./index.js');
      W.plate(ctx, box);

      const shown = data.leanValue === undefined || data.leanValue === null
        ? 0 : data.leanValue;
      const side = data.leanSide === undefined || data.leanSide === null
        ? 0 : data.leanSide;
      const degrees = W.clamp(Math.abs(shown) * (side || 1), -MAX_DEG, MAX_DEG);

      const cx = box.x + box.w / 2;
      const cy = box.y + box.h * 0.60;
      const radius = Math.min(box.w * 0.46, box.h * 0.40);
      const inner = radius * 0.30;
      const edge = (MAX_DEG * Math.PI) / 180;

      // The filled sector first, so the outline and the ticks sit on top of it.
      if (Math.abs(degrees) > 0.05) {
        const to = UP + (degrees * Math.PI) / 180;
        ctx.fillStyle = '#e2483d';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, Math.min(UP, to), Math.max(UP, to));
        ctx.closePath();
        ctx.fill();
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = Math.max(1, box.h * 0.008);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, UP - edge, UP + edge);
      ctx.stroke();

      // The two edges of the fan, drawn from a little way out so the apex stays clean.
      for (const end of [-edge, edge]) {
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(UP + end) * inner, cy + Math.sin(UP + end) * inner);
        ctx.lineTo(cx + Math.cos(UP + end) * radius, cy + Math.sin(UP + end) * radius);
        ctx.stroke();
      }

      for (let angle = -MAX_DEG; angle <= MAX_DEG; angle += TICK_DEG) {
        const at = UP + (angle * Math.PI) / 180;
        const from = angle === 0 ? inner : radius * 0.82;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(at) * from, cy + Math.sin(at) * from);
        ctx.lineTo(cx + Math.cos(at) * radius, cy + Math.sin(at) * radius);
        ctx.stroke();
      }

      W.value(ctx, `${Math.abs(shown).toFixed(0)}°`, cx, box.y + box.h * 0.85,
              box.h * 0.26, W.INK, 'center');

      // The bottom label carries the joke when it applies, because there is nowhere else
      // on a plate this narrow for it to go.
      const reached = Math.abs(shown) >= MARQUEZ_DEG;
      W.label(ctx, reached ? 'ALMOST MÁRQUEZ' : 'LEAN', cx, box.y + box.h * 0.96,
              box.h * (reached ? 0.085 : 0.10), reached ? '#e2483d' : W.DIM, 'center');
    },
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
