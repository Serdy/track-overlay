/**
 * layout.js — the layout as data: validation, hit testing and moving things about.
 *
 * Every position here is a fraction of the frame, never a pixel. That is not tidiness —
 * it is the one rule that lets the preview, drawn on an element of whatever size the
 * window happens to be, and the render, drawn at full output resolution, produce the same
 * picture. A pixel stored anywhere in this file would break that.
 *
 * DOM-free, so dragging can be tested without a browser.
 */
const Layout = (function () {

  const MIN_SCALE = 0.4;
  const MAX_SCALE = 3.0;
  const MIN_PIP = 0.08;            // an inset smaller than this is unreadable

  function clamp(value, lo, hi) {
    return value < lo ? lo : (value > hi ? hi : value);
  }

  /** Keeps a widget inside the frame, allowing for its own size. */
  function clampPos(pos, size) {
    const [w, h] = size || [0, 0];
    return [clamp(pos[0], 0, Math.max(0, 1 - w)), clamp(pos[1], 0, Math.max(0, 1 - h))];
  }

  function clampRect(rect) {
    const w = clamp(rect[2], MIN_PIP, 1);
    const h = clamp(rect[3], MIN_PIP, 1);
    return [clamp(rect[0], 0, 1 - w), clamp(rect[1], 0, 1 - h), w, h];
  }

  /**
   * Checks a layout and returns a corrected copy alongside whatever was wrong.
   *
   * Nothing throws: a layout saved against a different set of cameras, or hand-edited
   * into nonsense, should still open — with the damage reported rather than hidden.
   */
  function validate(layout, knownClips, widgetSizes) {
    const errors = [];
    const known = new Set(knownClips);
    const out = JSON.parse(JSON.stringify(layout || {}));

    out.output = Object.assign({ width: 1920, height: 1080, fps: 60 }, out.output);
    for (const key of ['width', 'height']) {
      if (!Number.isFinite(out.output[key]) || out.output[key] < 16) {
        errors.push(`output.${key} is not a usable size`);
        out.output[key] = key === 'width' ? 1920 : 1080;
      }
    }

    out.widgets = (out.widgets || []).filter((widget) => {
      if (!widget || typeof widget.type !== 'string') {
        errors.push('a widget without a type was dropped');
        return false;
      }
      return true;
    }).map((widget) => {
      const size = (widgetSizes || {})[widget.type] || [0, 0];
      const before = widget.pos || [0, 0];
      const pos = clampPos(before, size);
      if (pos[0] !== before[0] || pos[1] !== before[1]) {
        errors.push(`widget ${widget.type} sat outside the frame and was pulled back in`);
      }
      const scale = clamp(widget.scale === undefined ? 1 : widget.scale, MIN_SCALE, MAX_SCALE);
      return Object.assign({}, widget, { pos, scale });
    });

    out.slots = (out.slots || []).map((slot) => Object.assign({}, slot, {
      rect: clampRect(slot.rect || [0, 0, 1, 1]),
    }));

    const cuts = (out.cuts || []).filter((cut) => {
      const ok = known.has(cut.main) && (cut.pip === null || known.has(cut.pip));
      if (!ok) errors.push(`a switch at ${cut.t}s referred to a camera that is gone`);
      return ok;
    });
    out.cuts = cuts;
    if (!cuts.length) errors.push('no usable camera arrangement remained');

    return { layout: out, errors, ok: errors.length === 0 };
  }

  /** Widget rectangles in fractions of the frame, topmost last. */
  function boxes(layout, widgetSizes) {
    return (layout.widgets || []).map((widget, index) => {
      const [w, h] = (widgetSizes || {})[widget.type] || [0.1, 0.1];
      const scale = widget.scale === undefined ? 1 : widget.scale;
      return {
        index,
        type: widget.type,
        x: widget.pos[0], y: widget.pos[1],
        w: w * scale, h: h * scale,
      };
    });
  }

  /** Which widget lies under a point, in frame fractions. Topmost wins. */
  function hitTest(layout, widgetSizes, x, y) {
    const found = boxes(layout, widgetSizes).filter(
      (box) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h);
    return found.length ? found[found.length - 1] : null;
  }

  /** Moves one widget by a delta in frame fractions, keeping it on screen. */
  function moveWidget(layout, index, dx, dy, widgetSizes) {
    const out = JSON.parse(JSON.stringify(layout));
    const widget = out.widgets[index];
    if (!widget) return out;
    const [w, h] = (widgetSizes || {})[widget.type] || [0, 0];
    const scale = widget.scale === undefined ? 1 : widget.scale;
    widget.pos = clampPos([widget.pos[0] + dx, widget.pos[1] + dy], [w * scale, h * scale]);
    return out;
  }

  function scaleWidget(layout, index, factor) {
    const out = JSON.parse(JSON.stringify(layout));
    const widget = out.widgets[index];
    if (!widget) return out;
    widget.scale = clamp((widget.scale === undefined ? 1 : widget.scale) * factor,
                         MIN_SCALE, MAX_SCALE);
    return out;
  }

  /** Moves or resizes a slot rectangle, used for dragging the inset. */
  function setSlotRect(layout, slotId, rect) {
    const out = JSON.parse(JSON.stringify(layout));
    const slot = (out.slots || []).find((s) => s.id === slotId);
    if (slot) slot.rect = clampRect(rect);
    return out;
  }

  return { MIN_SCALE, MAX_SCALE, MIN_PIP, clampPos, clampRect, validate,
           boxes, hitTest, moveWidget, scaleWidget, setSlotRect };
}());

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Layout;
} else {
  window.Layout = Layout;
}
