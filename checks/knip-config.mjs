// Writes the knip config the gate runs with. From the project's own config it
// keeps only what knip cannot find for itself: each workspace's entry points
// and project files. Its ignores and rules are dropped, and the generated
// files given as arguments are ignored, as in every other check.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [outputPath, ...generatedFiles] = process.argv.slice(2);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readProjectConfig() {
  if (existsSync("knip.json")) return readJson("knip.json");
  if (existsSync(".knip.json")) return readJson(".knip.json");
  if (existsSync("package.json")) return readJson("package.json").knip ?? {};
  return {};
}

// The entry points and project files of one workspace, or of the root.
function filesToAnalyze(workspace) {
  const kept = {};
  if (workspace.entry) kept.entry = workspace.entry;
  if (workspace.project) kept.project = workspace.project;
  return kept;
}

const projectConfig = readProjectConfig();
const gateConfig = { ...filesToAnalyze(projectConfig), ignore: generatedFiles };

if (projectConfig.workspaces) {
  gateConfig.workspaces = {};
  for (const [name, workspace] of Object.entries(projectConfig.workspaces)) {
    gateConfig.workspaces[name] = filesToAnalyze(workspace);
  }
}

writeFileSync(outputPath, `${JSON.stringify(gateConfig, null, 2)}\n`);
