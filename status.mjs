import { promises as fs } from "node:fs";
import path from "node:path";

import { ROOT, isImage, listBatchDirs, pathExists } from "./lib.mjs";

const DIRS = {
  input: path.join(ROOT, "Input"),
  staging: path.join(ROOT, "staging"),
  pendingDelete: path.join(ROOT, "output", "pending-delete"),
  outputText: path.join(ROOT, "output", "text"),
  archiveOriginals: path.join(ROOT, "archive", "originals")
};

const STAGING_FOLDERS = ["extract-text", "low-yield", "keep", "review-later", "trash-candidate"];

async function listImagesRecursive(dir, base = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listImagesRecursive(path.join(dir, entry.name), rel)));
    } else if (entry.isFile() && isImage(entry.name)) {
      files.push(rel);
    }
  }
  return files;
}

async function countInput() {
  if (!(await pathExists(DIRS.input))) return 0;
  const entries = await fs.readdir(DIRS.input, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && isImage(entry.name)).length;
}

async function batchCounts(baseDir) {
  const rows = [];
  for (const batch of await listBatchDirs(baseDir)) {
    const images = await listImagesRecursive(path.join(baseDir, batch));
    rows.push({ batch, images });
  }
  return rows;
}

function line(indent, batch, count, note = "") {
  const suffix = note ? `  ${note}` : "";
  return `${" ".repeat(indent)}${batch.padEnd(14)}${String(count).padStart(6)} image(s)${suffix}`;
}

function sectionHeader(label, rows) {
  const oldest = rows.length ? `oldest batch: ${rows[0].batch}` : "(empty)";
  return `${label.padEnd(28)}${oldest}`;
}

async function main() {
  const out = [];
  out.push(`Screenshot Manager status — ${new Date().toISOString()}`);
  out.push("");

  out.push(`${"Input/".padEnd(28)}${String(await countInput()).padStart(6)} image(s) awaiting triage`);
  out.push("");

  for (const folder of STAGING_FOLDERS) {
    const baseDir = path.join(DIRS.staging, folder);
    const rows = await batchCounts(baseDir);
    out.push(sectionHeader(`staging/${folder}/`, rows));
    for (const row of rows) {
      const note =
        folder === "extract-text"
          ? "| awaiting OCR"
          : folder === "low-yield"
            ? "| OCR failed, awaiting fallback/manual"
            : "";
      out.push(line(2, row.batch, row.images.length, note));
    }
    out.push("");
  }

  const pendingRows = await batchCounts(DIRS.pendingDelete);
  out.push(sectionHeader("output/pending-delete/", pendingRows));
  for (const row of pendingRows) out.push(line(2, row.batch, row.images.length));
  out.push("");

  out.push("output/text/");
  const mdFiles = (await pathExists(DIRS.outputText))
    ? (await fs.readdir(DIRS.outputText)).filter((name) => name.toLowerCase().endsWith(".md")).sort()
    : [];
  if (mdFiles.length) {
    for (const name of mdFiles) out.push(`  ${name}`);
  } else {
    out.push("  (none)");
  }
  out.push("");

  const archiveRows = await batchCounts(DIRS.archiveOriginals);
  out.push(sectionHeader("archive/originals/", archiveRows));
  for (const row of archiveRows) out.push(line(2, row.batch, row.images.length));

  console.log(out.join("\n"));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
