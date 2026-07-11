import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3030);

const DIRS = {
  input: path.join(ROOT, "Input"),
  public: path.join(ROOT, "public"),
  staging: path.join(ROOT, "staging"),
  archive: path.join(ROOT, "archive"),
  logs: path.join(ROOT, "logs"),
  state: path.join(ROOT, "state")
};

const supportedExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
const actionConfig = {
  "extract-text": {
    stat: "extractText",
    outputDir: (...parts) => path.join(DIRS.staging, "extract-text", ...parts)
  },
  keep: {
    stat: "keep",
    outputDir: (...parts) => path.join(DIRS.staging, "keep", ...parts)
  },
  "review-later": {
    stat: "reviewLater",
    outputDir: (...parts) => path.join(DIRS.staging, "review-later", ...parts)
  },
  "trash-candidate": {
    stat: "trashCandidate",
    outputDir: (...parts) => path.join(DIRS.staging, "trash-candidate", ...parts)
  }
};

const statePath = path.join(DIRS.state, "current-session.json");

async function ensureBaseDirs() {
  await Promise.all([
    fs.mkdir(DIRS.input, { recursive: true }),
    fs.mkdir(DIRS.staging, { recursive: true }),
    fs.mkdir(DIRS.archive, { recursive: true }),
    fs.mkdir(DIRS.logs, { recursive: true }),
    fs.mkdir(DIRS.state, { recursive: true })
  ]);
}

function todayBatch() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(new Date());
}

function nowIso() {
  return new Date().toISOString();
}

function createEmptyStats() {
  return {
    extractText: 0,
    keep: 0,
    reviewLater: 0,
    trashCandidate: 0,
    processed: 0
  };
}

function defaultState(files) {
  const timestamp = nowIso();
  return {
    batch: todayBatch(),
    currentFile: files[0]?.name || null,
    fileOrder: files.map((file) => file.name),
    undoStack: [],
    stats: createEmptyStats(),
    groupCounter: 0,
    activeGroup: null,
    startedAt: timestamp,
    lastUpdated: timestamp,
    paused: false
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function safeName(name) {
  const base = path.basename(String(name || ""));
  if (!base || base === "." || base === "..") return null;
  return base;
}

function safeStem(name) {
  return path
    .parse(name)
    .name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "image";
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function rel(filePath) {
  return toPosix(path.relative(ROOT, filePath));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uniquePath(dir, fileName) {
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

async function listInputImages() {
  const entries = await fs.readdir(DIRS.input, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!supportedExtensions.has(ext)) continue;
    const fullPath = path.join(DIRS.input, entry.name);
    const stat = await fs.stat(fullPath);
    files.push({
      name: entry.name,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      url: `/api/image?name=${encodeURIComponent(entry.name)}`
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return files;
}

function normalizeStats(stats) {
  return { ...createEmptyStats(), ...(stats || {}) };
}

function normalizeState(raw, files) {
  const fileNames = files.map((file) => file.name);
  if (!raw || typeof raw !== "object") return defaultState(files);

  const order = Array.isArray(raw.fileOrder) ? raw.fileOrder.filter((name) => fileNames.includes(name)) : [];
  for (const name of fileNames) {
    if (!order.includes(name)) order.push(name);
  }

  let currentFile = raw.currentFile && fileNames.includes(raw.currentFile) ? raw.currentFile : null;
  if (!currentFile) currentFile = order.find((name) => fileNames.includes(name)) || fileNames[0] || null;

  return {
    batch: raw.batch || todayBatch(),
    currentFile,
    fileOrder: order,
    undoStack: Array.isArray(raw.undoStack) ? raw.undoStack.slice(-3) : [],
    stats: normalizeStats(raw.stats),
    groupCounter: Number(raw.groupCounter || 0),
    activeGroup: normalizeActiveGroup(raw.activeGroup),
    startedAt: raw.startedAt || nowIso(),
    lastUpdated: raw.lastUpdated || nowIso(),
    paused: Boolean(raw.paused)
  };
}

function normalizeActiveGroup(group) {
  if (!group || typeof group !== "object" || !group.id) return null;
  return {
    id: String(group.id),
    startedAt: group.startedAt || nowIso(),
    items: Array.isArray(group.items) ? group.items : []
  };
}

async function loadState(files) {
  const raw = await readJson(statePath);
  const state = normalizeState(raw, files);
  await saveState(state);
  return state;
}

async function saveState(state) {
  state.undoStack = (state.undoStack || []).slice(-3);
  state.stats = normalizeStats(state.stats);
  state.lastUpdated = nowIso();
  await writeJson(statePath, state);
}

function remainingFilesFromState(state, files) {
  const byName = new Map(files.map((file) => [file.name, file]));
  const orderedNames = [];
  for (const name of state.fileOrder || []) {
    if (byName.has(name) && !orderedNames.includes(name)) orderedNames.push(name);
  }
  for (const file of files) {
    if (!orderedNames.includes(file.name)) orderedNames.push(file.name);
  }
  return orderedNames.map((name) => byName.get(name)).filter(Boolean);
}

function currentIndex(state, orderedFiles) {
  const index = orderedFiles.findIndex((file) => file.name === state.currentFile);
  return index >= 0 ? index : 0;
}

function nextCurrentFileFromOrder(previousOrder, files, previousName) {
  const tempState = { fileOrder: previousOrder };
  const ordered = remainingFilesFromState(tempState, files);
  if (ordered.length === 0) return null;
  const previousIndex = previousOrder.indexOf(previousName);
  if (previousIndex >= 0) {
    for (let i = previousIndex; i < previousOrder.length; i += 1) {
      if (ordered.some((file) => file.name === previousOrder[i])) return previousOrder[i];
    }
  }
  return ordered[0].name;
}

function updatedFileOrder(previousOrder, files) {
  const nextOrder = previousOrder.filter((name) => files.some((file) => file.name === name));
  for (const file of files) {
    if (!nextOrder.includes(file.name)) nextOrder.push(file.name);
  }
  return nextOrder;
}

async function appendLog(batch, record) {
  await fs.mkdir(DIRS.logs, { recursive: true });
  const logPath = path.join(DIRS.logs, `${batch}.jsonl`);
  await fs.appendFile(logPath, `${JSON.stringify({ timestamp: nowIso(), batch, ...record })}\n`, "utf8");
}

function summary(state, files) {
  const remaining = remainingFilesFromState(state, files);
  return {
    batch: state.batch,
    currentFile: state.currentFile,
    currentIndex: state.currentFile ? currentIndex(state, remaining) : -1,
    remaining: remaining.length,
    stats: normalizeStats(state.stats),
    startedAt: state.startedAt,
    lastUpdated: state.lastUpdated,
    paused: state.paused,
    undoAvailable: (state.undoStack || []).length,
    activeGroup: state.activeGroup
      ? {
          id: state.activeGroup.id,
          count: state.activeGroup.items.length,
          startedAt: state.activeGroup.startedAt
        }
      : null,
    complete: remaining.length === 0
  };
}

async function sessionPayload() {
  await ensureBaseDirs();
  const files = await listInputImages();
  const state = await loadState(files);
  const orderedFiles = remainingFilesFromState(state, files);
  return {
    session: summary(state, files),
    files: orderedFiles
  };
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp"
  }[ext] || "application/octet-stream";
}

async function sendJson(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function parseJsonBody(request) {
  const raw = await readBody(request);
  if (!raw) return {};
  return JSON.parse(raw);
}

function assertCrop(crop) {
  if (!crop) return { mode: "full", x: 0, y: 0, width: 0, height: 0 };
  return {
    mode: String(crop.mode || "free"),
    x: Number(crop.x || 0),
    y: Number(crop.y || 0),
    width: Number(crop.width || 0),
    height: Number(crop.height || 0)
  };
}

async function handleClassify(body) {
  const action = String(body.action || "");
  if (!actionConfig[action]) return { status: 400, data: { error: "Unsupported action." } };

  const sourceName = safeName(body.sourceName);
  if (!sourceName) return { status: 400, data: { error: "Invalid source file." } };

  const sourcePath = path.join(DIRS.input, sourceName);
  if (!(await pathExists(sourcePath))) return { status: 404, data: { error: "Source file is not in Input/." } };

  const filesBefore = await listInputImages();
  const state = await loadState(filesBefore);
  const batch = state.batch || todayBatch();
  const config = actionConfig[action];
  const undoRecord = { action, sourceName };

  if (action === "extract-text" || action === "keep") {
    const imageBase64 = String(body.imageBase64 || "");
    const match = imageBase64.match(/^data:image\/png;base64,(.+)$/);
    if (!match) return { status: 400, data: { error: "Missing cropped PNG data." } };

    const outputDir =
      action === "extract-text"
        ? config.outputDir(batch, state.activeGroup ? state.activeGroup.id : "single")
        : config.outputDir(batch);
    const archiveDir = path.join(DIRS.archive, "originals", batch);
    const outputName = `${String(state.stats.processed + 1).padStart(4, "0")}__${safeStem(sourceName)}.png`;
    const outputPath = await uniquePath(outputDir, outputName);
    const archivePath = await uniquePath(archiveDir, sourceName);

    await fs.writeFile(outputPath, Buffer.from(match[1], "base64"));
    await fs.rename(sourcePath, archivePath);

    Object.assign(undoRecord, {
      outputPath: rel(outputPath),
      archivedOriginal: rel(archivePath),
      crop: assertCrop(body.crop)
    });

    if (action === "extract-text" && state.activeGroup) {
      Object.assign(undoRecord, {
        groupId: state.activeGroup.id,
        groupIndex: state.activeGroup.items.length + 1
      });
    }

    await appendLog(batch, {
      action,
      ...(undoRecord.groupId ? { group_id: undoRecord.groupId, group_index: undoRecord.groupIndex } : {}),
      source: rel(sourcePath),
      archived_original: rel(archivePath),
      output: rel(outputPath),
      crop: undoRecord.crop
    });
  } else {
    const outputDir = config.outputDir(batch);
    const outputPath = await uniquePath(outputDir, sourceName);
    await fs.rename(sourcePath, outputPath);

    Object.assign(undoRecord, {
      outputPath: rel(outputPath)
    });

    await appendLog(batch, {
      action,
      source: rel(sourcePath),
      output: rel(outputPath)
    });
  }

  state.stats[config.stat] += 1;
  state.stats.processed += 1;
  state.undoStack = [...(state.undoStack || []), undoRecord].slice(-3);
  if (undoRecord.groupId && state.activeGroup?.id === undoRecord.groupId) {
    state.activeGroup.items.push(undoRecord);
  }
  state.paused = false;

  const filesAfter = await listInputImages();
  const previousOrder = state.fileOrder || [];
  state.currentFile = nextCurrentFileFromOrder(previousOrder, filesAfter, sourceName);
  state.fileOrder = updatedFileOrder(previousOrder, filesAfter);
  await saveState(state);

  return { status: 200, data: await sessionPayload() };
}

async function restoreToInput(fromRelativePath, preferredName) {
  const fromPath = path.join(ROOT, fromRelativePath);
  if (!(await pathExists(fromPath))) {
    throw new Error(`Cannot restore missing file: ${fromRelativePath}`);
  }
  const targetPath = await uniquePath(DIRS.input, safeName(preferredName) || path.basename(fromRelativePath));
  await fs.rename(fromPath, targetPath);
  return targetPath;
}

async function restoreRecord(record) {
  let restoredPath;
  if (record.action === "extract-text" || record.action === "keep") {
    if (record.outputPath) {
      const outputPath = path.join(ROOT, record.outputPath);
      if (await pathExists(outputPath)) await fs.unlink(outputPath);
    }
    restoredPath = await restoreToInput(record.archivedOriginal, record.sourceName);
  } else {
    restoredPath = await restoreToInput(record.outputPath, record.sourceName);
  }
  return restoredPath;
}

async function handleUndo() {
  const filesBefore = await listInputImages();
  const state = await loadState(filesBefore);
  const record = state.undoStack.pop();
  if (!record) return { status: 400, data: { error: "No undo action available." } };

  const config = actionConfig[record.action];
  if (!config) return { status: 400, data: { error: "Invalid undo record." } };

  const restoredPath = await restoreRecord(record);

  state.stats[config.stat] = Math.max(0, state.stats[config.stat] - 1);
  state.stats.processed = Math.max(0, state.stats.processed - 1);
  if (record.groupId && state.activeGroup?.id === record.groupId) {
    state.activeGroup.items = state.activeGroup.items.filter((item) => item.outputPath !== record.outputPath);
  }
  state.currentFile = path.basename(restoredPath);
  state.fileOrder = [state.currentFile, ...(state.fileOrder || []).filter((name) => name !== state.currentFile)];
  state.paused = false;

  await appendLog(state.batch, {
    action: "undo",
    undo_of: record.action,
    restored: rel(restoredPath)
  });
  await saveState(state);

  return { status: 200, data: await sessionPayload() };
}

async function handlePause() {
  const files = await listInputImages();
  const state = await loadState(files);
  state.paused = true;
  await appendLog(state.batch, { action: "pause", current_file: state.currentFile });
  await saveState(state);
  return { status: 200, data: await sessionPayload() };
}

async function handleStartGroup() {
  const files = await listInputImages();
  const state = await loadState(files);
  if (state.activeGroup) {
    return { status: 400, data: { error: `Group ${state.activeGroup.id} is already active.` } };
  }

  state.groupCounter = Number(state.groupCounter || 0) + 1;
  state.activeGroup = {
    id: `group-${String(state.groupCounter).padStart(3, "0")}`,
    startedAt: nowIso(),
    items: []
  };
  state.paused = false;

  await appendLog(state.batch, {
    action: "start-group",
    group_id: state.activeGroup.id,
    current_file: state.currentFile
  });
  await saveState(state);
  return { status: 200, data: await sessionPayload() };
}

async function handleEndGroup() {
  const files = await listInputImages();
  const state = await loadState(files);
  if (!state.activeGroup) return { status: 400, data: { error: "No active group." } };

  const group = state.activeGroup;
  state.activeGroup = null;
  state.paused = false;

  await appendLog(state.batch, {
    action: "end-group",
    group_id: group.id,
    item_count: group.items.length
  });
  await saveState(state);
  return { status: 200, data: await sessionPayload() };
}

async function handleCancelGroup() {
  const files = await listInputImages();
  const state = await loadState(files);
  if (!state.activeGroup) return { status: 400, data: { error: "No active group." } };

  const group = state.activeGroup;
  const restoredNames = [];
  for (const record of [...group.items].reverse()) {
    const restoredPath = await restoreRecord(record);
    restoredNames.unshift(path.basename(restoredPath));
    state.stats.extractText = Math.max(0, state.stats.extractText - 1);
    state.stats.processed = Math.max(0, state.stats.processed - 1);
  }

  state.undoStack = (state.undoStack || []).filter((record) => record.groupId !== group.id);
  state.activeGroup = null;
  state.currentFile = restoredNames[0] || state.currentFile;
  state.fileOrder = [
    ...restoredNames,
    ...(state.fileOrder || []).filter((name) => !restoredNames.includes(name))
  ];
  state.paused = false;

  await appendLog(state.batch, {
    action: "cancel-group",
    group_id: group.id,
    restored: restoredNames,
    item_count: group.items.length
  });
  await saveState(state);
  return { status: 200, data: await sessionPayload() };
}

async function serveStatic(response, urlPath) {
  const fileName = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const requestedPath = path.normalize(path.join(DIRS.public, fileName));
  if (!requestedPath.startsWith(DIRS.public)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(requestedPath);
    response.writeHead(200, {
      "content-type": contentType(requestedPath),
      "cache-control": "no-store"
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

async function route(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/session") {
      await sendJson(response, 200, await sessionPayload());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/image") {
      const name = safeName(url.searchParams.get("name"));
      if (!name) {
        await sendJson(response, 400, { error: "Invalid image name." });
        return;
      }
      const imagePath = path.join(DIRS.input, name);
      if (!(await pathExists(imagePath)) || !supportedExtensions.has(path.extname(name).toLowerCase())) {
        await sendJson(response, 404, { error: "Image not found." });
        return;
      }
      const data = await fs.readFile(imagePath);
      response.writeHead(200, {
        "content-type": contentType(imagePath),
        "cache-control": "no-store"
      });
      response.end(data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/classify") {
      const result = await handleClassify(await parseJsonBody(request));
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/undo") {
      const result = await handleUndo();
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pause") {
      const result = await handlePause();
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/group/start") {
      const result = await handleStartGroup();
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/group/end") {
      const result = await handleEndGroup();
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/group/cancel") {
      const result = await handleCancelGroup();
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "GET") {
      await serveStatic(response, url.pathname);
      return;
    }

    await sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    await sendJson(response, 500, { error: error.message || "Internal server error." });
  }
}

await ensureBaseDirs();

createServer(route).listen(PORT, () => {
  console.log(`Screenshot triage tool is running at http://localhost:${PORT}`);
  console.log(`Input folder: ${DIRS.input}`);
});
