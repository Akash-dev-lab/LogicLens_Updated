import { parse } from '@babel/parser';

/**
 * Extracts a literal value from an AST node if it is a statically recognizable literal.
 * Supports numbers, strings, booleans, null, and signed numbers.
 * Optionally resolves known array lengths for patterns like `arr.length - 1`.
 * Does not evaluate arbitrary expressions.
 */
function extractLiteralValue(node, knownArrays = new Map()) {
  if (!node) return { valid: false };

  switch (node.type) {
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
      return { valid: true, value: node.value };
    case 'NullLiteral':
      return { valid: true, value: null };
    case 'UnaryExpression':
      // Support unary negative/positive numbers like -5, +10, -3.14
      if ((node.operator === '-' || node.operator === '+') && node.argument?.type === 'NumericLiteral') {
        const val = node.operator === '-' ? -node.argument.value : node.argument.value;
        return { valid: true, value: val };
      }
      return { valid: false };
    case 'ArrayExpression': {
      // Recursively resolve nested arrays like [[1,2],[3,4]]
      const elements = [];
      for (const elem of node.elements) {
        if (!elem) {
          elements.push(null);
          continue;
        }
        const extracted = extractLiteralValue(elem, knownArrays);
        elements.push(extracted.valid ? extracted.value : null);
      }
      return { valid: true, value: elements };
    }
    case 'BinaryExpression':
      // Support patterns like `arr.length - 1` if arr has known static elements
      if (
        (node.operator === '-' || node.operator === '+') &&
        node.left?.type === 'MemberExpression' &&
        node.left.object?.type === 'Identifier' &&
        node.left.property?.type === 'Identifier' &&
        node.left.property.name === 'length' &&
        node.right?.type === 'NumericLiteral'
      ) {
        const arrayName = node.left.object.name;
        if (knownArrays.has(arrayName)) {
          const arrLength = knownArrays.get(arrayName);
          const offset = node.right.value;
          const val = node.operator === '-' ? arrLength - offset : arrLength + offset;
          return { valid: true, value: val };
        }
      }
      return { valid: false };
    default:
      return { valid: false };
  }
}

/**
 * Recursively inspects an AST node to find referenced array names in conditions or body.
 * Looks for `arr.length` or `arr[...]`.
 */
function findTargetArray(node, knownArrayNames) {
  if (!node || typeof node !== 'object') return null;

  // MemberExpression: arr.length or arr[i]
  if (node.type === 'MemberExpression') {
    if (node.object?.type === 'Identifier' && knownArrayNames.has(node.object.name)) {
      return node.object.name;
    }
  }

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findTargetArray(item, knownArrayNames);
        if (found) return found;
      }
    } else if (child && typeof child === 'object') {
      const found = findTargetArray(child, knownArrayNames);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Statically parses code using @babel/parser and returns:
 * 1. Top-level variables (arrays, primitives, and loop variables)
 * 2. Static loop pointers associated with their target arrays
 *
 * Supported:
 * - Array expressions: [], [1, 2], [10, "hello", true, null]
 * - Numeric literals: 0, 42, 3.14, -5
 * - String literals: "hello", 'hello'
 * - Boolean literals: true, false
 * - Null literal: null
 * - For loop initialization:
 *   - for (let i = 0; i < arr.length; i++)
 *   - for (let i = 1; i < n; i++)
 *   - for (let i = arr.length - 1; i >= 0; i--)
 *   - for (let i = 0, j = 5; i < j; i++, j--)
 *
 * @param {string} sourceCode
 * @returns {Array<{ name: string, type: 'array'|'primitive', value: any, targetArray?: string, isLoopPointer?: boolean }>}
 */
export function extractStaticVariables(sourceCode) {
  if (typeof sourceCode !== 'string' || sourceCode.trim() === '') {
    return [];
  }

  let ast;
  try {
    ast = parse(sourceCode, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    });
  } catch {
    // If parsing fails completely, gracefully return empty
    return [];
  }

  const variables = [];
  const seenNames = new Set();
  const knownArrays = new Map();
  const knownArrayNames = new Set();

  const body = ast?.program?.body;
  if (!Array.isArray(body)) {
    return [];
  }

  // First pass: collect arrays and top-level variables
  for (const node of body) {
    if (node.type === 'VariableDeclaration' && Array.isArray(node.declarations)) {
      for (const decl of node.declarations) {
        if (decl.type === 'VariableDeclarator' && decl.id?.type === 'Identifier' && decl.init) {
          const varName = decl.id.name;
          if (seenNames.has(varName)) continue;

          // Array expressions
          if (decl.init.type === 'ArrayExpression') {
            const elements = [];
            for (const elem of decl.init.elements) {
              if (!elem) {
                elements.push(null);
                continue;
              }
              const extracted = extractLiteralValue(elem, knownArrays);
              elements.push(extracted.valid ? extracted.value : null);
            }

            seenNames.add(varName);
            knownArrays.set(varName, elements.length);
            knownArrayNames.add(varName);
            variables.push({
              name: varName,
              type: 'array',
              value: elements,
            });
            continue;
          }

          // Primitive literals (Numeric, String, Boolean, Null)
          const extracted = extractLiteralValue(decl.init, knownArrays);
          if (extracted.valid) {
            seenNames.add(varName);
            variables.push({
              name: varName,
              type: 'primitive',
              value: extracted.value,
            });
          }
        }
      }
    }

    // 2. ForStatement nodes: for (let i = 0; i < ...; i++)
    if (node.type === 'ForStatement' && node.init) {
      if (node.init.type === 'VariableDeclaration' && Array.isArray(node.init.declarations)) {
        // Try to identify which array this loop targets (from condition `test` or `body`)
        let targetArray = findTargetArray(node.test, knownArrayNames);
        if (!targetArray) {
          targetArray = findTargetArray(node.body, knownArrayNames);
        }

        for (const decl of node.init.declarations) {
          if (decl.type === 'VariableDeclarator' && decl.id?.type === 'Identifier' && decl.init) {
            const varName = decl.id.name;
            if (seenNames.has(varName)) continue;

            const extracted = extractLiteralValue(decl.init, knownArrays);
            if (extracted.valid) {
              seenNames.add(varName);
              variables.push({
                name: varName,
                type: 'primitive',
                value: extracted.value,
                targetArray: targetArray || undefined,
                isLoopPointer: Boolean(targetArray),
              });
            }
          }
        }
      }
    }
  }

  return variables;
}

// Backwards compatibility alias if imported elsewhere
export const extractStaticArrays = (sourceCode) => {
  return extractStaticVariables(sourceCode)
    .filter((v) => v.type === 'array')
    .map((v) => ({ name: v.name, elements: v.value }));
};
