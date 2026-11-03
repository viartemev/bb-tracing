// Time inside a turn that no span covers is the model at work: waiting for
// the API and writing its next step. bb only sees a tool call once the model
// has finished writing its arguments, so writing a 400-line file shows up as
// a long silence followed by a 30ms file change. These synthetic spans make
// that time visible instead of leaving holes in the timeline.
import { isProviderError } from "./errors.ts";
import type { TraceRecord } from "./record.ts";

export const GAP_NAME = "generating";
export const QUEUED_NAME = "queued";
export const RETRY_NAME = "retrying";

export function isGap(span: TraceRecord): boolean {
  return span.kind === "message" && span.name === GAP_NAME && span.attrs?.synthetic === true;
}

/** The wait between sending a message and its turn starting (a busy thread, a queue). */
export function isQueued(span: TraceRecord): boolean {
  return span.kind === "queue" && span.name === QUEUED_NAME && span.attrs?.synthetic === true;
}

/** A stretch where the provider's API calls failed and were retried. */
export function isRetry(span: TraceRecord): boolean {
  return span.kind === "queue" && span.name === RETRY_NAME && span.attrs?.synthetic === true;
}

/**
 * The spans in start order with a synthetic `generating` span for every
 * stretch of at least `minMs` that nothing covers, up to `end`. A trailing
 * stretch of a running turn is marked running.
 */
export function withGaps(
  spans: readonly TraceRecord[],
  start: number,
  end: number,
  options: { minMs?: number; running?: boolean; startLatencyMs?: number | null } = {},
): TraceRecord[] {
  const minMs = options.minMs ?? 500;
  const byStart = (a: TraceRecord, b: TraceRecord) => Date.parse(a.at) - Date.parse(b.at);
  // Provider errors are instants, not work: they explain the gap they fall in.
  const errors = spans.filter(isProviderError).sort(byStart);
  const sorted = spans.filter((s) => !isProviderError(s)).sort(byStart);
  const out: TraceRecord[] = [];
  const seqOf = (span: TraceRecord | undefined) => (typeof span?.attrs?.seq === "number" ? span.attrs.seq : null);
  // The steps on either side: what the model had just read, and what it wrote.
  let previous: TraceRecord | undefined;
  const gap = (from: number, to: number, running: boolean, next?: TraceRecord): TraceRecord => ({
    at: new Date(from).toISOString(),
    kind: "message",
    name: GAP_NAME,
    durationMs: to - from,
    outcome: running ? "running" : "ok",
    attrs: { synthetic: true, prevSeq: seqOf(previous), nextSeq: seqOf(next) },
  });
  let covered = start;
  // Before the provider started the turn the model was not working yet: the
  // message waited for the thread (a previous turn, provisioning, a queue).
  const latency = options.startLatencyMs ?? 0;
  if (latency >= minMs) {
    out.push({
      at: new Date(start).toISOString(),
      kind: "queue",
      name: QUEUED_NAME,
      durationMs: latency,
      outcome: "ok",
      attrs: { synthetic: true },
    });
    covered = start + latency;
  }
  // Fills [from, to): API retries first if errors fell in it, then generating.
  const fill = (from: number, to: number, running: boolean, next?: TraceRecord) => {
    const inside = errors.filter((e) => Date.parse(e.at) >= from && Date.parse(e.at) < to);
    if (inside.length > 0) {
      const last = inside[inside.length - 1]!;
      const backoff = typeof last.attrs?.retryDelayMs === "number" ? last.attrs.retryDelayMs : 0;
      const until = Math.min(to, Date.parse(last.at) + backoff);
      const first = inside[0]!;
      out.push({
        at: new Date(from).toISOString(),
        kind: "queue",
        name: RETRY_NAME,
        durationMs: until - from,
        outcome: running && until >= to ? "running" : "retry",
        attrs: {
          synthetic: true,
          attempts: inside.length,
          maxAttempts: typeof last.attrs?.maxAttempts === "number" ? last.attrs.maxAttempts : null,
          firstFailureAfterMs: Date.parse(first.at) - from,
          delays: inside.map((e) => (typeof e.attrs?.retryDelayMs === "number" ? `${e.attrs.retryDelayMs}ms` : "?")).join(", "),
          reason: typeof last.attrs?.detail === "string" ? last.attrs.detail : null,
        },
      });
      from = until;
    }
    if (to - from >= minMs) out.push(gap(from, to, running, next));
  };
  for (const span of sorted) {
    const at = Date.parse(span.at);
    if (at > covered) fill(covered, at, false, span);
    out.push(span);
    previous = span;
    covered = Math.max(covered, at + span.durationMs);
  }
  if (end > covered) fill(covered, end, options.running ?? false);
  return out;
}
