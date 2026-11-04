import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Fails when the generated artifacts in the working tree are stale: it
 * snapshots the files the generators own, reruns every generator, and
 * compares. Unlike `git diff --exit-code` it checks the tree, not the
 * commit, so it is equally usable in CI (clean checkout) and on a branch
 * with uncommitted work. The contract's own artifacts are gated by the
 * contract job's git diff; this gates the derived clients and the shared
 * packages' declaration files.
 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ARTIFACTS = [
  "apps/api/src/lib/api/schema.d.ts",
  "apps/web/src/lib/api/schema.d.ts",
  "packages/db/src/index.d.ts",
  "packages/i18n/src/index.d.ts",
];

const REGEN = [
  ["pnpm", ["--filter", "@patrol/db", "--filter", "@patrol/i18n", "run", "build"]],
  ["pnpm", ["-C", "apps/api", "run", "gen:api"]],
  ["pnpm", ["-C", "apps/web", "run", "gen:api"]],
];

function snapshot() {
  const hash = createHash("sha256");
  for (const relative of ARTIFACTS) {
    hash.update(relative);
    hash.update(readFileSync(join(ROOT, relative)));
  }
  return hash.digest("hex");
}

const before = snapshot();
for (const [command, args] of REGEN) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}
const after = snapshot();

if (before !== after) {
  console.error(
    "generated artifacts are stale — the generators rewrote:\n  " +
      ARTIFACTS.join("\n  ") +
      "\nrerun them and include the result in the change",
  );
  process.exit(1);
}
console.log("generated artifacts are fresh");
