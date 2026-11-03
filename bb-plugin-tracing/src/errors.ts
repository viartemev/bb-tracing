// Provider errors inside a turn, such as Claude Code retrying a failed API
// call. They explain long silences: a request that hangs and is retried with
// growing backoff shows nothing in the timeline until the model finally
// answers. Read from the thread history and shown as point spans.
import type { TraceRecord } from "./record.ts";

export const API_RETRY = "api-retry";

/** "Claude Code API retry 3/10 after 2124ms: unknown" → 3, 10, 2124, "unknown". */
export function parseRetry(detail: string): { attempt: number; of: number; delayMs: number; reason: string } | null {
  const match = /retry (\d+)\/(\d+) after (\d+)ms(?::\s*(.*))?/i.exec(detail);
  if (!match) return null;
  return { attempt: Number(match[1]), of: Number(match[2]), delayMs: Number(match[3]), reason: (match[4] ?? "").trim() };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" ? (v as Obj) : {});

/** One `provider/error` event as a zero-length span. */
export function providerErrorSpan(event: { seq: number; createdAt: number; data: unknown }): TraceRecord {
  const data = obj(event.data);
  const detail = typeof data.detail === "string" ? data.detail : typeof data.message === "string" ? data.message : "";
  const info = obj(data.errorInfo);
  const retry = parseRetry(detail);
  return {
    at: new Date(event.createdAt).toISOString(),
    kind: "error",
    name: data.willRetry === true || retry ? API_RETRY : "provider-error",
    durationMs: 0,
    outcome: data.willRetry === true || retry ? "retry" : "error",
    attrs: {
      seq: event.seq,
      detail: detail.slice(0, 300),
      category: typeof info.category === "string" ? info.category : null,
      httpStatusCode: typeof info.httpStatusCode === "number" ? info.httpStatusCode : null,
      ...(retry ? { attempt: retry.attempt, maxAttempts: retry.of, retryDelayMs: retry.delayMs } : {}),
    },
  };
}

export const isProviderError = (span: TraceRecord) => span.kind === "error" && span.durationMs === 0 && typeof span.attrs?.seq === "number";
