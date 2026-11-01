/**
 * "依相簿分組" (Sprint §5.2): splits an ordered id list into one section per
 * album plus a trailing "not in any album" section, and lays the sections out
 * as virtualisable rows. An asset in several albums appears in each of them.
 * Pure functions — unit-tested under node (v2/test/web-triage.test.mjs).
 */

export const NO_ALBUM_KEY = 'none';

/**
 * @param {number[]} ids Ordered ids of the current view.
 * @param {Record<number, {id: number, name: string}[]>} albumsOf POST /api/assets/albums result(s).
 * @returns {{key: string, albumId: number|null, title: string, ids: number[]}[]}
 */
export function buildGroups(ids, albumsOf) {
  const byAlbum = new Map();
  const none = [];
  for (const id of ids) {
    const list = albumsOf[id] ?? [];
    if (!list.length) { none.push(id); continue; }
    for (const al of list) {
      if (!byAlbum.has(al.id)) byAlbum.set(al.id, { key: `a${al.id}`, albumId: al.id, title: al.name, ids: [] });
      byAlbum.get(al.id).ids.push(id);
    }
  }
  const groups = [...byAlbum.values()].sort((a, b) => a.title.localeCompare(b.title) || a.albumId - b.albumId);
  if (none.length) groups.push({ key: NO_ALBUM_KEY, albumId: null, title: '未在任何相簿', ids: none });
  return groups;
}

/**
 * Row layout: a header row per group, then ceil(n / cols) cell rows.
 *
 * @returns {{rows: {type: 'header'|'cells', group: number, top: number, height: number, start?: number, count?: number}[],
 *            entries: {id: number, group: number}[], height: number}}
 *   entries = flat display order (cell rows' `start` index into it).
 */
export function layoutGroups(groups, cols, pitch, headerHeight) {
  const rows = [];
  const entries = [];
  let top = 0;
  groups.forEach((g, gi) => {
    rows.push({ type: 'header', group: gi, top, height: headerHeight });
    top += headerHeight;
    for (let i = 0; i < g.ids.length; i += cols) {
      rows.push({ type: 'cells', group: gi, top, height: pitch, start: entries.length + i, count: Math.min(cols, g.ids.length - i) });
      top += pitch;
    }
    for (const id of g.ids) entries.push({ id, group: gi });
  });
  return { rows, entries, height: top };
}

/** Index of the first row whose bottom edge is below `y` (binary search). */
export function firstRowAt(rows, y) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].top + rows[mid].height <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Splits ids into request-sized chunks (POST /api/assets/albums accepts ≤ 5000). */
export function chunks(ids, size = 5000) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
