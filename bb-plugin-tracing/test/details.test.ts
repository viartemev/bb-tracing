import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOCK_MAX_CHARS, itemDetail, itemTitle } from "../src/details.ts";
import * as itemSizeModule from "../src/details.ts";

test("a command shows the full command, its output and exit code", () => {
  const detail = itemDetail({
    type: "commandExecution",
    command: "cd /x && npm test -- --grep 'tracker'",
    cwd: "/x",
    exitCode: 1,
    status: "completed",
    aggregatedOutput: "1 failing\n  expected 2",
    presentation: { title: "cd /x && npm test…" },
  });
  assert.equal(detail.title, "cd /x && npm test -- --grep 'tracker'");
  assert.deepEqual(detail.fields, [
    { label: "Directory", value: "/x" },
    { label: "Exit code", value: "1" },
  ]);
  assert.deepEqual(
    detail.blocks.map((b) => [b.label, b.kind, b.content]),
    [
      ["Command", "code", "cd /x && npm test -- --grep 'tracker'"],
      ["Output", "text", "1 failing\n  expected 2"],
    ],
  );
});

test("a tool call shows arguments as JSON and a text result", () => {
  const detail = itemDetail({
    type: "toolCall",
    tool: "Read",
    arguments: { file_path: "/a.ts" },
    result: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }],
    presentation: { title: "a.ts" },
  });
  assert.equal(detail.title, "a.ts");
  assert.equal(detail.blocks[0]!.content, '{\n  "file_path": "/a.ts"\n}');
  assert.deepEqual([detail.blocks[1]!.kind, detail.blocks[1]!.content], ["text", "line 1\nline 2"]);
});

test("a file change becomes one diff block per file", () => {
  const detail = itemDetail({
    type: "fileChange",
    changes: [
      { path: "/r/src/a.ts", kind: "update", diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n" },
      { path: "/r/src/b.ts", kind: "add" },
    ],
  });
  assert.deepEqual(
    detail.blocks.map((b) => [b.label, b.kind, b.path]),
    [
      ["a.ts · update", "diff", "/r/src/a.ts"],
      ["b.ts · add", "text", undefined],
    ],
  );
});

test("reasoning shows its text and titles by its first line", () => {
  const item = { type: "reasoning", summary: [], content: ["\nPlan the UI.\nThen build it."] };
  assert.equal(itemTitle(item), "Plan the UI.");
  assert.equal(itemDetail(item).blocks[0]!.content, "Plan the UI.\nThen build it.");
});

test("long blocks are cut and say how much was cut", () => {
  const detail = itemDetail({ type: "commandExecution", command: "yes", aggregatedOutput: "y".repeat(BLOCK_MAX_CHARS + 5) });
  assert.equal(detail.blocks[1]!.content.length, BLOCK_MAX_CHARS);
  assert.equal(detail.blocks[1]!.truncatedChars, 5);
});

test("unknown items fall back to their data as JSON", () => {
  const detail = itemDetail({ type: "webSearch", id: "i1", query: "bb plugins", results: 3, presentation: {} });
  assert.equal(detail.title, "bb plugins");
  assert.deepEqual(detail.fields, [{ label: "Query", value: "bb plugins" }]);
  assert.equal(detail.blocks[0]!.content, '{\n  "query": "bb plugins",\n  "results": 3\n}');
});

test("itemSize counts what the model wrote and what came back", () => {
  const { itemSize } = itemSizeModule;
  assert.deepEqual(
    itemSize({ type: "commandExecution", command: "ls -la", aggregatedOutput: "a\nb\n" }),
    { type: "commandExecution", title: "ls -la", written: 6, returned: 4 },
  );
  // A file change counts only the added lines, without their "+".
  const change = itemSize({
    type: "fileChange",
    changes: [{ path: "/r/a.ts", diff: "--- a\n+++ b\n@@ -1 +1,2 @@\n-x\n+hello\n+world\n context" }],
    presentation: { title: "a.ts" },
  });
  assert.equal(change.written, 10);
  assert.equal(itemSize({ type: "toolCall", tool: "Read", arguments: { p: 1 }, result: "abc" }).returned, 3);
});
