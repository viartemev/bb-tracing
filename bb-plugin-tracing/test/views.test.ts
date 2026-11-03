import assert from "node:assert/strict";
import { test } from "node:test";
import type { TraceRecord } from "../src/record.ts";
import { TraceIndex } from "../src/views.ts";

const span = (over: Partial<TraceRecord>): TraceRecord => ({
  at: "2026-11-03T10:00:00.000Z",
  kind: "tool",
  name: "command:ls",
  durationMs: 10,
  outcome: "ok",
  threadId: "thr_1",
  ...over,
});

test("turn() finds a finished turn and its spans by provider turn id", () => {
  const index = new TraceIndex();
  index.load([
    span({ kind: "provisioning", name: "workspace", turnRequestId: "creq_1" }),
    span({ at: "2026-11-03T10:00:02.000Z", turnRequestId: "creq_1", turnId: "t1" }),
    span({ turnRequestId: "creq_2", turnId: "t2" }),
    span({ kind: "turn", name: "turn", durationMs: 5000, outcome: "completed", turnRequestId: "creq_1", turnId: "t1" }),
  ]);
  const view = index.turn("thr_1", "t1", null)!;
  assert.equal(view.running, false);
  assert.equal(view.turn.durationMs, 5000);
  assert.deepEqual(view.spans.map((s) => s.kind), ["provisioning", "tool"]);
  assert.equal(index.turn("thr_1", "nope", null), null);
  assert.equal(index.turn("thr_2", "t1", null), null);
});

test("turn() merges a running turn's closed and open spans", () => {
  const index = new TraceIndex();
  index.push(span({ turnRequestId: "creq_9", turnId: "t9" }));
  const live = {
    turn: span({ kind: "turn", name: "turn", outcome: "running", turnRequestId: "creq_9", turnId: "t9" }),
    spans: [span({ at: "2026-11-03T10:00:05.000Z", name: "command:npm", outcome: "running", turnId: "t9" })],
  };
  const view = index.turn("thr_1", "t9", live)!;
  assert.equal(view.running, true);
  assert.deepEqual(view.spans.map((s) => s.name), ["command:ls", "command:npm"]);
  assert.equal(index.threadTurns("thr_1", live)[0]!.outcome, "running");
});

test("overview() counts turns, tools and failures inside the window", () => {
  const index = new TraceIndex();
  const now = Date.parse("2026-11-03T12:00:00.000Z");
  index.load([
    span({ at: "2026-11-01T10:00:00.000Z" }), // outside 24h
    span({ outcome: "error", durationMs: 100 }),
    span({ durationMs: 50 }),
    span({ kind: "reasoning", name: "reasoning", durationMs: 700 }),
    span({ kind: "turn", name: "turn", durationMs: 4000, outcome: "completed" }),
    span({ kind: "turn", name: "turn", durationMs: 9000, outcome: "failed" }),
  ]);
  const o = index.overview(now, 24 * 3_600_000);
  assert.deepEqual(o.turns, { count: 2, errors: 1, p50Ms: 4000, p95Ms: 9000 });
  assert.deepEqual(o.tools, { count: 2, errors: 1, totalMs: 150 });
  assert.equal(o.reasoningMs, 700);
  assert.equal(o.recentTurns[0]!.outcome, "failed");
});
