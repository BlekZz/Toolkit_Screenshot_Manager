import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROOT, appendLog, isImage, listImages, nowIso, pathExists, readJson, uniquePath, writeJson } from "./lib.mjs";

const DIRS = {
  extractText: path.join(ROOT, "staging", "extract-text"),
  outputText: path.join(ROOT, "output", "text"),
  pendingDelete: path.join(ROOT, "output", "pending-delete"),
  state: path.join(ROOT, "state")
};

const ocrScriptPath = path.join(ROOT, "extract-ocr.ps1");
const statePath = path.join(DIRS.state, "extract-state.json");
const LOW_YIELD_CHARS = 5;

function parseArgs(argv) {
  const args = { batch: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--batch") {
      args.batch = argv[i + 1] || null;
      i += 1;
    } else if (argv[i].startsWith("--batch=")) {
      args.batch = argv[i].slice("--batch=".length);
    }
  }
  return args;
}

async function scanBatch(batch) {
  const batchDir = path.join(DIRS.extractText, batch);
  const entries = await fs.readdir(batchDir, { withFileTypes: true });
  const singles = [];
  const groups = [];
  for (const entry of entries) {
    if (entry.isFile() && isImage(entry.name)) {
      singles.push({ rel: entry.name, name: entry.name });
    } else if (entry.isDirectory() && entry.name === "single") {
      for (const name of await listImages(path.join(batchDir, "single"))) {
        singles.push({ rel: `single/${name}`, name });
      }
    } else if (entry.isDirectory() && /^group-\d+$/.test(entry.name)) {
      const files = (await listImages(path.join(batchDir, entry.name))).map((name) => ({
        rel: `${entry.name}/${name}`,
        name
      }));
      if (files.length) groups.push({ name: entry.name, files });
    }
  }
  singles.sort((a, b) => a.name.localeCompare(b.name));
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return { batch, batchDir, singles, groups };
}

function cleanText(raw) {
  return String(raw || "")
    .replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, "")
    .trim();
}

async function runOcr(absolutePaths) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "extract-ocr-"));
  const manifestPath = path.join(tmpDir, "manifest.txt");
  await fs.writeFile(manifestPath, `${absolutePaths.join("\r\n")}\r\n`, "utf8");
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ocrScriptPath, "-ManifestPath", manifestPath],
        { windowsHide: true }
      );
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`extract-ocr.ps1 exited ${code}: ${err.trim()}`));
      });
    });
    const parsed = JSON.parse(stdout);
    const results = new Map();
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      results.set(entry.path, entry);
    }
    return results;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function batchState(state, batch) {
  if (!state.batches[batch]) state.batches[batch] = { files: {} };
  return state.batches[batch];
}

async function moveToPendingDelete(batch, batchDir, rel) {
  const relDir = path.posix.dirname(rel);
  const destDir = relDir === "." ? path.join(DIRS.pendingDelete, batch) : path.join(DIRS.pendingDelete, batch, relDir);
  const destPath = await uniquePath(destDir, path.posix.basename(rel));
  await fs.rename(path.join(batchDir, rel), destPath);
  return path.relative(ROOT, destPath).split(path.sep).join("/");
}

async function processBatch(scan, ocrResults, state) {
  const { batch, batchDir } = scan;
  const mdRel = `output/text/${batch}.md`;
  const mdPath = path.join(DIRS.outputText, `${batch}.md`);
  const files = batchState(state, batch).files;
  const sections = [];
  const outcomes = [];
  const counts = { total: 0, extracted: 0, lowYield: 0, errors: 0 };

  function ocrOne(item) {
    counts.total += 1;
    const result = ocrResults.get(path.join(batchDir, item.rel));
    if (!result || result.error) {
      counts.errors += 1;
      return { item, status: "error", error: result?.error || "no OCR result" };
    }
    const text = cleanText(result.text);
    if (text.length < LOW_YIELD_CHARS) {
      counts.lowYield += 1;
      return { item, status: "low-yield", text };
    }
    counts.extracted += 1;
    return { item, status: "extracted", text };
  }

  for (const item of scan.singles) {
    const outcome = ocrOne(item);
    outcomes.push(outcome);
    if (outcome.status === "error") continue;
    const body = [];
    if (outcome.status === "low-yield") body.push("⚠️ low-yield");
    if (outcome.text) body.push(outcome.text);
    sections.push(`## ${item.name}\n\n${body.join("\n\n") || "(no text)"}\n`);
  }

  for (const group of scan.groups) {
    const groupOutcomes = group.files.map(ocrOne);
    outcomes.push(...groupOutcomes);
    const usable = groupOutcomes.filter((outcome) => outcome.status !== "error");
    if (!usable.length) continue;
    const sourceList = usable
      .map((outcome) => (outcome.status === "low-yield" ? `${outcome.item.name} ⚠️ low-yield` : outcome.item.name))
      .join("、");
    const texts = usable.map((outcome) => outcome.text).filter(Boolean);
    sections.push(`## ${group.name}\n\n來源：${sourceList}\n\n${texts.join("\n\n") || "(no text)"}\n`);
  }

  if (sections.length) {
    await fs.mkdir(DIRS.outputText, { recursive: true });
    const header = (await pathExists(mdPath)) ? "" : `# ${batch}\n`;
    await fs.appendFile(mdPath, `${header}\n${sections.join("\n")}`, "utf8");
  }

  for (const outcome of outcomes) {
    const sourceRel = `staging/extract-text/${batch}/${outcome.item.rel}`;
    if (outcome.status === "error") {
      await appendLog(batch, { action: "extract", source: sourceRel, error: outcome.error });
      continue;
    }
    if (outcome.status === "low-yield") {
      files[outcome.item.rel] = { status: "low-yield", chars: outcome.text.length, at: nowIso() };
      await appendLog(batch, { action: "extract", warning: "low-yield", source: sourceRel, output: mdRel, chars: outcome.text.length });
      continue;
    }
    const movedTo = await moveToPendingDelete(batch, batchDir, outcome.item.rel);
    files[outcome.item.rel] = { status: "extracted", chars: outcome.text.length, at: nowIso() };
    await appendLog(batch, { action: "extract", source: sourceRel, output: mdRel, chars: outcome.text.length, moved_to: movedTo });
  }

  await writeJson(statePath, state);
  await appendLog(batch, {
    action: "extract-batch",
    images: counts.total,
    extracted: counts.extracted,
    low_yield: counts.lowYield,
    errors: counts.errors,
    output: mdRel
  });
  console.log(
    `${batch}: ${counts.total} images | extracted ${counts.extracted} | low-yield ${counts.lowYield} | errors ${counts.errors} -> ${mdRel}`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!(await pathExists(DIRS.extractText))) {
    console.log("No staging/extract-text directory. Nothing to extract.");
    return;
  }
  const entries = await fs.readdir(DIRS.extractText, { withFileTypes: true });
  let batches = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (args.batch) {
    if (!batches.includes(args.batch)) {
      console.error(`Batch not found: staging/extract-text/${args.batch}`);
      process.exitCode = 1;
      return;
    }
    batches = [args.batch];
  }

  const state = (await readJson(statePath)) || { batches: {} };
  if (!state.batches) state.batches = {};

  const scans = [];
  for (const batch of batches) {
    const scan = await scanBatch(batch);
    const done = batchState(state, batch).files;
    const stale = [...scan.singles, ...scan.groups.flatMap((group) => group.files)].filter(
      (item) => done[item.rel] && done[item.rel].status !== "low-yield"
    );
    for (const item of stale) {
      const sourceRel = `staging/extract-text/${batch}/${item.rel}`;
      console.warn(`WARNING: already processed but still present, skipping: ${sourceRel}`);
      await appendLog(batch, { action: "extract", warning: "already-processed-but-present", source: sourceRel });
    }
    scan.singles = scan.singles.filter((item) => !done[item.rel]);
    scan.groups = scan.groups
      .map((group) => ({ ...group, files: group.files.filter((item) => !done[item.rel]) }))
      .filter((group) => group.files.length);
    if (scan.singles.length || scan.groups.length) scans.push(scan);
  }

  const pendingPaths = scans.flatMap((scan) =>
    [...scan.singles, ...scan.groups.flatMap((group) => group.files)].map((item) => path.join(scan.batchDir, item.rel))
  );
  if (!pendingPaths.length) {
    console.log("Nothing to extract. All batches are up to date.");
    return;
  }

  console.log(`OCR ${pendingPaths.length} image(s) across ${scans.length} batch(es)...`);
  const ocrResults = await runOcr(pendingPaths);
  for (const scan of scans) {
    await processBatch(scan, ocrResults, state);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
