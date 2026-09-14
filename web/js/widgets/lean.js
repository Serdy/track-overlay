/**
 * Lean angle. The value is derived from the trajectory rather than read off the
 * accelerometer: in a steady corner a bike-mounted sensor reads close to zero, because
 * the machine leans until the resultant force lines up with its own vertical axis.
 */
(function (register) {
  const MAX_DEG = 60;

  register({
    id: 'lean',
    title: 'Lean angle',
    defaultSize: [0.15, 0.095],

    draw(ctx, box, data) {
      const W = (typeof Widgets !== 'undefined') ? Widgets : require('./index.js');
      W.plate(ctx, box);

      const lean = data.lean === null || data.lean === undefined ? 0 : data.lean;
      const fraction = W.clamp(lean / MAX_DEG, -1, 1);

      // The scale is centred on upright; left and right are the two lean directions.
      const midX = box.x + box.w / 2;
      const trackY = box.y + box.h * 0.82;
      const half = box.w * 0.42;
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(midX - half, trackY, half * 2, box.h * 0.06);

      ctx.fillStyle = '#e2483d';
      const length = half * Math.abs(fraction);
      ctx.fillRect(fraction < 0 ? midX - length : midX, trackY, length, box.h * 0.06);

      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillRect(midX - box.h * 0.015, trackY - box.h * 0.04,
                   box.h * 0.03, box.h * 0.14);

      W.value(ctx, `${Math.abs(lean).toFixed(0)}°`,
              box.x + box.w * 0.06, box.y + box.h * 0.6, box.h * 0.46);
      W.label(ctx, lean < -0.5 ? 'LEFT' : (lean > 0.5 ? 'RIGHT' : 'LEAN'),
              box.x + box.w * 0.94, box.y + box.h * 0.55, box.h * 0.2, W.DIM, 'right');
    },
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
