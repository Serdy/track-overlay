/**
 * history.js — undo and redo over layout snapshots.
 *
 * The layout is small and entirely serialisable, so a snapshot per edit is simpler and
 * more reliable than recording inverse operations: there is no way for an undo to be
 * subtly wrong about what "the opposite" of dragging a widget was.
 *
 * Snapshots are kept as JSON text, which makes "did anything actually change?" a string
 * comparison and stops an unchanged re-save from filling the stack with duplicates.
 */
const History = (function () {

  const LIMIT = 50;

  function create(limit = LIMIT) {
    return { past: [], future: [], limit };
  }

  /** Records the state about to be replaced. Returns a new history. */
  function push(history, state) {
    const frame = JSON.stringify(state);
    if (history.past[history.past.length - 1] === frame) return history;
    const past = [...history.past, frame].slice(-history.limit);
    return { past, future: [], limit: history.limit };   // a new edit ends the redo line
  }

  function canUndo(history) {
    return history.past.length > 0;
  }

  function canRedo(history) {
    return history.future.length > 0;
  }

  /**
   * Steps back. `current` is what is on screen now, so it can be stepped forward to again.
   * Returns null when there is nothing to undo.
   */
  function undo(history, current) {
    if (!canUndo(history)) return null;
    const past = history.past.slice(0, -1);
    const frame = history.past[history.past.length - 1];
    return {
      history: { past, future: [JSON.stringify(current), ...history.future], limit: history.limit },
      state: JSON.parse(frame),
    };
  }

  function redo(history, current) {
    if (!canRedo(history)) return null;
    const [frame, ...future] = history.future;
    return {
      history: { past: [...history.past, JSON.stringify(current)], future, limit: history.limit },
      state: JSON.parse(frame),
    };
  }

  return { LIMIT, create, push, undo, redo, canUndo, canRedo };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = History;
else window.History = History;
