async function request(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
  return body;
}

export const api = {
  listAssets: (sort, order) => request(`/api/assets?sort=${sort}&order=${order}`),
  asset: (id) => request(`/api/assets/${id}`),
  stats: () => request('/api/stats'),
  health: () => request('/api/health'),
  startImport: (path, recursive) => request('/api/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, recursive }),
  }),
  importStatus: () => request('/api/import'),
};

export const thumbUrl = (id, size = 256) => `/media/thumb/${id}?size=${size}`;
export const originalUrl = (id) => `/media/original/${id}`;

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
