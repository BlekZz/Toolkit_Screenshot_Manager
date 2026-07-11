import { spawn } from "node:child_process";
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
const UNDO_DEPTH = 10;

function sanitizeBatchName(rawName) {
  return String(rawName || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 80);
}

function parseBatchOverride(argv) {
  const index = argv.indexOf("--batch");
  if (index < 0) return null;
  const raw = argv[index + 1];
  if (!raw || raw.startsWith("--")) {
    console.error("Missing value for --batch. Usage: node server.mjs --batch <name>");
    process.exit(1);
  }
  const sanitized = sanitizeBatchName(raw);
  if (!sanitized) {
    console.error(`Invalid batch name: ${raw}`);
    process.exit(1);
  }
  return sanitized;
}

const batchOverride = parseBatchOverride(process.argv.slice(2));

function currentBatch() {
  return batchOverride || todayBatch();
}

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
    batch: currentBatch(),
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
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

let mutationQueue = Promise.resolve();

function enqueueMutation(task) {
  const run = mutationQueue.then(task);
  mutationQueue = run.catch(() => {});
  return run;
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

function inputFileEntry(name) {
  return {
    name,
    url: `/api/image?name=${encodeURIComponent(name)}`
  };
}

async function listInputImages() {
  const entries = await fs.readdir(DIRS.input, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!supportedExtensions.has(ext)) continue;
    files.push(inputFileEntry(entry.name));
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

  const fileNameSet = new Set(fileNames);
  const order = Array.isArray(raw.fileOrder) ? raw.fileOrder.filter((name) => fileNameSet.has(name)) : [];
  const orderSet = new Set(order);
  for (const name of fileNames) {
    if (!orderSet.has(name)) order.push(name);
  }

  let currentFile = raw.currentFile && fileNameSet.has(raw.currentFile) ? raw.currentFile : null;
  if (!currentFile) currentFile = order[0] || null;

  return {
    batch: batchOverride || raw.batch || todayBatch(),
    currentFile,
    fileOrder: order,
    undoStack: Array.isArray(raw.undoStack) ? raw.undoStack.slice(-UNDO_DEPTH) : [],
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
  if (!batchOverride && raw && typeof raw === "object" && raw.batch && raw.batch !== todayBatch() && files.length === 0) {
    await writeJson(path.join(DIRS.logs, `state-archived-${raw.batch}.json`), raw);
    const state = defaultState(files);
    await saveState(state);
    return state;
  }
  return normalizeState(raw, files);
}

async function saveState(state) {
  state.undoStack = (state.undoStack || []).slice(-UNDO_DEPTH);
  state.stats = normalizeStats(state.stats);
  state.lastUpdated = nowIso();
  await writeJson(statePath, state);
}

function remainingFilesFromState(state, files) {
  const byName = new Map(files.map((file) => [file.name, file]));
  const seen = new Set();
  const orderedNames = [];
  for (const name of state.fileOrder || []) {
    if (byName.has(name) && !seen.has(name)) {
      seen.add(name);
      orderedNames.push(name);
    }
  }
  for (const file of files) {
    if (!seen.has(file.name)) {
      seen.add(file.name);
      orderedNames.push(file.name);
    }
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
  const orderedNames = new Set(ordered.map((file) => file.name));
  const previousIndex = previousOrder.indexOf(previousName);
  if (previousIndex >= 0) {
    for (let i = previousIndex; i < previousOrder.length; i += 1) {
      if (orderedNames.has(previousOrder[i])) return previousOrder[i];
    }
  }
  return ordered[0].name;
}

function updatedFileOrder(previousOrder, files) {
  const fileNameSet = new Set(files.map((file) => file.name));
  const nextOrder = previousOrder.filter((name) => fileNameSet.has(name));
  const nextOrderSet = new Set(nextOrder);
  for (const file of files) {
    if (!nextOrderSet.has(file.name)) nextOrder.push(file.name);
  }
  return nextOrder;
}

async function appendLog(batch, record) {
  await fs.mkdir(DIRS.logs, { recursive: true });
  const logPath = path.join(DIRS.logs, `${batch}.jsonl`);
  await fs.appendFile(logPath, `${JSON.stringify({ timestamp: nowIso(), batch, ...record })}\n`, "utf8");
}

function summary(state, remaining) {
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

async function currentFileBytes(currentFileName) {
  if (!currentFileName) return null;
  try {
    return (await fs.stat(path.join(DIRS.input, currentFileName))).size;
  } catch {
    return null;
  }
}

async function sessionPayload(state, files) {
  const orderedFiles = remainingFilesFromState(state, files);
  return {
    session: {
      ...summary(state, orderedFiles),
      currentFileBytes: await currentFileBytes(state.currentFile)
    },
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

const MAX_BODY_BYTES = 50 * 1024 * 1024;

async function readBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("Request body exceeds 50MB limit.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
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

  const files = await listInputImages();
  const state = await loadState(files);
  const batch = state.batch || currentBatch();
  const config = actionConfig[action];
  const undoRecord = { action, sourceName };

  if (action === "extract-text" || action === "keep") {
    const crop = assertCrop(body.crop);
    const outputDir =
      action === "extract-text"
        ? config.outputDir(batch, state.activeGroup ? state.activeGroup.id : "single")
        : config.outputDir(batch);
    const archiveDir = path.join(DIRS.archive, "originals", batch);
    const outputStem = `${String(state.stats.processed + 1).padStart(4, "0")}__${safeStem(sourceName)}`;

    let outputPath;
    if (crop.mode === "full") {
      outputPath = await uniquePath(outputDir, `${outputStem}${path.extname(sourceName).toLowerCase()}`);
      await fs.copyFile(sourcePath, outputPath);
    } else {
      const imageBase64 = String(body.imageBase64 || "");
      const match = imageBase64.match(/^data:image\/(png|jpeg);base64,(.+)$/);
      if (!match) return { status: 400, data: { error: "Missing cropped image data." } };
      outputPath = await uniquePath(outputDir, `${outputStem}${match[1] === "jpeg" ? ".jpg" : ".png"}`);
      await fs.writeFile(outputPath, Buffer.from(match[2], "base64"));
    }

    const archivePath = await uniquePath(archiveDir, sourceName);
    await fs.rename(sourcePath, archivePath);

    Object.assign(undoRecord, {
      outputPath: rel(outputPath),
      archivedOriginal: rel(archivePath),
      crop
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
  state.undoStack = [...(state.undoStack || []), undoRecord].slice(-UNDO_DEPTH);
  if (undoRecord.groupId && state.activeGroup?.id === undoRecord.groupId) {
    state.activeGroup.items.push(undoRecord);
  }
  state.paused = false;

  const filesAfter = files.filter((file) => file.name !== sourceName);
  const previousOrder = state.fileOrder || [];
  state.currentFile = nextCurrentFileFromOrder(previousOrder, filesAfter, sourceName);
  state.fileOrder = updatedFileOrder(previousOrder, filesAfter);
  await saveState(state);

  return { status: 200, data: await sessionPayload(state, filesAfter) };
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
  const files = await listInputImages();
  const state = await loadState(files);
  const record = state.undoStack.pop();
  if (!record) return { status: 400, data: { error: "No undo action available." } };

  const config = actionConfig[record.action];
  if (!config) return { status: 400, data: { error: "Invalid undo record." } };

  let restoredPath;
  try {
    restoredPath = await restoreRecord(record);
  } catch (error) {
    await appendLog(state.batch, {
      action: "undo",
      undo_of: record.action,
      source: record.sourceName,
      error: error.message || String(error)
    });
    throw error;
  }
  const restoredName = path.basename(restoredPath);

  state.stats[config.stat] = Math.max(0, state.stats[config.stat] - 1);
  state.stats.processed = Math.max(0, state.stats.processed - 1);
  if (record.groupId && state.activeGroup?.id === record.groupId) {
    state.activeGroup.items = state.activeGroup.items.filter((item) => item.outputPath !== record.outputPath);
  }
  state.currentFile = restoredName;
  state.fileOrder = [restoredName, ...(state.fileOrder || []).filter((name) => name !== restoredName)];
  state.paused = false;

  await appendLog(state.batch, {
    action: "undo",
    undo_of: record.action,
    restored: rel(restoredPath)
  });
  await saveState(state);

  const filesAfter = [inputFileEntry(restoredName), ...files.filter((file) => file.name !== restoredName)];
  return { status: 200, data: await sessionPayload(state, filesAfter) };
}

async function handlePause() {
  const files = await listInputImages();
  const state = await loadState(files);
  state.paused = true;
  await appendLog(state.batch, { action: "pause", current_file: state.currentFile });
  await saveState(state);
  return { status: 200, data: await sessionPayload(state, files) };
}

async function handleResume() {
  const files = await listInputImages();
  const state = await loadState(files);
  state.paused = false;
  await appendLog(state.batch, { action: "resume", current_file: state.currentFile });
  await saveState(state);
  return { status: 200, data: await sessionPayload(state, files) };
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
  return { status: 200, data: await sessionPayload(state, files) };
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
  return { status: 200, data: await sessionPayload(state, files) };
}

async function handleCancelGroup() {
  const files = await listInputImages();
  const state = await loadState(files);
  if (!state.activeGroup) return { status: 400, data: { error: "No active group." } };

  const group = state.activeGroup;
  const itemCount = group.items.length;
  const restoredNames = [];
  for (const record of [...group.items].reverse()) {
    const restoredPath = await restoreRecord(record);
    const restoredName = path.basename(restoredPath);
    restoredNames.unshift(restoredName);
    state.stats.extractText = Math.max(0, state.stats.extractText - 1);
    state.stats.processed = Math.max(0, state.stats.processed - 1);
    state.activeGroup.items = state.activeGroup.items.filter((item) => item.outputPath !== record.outputPath);
    state.undoStack = (state.undoStack || []).filter((item) => item.outputPath !== record.outputPath);
    state.currentFile = restoredName;
    state.fileOrder = [restoredName, ...(state.fileOrder || [])];
    await saveState(state);
  }

  state.activeGroup = null;
  state.paused = false;

  await appendLog(state.batch, {
    action: "cancel-group",
    group_id: group.id,
    restored: restoredNames,
    item_count: itemCount
  });
  await saveState(state);

  const filesAfter = [...restoredNames.map(inputFileEntry), ...files];
  return { status: 200, data: await sessionPayload(state, filesAfter) };
}

// Maintenance tasks reuse the standalone CLI scripts (already validated in M1/M2).
// purge-apply carries --yes because the human confirmation happens in the UI.
const maintenanceTasks = {
  status: ["status.mjs"],
  extract: ["extract.mjs"],
  "requeue-dry": ["requeue.mjs"],
  "requeue-apply": ["requeue.mjs", "--apply"],
  "purge-dry": ["purge.mjs"],
  "purge-apply": ["purge.mjs", "--apply", "--yes"]
};

let maintenanceBusy = null;

function runMaintenanceScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, args[0]), ...args.slice(1)], {
      cwd: ROOT,
      windowsHide: true
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => resolve({ exitCode: -1, output: `${output}\n${error.message}`.trim() }));
    child.on("close", (code) => resolve({ exitCode: code ?? -1, output: output.trim() }));
  });
}

async function handleMaintenance(task) {
  const { exitCode, output } = await runMaintenanceScript(maintenanceTasks[task]);
  await appendLog(currentBatch(), { action: "maintenance", task, exit_code: exitCode });
  return { status: 200, data: { task, exitCode, output } };
}

async function serveStatic(response, urlPath) {
  const fileName = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const requestedPath = path.normalize(path.join(DIRS.public, fileName));
  if (!requestedPath.startsWith(DIRS.public + path.sep)) {
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
      const files = await listInputImages();
      const state = await loadState(files);
      await sendJson(response, 200, await sessionPayload(state, files));
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
      const body = await parseJsonBody(request);
      const result = await enqueueMutation(() => handleClassify(body));
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/undo") {
      const result = await enqueueMutation(() => handleUndo());
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/pause") {
      const result = await enqueueMutation(() => handlePause());
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/resume") {
      const result = await enqueueMutation(() => handleResume());
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/group/start") {
      const result = await enqueueMutation(() => handleStartGroup());
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/group/end") {
      const result = await enqueueMutation(() => handleEndGroup());
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/group/cancel") {
      const result = await enqueueMutation(() => handleCancelGroup());
      await sendJson(response, result.status, result.data);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/maintenance/run") {
      const body = await parseJsonBody(request);
      const task = String(body.task || "");
      if (!maintenanceTasks[task]) {
        await sendJson(response, 400, { error: "Unsupported maintenance task." });
        return;
      }
      if (maintenanceBusy) {
        await sendJson(response, 409, { error: `Maintenance task already running: ${maintenanceBusy}` });
        return;
      }
      maintenanceBusy = task;
      try {
        const result = await enqueueMutation(() => handleMaintenance(task));
        await sendJson(response, result.status, result.data);
      } finally {
        maintenanceBusy = null;
      }
      return;
    }

    if (request.method === "GET") {
      await serveStatic(response, url.pathname);
      return;
    }

    await sendJson(response, 405, { error: "Method not allowed." });
  } catch (error) {
    console.error(error);
    await sendJson(response, error.statusCode || 500, { error: error.message || "Internal server error." });
  }
}

await ensureBaseDirs();

createServer(route).listen(PORT, "127.0.0.1", () => {
  console.log(`Screenshot triage tool is running at http://localhost:${PORT}`);
  console.log(`Input folder: ${DIRS.input}`);
  if (batchOverride) console.log(`Batch override: ${batchOverride}`);
});
