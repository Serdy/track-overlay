/**
 * Угол наклона. Значение вычисляется из траектории, а не берётся с акселерометра:
 * в установившемся повороте датчик на мотоцикле показывает около нуля.
 */
(function (register) {
  const MAX_DEG = 60;

  register({
    id: 'lean',
    title: 'Наклон',
    defaultSize: [0.15, 0.095],

    draw(ctx, box, data) {
      const W = (typeof Widgets !== 'undefined') ? Widgets : require('./index.js');
      W.plate(ctx, box);

      const lean = data.lean === null || data.lean === undefined ? 0 : data.lean;
      const fraction = W.clamp(lean / MAX_DEG, -1, 1);

      // Шкала: центр — вертикаль, влево и вправо — стороны наклона.
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
      W.label(ctx, lean < -0.5 ? 'ЛЕВЫЙ' : (lean > 0.5 ? 'ПРАВЫЙ' : 'НАКЛОН'),
              box.x + box.w * 0.94, box.y + box.h * 0.55, box.h * 0.2, W.DIM, 'right');
    },
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
