/** Цифровая скорость — единственный канал, который измеряется напрямую. */
(function (register) {
  register({
    id: 'speed',
    title: 'Скорость',
    defaultSize: [0.15, 0.095],

    draw(ctx, box, data) {
      const W = (typeof Widgets !== 'undefined') ? Widgets : require('./index.js');
      W.plate(ctx, box);
      const speed = data.speed === null || data.speed === undefined ? 0 : data.speed;
      W.value(ctx, String(Math.round(speed)),
              box.x + box.w * 0.06, box.y + box.h * 0.78, box.h * 0.62);
      W.label(ctx, 'КМ/Ч',
              box.x + box.w * 0.94, box.y + box.h * 0.74, box.h * 0.2, W.DIM, 'right');
    },
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
