/**
 * Speed and throttle in one strip, the way a MotoGP broadcast shows it.
 *
 * Two readings that are always read together: how fast, and whether that number is
 * climbing or falling. Separately they cost two glances and two plates; together the
 * length says the speed and the colour says what the right hand is doing.
 *
 * The scale is the session's own top speed rather than a constant, because a constant
 * generous enough for a litre bike leaves most of the bar dead on a 600.
 *
 * Colour comes from the same score as the acceleration widget, and the *side* from
 * `display.js`, steadied — a plain threshold on the raw channel makes the strip flicker
 * between green and red while coasting, which is most of a lap.
 */
(function (register) {
  const FALLBACK_TOP_KMH = 200;   // until the session says otherwise

  const COASTING = 'rgba(255,255,255,0.22)';

  register({
    id: 'speedbar',
    title: 'Speed bar',
    defaultSize: [0.22, 0.072],
    defaultPos: [0.035, 0.08],

    draw(ctx, box, data) {
      const W = (typeof Widgets !== 'undefined') ? Widgets : require('./index.js');
      W.plate(ctx, box, box.h * 0.18);

      const speed = data.speed === null || data.speed === undefined ? 0 : data.speed;
      const top = data.topSpeed > 0 ? data.topSpeed : FALLBACK_TOP_KMH;
      const side = data.scoreSide === undefined || data.scoreSide === null
        ? 0 : data.scoreSide;

      const left = box.x + box.w * 0.04;
      const width = box.w * 0.92;
      const top_y = box.y + box.h * 0.16;
      const height = box.h * 0.68;
      const radius = height * 0.22;

      const round = (x, y, w, h, r) => {
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
        else ctx.rect(x, y, w, h);
        ctx.fill();
      };

      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      round(left, top_y, width, height, radius);

      const reach = width * W.clamp(speed / top, 0, 1);
      if (reach > 1) {
        // Coasting gets no colour at all: a strip that is green or red at every moment
        // says nothing by being green, and the lap is mostly neither.
        ctx.fillStyle = side === 0 ? COASTING : (data.scoreColor
          || (side < 0 ? '#ff3c2e' : '#29d175'));
        round(left, top_y, reach, height, radius);
      }

      // The number sits over the strip, not beside it, which is what makes this one
      // reading rather than two next to each other.
      W.value(ctx, String(Math.round(speed)),
              left + width * 0.04, box.y + box.h * 0.76, box.h * 0.56);
      W.label(ctx, 'KM/H', left + width * 0.97, box.y + box.h * 0.70,
              box.h * 0.20, W.INK, 'right');
    },

    _fill: (speed, top) => (top > 0 ? Math.min(1, Math.max(0, speed / top)) : 0),
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
