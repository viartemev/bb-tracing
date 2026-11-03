// The trace of one turn: summary tiles, where the time went, and a waterfall
// of every tool call and thinking block. Also the thread's list of turns.
import { useMemo, useState } from "react";
import {
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../src/contract.ts";
import {
  CATEGORY,
  Empty,
  Metric,
  OutcomePill,
  ShareBar,
  Spinner,
  categoryOf,
  displayName,
  formatAgo,
  formatMs,
  formatTokens,
  isError,
  liveDuration,
  useNow,
  type Category,
  type Span,
} from "./common.tsx";
import { Waterfall } from "./Waterfall.tsx";
import { TokenBreakdown, spendOf } from "./Tokens.tsx";
import { isProviderError } from "../src/errors.ts";

type Filter = "all" | "tools" | "thinking" | "errors";

export function TurnTrace({ threadId, turnId }: { threadId: string; turnId: string }) {
  const query = useRpcQuery({ contract: rpcContract, method: "turn", input: { threadId, turnId } });
  const view = query.data?.view ?? null;
  const now = useNow(view?.running ?? false);

  if (query.isLoading) return <Spinner />;
  if (!view) {
    return (
      <Empty icon="tracing/activity" title="No trace for this turn">
        Tracing records turns that start after the plugin is installed.
      </Empty>
    );
  }
  return <TurnDetail threadId={threadId} turn={view.turn} spans={view.spans} running={view.running} now={now} />;
}

function TurnDetail({
  threadId,
  turn,
  spans,
  running,
  now,
}: {
  threadId: string;
  turn: Span;
  spans: Span[];
  running: boolean;
  now: number;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const start = Date.parse(turn.at);
  const total = Math.max(1, liveDuration(turn, now));
  const attrs = turn.attrs ?? {};
  // Provider errors are instants; the trace viewer folds them into retry steps.
  const work = spans.filter(
    (s) => !isProviderError(s) && (s.kind !== "provisioning" || Date.parse(s.at) >= start - 60_000),
  );

  const shares = useMemo(() => {
    const by = new Map<Category, number>();
    for (const span of work) {
      const category = categoryOf(span);
      by.set(category, (by.get(category) ?? 0) + liveDuration(span, now));
    }
    const busy = [...by.values()].reduce((a, b) => a + b, 0);
    const parts = (Object.keys(CATEGORY) as Category[])
      .filter((c) => by.has(c))
      .map((c) => ({ label: CATEGORY[c].label, value: by.get(c)!, color: CATEGORY[c].color }));
    // Time with nothing open is the model writing; overlapping spans can
    // exceed the turn, so the remainder is floored at zero.
    parts.push({ label: "Model", value: Math.max(0, total - busy), color: "var(--primary)" });
    return parts;
  }, [work, now, total]);

  const errors = work.filter(isError).length;
  const visible = work.filter((s) =>
    filter === "all"
      ? true
      : filter === "tools"
        ? s.kind === "tool"
        : filter === "thinking"
          ? s.kind === "reasoning"
          : isError(s),
  );
  const used = typeof attrs.usedTokens === "number" ? attrs.usedTokens : null;
  const window = typeof attrs.contextWindow === "number" ? attrs.contextWindow : null;
  const tools = work.filter((s) => s.kind === "tool");

  return (
    <div className="space-y-5 p-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xl font-semibold tabular-nums text-foreground">{formatMs(total)}</span>
          <OutcomePill outcome={turn.outcome} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {attrs.model && (
            <span className="inline-flex items-center gap-1">
              <Icon name="Bot" className="size-3" aria-hidden />
              {String(attrs.model)}
            </span>
          )}
          <span title={turn.at}>{new Date(start).toLocaleString()}</span>
          {attrs.initiator && attrs.initiator !== "user" && <span>by {String(attrs.initiator)}</span>}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4 sm:grid-cols-4">
        <Metric
          icon="Clock"
          label="First response"
          value={typeof attrs.startLatencyMs === "number" ? formatMs(attrs.startLatencyMs) : "—"}
          note="request → provider start"
        />
        <Metric
          icon="ToolCase"
          label="Tool calls"
          value={tools.length}
          note={errors > 0 ? <span className="text-destructive">{errors} failed</span> : "none failed"}
        />
        <Metric
          icon="Brain"
          label="Thinking"
          value={formatMs(work.filter((s) => s.kind === "reasoning").reduce((a, s) => a + liveDuration(s, now), 0))}
          note={`${work.filter((s) => s.kind === "reasoning").length} blocks`}
        />
        <Metric
          icon="Layers"
          label="Context"
          value={used !== null ? formatTokens(used) : "—"}
          note={used !== null && window ? `${Math.round((used / window) * 100)}% of ${formatTokens(window)}` : "tokens"}
        />
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Where the time went</h3>
        <ShareBar parts={shares} />
      </section>

      {spendOf(turn.attrs) && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tokens spent</h3>
          <TokenBreakdown spend={spendOf(turn.attrs)!} />
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Timeline</h3>
          <div className="flex rounded-md border border-border p-0.5 text-xs">
            {(["all", "tools", "thinking", "errors"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded px-2 py-0.5 capitalize transition-colors ${
                  filter === f ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f}
                {f === "errors" && errors > 0 ? ` ${errors}` : ""}
              </button>
            ))}
          </div>
        </div>
        {visible.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {running ? "Nothing yet — spans appear as the agent works." : "No spans match this filter."}
          </div>
        ) : (
          <Waterfall threadId={threadId} spans={visible} start={start} total={total} now={now} />
        )}
      </section>
    </div>
  );
}

/** Every recorded turn of a thread; picking one shows its trace. */
export function ThreadTraces({ threadId, initialTurnId }: { threadId: string; initialTurnId: string | null }) {
  const [selected, setSelected] = useState<string | null>(initialTurnId);
  const query = useRpcQuery({ contract: rpcContract, method: "threadTurns", input: { threadId } });
  const turns = query.data?.turns ?? [];
  const running = turns.some((t) => t.outcome === "running");
  const now = useNow(running);

  if (selected) {
    return (
      <div>
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Icon name="ChevronLeft" className="size-4" aria-hidden />
            All turns
          </button>
        </div>
        <TurnTrace threadId={threadId} turnId={selected} />
      </div>
    );
  }
  if (query.isLoading) return <Spinner />;
  if (turns.length === 0) {
    return (
      <Empty icon="tracing/activity" title="No turns traced yet">
        Send a message: each turn shows up here with its tool calls and timings.
      </Empty>
    );
  }
  const longest = Math.max(...turns.map((t) => liveDuration(t, now)), 1);
  return (
    <ul className="divide-y divide-border">
      {turns.map((turn, i) => {
        const duration = liveDuration(turn, now);
        const attrs = turn.attrs ?? {};
        return (
          <li key={turn.turnRequestId ?? turn.turnId ?? i}>
            <button
              type="button"
              disabled={!turn.turnId}
              onClick={() => turn.turnId && setSelected(turn.turnId)}
              className="flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium tabular-nums text-foreground">{formatMs(duration)}</span>
                <OutcomePill outcome={turn.outcome} />
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${turn.outcome === "running" ? "animate-pulse" : ""}`}
                  style={{
                    width: `${(duration / longest) * 100}%`,
                    background: isError(turn) ? "var(--destructive)" : "var(--timeline-accent)",
                  }}
                />
              </div>
              <div className="flex gap-3 text-xs tabular-nums text-muted-foreground">
                <span>{formatAgo(turn.at, now)}</span>
                <span>{Number(attrs.tools ?? 0)} tools</span>
                {Number(attrs.toolErrors ?? 0) > 0 && (
                  <span className="text-destructive">{Number(attrs.toolErrors)} failed</span>
                )}
                {attrs.model && <span className="truncate">{String(attrs.model)}</span>}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
