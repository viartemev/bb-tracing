import assert from "node:assert/strict";
import { test } from "node:test";
import type { TraceRecord } from "../src/record.ts";
import { isGap, isQueued, withGaps } from "../src/gaps.ts";

const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const span = (offset: number, durationMs: number, name = "command:ls"): TraceRecord => ({
  at: new Date(T0 + offset).toISOString(),
  kind: "tool",
  name,
  durationMs,
  outcome: "ok",
});

test("uncovered stretches become generating spans, overlaps do not", () => {
  const out = withGaps([span(5000, 1000), span(1000, 500), span(5200, 2000, "tool:Read")], T0, T0 + 10_000);
  assert.deepEqual(
    out.map((s) => [isGap(s) ? "gap" : s.name, Date.parse(s.at) - T0, s.durationMs]),
    [
      ["gap", 0, 1000],
      ["command:ls", 1000, 500],
      ["gap", 1500, 3500],
      ["command:ls", 5000, 1000],
      ["tool:Read", 5200, 2000],
      ["gap", 7200, 2800],
    ],
  );
});

test("short gaps are left out and a running turn's tail is running", () => {
  const out = withGaps([span(300, 1000)], T0, T0 + 3000, { running: true });
  assert.deepEqual(out.map((s) => [isGap(s), s.outcome]), [[false, "ok"], [true, "running"]]);
});

test("time before the turn started is queued, not generating", () => {
  const out = withGaps([span(5000, 1000)], T0, T0 + 6000, { startLatencyMs: 4000 });
  assert.deepEqual(
    out.map((s) => [isQueued(s) ? "queued" : isGap(s) ? "gap" : s.name, Date.parse(s.at) - T0, s.durationMs]),
    [
      ["queued", 0, 4000],
      ["gap", 4000, 1000],
      ["command:ls", 5000, 1000],
    ],
  );
});

test("a generating gap names the steps around it by seq", () => {
  const withSeq = (offset: number, duration: number, seq: number): TraceRecord => ({ ...span(offset, duration), attrs: { seq } });
  const out = withGaps([withSeq(0, 1000, 10), withSeq(5000, 500, 12)], T0, T0 + 5500);
  const gap = out.find(isGap)!;
  assert.deepEqual([gap.attrs?.prevSeq, gap.attrs?.nextSeq], [10, 12]);
});
