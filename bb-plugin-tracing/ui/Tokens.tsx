// Where a turn's tokens went: re-reading context from the prompt cache,
// writing new context to it, uncached input, and what the model wrote.
import { Dot } from "./common.tsx";

export interface TokenSpend {
  total: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning?: number;
  threadTotal?: number | null;
}

export const formatTokenCount = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
      : String(n);

/** Token attributes of a turn span, or null for a turn that reported none. */
export function spendOf(attrs: Record<string, unknown> | undefined): TokenSpend | null {
  if (!attrs || typeof attrs.tokTotal !== "number") return null;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    total: attrs.tokTotal,
    input: n(attrs.tokInput),
    cacheRead: n(attrs.tokCacheRead),
    cacheWrite: n(attrs.tokCacheWrite),
    output: n(attrs.tokOutput),
    reasoning: n(attrs.tokReasoning),
    threadTotal: typeof attrs.tokThreadTotal === "number" ? attrs.tokThreadTotal : null,
  };
}

const PARTS = [
  {
    key: "cacheRead",
    short: "cache read",
    label: "Cache read",
    color: "color-mix(in oklab, var(--timeline-accent) 45%, transparent)",
    note: "Context re-read from the prompt cache on every step. The bulk of the volume, billed at a fraction of normal input.",
  },
  {
    key: "cacheWrite",
    short: "cache write",
    label: "Cache write",
    color: "var(--attention)",
    note: "New context (tool results, files read) written to the cache so later steps can re-read it.",
  },
  {
    key: "input",
    short: "input",
    label: "Uncached input",
    color: "var(--timeline-accent)",
    note: "Input sent at the full price, outside the cache.",
  },
  {
    key: "output",
    short: "output",
    label: "Output",
    color: "var(--pr-merged)",
    note: "Everything the model wrote: answers, tool calls with their arguments, file contents, thinking.",
  },
] as const;

/**
 * One thin bar and one line of figures. The longer explanation of each part
 * is in its tooltip.
 */
export function TokenBreakdown({ spend }: { spend: TokenSpend }) {
  const total = Math.max(1, spend.cacheRead + spend.cacheWrite + spend.input + spend.output);
  const inputSide = spend.cacheRead + spend.cacheWrite + spend.input;
  const hitRate = inputSide > 0 ? spend.cacheRead / inputSide : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {PARTS.map((part) => {
          const value = spend[part.key];
          return value > 0 ? (
            <div
              key={part.key}
              title={`${part.label}: ${value.toLocaleString()}`}
              style={{ width: `max(2px, ${(value / total) * 100}%)`, background: part.color }}
            />
          ) : null;
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
        {PARTS.map((part) => (
          <span
            key={part.key}
            className="inline-flex items-center gap-1"
            title={`${part.label}: ${spend[part.key].toLocaleString()} (${sharePct(spend[part.key], total)}). ${part.note}`}
          >
            <Dot color={part.color} />
            {part.short}
            <span className="text-foreground">{formatTokenCount(spend[part.key])}</span>
          </span>
        ))}
        {spend.reasoning ? (
          <span title="Reasoning tokens, counted inside output">
            reasoning <span className="text-foreground">{formatTokenCount(spend.reasoning)}</span>
          </span>
        ) : null}
        <span title="Share of input served from the prompt cache">
          hit <span className="text-foreground">{(hitRate * 100).toFixed(1)}%</span>
        </span>
        {spend.threadTotal ? (
          <span title="Tokens spent in this thread so far">
            thread <span className="text-foreground">{formatTokenCount(spend.threadTotal)}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function sharePct(value: number, total: number): string {
  const pct = (value / total) * 100;
  if (value === 0) return "0%";
  if (pct < 0.01) return "<0.01%";
  return `${pct.toFixed(pct < 1 ? 2 : 0)}%`;
}
