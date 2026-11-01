/**
 * Triage key map (Sprint §7) as a pure function: keyboard event → action
 * descriptor. The Triage component executes descriptors; this module decides
 * nothing about the network. Unit-tested under node (v2/test/web-triage.test.mjs).
 *
 * Modes:
 *   browse — normal triage: Q W E R, 1–9, G / Shift+G, Z, S, navigation, zoom
 *   crop   — a Q / W crop is being drawn: Enter / Space confirm, Esc cancel,
 *            1–4 pick the aspect ratio (legacy behaviour)
 *   stats  — the session-statistics panel is open: S / Esc close it
 */

/** Crop-mode ratio keys (legacy order). */
export const CROP_RATIO_KEYS = { 1: 'free', 2: '1:1', 3: '3:4', 4: '16:9' };

const NAV_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'pageup', 'pagedown']);

/** True when keystrokes belong to a text field rather than to shortcuts. */
export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = String(target.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

/**
 * @param {{key: string, shiftKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean,
 *          repeat?: boolean, target?: unknown}} e
 * @param {{mode?: 'browse'|'crop'|'stats', blocked?: boolean}} [ctx] blocked = a dialog / picker owns the keyboard
 * @returns {null | {type: string, [k: string]: unknown}}
 */
export function triageAction(e, ctx = {}) {
  const mode = ctx.mode ?? 'browse';
  if (ctx.blocked || !e || typeof e.key !== 'string') return null;
  if (isEditableTarget(e.target)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();

  if (mode === 'stats') {
    return k === 's' || k === 'escape' ? { type: 'stats' } : null;
  }

  if (mode === 'crop') {
    if (e.repeat) return null;
    if (k === 'enter' || k === ' ') return { type: 'crop-confirm' };
    if (k === 'escape') return { type: 'crop-cancel' };
    if (!e.shiftKey && CROP_RATIO_KEYS[k]) return { type: 'ratio', ratio: CROP_RATIO_KEYS[k] };
    return null;
  }

  // Held-down keys only auto-repeat navigation / zoom; a held R must not trash a run of images.
  if (e.repeat && !NAV_KEYS.has(k)) return null;

  switch (k) {
    case 'q': return { type: 'crop-start', purpose: 'bundle' };
    case 'w': return { type: 'crop-start', purpose: 'keep' };
    case 'e': return { type: 'later' };
    case 'r': return { type: 'trash' };
    case 'z': return { type: 'undo' };
    case 's': return { type: 'stats' };
    case 'g': return e.shiftKey ? { type: 'bundle-cancel' } : { type: 'bundle-toggle' };
    case 'arrowleft': case 'a': case 'pageup': return { type: 'nav', delta: -1 };
    case 'arrowright': case 'd': case 'pagedown': return { type: 'nav', delta: 1 };
    case 'home': return { type: 'nav-to', where: 'first' };
    case 'end': return { type: 'nav-to', where: 'last' };
    case 'arrowup': case '+': case '=': return { type: 'zoom', dir: 1 };
    case 'arrowdown': case '-': return { type: 'zoom', dir: -1 };
    case '0': return { type: 'zoom-reset' };
    case 'escape': return { type: 'exit' };
    default: break;
  }
  if (!e.shiftKey && /^[1-9]$/.test(k)) return { type: 'slot', slot: Number(k) - 1 };
  return null;
}

/**
 * Where the triage cursor lands after the source list is re-queried.
 *
 * - The current image is still in the list: stay on it, or move one further
 *   when `advance` (E / Q / W "next image" semantics).
 * - It left the list (tagged out of 未歸類, trashed, …): the first image after
 *   it in the old order that survived — i.e. the natural "next" — else the
 *   nearest survivor before it.
 *
 * @param {number[]} oldIds
 * @param {number[]} newIds
 * @param {number} oldIndex
 * @param {boolean} [advance]
 * @returns {number} index into newIds, -1 when newIds is empty
 */
export function nextIndex(oldIds, newIds, oldIndex, advance = false) {
  if (!newIds.length) return -1;
  const pos = new Map(newIds.map((id, i) => [id, i]));
  const cur = oldIds[oldIndex];
  if (pos.has(cur)) {
    const j = pos.get(cur);
    return advance ? Math.min(j + 1, newIds.length - 1) : j;
  }
  for (let i = oldIndex + 1; i < oldIds.length; i++) if (pos.has(oldIds[i])) return pos.get(oldIds[i]);
  for (let i = Math.min(oldIndex, oldIds.length) - 1; i >= 0; i--) if (pos.has(oldIds[i])) return pos.get(oldIds[i]);
  return Math.min(Math.max(0, oldIndex), newIds.length - 1);
}

/**
 * Decides what Z undoes. The server keeps one global event stack; one UI
 * action can write several events (Q = [bundle.create] + crop.create +
 * bundle.add). When the newest undoable event is the last event of the newest
 * local action, and all of that action's events are still undoable, undo them
 * all (newest first) so Z reverses exactly one keystroke. Otherwise fall back
 * to a plain global undo of the newest event; the local entry that event
 * belongs to is dropped — an entry with unknown event ids (catalog ops such as
 * E / slot toggles don't return one) is assumed to own it when it is on top.
 *
 * @param {{label: string, eventIds: number[]}[]} history Local actions, oldest first.
 * @param {{id: number}[]} undoable GET /api/undo, newest first.
 * @returns {{eventIds: number[]|null, label: string|null, rest: {label: string, eventIds: number[]}[]}}
 */
export function planUndo(history, undoable) {
  if (!undoable.length) return { eventIds: null, label: null, rest: history };
  const top = history[history.length - 1];
  const live = new Set(undoable.map((u) => u.id));
  if (top && top.eventIds.length && Math.max(...top.eventIds) === undoable[0].id && top.eventIds.every((id) => live.has(id))) {
    return { eventIds: [...top.eventIds].sort((a, b) => b - a), label: top.label, rest: history.slice(0, -1) };
  }
  const newest = undoable[0].id;
  const rest = top && !top.eventIds.length ? history.slice(0, -1) : history;
  return { eventIds: null, label: null, rest: rest.filter((h) => !h.eventIds.includes(newest)) };
}
