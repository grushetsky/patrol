import { readFile, writeFile } from "node:fs/promises";

// The JSON Schema emitter writes its bundle without a trailing newline, and the
// repository's commit hooks add one. Normalising here keeps a compile from
// leaving the working tree dirty.
const bundlePath = new URL("../generated/json-schema/patrol", import.meta.url);
const bundle = await readFile(bundlePath, "utf8");
if (!bundle.endsWith("\n")) {
  await writeFile(bundlePath, `${bundle}\n`);
}
