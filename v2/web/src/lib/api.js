async function request(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

const send = (method, url, body) => request(url, {
  method,
  headers: body === undefined ? {} : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  query: (payload) => send('POST', '/api/query', payload),
  facets: (payload) => send('POST', '/api/facets', payload),
  asset: (id) => request(`/api/assets/${id}`),
  stats: () => request('/api/stats'),
  health: () => request('/api/health'),
  catalog: () => request('/api/catalog'),

  createTag: (body) => send('POST', '/api/tags', body),
  updateTag: (id, body) => send('PATCH', `/api/tags/${id}`, body),
  deleteTag: (id) => send('DELETE', `/api/tags/${id}`),
  applyTags: (body) => send('POST', '/api/tags/apply', body),

  createFolder: (body) => send('POST', '/api/folders', body),
  updateFolder: (id, body) => send('PATCH', `/api/folders/${id}`, body),
  deleteFolder: (id) => send('DELETE', `/api/folders/${id}`),

  createAlbum: (body) => send('POST', '/api/albums', body),
  updateAlbum: (id, body) => send('PATCH', `/api/albums/${id}`, body),
  deleteAlbum: (id) => send('DELETE', `/api/albums/${id}`),
  addToAlbum: (id, assetIds) => send('POST', `/api/albums/${id}/add`, { asset_ids: assetIds }),
  removeFromAlbum: (id, assetIds) => send('POST', `/api/albums/${id}/remove`, { asset_ids: assetIds }),

  createSmart: (body) => send('POST', '/api/smart', body),
  updateSmart: (id, body) => send('PATCH', `/api/smart/${id}`, body),
  deleteSmart: (id) => send('DELETE', `/api/smart/${id}`),

  startImport: (path, recursive) => send('POST', '/api/import', { path, recursive }),
  importStatus: () => request('/api/import'),

  // ---- P2: undo / trash / crops / bundles / triage slots / grouping / roots ----
  undoList: () => request('/api/undo'),
  /** No eventId = undo the newest undoable event (global stack). */
  undo: (eventId) => send('POST', '/api/undo', eventId == null ? {} : { event_id: eventId }),
  trash: (ids) => send('POST', '/api/assets/trash', { ids }),
  restore: (ids) => send('POST', '/api/assets/restore', { ids }),
  albumsOf: (ids) => send('POST', '/api/assets/albums', { ids }),
  crops: (assetId) => request(`/api/assets/${assetId}/crops`),
  createCrop: (assetId, rect) => send('POST', `/api/assets/${assetId}/crops`, rect),
  deleteCrop: (cropId) => send('DELETE', `/api/crops/${cropId}`),
  bundles: (status) => request(`/api/bundles${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  createBundle: (body = {}) => send('POST', '/api/bundles', body),
  bundle: (id) => request(`/api/bundles/${id}`),
  updateBundle: (id, body) => send('PATCH', `/api/bundles/${id}`, body),
  addBundleItem: (id, body) => send('POST', `/api/bundles/${id}/items`, body),
  removeBundleItem: (id, itemId) => send('DELETE', `/api/bundles/${id}/items/${itemId}`),
  slots: () => request('/api/settings/triage-slots'),
  putSlots: (slots) => send('PUT', '/api/settings/triage-slots', slots),
  roots: () => request('/api/roots'),
  addRoot: (path) => send('POST', '/api/roots', { path }),
  scanRoot: (id, dryRun = false) => send('POST', `/api/roots/${id}/scan`, { dry_run: dryRun }),
  scanStatus: () => request('/api/roots/scan'),
};

export const thumbUrl = (id, size = 256) => `/media/thumb/${id}?size=${size}`;
export const originalUrl = (id) => `/media/original/${id}`;
export const cropUrl = (cropId) => `/media/crop/${cropId}`;

/** localStorage wrapper that never throws (private mode / blocked storage). */
export const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`plv2.${key}`); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`plv2.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

export function formatBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
