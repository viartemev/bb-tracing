// The Tracing page: turns and tools across every thread, the slowest spans,
// and the bb server's resource samples.
import { useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../src/contract.ts";
import { TokenBreakdown, formatTokenCount } from "./Tokens.tsx";
import {
  CATEGORY,
  Dot,
  Empty,
  Metric,
  OutcomePill,
  Sparkline,
  Spinner,
  categoryOf,
  displayName,
  formatAgo,
  formatMs,
  useNow,
  type Span,
} from "./common.tsx";

const WINDOWS = [
  { label: "1h", hours: 1 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
] as const;

export function Dashboard() {
  const [hours, setHours] = useState<number>(24);
  const query = useRpcQuery({ contract: rpcContract, method: "overview", input: { windowHours: hours } });
  const now = useNow(true, 30_000);
  const data = query.data;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Every turn, tool call and wait across your threads.</p>
          <div className="flex rounded-md border border-border p-0.5 text-xs">
            {WINDOWS.map((w) => (
              <button
                key={w.label}
                type="button"
                onClick={() => setHours(w.hours)}
                className={`rounded px-2.5 py-1 transition-colors ${
                  hours === w.hours ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        {!data ? (
          query.error ? (
            <Empty icon="AlertTriangle" title="Could not load traces">
              {query.error.message}
            </Empty>
          ) : (
            <Spinner />
          )
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Metric
                icon="MessageSquare"
                label="Turns"
                value={data.turns.count}
                note={data.turns.errors > 0 ? <span className="text-destructive">{data.turns.errors} not completed</span> : "all completed"}
              />
              <Metric icon="Clock" label="Turn time p50" value={formatMs(data.turns.p50Ms)} note={`p95 ${formatMs(data.turns.p95Ms)}`} />
              <Metric
                icon="ToolCase"
                label="Tool calls"
                value={data.tools.count}
                note={
                  data.tools.errors > 0 ? (
                    <span className="text-destructive">
                      {data.tools.errors} failed · {Math.round((data.tools.errors / Math.max(1, data.tools.count)) * 100)}%
                    </span>
                  ) : (
                    "none failed"
                  )
                }
              />
              <Metric icon="Brain" label="Thinking" value={formatMs(data.reasoningMs)} note={`tools ${formatMs(data.tools.totalMs)}`} />
              <Metric
                icon="Layers"
                label="Tokens spent"
                value={data.tokens.turns > 0 ? formatTokenCount(data.tokens.total) : "—"}
                note={data.tokens.turns > 0 ? `out ${formatTokenCount(data.tokens.output)} · ${data.tokens.turns} turns` : "from the next turn on"}
              />
            </div>

            {data.tokens.turns > 0 && (
              <Section title="Tokens">
                <div className="px-3 py-2">
                  <TokenBreakdown spend={data.tokens} />
                </div>
              </Section>
            )}

            <Section title="Recent turns">
              {data.recentTurns.length === 0 ? (
                <Empty icon="tracing/activity" title="No turns in this window">
                  Turns appear here as soon as an agent finishes one.
                </Empty>
              ) : (
                <RecentTurns turns={data.recentTurns} now={now} />
              )}
            </Section>

            <div className="grid gap-5 md:grid-cols-[3fr_2fr]">
              <Section title="Where time goes">
                <TopSpans top={data.top} />
              </Section>
              <Section title="bb server">
                <Resources samples={data.resources} />
              </Section>
            </div>

            <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <Icon name="FileText" className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate font-mono">{data.tracePath}</span>
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="overflow-hidden rounded-lg border border-border bg-card">{children}</div>
    </section>
  );
}

function RecentTurns({ turns, now }: { turns: (Span & { threadTitle: string | null })[]; now: number }) {
  const navigate = useBbNavigate();
  const longest = Math.max(...turns.map((t) => t.durationMs), 1);
  return (
    <ul className="divide-y divide-border">
      {turns.map((turn, i) => {
        const attrs = turn.attrs ?? {};
        return (
          <li key={turn.turnRequestId ?? i}>
            <button
              type="button"
              onClick={() => turn.threadId && navigate.toThread(turn.threadId)}
              className="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
            >
              <span className="truncate text-sm text-foreground">{turn.threadTitle ?? turn.threadId}</span>
              <span className="text-right text-sm font-medium tabular-nums text-foreground">{formatMs(turn.durationMs)}</span>
              <span className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
                <span>{formatAgo(turn.at, now)}</span>
                <span>{Number(attrs.tools ?? 0)} tools</span>
                {Number(attrs.toolErrors ?? 0) > 0 && <span className="text-destructive">{Number(attrs.toolErrors)} failed</span>}
                {turn.outcome !== "completed" && <OutcomePill outcome={turn.outcome} />}
              </span>
              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted sm:w-40">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${(turn.durationMs / longest) * 100}%`,
                    background: turn.outcome === "completed" ? "var(--timeline-accent)" : "var(--destructive)",
                  }}
                />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TopSpans({ top }: { top: { kind: string; name: string; count: number; errors: number; p50Ms: number; p95Ms: number; totalMs: number }[] }) {
  if (top.length === 0) return <div className="px-3 py-6 text-center text-sm text-muted-foreground">No spans yet.</div>;
  const max = Math.max(...top.map((t) => t.totalMs), 1);
  return (
    <ul className="divide-y divide-border">
      {top.map((stat) => {
        const span = { kind: stat.kind, name: stat.name, at: "", durationMs: 0, outcome: "ok" } as Span;
        const meta = CATEGORY[categoryOf(span)];
        return (
          <li key={`${stat.kind}:${stat.name}`} className="space-y-1 px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Dot color={meta.color} />
                <span className="truncate text-foreground">{displayName(span)}</span>
                <span className="text-xs text-muted-foreground">×{stat.count}</span>
                {stat.errors > 0 && <span className="text-xs text-destructive">{stat.errors} failed</span>}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                <span className="text-foreground">{formatMs(stat.totalMs)}</span> · p95 {formatMs(stat.p95Ms)}
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full" style={{ width: `${(stat.totalMs / max) * 100}%`, background: meta.color }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Resources({
  samples,
}: {
  samples: { at: string; rssMb: number; cpuPct: number; eventLoopMs: { p99: number }; activeTurns: number }[];
}) {
  const last = samples.at(-1);
  const rows = [
    { label: "Memory", value: last ? `${last.rssMb} MB` : "—", values: samples.map((s) => s.rssMb), color: "var(--timeline-accent)" },
    { label: "CPU", value: last ? `${last.cpuPct}%` : "—", values: samples.map((s) => s.cpuPct), color: "var(--success)" },
    {
      label: "Event loop p99",
      value: last ? `${last.eventLoopMs.p99} ms` : "—",
      values: samples.map((s) => s.eventLoopMs.p99),
      color: last && last.eventLoopMs.p99 > 100 ? "var(--destructive)" : "var(--warning)",
    },
  ];
  return (
    <div className="divide-y divide-border">
      {rows.map((row) => (
        <div key={row.label} className="space-y-1 px-3 py-2">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">{row.label}</span>
            <span className="text-sm font-medium tabular-nums text-foreground">{row.value}</span>
          </div>
          <Sparkline values={row.values} color={row.color} height={32} />
        </div>
      ))}
      <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
        <span>Active turns</span>
        <span className="tabular-nums text-foreground">{last?.activeTurns ?? 0}</span>
      </div>
    </div>
  );
}
