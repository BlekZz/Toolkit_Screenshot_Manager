import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import { ROOT, appendLog, listBatchDirs } from "./lib.mjs";

const DEFAULT_DAYS = 14;
const DEFAULT_ARCHIVE_DAYS = 90;
const TARGET_NAMES = ["trash", "archive", "pending-delete"];

function targetDefs(args) {
  return {
    trash: { label: "staging/trash-candidate", dir: path.join(ROOT, "staging", "trash-candidate"), days: args.days },
    "pending-delete": { label: "output/pending-delete", dir: path.join(ROOT, "output", "pending-delete"), days: args.days },
    archive: { label: "archive/originals", dir: path.join(ROOT, "archive", "originals"), days: args.archiveDays }
  };
}

function parseArgs(argv) {
  const args = { days: DEFAULT_DAYS, archiveDays: DEFAULT_ARCHIVE_DAYS, target: "all", apply: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--yes") {
      args.yes = true;
    } else if (arg === "--days" || arg === "--archive-days" || arg === "--target") {
      const value = argv[i + 1];
      i += 1;
      if (value === undefined) {
        console.error(`Missing value for ${arg}`);
        return null;
      }
      if (arg === "--target") args.target = value;
      else if (arg === "--days") args.days = Number(value);
      else args.archiveDays = Number(value);
    } else {
      console.error(`Unknown argument: ${arg}`);
      return null;
    }
  }
  if (!Number.isInteger(args.days) || args.days < 0 || !Number.isInteger(args.archiveDays) || args.archiveDays < 0) {
    console.error("--days / --archive-days must be non-negative integers.");
    return null;
  }
  if (args.target !== "all" && !TARGET_NAMES.includes(args.target)) {
    console.error(`Unknown --target: ${args.target} (expected trash|archive|pending-delete|all)`);
    return null;
  }
  return args;
}

function batchAgeDays(batch) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(batch);
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(time)) return null;
  return Math.floor((Date.now() - time) / 86_400_000);
}

async function listFilesRecursive(dir, base = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(path.join(dir, entry.name), rel)));
    } else if (entry.isFile()) {
      const stat = await fs.stat(path.join(dir, entry.name));
      files.push({ rel, size: stat.size });
    }
  }
  return files;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function collectPlan(targets) {
  const plan = [];
  for (const [name, target] of targets) {
    for (const batch of await listBatchDirs(target.dir)) {
      const ageDays = batchAgeDays(batch);
      if (ageDays === null) {
        console.warn(`WARNING: skipping ${target.label}/${batch} (folder name has no YYYY-MM-DD date)`);
        continue;
      }
      if (ageDays < target.days) continue;
      const batchDir = path.join(target.dir, batch);
      const files = await listFilesRecursive(batchDir);
      const bytes = files.reduce((sum, file) => sum + file.size, 0);
      plan.push({ targetName: name, label: target.label, days: target.days, batch, batchDir, ageDays, files, bytes });
    }
  }
  return plan;
}

async function confirm(totalFiles, totalBytes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Permanently delete ${totalFiles} file(s), ${humanSize(totalBytes)}? Type "yes" to confirm: `
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.exitCode = 1;
    return;
  }
  const defs = targetDefs(args);
  const targets = (args.target === "all" ? TARGET_NAMES : [args.target]).map((name) => [name, defs[name]]);

  const plan = await collectPlan(targets);
  if (!plan.length) {
    console.log("Nothing has passed its retention period. Nothing to purge.");
    return;
  }

  let totalFiles = 0;
  let totalBytes = 0;
  for (const [name, target] of targets) {
    const items = plan.filter((item) => item.targetName === name);
    console.log(`${target.label}/  (retention ${target.days} day(s))`);
    if (!items.length) {
      console.log("  (nothing expired)");
      continue;
    }
    for (const item of items) {
      console.log(`  ${item.batch}  age ${item.ageDays} day(s)  ${item.files.length} file(s)  ${humanSize(item.bytes)}`);
      for (const file of item.files) console.log(`    ${file.rel}  (${humanSize(file.size)})`);
      if (!item.files.length) console.log("    (empty folder)");
      totalFiles += item.files.length;
      totalBytes += item.bytes;
    }
  }
  console.log(`\nTotal: ${totalFiles} file(s), ${humanSize(totalBytes)} across ${plan.length} batch folder(s).`);

  if (!args.apply) {
    console.log("Dry-run: nothing was deleted. Re-run with --apply to delete (confirmation will be asked).");
    return;
  }

  if (!args.yes && !(await confirm(totalFiles, totalBytes))) {
    console.log("Aborted. Nothing was deleted.");
    return;
  }

  let deletedFiles = 0;
  for (const item of plan) {
    for (const file of item.files) {
      await fs.rm(path.join(item.batchDir, file.rel));
      deletedFiles += 1;
      await appendLog(item.batch, {
        action: "purge",
        target: item.label,
        file: `${item.label}/${item.batch}/${file.rel}`,
        size: file.size,
        age_days: item.ageDays
      });
    }
    await fs.rm(item.batchDir, { recursive: true, force: true });
    await appendLog(item.batch, {
      action: "purge-batch",
      target: item.label,
      files: item.files.length,
      bytes: item.bytes,
      age_days: item.ageDays,
      retention_days: item.days
    });
  }
  console.log(`Deleted ${deletedFiles} file(s) across ${plan.length} batch folder(s).`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
