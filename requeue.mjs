import { promises as fs } from "node:fs";
import path from "node:path";

import { ROOT, appendLog, isImage, listBatchDirs, uniquePath } from "./lib.mjs";

const reviewLaterDir = path.join(ROOT, "staging", "review-later");
const inputDir = path.join(ROOT, "Input");

function parseArgs(argv) {
  const args = { batch: null, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") {
      args.apply = true;
    } else if (argv[i] === "--batch") {
      args.batch = argv[i + 1] || null;
      i += 1;
    } else if (argv[i].startsWith("--batch=")) {
      args.batch = argv[i].slice("--batch=".length);
    } else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exitCode = 1;
      return null;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;

  let batches = await listBatchDirs(reviewLaterDir);
  if (args.batch) {
    if (!batches.includes(args.batch)) {
      console.error(`Batch not found: staging/review-later/${args.batch}`);
      process.exitCode = 1;
      return;
    }
    batches = [args.batch];
  }

  const plan = [];
  for (const batch of batches) {
    const batchDir = path.join(reviewLaterDir, batch);
    const entries = await fs.readdir(batchDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && isImage(entry.name))
      .map((entry) => entry.name)
      .sort();
    const leftovers = entries.length - files.length;
    if (files.length || leftovers) plan.push({ batch, batchDir, files, leftovers });
  }

  const total = plan.reduce((sum, item) => sum + item.files.length, 0);
  if (!total) {
    console.log("staging/review-later/ is empty. Nothing to requeue.");
    return;
  }

  for (const item of plan) {
    console.log(`staging/review-later/${item.batch}/  (${item.files.length} image(s))`);
    for (const name of item.files) console.log(`  ${name} -> Input/`);
    if (item.leftovers) console.log(`  (${item.leftovers} non-image entr(y/ies) will stay behind)`);
  }

  if (!args.apply) {
    console.log(`\nDry-run: ${total} image(s) would move back to Input/. Re-run with --apply to move them.`);
    return;
  }

  let moved = 0;
  for (const item of plan) {
    let movedInBatch = 0;
    for (const name of item.files) {
      const destPath = await uniquePath(inputDir, name);
      await fs.rename(path.join(item.batchDir, name), destPath);
      movedInBatch += 1;
      await appendLog(item.batch, {
        action: "requeue",
        source: `staging/review-later/${item.batch}/${name}`,
        moved_to: path.relative(ROOT, destPath).split(path.sep).join("/")
      });
    }
    let removedDir = false;
    try {
      await fs.rmdir(item.batchDir);
      removedDir = true;
    } catch {
      // Directory not empty (non-image leftovers) — leave it in place.
    }
    await appendLog(item.batch, { action: "requeue-batch", moved: movedInBatch, batch_dir_removed: removedDir });
    moved += movedInBatch;
  }
  console.log(`\nMoved ${moved} image(s) back to Input/. They will show up on next npm start.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
