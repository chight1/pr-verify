/**
 * The one build-file change a test patch may make: adding the test files it
 * adds to the build. In a C++ project a new test file is compiled only once
 * CMakeLists.txt names it, so a test patch could not otherwise add one.
 */

import path from "node:path";
import type { DiffFile } from "./diff.js";

/** The CMake commands that build a test and register it with CTest. */
const REGISTRATION_COMMANDS = new Set([
  "add_executable",
  "target_link_libraries",
  "target_include_directories",
  "add_test",
  "gtest_discover_tests",
  "catch_discover_tests",
  "doctest_discover_tests",
]);

const COMMAND_NAME = /^[A-Za-z_]\w*$/;

/** A CMake command such as `add_test(NAME order_test COMMAND order_test)`. */
interface CMakeCommand {
  name: string;
  commandArguments: string;
}

/** The commands in CMake text, and whether anything else is there too. */
interface ParsedCMake {
  commands: CMakeCommand[];
  onlyCommands: boolean;
}

/**
 * Reads CMake text as commands, each a name and its arguments up to the
 * closing parenthesis, over as many lines as it takes. Text that is not part
 * of a command, or a command whose arguments hold parentheses, makes
 * onlyCommands false.
 */
function parseCMake(text: string): ParsedCMake {
  const pieces = text.split(")");
  const trailing = pieces.pop() ?? "";
  const commands: CMakeCommand[] = [];
  let onlyCommands = trailing.trim() === "";
  for (const piece of pieces) {
    const open = piece.indexOf("(");
    const name = piece.slice(0, open).trim();
    const commandArguments = piece.slice(open + 1);
    if (
      open === -1 ||
      !COMMAND_NAME.test(name) ||
      commandArguments.includes("(")
    ) {
      onlyCommands = false;
    } else {
      commands.push({ name, commandArguments });
    }
  }
  return { commands, onlyCommands };
}

function baseName(filePath: string): string {
  return path.posix.basename(filePath.replace(/\\/g, "/"));
}

export function isCMakeLists(filePath: string): boolean {
  return baseName(filePath) === "CMakeLists.txt";
}

/** A line without its comment, which in CMake runs from # to the end of the line. */
function withoutComment(line: string): string {
  const commentStart = line.indexOf("#");
  return commentStart === -1 ? line : line.slice(0, commentStart);
}

/**
 * The names a registration may use for each test file: its file name, and its
 * name without the extension, the usual name of the test's target.
 */
function testNames(addedTests: DiffFile[]): Set<string> {
  const names = new Set<string>();
  for (const test of addedTests) {
    const fileName = baseName(test.path);
    names.add(fileName);
    names.add(path.posix.parse(fileName).name);
  }
  return names;
}

/** Whether a command's arguments name one of the tests, alone or at the end of a path. */
function namesATest(commandArguments: string, names: Set<string>): boolean {
  return commandArguments
    .split(/\s+/)
    .some((argument) => names.has(baseName(argument)));
}

function commandViolations(
  file: DiffFile,
  commands: CMakeCommand[],
  names: Set<string>,
): string[] {
  const violations: string[] = [];
  for (const { name, commandArguments } of commands) {
    if (!REGISTRATION_COMMANDS.has(name.toLowerCase())) {
      violations.push(
        `${file.path}: a test patch may only add a test to the build, not call ${name}`,
      );
    } else if (!namesATest(commandArguments, names)) {
      violations.push(
        `${file.path}: ${name} names no test file this patch adds`,
      );
    }
  }
  return violations;
}

/**
 * Why the lines a test patch adds to CMakeLists.txt are something other than
 * commands that build and register the test files the same patch adds.
 */
export function registrationViolations(
  file: DiffFile,
  addedTests: DiffFile[],
): string[] {
  if (file.status !== "modified" || file.removed > 0) {
    return [`${file.path}: a test patch may only add lines to CMakeLists.txt`];
  }
  const text = file.addedText.map(withoutComment).join("\n");
  const { commands, onlyCommands } = parseCMake(text);
  const violations = commandViolations(file, commands, testNames(addedTests));
  if (!onlyCommands) {
    violations.push(
      `${file.path}: a test patch may only add whole CMake commands`,
    );
  }
  return violations;
}
