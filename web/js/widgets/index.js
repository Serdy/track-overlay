/**
 * widgets/index.js — the widget contract and registry.
 *
 * A widget is handed a rectangle **in pixels** and draws inside it, deriving every
 * dimension from that rectangle's height. That is what lets one piece of code produce
 * the same picture in a quarter-screen preview and in a 4K render: layout.json stores
 * position and size as fractions of the frame, and the conversion to pixels happens
 * once, outside.
 *
 * A widget knows nothing about the DOM, about time, or about where the values came
 * from — it receives a ready slice of telemetry. So the same call works from the
 * preview, from the frame exporter, and from a test with a fake context.
 */
const Widgets = (function () {

  const registry = {};

  function register(widget) {
    registry[widget.id] = widget;
    return widget;
  }

  function get(id) {
    return registry[id] || null;
  }

  function ids() {
    return Object.keys(registry);
  }

  /** Widget rectangle in pixels, from fractions of the frame. */
  function boxFor(widget, placement, frame) {
    const size = widget.defaultSize;
    const scale = placement.scale === undefined ? 1 : placement.scale;
    return {
      x: placement.pos[0] * frame.width,
      y: placement.pos[1] * frame.height,
      w: size[0] * frame.width * scale,
      h: size[1] * frame.height * scale,
    };
  }

  function drawAll(ctx, placements, frame, data) {
    for (const placement of placements) {
      const widget = get(placement.type);
      if (!widget) continue;
      ctx.save();
      widget.draw(ctx, boxFor(widget, placement, frame), data);
      ctx.restore();
    }
  }

  // --- shared styling primitives ---------------------------------------------

  const INK = '#ffffff';
  const DIM = 'rgba(255,255,255,0.55)';
  const PLATE = 'rgba(10,12,16,0.62)';

  function plate(ctx, box, radius) {
    ctx.fillStyle = PLATE;
    ctx.beginPath();
    const r = radius === undefined ? box.h * 0.14 : radius;
    if (ctx.roundRect) ctx.roundRect(box.x, box.y, box.w, box.h, r);
    else ctx.rect(box.x, box.y, box.w, box.h);
    ctx.fill();
  }

  function label(ctx, text, x, y, size, color, align) {
    ctx.fillStyle = color || DIM;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(text, x, y);
  }

  function value(ctx, text, x, y, size, color, align) {
    ctx.fillStyle = color || INK;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(text, x, y);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  return { register, get, ids, boxFor, drawAll, plate, label, value, clamp, INK, DIM, PLATE };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Widgets;
} else {
  window.Widgets = Widgets;
}
