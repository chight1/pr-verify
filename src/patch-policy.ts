/**
 * What an agent's patch may touch, decided from the diff alone before
 * anything touches disk: test patches only add tests, fixes are more than
 * tests, and workflows, dependencies and scanner settings are off limits.
 */

import path from "node:path";
import { parseDiff, totalChangedLines, type DiffFile } from "./diff.js";
import type { PatchKind } from "./types.js";

const TEST_DIR_SEGMENTS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "testing",
]);
const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /^test_.*\.py$/,
  /_test\.py$/,
  /Tests?\.cs$/,
  /Tests?\.java$/,
  /_spec\.rb$/,
  /\.test\.ps1$/,
];

/** Conservative notion of "a test location": a test directory anywhere in the path, or a test-named file. */
export function isTestPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((s) => TEST_DIR_SEGMENTS.has(s.toLowerCase())))
    return true;
  return TEST_FILE_PATTERNS.some((p) => p.test(base));
}

const DEPENDENCY_FILES = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^bun\.lockb?$/,
  /^requirements[^/]*\.txt$/,
  /^pyproject\.toml$/,
  /^setup\.(py|cfg)$/,
  /^poetry\.lock$/,
  /^Pipfile(\.lock)?$/,
  /^uv\.lock$/,
  /^go\.(mod|sum)$/,
  /^Cargo\.(toml|lock)$/,
  /^Gemfile(\.lock)?$/,
  /\.csproj$/,
  /^packages\.lock\.json$/,
  /^pom\.xml$/,
  /^build\.gradle(\.kts)?$/,
];

export function isDependencyFile(filePath: string): boolean {
  const base = path.posix.basename(filePath.replace(/\\/g, "/"));
  return DEPENDENCY_FILES.some((p) => p.test(base));
}

/** A patch that silences a scanner instead of fixing what it found is not a fix. */
const SCANNER_IGNORE_FILES = new Set([
  ".semgrepignore",
  ".trivyignore",
  ".trivyignore.yaml",
]);

function isScannerIgnoreFile(filePath: string): boolean {
  return SCANNER_IGNORE_FILES.has(
    path.posix.basename(filePath.replace(/\\/g, "/")),
  );
}

export interface PatchLimits {
  maxLines: number;
  maxFiles: number;
}

export interface PolicyResult {
  ok: boolean;
  violations: string[];
  files: DiffFile[];
}

function isOutsideRepository(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  );
}

/** An empty patch, or one over the file or line limit. */
function sizeViolations(files: DiffFile[], limits: PatchLimits): string[] {
  const violations: string[] = [];
  if (files.length === 0) violations.push("patch contains no file changes");
  if (files.length > limits.maxFiles) {
    violations.push(
      `patch touches ${String(files.length)} files; the limit is ${String(limits.maxFiles)}`,
    );
  }
  const changed = totalChangedLines(files);
  if (changed > limits.maxLines) {
    violations.push(
      `patch changes ${String(changed)} lines; the limit is ${String(limits.maxLines)}`,
    );
  }
  return violations;
}

/** The places no patch may touch, checked for both sides of a rename. */
function pathViolations(p: string): string[] {
  const violations: string[] = [];
  if (isOutsideRepository(p))
    violations.push(`${p}: path resolves outside the repository`);
  if (p === ".github" || p.startsWith(".github/"))
    violations.push(`${p}: workflow files are off limits`);
  if (isDependencyFile(p))
    violations.push(`${p}: dependency manifests and lockfiles are off limits`);
  if (isScannerIgnoreFile(p))
    violations.push(`${p}: scanner ignore files are off limits`);
  return violations;
}

/** A test patch only adds tests: new test files, or lines added to existing ones. */
function testPatchViolations(file: DiffFile): string[] {
  const violations: string[] = [];
  if (!isTestPath(file.path)) {
    violations.push(`${file.path}: a test patch may only touch test locations`);
  } else if (file.status !== "added" && file.removed > 0) {
    violations.push(
      `${file.path}: a test patch may only add to an existing test file, not remove lines`,
    );
  }
  if (file.status === "deleted" || file.status === "renamed") {
    violations.push(
      `${file.path}: a test patch may not delete or rename files`,
    );
  }
  return violations;
}

/** Every rule one file of the patch breaks. */
function fileViolations(file: DiffFile, kind: PatchKind): string[] {
  const paths = [file.path, file.oldPath].filter(
    (p): p is string => p !== null,
  );
  const violations = paths.flatMap(pathViolations);
  if (file.binary) violations.push(`${file.path}: binary files are off limits`);
  if (file.symlink) violations.push(`${file.path}: symlinks are off limits`);
  if (kind === "test") violations.push(...testPatchViolations(file));
  return violations;
}

/**
 * Checks a proposed patch against the policy before anything touches disk.
 * Every rule is listed in the README's guardrails section; keep them in step.
 */
export function checkPatchPolicy(
  diffText: string,
  kind: PatchKind,
  limits: PatchLimits,
): PolicyResult {
  const files = parseDiff(diffText);
  const violations = sizeViolations(files, limits);
  for (const file of files) violations.push(...fileViolations(file, kind));

  if (
    kind === "fix" &&
    files.length > 0 &&
    files.every((f) => isTestPath(f.path))
  ) {
    violations.push("a fix patch that touches only tests is not a fix");
  }

  return { ok: violations.length === 0, violations, files };
}
