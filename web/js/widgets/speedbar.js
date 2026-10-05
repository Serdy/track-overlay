/**
 * Speed and throttle in one strip, the way a MotoGP broadcast shows it.
 *
 * The number is the speed and sits in the middle. The middle is also zero: the bar grows
 * out of it, right and green on the throttle, left and red on the brakes, and the harder
 * either is the further it reaches. So one strip answers how fast and what the right hand
 * is doing, where otherwise there are two plates and two glances.
 *
 * Length and direction come from the same score as the acceleration widget — already
 * normalised to -1..1 — so the two tell one story rather than two. There is no suppressing
 * of small values: a sliver either side of the middle is a light touch, and reads as one.
 */
(function (register) {
  register({
    id: 'speedbar',
    title: 'Speed bar',
    defaultSize: [0.22, 0.072],
    defaultPos: [0.035, 0.08],

    draw(ctx, box, data) {
      const W = (typeof Widgets !== 'undefined') ? Widgets : require('./index.js');
      W.plate(ctx, box, box.h * 0.18);

      const speed = data.speed === null || data.speed === undefined ? 0 : data.speed;
      const score = W.clamp(
        data.score === undefined || data.score === null ? 0 : data.score, -1, 1);

      const left = box.x + box.w * 0.04;
      const width = box.w * 0.92;
      const top = box.y + box.h * 0.16;
      const height = box.h * 0.68;
      const mid = left + width / 2;

      // Square corners, as the broadcast draws them. A rounded bar reads as a pill with a
      // length; a square one reads as a quantity against a scale, which is what it is.
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(left, top, width, height);

      // Out of the middle: right on the throttle, left on the brakes. Half the strip each
      // way, so a full bar means as hard as this session ever went either way.
      const reach = (width / 2) * Math.abs(score);
      if (reach > 0.5) {
        ctx.fillStyle = data.scoreColor || (score < 0 ? '#ff3c2e' : '#29d175');
        ctx.fillRect(score < 0 ? mid - reach : mid, top, reach, height);
      }

      // The middle marked, or which way the bar has grown is a guess at a glance.
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(mid - box.h * 0.012, top, box.h * 0.024, height);

      W.value(ctx, String(Math.round(speed)), mid, box.y + box.h * 0.76,
              box.h * 0.56, W.INK, 'center');
      W.label(ctx, 'KM/H', left + width * 0.97, box.y + box.h * 0.70,
              box.h * 0.20, W.INK, 'right');
    },

    // The signed share of the strip the bar takes, out of the middle. Negative is to the
    // left, which is braking.
    _reach: (score) => (score < 0 ? -1 : 1) * Math.min(1, Math.abs(score || 0)) / 2,
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
