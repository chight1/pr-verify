// An ESLint formatter that prints each finding on a line of its own, as
// path:line:column: severity message [rule], with the path relative to the
// project: the form in which the gate finds where each finding is.
import path from "node:path";

const WARNING = 1;
const ERROR = 2;
const SEVERITIES = new Map([
  [WARNING, "warning"],
  [ERROR, "error"],
]);

export default function eslintLocations(results) {
  const lines = [];
  for (const result of results) {
    const file = path.relative(process.cwd(), result.filePath);
    for (const finding of result.messages) {
      const severity = SEVERITIES.get(finding.severity);
      const rule = finding.ruleId ?? "parse error";
      lines.push(
        `${file}:${finding.line}:${finding.column}: ${severity} ${finding.message} [${rule}]`,
      );
    }
  }
  return lines.join("\n");
}
