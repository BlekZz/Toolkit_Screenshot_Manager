/**
 * Sidebar/chip filter state ⇄ query AST (server grammar, Sprint §5).
 *
 * state = {
 *   tags:   { [id]: 'in' | 'out' },
 *   albums: { [id]: 'in' | 'out' },
 *   tagMode: 'all' | 'any',      // how included tags combine
 *   albumMode: 'any' | 'all',    // how included albums combine
 *   smart: null | number | 'unfiled',
 *   q: string,                   // advanced query text, ANDed
 * }
 */

export const UNFILED_AST = {
  op: 'and',
  args: [{ op: 'not', arg: { op: 'has', what: 'album' } }, { op: 'not', arg: { op: 'has', what: 'tag' } }],
};

export function emptyFilter() {
  return { tags: {}, albums: {}, tagMode: 'all', albumMode: 'any', smart: null, q: '' };
}

const pick = (states, want) => Object.entries(states).filter(([, s]) => s === want).map(([id]) => Number(id));

function combine(nodes, mode) {
  if (!nodes.length) return null;
  if (nodes.length === 1) return nodes[0];
  return { op: mode === 'any' ? 'or' : 'and', args: nodes };
}

/** @returns {{ast: object, q: string}} payload for /api/query and /api/facets */
export function toPayload(f) {
  const parts = [];
  if (f.smart === 'unfiled') parts.push(UNFILED_AST);
  else if (f.smart != null) parts.push({ op: 'smart', id: f.smart });
  const albumsIn = combine(pick(f.albums, 'in').map((id) => ({ op: 'album', id })), f.albumMode);
  const tagsIn = combine(pick(f.tags, 'in').map((id) => ({ op: 'tag', id })), f.tagMode);
  if (albumsIn) parts.push(albumsIn);
  if (tagsIn) parts.push(tagsIn);
  for (const id of pick(f.albums, 'out')) parts.push({ op: 'not', arg: { op: 'album', id } });
  for (const id of pick(f.tags, 'out')) parts.push({ op: 'not', arg: { op: 'tag', id } });
  const ast = parts.length === 0 ? { op: 'all' } : parts.length === 1 ? parts[0] : { op: 'and', args: parts };
  return { ast, q: f.q.trim() };
}

export function isEmpty(f) {
  return f.smart == null && !f.q.trim() && !Object.keys(f.tags).length && !Object.keys(f.albums).length;
}

export const includedCount = (states) => pick(states, 'in').length;

/** The single album being viewed (enables "album order" sort), or null. */
export function soleAlbum(f) {
  const ins = pick(f.albums, 'in');
  if (ins.length !== 1 || pick(f.albums, 'out').length || Object.keys(f.tags).length || f.smart != null || f.q.trim()) return null;
  return ins[0];
}

/** Three-state cycle: click toggles in/off, alt-click toggles out/off. */
export function cycle(current, exclude) {
  if (exclude) return current === 'out' ? undefined : 'out';
  return current ? undefined : 'in';
}

export function encodeHash(f) {
  if (isEmpty(f)) return '';
  return `#f=${encodeURIComponent(JSON.stringify(f))}`;
}

export function decodeHash(hash) {
  const m = /^#f=(.+)$/.exec(hash || '');
  if (!m) return emptyFilter();
  try {
    const raw = JSON.parse(decodeURIComponent(m[1]));
    const f = { ...emptyFilter(), ...raw };
    const clean = (o) => Object.fromEntries(Object.entries(o || {})
      .filter(([k, v]) => /^\d+$/.test(k) && (v === 'in' || v === 'out')));
    f.tags = clean(f.tags);
    f.albums = clean(f.albums);
    if (!['all', 'any'].includes(f.tagMode)) f.tagMode = 'all';
    if (!['all', 'any'].includes(f.albumMode)) f.albumMode = 'any';
    if (!(f.smart === null || f.smart === 'unfiled' || Number.isInteger(f.smart))) f.smart = null;
    if (typeof f.q !== 'string') f.q = '';
    return f;
  } catch {
    return emptyFilter();
  }
}

/** Lookup maps and full display paths for the sidebar catalogue. */
export function indexCatalog(cat) {
  const tagById = new Map(cat.tags.map((t) => [t.id, t]));
  const tagPath = (id) => {
    const parts = [];
    for (let t = tagById.get(id); t; t = tagById.get(t.parent_id)) parts.unshift(t.name);
    return parts.join('/');
  };
  return {
    tagById,
    albumById: new Map(cat.albums.map((a) => [a.id, a])),
    folderById: new Map(cat.folders.map((f) => [f.id, f])),
    smartById: new Map(cat.smart.map((s) => [s.id, s])),
    tagPath,
  };
}

/** Children-by-parent map for tree rendering (key 0 = top level). */
export function childrenOf(items, parentKey) {
  const map = new Map();
  for (const it of items) {
    const k = it[parentKey] ?? 0;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

/** dataTransfer type carrying a JSON array of asset ids dragged from the grid. */
export const DRAG_TYPE = 'application/x-plv2-assets';
