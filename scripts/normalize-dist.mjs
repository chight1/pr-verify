// ncc copies some vendored modules verbatim, CRLF included, and the result
// differs between Windows and Linux builds. Rewrite dist/ to LF so the
// committed bundle is byte-identical wherever it was built.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dist = path.resolve("dist");
for (const name of await readdir(dist)) {
  const file = path.join(dist, name);
  const before = await readFile(file, "utf8");
  const after = before.replace(/\r\n/g, "\n");
  if (after !== before) await writeFile(file, after, "utf8");
}
