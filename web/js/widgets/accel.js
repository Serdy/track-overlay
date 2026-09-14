/**
 * Acceleration and braking, shown as a bar alone.
 *
 * There used to be a number here as well, and it was useless: at two decimals the G
 * reading changed 17.6 times a second, which is 29% of frames at 60 fps. Nobody reads a
 * digit that moves that fast. The bar changes just as often but the eye takes it as
 * continuous motion rather than flicker, so it carries the information and the number
 * only added noise.
 *
 * The colour comes from sr-track — the same score that paints the track line on
 * serious-racing. The label is steadied by `display.js`, because a plain threshold makes
 * it flip while coasting.
 */
(function (register) {
  register({
    id: 'accel',
    title: 'Acceleration / braking',
    defaultSize: [0.15, 0.055],

    draw(ctx, box, data) {
      const W = (typeof Widgets !== 'undefined') ? Widgets : require('./index.js');
      W.plate(ctx, box, box.h * 0.24);

      const score = W.clamp(
        data.score === undefined || data.score === null ? 0 : data.score, -1, 1);
      const side = data.scoreSide === undefined || data.scoreSide === null
        ? 0 : data.scoreSide;

      const label = side < 0 ? 'BRAKING' : (side > 0 ? 'POWER' : 'COASTING');
      W.label(ctx, label, box.x + box.w * 0.07, box.y + box.h * 0.42,
              box.h * 0.30, W.DIM, 'left');

      // The bar is the whole point now, so it gets the weight: full width and thick
      // enough to read from across a room.
      const left = box.x + box.w * 0.07;
      const width = box.w * 0.86;
      const height = box.h * 0.22;
      const top = box.y + box.h * 0.60;
      const mid = left + width / 2;

      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(left, top, width, height, height / 2);
      else ctx.rect(left, top, width, height);
      ctx.fill();

      const reach = (width / 2) * Math.abs(score);
      if (reach > 0.5) {
        ctx.fillStyle = data.scoreColor || (score < 0 ? '#ff3c2e' : '#29d175');
        ctx.beginPath();
        const barX = score < 0 ? mid - reach : mid;
        if (ctx.roundRect) ctx.roundRect(barX, top, reach, height, height / 2);
        else ctx.rect(barX, top, reach, height);
        ctx.fill();
      }

      // A tick at zero, so which side the bar has grown to is unmistakable.
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillRect(mid - box.h * 0.012, top - box.h * 0.07,
                   box.h * 0.024, height + box.h * 0.14);
    },
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
