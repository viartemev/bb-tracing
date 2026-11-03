import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRetry, providerErrorSpan } from "../src/errors.ts";
import { isGap, isRetry, withGaps } from "../src/gaps.ts";
import type { TraceRecord } from "../src/record.ts";

const T0 = Date.parse("2026-11-03T11:51:33.000Z");
const retryEvent = (seq: number, offset: number, attempt: number, delay: number) =>
  providerErrorSpan({
    seq,
    createdAt: T0 + offset,
    data: {
      message: "Provider error",
      detail: `Claude Code API retry ${attempt}/10 after ${delay}ms: unknown`,
      willRetry: true,
      errorInfo: { category: "unknown", httpStatusCode: null },
    },
  });

test("parseRetry reads attempt, limit, backoff and reason", () => {
  assert.deepEqual(parseRetry("Claude Code API retry 6/10 after 19680ms: overloaded"), {
    attempt: 6,
    of: 10,
    delayMs: 19680,
    reason: "overloaded",
  });
  assert.equal(parseRetry("Provider error"), null);
});

test("a provider error becomes a zero-length retry span", () => {
  const span = retryEvent(1977, 99_000, 1, 551);
  assert.deepEqual([span.kind, span.name, span.outcome, span.durationMs], ["error", "api-retry", "retry", 0]);
  assert.deepEqual([span.attrs?.attempt, span.attrs?.maxAttempts, span.attrs?.retryDelayMs, span.attrs?.seq], [1, 10, 551, 1977]);
});

test("a silence with retries splits into API retries, then generating", () => {
  // The turn from 11:51:33: retries at +99s…+251s, thinking starts at +276s.
  const thinking: TraceRecord = {
    at: new Date(T0 + 276_000).toISOString(),
    kind: "reasoning",
    name: "reasoning",
    durationMs: 4000,
    outcome: "ok",
  };
  const spans = [
    retryEvent(1977, 99_000, 1, 551),
    retryEvent(1978, 130_000, 2, 1094),
    retryEvent(1982, 251_000, 6, 19_680),
    thinking,
  ];
  const out = withGaps(spans, T0, T0 + 280_000);
  assert.deepEqual(
    out.map((s) => [isRetry(s) ? "retry" : isGap(s) ? "gap" : s.name, (Date.parse(s.at) - T0) / 1000, s.durationMs / 1000]),
    [
      ["retry", 0, 270.68],
      ["gap", 270.68, 5.32],
      ["reasoning", 276, 4],
    ],
  );
  assert.equal(out[0]!.attrs?.attempts, 3);
  assert.equal(out[0]!.attrs?.firstFailureAfterMs, 99_000);
  assert.equal(out[0]!.attrs?.delays, "551ms, 1094ms, 19680ms");
});
