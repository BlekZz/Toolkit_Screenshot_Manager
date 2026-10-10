import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startServer } from '../server/app.mjs';

/** Fresh temp dir; caller removes it via cleanup(). */
export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `plv2-${prefix}-`));
}

export function cleanup(...dirs) {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

/**
 * Writes `count` visually distinct images (distinct bytes ⇒ distinct sha256).
 *
 * @returns {Promise<string[]>} Absolute file paths.
 */
export async function makeImages(dir, count, { ext = 'png', width = 640, height = 400, offset = 0 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < count; i++) {
    const n = i + offset;
    const file = path.join(dir, `img_${String(n).padStart(4, '0')}.${ext}`);
    const img = sharp({ create: { width, height, channels: 3, background: { r: (n * 37) % 256, g: (n * 91) % 256, b: (n * 13) % 256 } } });
    await (ext === 'jpg' ? img.jpeg() : img.png()).toFile(file);
    files.push(file);
  }
  return files;
}

/** Starts the real server on an ephemeral port; returns {app, base}. */
export async function startTestServer(libraryDir) {
  const app = await startServer({ libraryDir, port: 0 });
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

export async function waitForImport(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await (await fetch(`${base}/api/import`)).json();
    if (job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('import did not finish in time');
}
