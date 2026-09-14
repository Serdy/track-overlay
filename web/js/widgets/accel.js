/**
 * Acceleration and braking. The bar grows from the centre: right under power, left
 * under braking. The colour comes from sr-track — the same score that paints the
 * track line on serious-racing.
 *
 * The bar follows the score directly, but the label comes from `display.js` with
 * hysteresis applied: a plain threshold makes it flicker while coasting, when the score
 * hovers around zero.
 */
(function (register) {
  register({
    id: 'accel',
    title: 'Acceleration / braking',
    defaultSize: [0.15, 0.095],

    draw(ctx, box, data) {
      const W = (typeof Widgets !== 'undefined') ? Widgets : require('./index.js');
      W.plate(ctx, box);

      const score = W.clamp(data.score === undefined || data.score === null ? 0 : data.score, -1, 1);
      const midX = box.x + box.w / 2;
      const trackY = box.y + box.h * 0.78;
      const half = box.w * 0.42;
      const height = box.h * 0.1;

      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(midX - half, trackY, half * 2, height);

      ctx.fillStyle = data.scoreColor || (score < 0 ? '#ff3c2e' : '#29d175');
      const length = half * Math.abs(score);
      ctx.fillRect(score < 0 ? midX - length : midX, trackY, length, height);

      const accel = data.accel === null || data.accel === undefined ? 0 : data.accel;
      W.value(ctx, `${accel >= 0 ? '+' : ''}${accel.toFixed(2)}`,
              box.x + box.w * 0.06, box.y + box.h * 0.58, box.h * 0.44);
      const side = data.scoreSide === undefined || data.scoreSide === null
        ? 0 : data.scoreSide;
      W.label(ctx, side < 0 ? 'BRAKING' : (side > 0 ? 'POWER' : 'G'),
              box.x + box.w * 0.94, box.y + box.h * 0.54, box.h * 0.2, W.DIM, 'right');
    },
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
