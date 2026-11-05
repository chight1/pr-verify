// Writes the knip config the gate runs with. From the project's own config it
// keeps only what knip cannot find for itself: each workspace's entry points.
// Its ignores, rules and project files are dropped, and the generated files
// given as arguments are ignored, as in every other check.
//
// An entry point must name a file. A pattern such as "**" could make every file
// an entry point, so that nothing is ever unused, so patterns are dropped and
// fail the check.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// process.argv starts with the paths of node and of this script.
const FIRST_ARGUMENT = 2;
const JSON_INDENT = 2;

const [outputPath, ...generatedFiles] = process.argv.slice(FIRST_ARGUMENT);
const patternCharacters = /[*?[\]{}()!]/;
const patterns = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readProjectConfig() {
  if (existsSync("knip.json")) return readJson("knip.json");
  if (existsSync(".knip.json")) return readJson(".knip.json");
  if (existsSync("package.json")) return readJson("package.json").knip ?? {};
  return {};
}

// knip takes one entry point as a string, or several as an array.
function entriesOf(workspace) {
  if (workspace.entry === undefined) return [];
  if (typeof workspace.entry === "string") return [workspace.entry];
  return workspace.entry;
}

// The entry points of one workspace, or of the root, that name a file.
function namedEntryPoints(workspace, workspaceName = ".") {
  const named = [];
  for (const entry of entriesOf(workspace)) {
    if (patternCharacters.test(entry)) {
      patterns.push(`"${entry}" in workspace "${workspaceName}"`);
    } else {
      named.push(entry);
    }
  }
  if (named.length === 0) return {};
  return { entry: named };
}

const projectConfig = readProjectConfig();
const gateConfig = {
  ...namedEntryPoints(projectConfig),
  ignore: generatedFiles,
};

if (projectConfig.workspaces) {
  gateConfig.workspaces = {};
  for (const [name, workspace] of Object.entries(projectConfig.workspaces)) {
    gateConfig.workspaces[name] = namedEntryPoints(workspace, name);
  }
}

writeFileSync(outputPath, `${JSON.stringify(gateConfig, null, JSON_INDENT)}\n`);

if (patterns.length > 0) {
  process.stderr.write(
    "These knip entry points are patterns. List each entry file by name:\n",
  );
  for (const pattern of patterns) {
    process.stderr.write(`  ${pattern}\n`);
  }
  process.exitCode = 1;
}
