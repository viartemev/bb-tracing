// Read models the UI asks for, computed from the in-memory span index.
import type { TraceRecord } from "./record.ts";
import { summarize, type SpanStats } from "./summary.ts";
import type { LiveTurn } from "./tracker.ts";

export interface TurnView {
  turn: TraceRecord;
  /** Every span of the turn except the turn itself, by start time. */
  spans: TraceRecord[];
  running: boolean;
}

export interface Overview {
  windowMs: number;
  turns: { count: number; errors: number; p50Ms: number; p95Ms: number };
  tools: { count: number; errors: number; totalMs: number };
  reasoningMs: number;
  /** Token spend summed over the window's turns that reported it. */
  tokens: { turns: number; total: number; input: number; cacheRead: number; cacheWrite: number; output: number };
  /** Slowest span names by total time, turns excluded. */
  top: SpanStats[];
  recentTurns: TraceRecord[];
}

/** Recent spans held in memory so badge and panel reads never touch disk. */
export class TraceIndex {
  private records: TraceRecord[] = [];
  private readonly limit: number;

  constructor(limit = 50_000) {
    this.limit = limit;
  }

  load(records: readonly TraceRecord[]) {
    this.records = records.slice(-this.limit);
  }

  push(record: TraceRecord) {
    this.records.push(record);
    if (this.records.length > this.limit * 1.1) this.records = this.records.slice(-this.limit);
  }

  all(): readonly TraceRecord[] {
    return this.records;
  }

  /**
   * One turn by its provider turn id: the finished turn from the index, or
   * the running one from `live` with the spans it already closed.
   */
  turn(threadId: string, turnId: string, live: LiveTurn | null): TurnView | null {
    const running = live && live.turn.turnId === turnId ? live : null;
    const turn =
      running?.turn ??
      findLast(this.records, (r) => r.kind === "turn" && r.threadId === threadId && r.turnId === turnId);
    if (!turn) return null;
    const requestId = turn.turnRequestId;
    const spans = this.records.filter(
      (r) =>
        r.kind !== "turn" &&
        r.threadId === threadId &&
        (r.turnId === turnId || (requestId !== undefined && r.turnRequestId === requestId)),
    );
    if (running) spans.push(...running.spans);
    spans.sort((a, b) => a.at.localeCompare(b.at));
    return { turn, spans, running: running !== null };
  }

  /** A thread's turns, newest first, with the running one on top. */
  threadTurns(threadId: string, live: LiveTurn | null, limit = 50): TraceRecord[] {
    const turns: TraceRecord[] = [];
    for (let i = this.records.length - 1; i >= 0 && turns.length < limit; i--) {
      const r = this.records[i]!;
      if (r.kind === "turn" && r.threadId === threadId) turns.push(r);
    }
    return live?.turn.turnId ? [live.turn, ...turns] : turns;
  }

  overview(now: number, windowMs: number): Overview {
    const from = now - windowMs;
    const recent = this.records.filter((r) => Date.parse(r.at) >= from);
    const turns = recent.filter((r) => r.kind === "turn");
    const turnStats = summarize(turns)[0];
    const tools = recent.filter((r) => r.kind === "tool");
    return {
      windowMs,
      turns: {
        count: turns.length,
        errors: turns.filter((t) => t.outcome !== "completed").length,
        p50Ms: turnStats?.p50Ms ?? 0,
        p95Ms: turnStats?.p95Ms ?? 0,
      },
      tools: {
        count: tools.length,
        errors: tools.filter((t) => t.outcome !== "ok").length,
        totalMs: tools.reduce((sum, t) => sum + t.durationMs, 0),
      },
      tokens: sumTokens(turns),
      reasoningMs: recent
        .filter((r) => r.kind === "reasoning")
        .reduce((sum, r) => sum + r.durationMs, 0),
      top: summarize(recent.filter((r) => r.kind !== "turn" && r.kind !== "thread")).slice(0, 10),
      recentTurns: turns.slice(-15).reverse(),
    };
  }
}

function findLast<T>(items: readonly T[], test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return items[i];
  return undefined;
}

function sumTokens(turns: readonly TraceRecord[]): Overview["tokens"] {
  const sum = { turns: 0, total: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const turn of turns) {
    const a = turn.attrs ?? {};
    if (typeof a.tokTotal !== "number") continue;
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    sum.turns += 1;
    sum.total += a.tokTotal;
    sum.input += n(a.tokInput);
    sum.cacheRead += n(a.tokCacheRead);
    sum.cacheWrite += n(a.tokCacheWrite);
    sum.output += n(a.tokOutput);
  }
  return sum;
}
