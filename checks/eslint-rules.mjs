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

function isNamed(node) {
  let child = node;
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "VariableDeclarator") {
      return current.parent.kind === "const" && current.init === child;
    }
    if (current.type === "PropertyDefinition") {
      return current.readonly === true && current.value === child;
    }
    if (current.type === "TSEnumMember" || current.type.startsWith("TSType")) {
      return true;
    }
    if (current.type === "TSLiteralType") return true;
    if (current.type === "AssignmentPattern") return current.right === child;
    if (!CONSTANT_PARTS.has(current.type)) return false;
    child = current;
  }
  return false;
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
        if (value === 0 || value === 1 || value === -1) return;
        const { parent } = subject;
        // An index into an array or a string needs no name.
        if (
          parent.type === "MemberExpression" &&
          parent.computed &&
          parent.property === subject
        ) {
          return;
        }
        if (isNamed(subject)) return;
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
