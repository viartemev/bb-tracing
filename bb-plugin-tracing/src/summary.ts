import type { TraceRecord } from "./record.ts";

export interface SpanStats {
  kind: string;
  name: string;
  count: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
}

const OK_OUTCOMES = new Set(["ok", "completed", "resolved", "dispatched"]);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/** Groups spans by kind and name, slowest total first. */
export function summarize(records: readonly TraceRecord[]): SpanStats[] {
  const groups = new Map<string, TraceRecord[]>();
  for (const record of records) {
    const key = `${record.kind}\u0000${record.name}`;
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  const stats: SpanStats[] = [];
  for (const group of groups.values()) {
    const durations = group.map((r) => r.durationMs).sort((a, b) => a - b);
    stats.push({
      kind: group[0]!.kind,
      name: group[0]!.name,
      count: group.length,
      errors: group.filter((r) => !OK_OUTCOMES.has(r.outcome)).length,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      maxMs: durations[durations.length - 1] ?? 0,
      totalMs: durations.reduce((sum, d) => sum + d, 0),
    });
  }
  return stats.sort((a, b) => b.totalMs - a.totalMs);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** A fixed-width text table; the first row is the header. */
export function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows
    .map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd())
    .join("\n");
}

/**
 * One turn and its tool spans as a text waterfall: offset from the turn's
 * start, a bar scaled to the turn, then duration and outcome.
 */
export function waterfall(turn: TraceRecord, children: readonly TraceRecord[], width = 40): string {
  const start = Date.parse(turn.at);
  const span = Math.max(1, turn.durationMs);
  const lines = [
    `turn ${turn.turnRequestId ?? "?"}  ${turn.at}  ${formatMs(turn.durationMs)}  ${turn.outcome}` +
      (turn.attrs?.model ? `  ${turn.attrs.model}` : ""),
  ];
  for (const child of children) {
    const offset = Date.parse(child.at) - start;
    const from = Math.min(width - 1, Math.floor((offset / span) * width));
    const len = Math.max(1, Math.round((child.durationMs / span) * width));
    const bar = " ".repeat(from) + "█".repeat(Math.min(len, width - from));
    lines.push(
      `  +${formatMs(offset).padStart(6)} |${bar.padEnd(width)}| ${formatMs(child.durationMs).padStart(6)}  ${child.name}` +
        (child.outcome === "ok" ? "" : `  [${child.outcome}]`),
    );
  }
  return lines.join("\n");
}
