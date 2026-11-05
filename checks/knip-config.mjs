// Writes the knip config the gate runs with. From the project's own config it
// keeps only what knip cannot find for itself, the entry points and project
// files of each workspace, and none of its ignores or rules. Generated files,
// given as arguments, are ignored, as in every other check.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [out, ...generated] = process.argv.slice(2);

function projectConfig() {
  for (const file of ["knip.json", ".knip.json"]) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  }
  if (existsSync("package.json")) {
    return JSON.parse(readFileSync("package.json", "utf8")).knip ?? {};
  }
  return {};
}

function entries({ entry, project }) {
  return { ...(entry && { entry }), ...(project && { project }) };
}

const project = projectConfig();
const config = { ...entries(project), ignore: generated };
if (project.workspaces) {
  config.workspaces = Object.fromEntries(
    Object.entries(project.workspaces).map(([name, workspace]) => [
      name,
      entries(workspace),
    ]),
  );
}

writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
