// Structural guard for the advanced-search sheet.
//
// The two-column layout lives in createElement nesting, not in CSS: a lost or
// misplaced column wrapper still parses and still renders — as one long single
// column, which is exactly how a regression shipped once. This test reads the
// source and asserts which section belongs to which column.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** Index of the parenthesis that closes the call starting at `openIdx`. */
function matchParen(text, openIdx) {
  let depth = 0;
  let inString = null;
  let escaped = false;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inString !== null) {
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inString = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Every `mg-adv-col` wrapper with the section titles it contains. */
function columns() {
  const out = [];
  for (const match of source.matchAll(/className: "mg-adv-col"/g)) {
    const open = source.lastIndexOf("React.createElement(", match.index);
    const close = matchParen(source, open + "React.createElement".length);
    assert.ok(close > match.index, "column wrapper is unbalanced");
    const body = source.slice(match.index, close);
    out.push({
      scope: body.includes('"Scope"'),
      capabilities: body.includes('"Capabilities"'),
      limits: body.includes('"Limits"'),
      lifecycle: body.includes('"Lifecycle"'),
      providers: body.includes('"Providers"'),
    });
  }
  return out;
}

test("advanced sheet renders exactly two columns", () => {
  assert.equal(columns().length, 2, "expected a left and a right column wrapper");
});

test("left column holds scope and capabilities only", () => {
  const [left] = columns();
  assert.equal(left.scope, true);
  assert.equal(left.capabilities, true);
  assert.equal(left.limits, false, "Limits must not leak into the left column");
  assert.equal(left.providers, false, "Providers must not leak into the left column");
});

test("right column holds limits, lifecycle and providers", () => {
  const [, right] = columns();
  assert.equal(right.limits, true);
  assert.equal(right.lifecycle, true);
  assert.equal(right.providers, true);
  assert.equal(right.scope, false);
});

test("both columns sit inside the grid body", () => {
  const body = source.indexOf('className: "mg-adv-body"');
  assert.ok(body > 0, "grid body wrapper missing");
  const first = source.indexOf('className: "mg-adv-col"');
  const second = source.indexOf('className: "mg-adv-col"', first + 1);
  const close = matchParen(source, source.lastIndexOf("React.createElement(", body) + "React.createElement".length);
  assert.ok(first > body && second < close, "columns must be children of the grid body");
});
