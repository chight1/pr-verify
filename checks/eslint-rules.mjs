// The gate's own ESLint rules, for checks no published rule makes the way the
// gate needs them.

// Nodes a constant's value can be built from: arithmetic on literals, and
// objects and arrays of them. A number reached only through these is named.
const CONSTANT_PARTS = new Set([
  "ArrayExpression",
  "BinaryExpression",
  "ObjectExpression",
  "Property",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "UnaryExpression",
]);

// Nodes that end the walk up from a number, each with whether the number is
// named there. `child` is the node the walk came up through.
const NAMING_NODES = new Map([
  [
    "VariableDeclarator",
    (node, child) => node.parent.kind === "const" && node.init === child,
  ],
  [
    "PropertyDefinition",
    (node, child) => node.readonly === true && node.value === child,
  ],
  ["TSEnumMember", () => true],
  ["TSLiteralType", () => true],
  ["AssignmentPattern", (node, child) => node.right === child],
]);

function namingCheck(type) {
  if (type.startsWith("TSType")) return () => true;
  return NAMING_NODES.get(type);
}

function isNamed(node) {
  let child = node;
  for (let current = node.parent; current; current = current.parent) {
    const named = namingCheck(current.type);
    if (named) return named(current, child);
    if (!CONSTANT_PARTS.has(current.type)) return false;
    child = current;
  }
  return false;
}

// Whether a number, or its negation, may stand without a name.
function allowed(subject, value) {
  if (value === 0 || value === 1 || value === -1) return true;
  const { parent } = subject;
  // An index into an array or a string needs no name.
  if (
    parent.type === "MemberExpression" &&
    parent.computed &&
    parent.property === subject
  ) {
    return true;
  }
  return isNamed(subject);
}

const noMagicNumbers = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Numbers other than 0, 1 and -1 are named where they are declared",
    },
    messages: { magic: "Name {{ value }} with a constant." },
    schema: [],
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== "number" && typeof node.value !== "bigint") {
          return;
        }
        const negated =
          node.parent.type === "UnaryExpression" &&
          node.parent.operator === "-";
        const subject = negated ? node.parent : node;
        const value = negated ? -node.value : node.value;
        if (allowed(subject, value)) return;
        context.report({
          node: subject,
          messageId: "magic",
          data: { value: String(value) },
        });
      },
    };
  },
};

export default {
  meta: { name: "pr-verify" },
  rules: { "no-magic-numbers": noMagicNumbers },
};
