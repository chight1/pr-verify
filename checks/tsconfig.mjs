// Writes the tsconfig the gate type-checks with: the project's own, for module
// settings and paths, with the gate's strict flags on top and only the given files.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const [out, ...files] = process.argv.slice(2);
const project = path.resolve("tsconfig.json");

const config = {
  ...(existsSync(project) && { extends: project }),
  compilerOptions: {
    // Each flag strict turns on, too, since a project's explicit false beats strict.
    strict: true,
    alwaysStrict: true,
    noImplicitAny: true,
    noImplicitThis: true,
    strictBindCallApply: true,
    strictBuiltinIteratorReturn: true,
    strictFunctionTypes: true,
    strictNullChecks: true,
    strictPropertyInitialization: true,
    useUnknownInCatchVariables: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    noImplicitReturns: true,
    noFallthroughCasesInSwitch: true,
    noEmit: true,
  },
  files: files.map((file) => path.resolve(file)),
  include: [],
};

writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
