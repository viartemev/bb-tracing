import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NdjsonSink, readNdjson } from "../src/ndjson.ts";
import { summarize } from "../src/summary.ts";
import { ThreadTracker, commandProgram, emptyState, type RawEvent } from "../src/tracker.ts";

let seq = 0;
const ev = (createdAt: number, type: string, data: unknown): RawEvent => ({
  seq: ++seq,
  createdAt,
  type,
  data,
});
const T0 = Date.parse("2026-11-03T10:00:00.000Z");

function turnEvents(): RawEvent[] {
  return [
    ev(T0, "client/turn/requested", {
      requestId: "creq_1",
      initiator: "user",
      source: "spawn",
      execution: { model: "claude-opus-5-5" },
    }),
    { ...ev(T0 + 400, "turn/started", {}), scope: { kind: "turn", turnId: "t1" } },
    ev(T0 + 500, "item/started", { item: { type: "reasoning", id: "r1" } }),
    ev(T0 + 1500, "item/completed", { item: { type: "reasoning", id: "r1" } }),
    ev(T0 + 1600, "item/started", {
      item: { type: "commandExecution", id: "c1", command: "cd /x && TOKEN=s3cret npm test --x" },
    }),
    ev(T0 + 4600, "item/completed", {
      item: { type: "commandExecution", id: "c1", command: "cd /x && TOKEN=s3cret npm test --x", exitCode: 1, status: "completed" },
    }),
    ev(T0 + 4700, "item/started", { item: { type: "toolCall", id: "t1", tool: "Read" } }),
    ev(T0 + 4800, "item/completed", { item: { type: "toolCall", id: "t1", tool: "Read", status: "completed" } }),
    ev(T0 + 4900, "thread/contextWindowUsage/updated", {
      contextWindowUsage: { usedTokens: 12000, modelContextWindow: 200000, estimated: false },
    }),
    ev(T0 + 5000, "item/started", { item: { type: "webFetch", id: "w1" } }),
    ev(T0 + 6000, "turn/completed", { status: "completed" }),
  ];
}

test("a turn becomes one turn span plus one span per tool", () => {
  const tracker = new ThreadTracker("thr_1", emptyState(), () => "names", "proj_1");
  const spans = tracker.consume(turnEvents());

  assert.deepEqual(
    spans.map((s) => [s.kind, s.name, s.durationMs, s.outcome]),
    [
      ["reasoning", "reasoning", 1000, "ok"],
      ["tool", "command:npm", 3000, "error"],
      ["tool", "tool:Read", 100, "ok"],
      ["tool", "webFetch", 1000, "abandoned"],
      ["turn", "turn", 6000, "completed"],
    ],
  );
  const turn = spans.at(-1)!;
  assert.equal(turn.at, "2026-11-03T10:00:00.000Z");
  assert.equal(turn.turnRequestId, "creq_1");
  assert.equal(turn.projectId, "proj_1");
  assert.deepEqual(turn.attrs, {
    model: "claude-opus-5-5",
    initiator: "user",
    source: "spawn",
    startLatencyMs: 400,
    tools: 2,
    toolErrors: 1,
    toolMs: 3100,
    reasoningMs: 1000,
    usedTokens: 12000,
    contextWindow: 200000,
  });
  assert.equal(turn.turnId, "t1");
  // Spans point at their completion event so the UI can read the details.
  assert.deepEqual(spans.slice(0, 3).map((s) => s.attrs?.seq), [4, 6, 8]);
  assert.ok(spans.every((s) => s.turnRequestId === "creq_1" && s.turnId === "t1"));
  assert.equal(tracker.activeTurn, false);
  assert.equal(tracker.openSpans, 0);
});

test("names mode keeps command arguments out of the trace", () => {
  const spans = new ThreadTracker("thr_1", emptyState(), () => "names").consume(turnEvents());
  assert.ok(!JSON.stringify(spans).includes("s3cret"));
  const full = new ThreadTracker("thr_1", emptyState(), () => "full").consume(turnEvents());
  assert.equal(full[1]!.attrs?.command, "cd /x && TOKEN=s3cret npm test --x");
});

test("state survives a reload between batches", () => {
  const events = turnEvents();
  const first = new ThreadTracker("thr_1", emptyState(), () => "names");
  const before = first.consume(events.slice(0, 5));
  assert.equal(first.activeTurn, true);
  const restored = JSON.parse(JSON.stringify(first.state));
  const after = new ThreadTracker("thr_1", restored, () => "names").consume(events.slice(5));
  assert.deepEqual(
    [...before, ...after].map((s) => [s.name, s.durationMs]),
    [
      ["reasoning", 1000],
      ["command:npm", 3000],
      ["tool:Read", 100],
      ["webFetch", 1000],
      ["turn", 6000],
    ],
  );
});

test("interactions and provisioning become spans", () => {
  const spans = new ThreadTracker("thr_1", emptyState(), () => "names").consume([
    ev(T0, "system/thread-provisioning", { provisioningId: "p1", status: "active" }),
    ev(T0 + 2500, "system/thread-provisioning", { provisioningId: "p1", status: "completed" }),
    ev(T0 + 3000, "system/interaction/lifecycle", {
      interaction: { id: "i1", status: "pending", payload: { kind: "approval" } },
    }),
    ev(T0 + 9000, "system/interaction/lifecycle", {
      interaction: { id: "i1", status: "resolved", payload: { kind: "approval" } },
    }),
  ]);
  assert.deepEqual(
    spans.map((s) => [s.kind, s.name, s.durationMs, s.outcome]),
    [
      ["provisioning", "workspace", 2500, "completed"],
      ["interaction", "approval", 6000, "resolved"],
    ],
  );
});

test("subagent turn/started does not open a second turn", () => {
  const tracker = new ThreadTracker("thr_1", emptyState(), () => "names");
  tracker.consume([
    ev(T0, "client/turn/requested", { requestId: "creq_1" }),
    ev(T0 + 100, "turn/started", {}),
    ev(T0 + 200, "turn/started", { parentToolCallId: "tc_1" }),
  ]);
  assert.equal(tracker.state.turn?.startedAt, T0 + 100);
});

test("commandProgram skips cd and env assignments", () => {
  assert.equal(commandProgram("cd /a; cd b && FOO=1 BAR=2 /usr/bin/git status"), "git");
  assert.equal(commandProgram("cd /a"), "sh");
  assert.equal(commandProgram("ls | head"), "ls");
  assert.equal(commandProgram("$(find . -name x) | head"), "find");
  assert.equal(commandProgram("for i in 1 2; do echo $i; done"), "shell");
  assert.equal(commandProgram("command ls -la; sudo -n true"), "ls");
});

test("summarize reports p50/p95/max and errors per name", () => {
  const base = { at: "2026-11-03T10:00:00.000Z", kind: "tool" as const, name: "command:npm" };
  const stats = summarize([
    ...[100, 200, 300, 400].map((d) => ({ ...base, durationMs: d, outcome: "ok" })),
    { ...base, durationMs: 1000, outcome: "error" },
  ]);
  assert.deepEqual(stats[0], {
    kind: "tool",
    name: "command:npm",
    count: 5,
    errors: 1,
    p50Ms: 300,
    p95Ms: 1000,
    maxMs: 1000,
    totalMs: 2000,
  });
});

test("the sink rotates into .1 and reads both generations in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-tracing-"));
  const path = join(dir, "logs", "trace.ndjson");
  const sink = new NdjsonSink(path, () => 64);
  for (let i = 0; i < 5; i++) void sink.write({ i, pad: "xxxxxxxxxx" });
  await sink.flush();
  assert.ok((await stat(`${path}.1`)).size <= 64);
  assert.ok((await readFile(path, "utf8")).length <= 64);
  const lines = await readNdjson<{ i: number }>(path);
  // One rotated generation: the oldest lines are dropped, order is kept.
  assert.deepEqual(lines.map((l) => l.i), lines.map((l) => l.i).sort());
  assert.equal(lines.at(-1)!.i, 4);
});

test("a span whose start was never seen is dropped, not recorded as 0ms", () => {
  const spans = new ThreadTracker("thr_1", emptyState(), () => "names").consume([
    ev(T0, "item/completed", { item: { type: "commandExecution", id: "c9", command: "ls" } }),
    ev(T0 + 10, "turn/completed", { status: "completed" }),
  ]);
  assert.deepEqual(spans, []);
});

test("live() shows the running turn and its open spans up to now", () => {
  const tracker = new ThreadTracker("thr_1", emptyState(), () => "names");
  tracker.consume(turnEvents().slice(0, 5)); // the npm command is still running
  const live = tracker.live(T0 + 2600)!;
  assert.equal(live.turn.outcome, "running");
  assert.equal(live.turn.durationMs, 2600);
  assert.equal(live.turn.turnId, "t1");
  assert.deepEqual(live.spans.map((s) => [s.name, s.durationMs, s.outcome]), [["command:npm", 1000, "running"]]);
});

test("the turn span carries the token spend bb reports just before it completes", () => {
  const tracker = new ThreadTracker("thr_1", emptyState(), () => "names");
  const spans = tracker.consume([
    ev(T0, "client/turn/requested", { requestId: "creq_t" }),
    ev(T0 + 100, "turn/started", {}),
    ev(T0 + 20_000, "thread/tokenUsage/updated", {
      tokenUsage: {
        total: { totalTokens: 19_823_443 },
        last: {
          totalTokens: 917_580,
          inputTokens: 6,
          cachedInputTokens: 915_852,
          cacheReadInputTokens: 913_962,
          cacheWriteInputTokens: 1_890,
          outputTokens: 1_722,
          reasoningOutputTokens: 0,
        },
      },
    }),
    ev(T0 + 20_000, "turn/completed", { status: "completed" }),
    // The next turn starts without inheriting the previous spend.
    ev(T0 + 30_000, "client/turn/requested", { requestId: "creq_u" }),
    ev(T0 + 31_000, "turn/completed", { status: "completed" }),
  ]);
  const [first, second] = spans.filter((s) => s.kind === "turn");
  assert.deepEqual(
    [first!.attrs?.tokTotal, first!.attrs?.tokInput, first!.attrs?.tokCacheRead, first!.attrs?.tokCacheWrite, first!.attrs?.tokOutput, first!.attrs?.tokThreadTotal],
    [917_580, 6, 913_962, 1_890, 1_722, 19_823_443],
  );
  assert.equal(second!.attrs?.tokTotal, undefined);
});
