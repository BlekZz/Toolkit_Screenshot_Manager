import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const LOGS_DIR = path.join(ROOT, "logs");

export const supportedExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);

export function nowIso() {
  return new Date().toISOString();
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function uniquePath(dir, fileName) {
  await fs.mkdir(dir, { recursive: true });
  const parsed = path.parse(fileName);
  let candidate = path.join(dir, fileName);
  let count = 2;
  while (await pathExists(candidate)) {
    candidate = path.join(dir, `${parsed.name}__${count}${parsed.ext}`);
    count += 1;
  }
  return candidate;
}

export async function appendLog(batch, record) {
  await fs.mkdir(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `${batch}.jsonl`);
  await fs.appendFile(logPath, `${JSON.stringify({ timestamp: nowIso(), batch, ...record })}\n`, "utf8");
}

export function isImage(name) {
  return supportedExtensions.has(path.extname(name).toLowerCase());
}

export async function listImages(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isImage(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function listBatchDirs(dir) {
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
