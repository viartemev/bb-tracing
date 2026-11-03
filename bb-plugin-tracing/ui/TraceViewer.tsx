// A full trace viewer for one turn, after OpenBot's: a metrics strip, a step
// tree beside a time grid, search (Mod+F), replay, and the selected step's
// details in a side pane.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../src/contract.ts";
import { CATEGORY, Spinner, categoryOf, paint, swatch, type Category, displayName, formatMs, formatTokens, isError, liveDuration, useNow, type Span } from "./common.tsx";
import { SpanDetail, seqOf } from "./Waterfall.tsx";
import { TokenBreakdown, formatTokenCount, spendOf } from "./Tokens.tsx";
import { isGap, isQueued, isRetry, withGaps } from "../src/gaps.ts";


const SPEEDS = [1, 2, 5, 10, 25] as const;
const ROW = "h-9";
const LEFT = "w-[17rem] shrink-0";

function ticksFor(total: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);
  const step = steps.find((s) => total / s <= 5) ?? 3_600_000;
  const out: number[] = [];
  for (let t = 0; t <= total; t += step) out.push(t);
  return out;
}

const formatCount = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : formatTokens(n));

export function TraceViewer({
  threadId,
  turnId,
  onClose,
}: {
  threadId: string;
  turnId: string;
  onClose?: () => void;
}) {
  const query = useRpcQuery({ contract: rpcContract, method: "turn", input: { threadId, turnId } });
  const view = query.data?.view ?? null;
  const now = useNow(view?.running ?? false, 500);
  const spans = view?.spans ?? [];
  const seqs = spans.map(seqOf).filter((s): s is number => s !== null);
  const titles =
    useRpcQuery({
      contract: rpcContract,
      method: "spanTitles",
      input: { threadId, seqs: seqs.slice(0, 2000) },
      enabled: seqs.length > 0,
    }).data?.titles ?? {};

  const [search, setSearch] = useState("");
  const [showTokens, setShowTokens] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // The step under the pointer, in the list or on the ribbon; it is lit in both.
  const [hovered, setHovered] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Replay: a playhead sweeps the turn; steps it has not reached are dimmed.
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(5);

  const start = view ? Date.parse(view.turn.at) : 0;
  const total = view ? Math.max(1, liveDuration(view.turn, now)) : 1;

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = t - last;
      last = t;
      let done = false;
      setPlayhead((p) => {
        const next = (p ?? 0) + dt * speed;
        if (next >= total) {
          done = true;
          return total;
        }
        return next;
      });
      if (done) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, total]);

  // Spans plus "Generating" rows for the time no span covers (see gaps.ts).
  const timeline = useMemo(
    () =>
      withGaps(spans, start, start + total, {
        running: view?.running ?? false,
        startLatencyMs: typeof view?.turn.attrs?.startLatencyMs === "number" ? view.turn.attrs.startLatencyMs : null,
      }),
    [spans, start, total, view?.running, view?.turn.attrs?.startLatencyMs],
  );
  const ribbon = useMemo(() => {
    const layer = (span: Span) => (isError(span) ? 2 : isGap(span) ? 0 : 1);
    return timeline.map((span, i) => ({ span, i })).sort((a, b) => layer(a.span) - layer(b.span));
  }, [timeline]);
  const present = useMemo(() => {
    const seen = new Set(timeline.map(categoryOf));
    return (Object.keys(CATEGORY) as Category[]).filter((c) => seen.has(c));
  }, [timeline]);
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const titled = timeline.map((span) => {
      const seq = seqOf(span);
      const title = (seq !== null && titles[seq]) || displayName(span);
      return { span, title, key: stepKey(span) };
    });
    // A gap is the model writing whatever comes next, so it is named after it.
    for (let i = 0; i < titled.length; i++) {
      if (!isGap(titled[i]!.span)) continue;
      const next = titled.slice(i + 1).find((r) => !isGap(r.span));
      titled[i]!.title = next ? `→ ${next.title}` : titled[i]!.span.outcome === "running" ? "…" : "→ final answer";
    }
    return titled.filter(
      (r) => !needle || r.title.toLowerCase().includes(needle) || r.span.name.toLowerCase().includes(needle),
    );
  }, [timeline, titles, search]);

  if (query.isLoading) return <Spinner />;
  if (!view) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        No trace for this turn. Tracing records turns that start after the plugin is installed.
      </div>
    );
  }

  const attrs = view.turn.attrs ?? {};
  const spend = spendOf(attrs);
  const tools = spans.filter((s) => s.kind === "tool").length;
  const modelCalls = spans.filter((s) => s.kind === "reasoning" || s.kind === "message").length;
  const errors = spans.filter(isError).length;
  const ticks = ticksFor(total);
  const pct = (ms: number) => `${Math.min(100, (ms / total) * 100)}%`;
  const selectedRow = rows.find((r) => r.key === selected) ?? null;
  const focus = hovered ?? selected;
  const focusSpan = focus ? (timeline.find((span) => stepKey(span) === focus) ?? null) : null;

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  };

  const bar = (span: Span, height: string, minWidth = "4px") => {
    const offset = Math.max(0, Date.parse(span.at) - start);
    const duration = liveDuration(span, now);
    const reached = playhead === null ? duration : Math.max(0, Math.min(duration, playhead - offset));
    return {
      offset,
      duration,
      style: {
        left: pct(offset),
        width: `max(${minWidth}, ${pct(reached)})`,
        ...paint(span),
      } as CSSProperties,
      className: `absolute top-1/2 -translate-y-1/2 rounded-full ${height} ${span.outcome === "running" ? "animate-pulse" : ""}`,
      hidden: playhead !== null && offset > playhead,
    };
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground outline-none" onKeyDown={onKeyDown} tabIndex={-1}>
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Trace</h2>
        {view.running && (
          <span className="text-xs text-muted-foreground">
            running · {formatMs(total)}
          </span>
        )}
        <label className="ml-auto flex h-8 w-64 items-center gap-2 rounded-md border border-border bg-background px-2 text-sm focus-within:border-ring">
          <Icon name="Search" className="size-3.5 text-muted-foreground" aria-hidden />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search steps"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border px-1 text-[10px] text-muted-foreground">⌘F</kbd>
        </label>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        )}
      </header>

      <div className="grid grid-cols-6 divide-x divide-border border-b border-border">
        <Cell label="Duration" value={formatMs(total)} />
        <button
          type="button"
          onClick={() => spend && setShowTokens(!showTokens)}
          disabled={!spend}
          title={spend ? "Show the token breakdown" : "Token spend is recorded for turns that finish after this version"}
          className={`px-4 py-2 text-left transition-colors enabled:hover:bg-muted/50 ${showTokens ? "bg-muted/50" : ""}`}
        >
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            Tokens spent
            {spend && (
              <Icon name="ChevronDown" className={`size-3 transition-transform ${showTokens ? "rotate-180" : ""}`} aria-hidden />
            )}
          </div>
          <div className="text-sm tabular-nums">
            {spend ? formatTokenCount(spend.total) : "—"}
            {spend && <span className="ml-1.5 text-xs text-muted-foreground">out {formatTokenCount(spend.output)}</span>}
          </div>
        </button>
        <Cell
          label="Context"
          value={typeof attrs.usedTokens === "number" ? formatCount(attrs.usedTokens) : "—"}
          note={
            typeof attrs.usedTokens === "number" && typeof attrs.contextWindow === "number"
              ? `${Math.round((attrs.usedTokens / attrs.contextWindow) * 100)}% of ${formatCount(attrs.contextWindow)}`
              : undefined
          }
        />
        <Cell label="Model calls" value={String(modelCalls)} />
        <Cell label="Tool calls" value={String(tools)} />
        <Cell label="Errors" value={String(errors)} danger={errors > 0} />
      </div>
      {showTokens && spend && (
        <div className="border-b border-border px-4 py-2">
          <TokenBreakdown spend={spend} />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div ref={listRef} className="min-w-0 flex-1 overflow-auto">
          {/* Axis */}
          <div className={`sticky top-0 z-10 flex border-b border-border bg-background text-xs text-muted-foreground ${ROW}`}>
            <div className={`${LEFT} flex items-center gap-1.5 border-r border-border px-3`}>
              <Icon name="Workflow" className="size-3.5" aria-hidden />
              Steps
            </div>
            <div className="relative mx-3 flex-1">
              {/* A label too close to the right edge would wrap; its grid line stays. */}
              {ticks.filter((t) => t / total < 0.93).map((t) => (
                <span key={t} className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap tabular-nums" style={{ left: pct(t) }}>
                  {formatMs(t)}
                </span>
              ))}
              {playhead !== null && <Playhead left={pct(playhead)} />}
            </div>
          </div>

          {/* Root: the turn, with every step on one overview track */}
          <div className={`flex border-b border-border ${ROW}`}>
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              className={`${LEFT} flex items-center gap-1.5 border-r border-border px-2 text-sm font-medium`}
            >
              <Icon
                name="ChevronDown"
                className={`size-3.5 text-muted-foreground transition-transform ${collapsed ? "-rotate-90" : ""}`}
                aria-hidden
              />
              <Icon name="Bot" className="size-4 text-muted-foreground" aria-hidden />
              <span className="truncate">{String(attrs.model ?? "Turn")}</span>
              <span className="ml-auto pl-2 text-xs font-normal tabular-nums text-muted-foreground">{formatMs(total)}</span>
            </button>
            <div className="relative mx-3 flex flex-1 items-center">
              <Grid ticks={ticks} pct={pct} />
              {/* One continuous ribbon: square segments side by side, model time
                  underneath, steps over it and failures on top. */}
              {focusSpan && (
                // A band across the row marks where the lit step sits in the turn.
                <span
                  className="pointer-events-none absolute inset-y-1 rounded-sm"
                  style={{
                    left: pct(Math.max(0, Date.parse(focusSpan.at) - start)),
                    width: `max(6px, ${pct(liveDuration(focusSpan, now))})`,
                    background: "color-mix(in oklab, var(--foreground) 9%, transparent)",
                    boxShadow: "inset 0 0 0 1px color-mix(in oklab, var(--foreground) 25%, transparent)",
                  }}
                />
              )}
              <div
                className="relative h-3 flex-1 overflow-hidden rounded-full bg-muted"
                onMouseLeave={() => setHovered(null)}
              >
                {ribbon.map(({ span, i }) => {
                  const b = bar(span, "", "2px");
                  if (b.hidden) return null;
                  const key = stepKey(span);
                  const lit = focus === key;
                  return (
                    <span
                      key={i}
                      title={`${CATEGORY[categoryOf(span)].label} · ${formatMs(b.duration)}`}
                      onMouseEnter={() => setHovered(key)}
                      onClick={() => {
                        setSelected(key);
                        listRef.current
                          ?.querySelector(`[data-step="${CSS.escape(key)}"]`)
                          ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                      }}
                      className={`absolute inset-y-0 cursor-pointer transition-opacity ${span.outcome === "running" ? "animate-pulse" : ""}`}
                      style={{
                        ...b.style,
                        opacity: focus === null || lit ? 1 : 0.28,
                        ...(lit ? { zIndex: 1, boxShadow: "inset 0 0 0 1.5px var(--foreground)" } : {}),
                      }}
                    />
                  );
                })}
              </div>
              {playhead !== null && <Playhead left={pct(playhead)} />}
            </div>
          </div>

          {!collapsed &&
            rows.map(({ span, title, key }) => {
              const b = bar(span, "h-2");
              const failed = isError(span);
              const category = categoryOf(span);
              const icon = CATEGORY[category].icon;
              const active = selected === key;
              const endPct = ((b.offset + b.duration) / total) * 100;
              return (
                <button
                  key={key}
                  type="button"
                  data-step={key}
                  onClick={() => setSelected(active ? null : key)}
                  onMouseEnter={() => setHovered(key)}
                  onMouseLeave={() => setHovered((h) => (h === key ? null : h))}
                  title={title}
                  className={`flex w-full border-b border-border text-left transition-colors ${ROW} ${
                    active ? "bg-muted" : hovered === key ? "bg-muted/60" : ""
                  } ${b.hidden ? "opacity-30" : ""}`}
                >
                  <span className={`${LEFT} flex items-center gap-2 border-r border-border pl-8 pr-3 text-sm`}>
                    <span
                      className="flex size-5 shrink-0 items-center justify-center rounded"
                      style={iconTint(failed ? "var(--destructive)" : category === "generating" || category === "message" ? "var(--pr-merged)" : category === "wait" ? "var(--muted-foreground)" : CATEGORY[category].color)}
                    >
                      <Icon name={icon} className="size-3" aria-hidden />
                    </span>
                    {span.kind === "reasoning" || span.kind === "message" ? (
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="shrink-0">{displayName(span)}</span>
                        {title !== displayName(span) && (
                          <span className="truncate text-xs text-muted-foreground">{title}</span>
                        )}
                      </span>
                    ) : (
                      <span className={`truncate ${failed ? "text-destructive" : ""}`}>{title}</span>
                    )}
                  </span>
                  <span className="relative mx-3 flex-1">
                    <Grid ticks={ticks} pct={pct} />
                    {!b.hidden && (
                      <>
                        <span className={b.className} style={b.style} />
                        <span
                          className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                          style={endPct > 85 ? { right: `calc(${100 - (b.offset / total) * 100}% + 6px)` } : { left: `calc(${endPct}% + 6px)` }}
                        >
                          {formatMs(b.duration)}
                        </span>
                      </>
                    )}
                    {playhead !== null && <Playhead left={pct(playhead)} />}
                  </span>
                </button>
              );
            })}
          {!collapsed && rows.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {search ? "No steps match the search." : "No steps yet."}
            </div>
          )}
        </div>

        {selectedRow && (
          <aside className="w-[26rem] shrink-0 overflow-y-auto border-l border-border">
            <div className="flex items-start gap-2 border-b border-border px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted-foreground">{displayName(selectedRow.span)}</div>
                {selectedRow.title !== displayName(selectedRow.span) && (
                  <div className="line-clamp-3 break-all font-mono text-xs">{selectedRow.title}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close details"
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
            {isRetry(selectedRow.span) ? (
              <GapDetail
                duration={liveDuration(selectedRow.span, now)}
                offset={Math.max(0, Date.parse(selectedRow.span.at) - start)}
                text={retryText(selectedRow.span)}
              />
            ) : isQueued(selectedRow.span) ? (
              <GapDetail
                duration={liveDuration(selectedRow.span, now)}
                offset={0}
                text="The message waited here before its turn started: the thread was still busy with an earlier turn, its workspace was being prepared, or the message was queued."
              />
            ) : isGap(selectedRow.span) ? (
              <GeneratingDetail
                threadId={threadId}
                span={selectedRow.span}
                duration={liveDuration(selectedRow.span, now)}
                offset={Math.max(0, Date.parse(selectedRow.span.at) - start)}
                onOpenStep={(seq) => {
                  const row = rows.find((r) => seqOf(r.span) === seq && !isGap(r.span));
                  if (!row) return;
                  setSelected(row.key);
                  listRef.current
                    ?.querySelector(`[data-step="${CSS.escape(row.key)}"]`)
                    ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
                }}
              />
            ) : (
              <SpanDetail
                threadId={threadId}
                span={selectedRow.span}
                offset={Math.max(0, Date.parse(selectedRow.span.at) - start)}
                duration={liveDuration(selectedRow.span, now)}
              />
            )}
          </aside>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-4 py-2.5">
        <button
          type="button"
          aria-label={playing ? "Pause replay" : "Replay"}
          onClick={() => {
            if (playing) return setPlaying(false);
            if (playhead === null || playhead >= total) setPlayhead(0);
            setPlaying(true);
          }}
          className="flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Icon name={playing ? "Pause" : "Play"} className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Reset replay"
          onClick={() => {
            setPlaying(false);
            setPlayhead(null);
          }}
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Icon name="RotateCcw" className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)}
          className="h-8 rounded-md border border-border px-2.5 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Replay speed"
        >
          {speed}×
        </button>
        {playhead !== null && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatMs(playhead)} / {formatMs(total)}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          {present.map((category) => (
            <span key={category} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-4 rounded-full" style={swatch(category)} />
              {CATEGORY[category].label}
            </span>
          ))}
          {timeline.some((span) => isError(span) && categoryOf(span) !== "retry") && (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-4 rounded-full" style={{ background: "var(--destructive)" }} />
              Failed
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}

function Grid({ ticks, pct }: { ticks: number[]; pct: (ms: number) => string }) {
  return (
    <>
      {ticks.map((t) => (
        <span key={t} className="pointer-events-none absolute inset-y-0 w-px bg-border/70" style={{ left: pct(t) }} />
      ))}
    </>
  );
}

function Playhead({ left }: { left: string }) {
  return <span className="pointer-events-none absolute inset-y-0 z-10 w-px bg-ring" style={{ left }} />;
}

/** bb's icon set has no close glyph, so the viewer draws its own. */
function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" className={className} aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function GapDetail({ duration, offset, text }: { duration: number; offset: number; text?: string }) {
  return (
    <div className="space-y-3 px-3 py-3 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Started</dt>
        <dd className="font-mono">+{formatMs(offset)}</dd>
        <dt className="text-muted-foreground">Duration</dt>
        <dd className="font-mono">{formatMs(duration)}</dd>
      </dl>
      <p className="text-muted-foreground">
        {text ??
          "No step was open here: the model was working. This covers waiting for the API, thinking that was not streamed, and writing the next step. A tool call only appears once its arguments are fully written, so a long gap before a file change is usually the model writing that file."}
      </p>
    </div>
  );
}

/** A small chip in the category's color behind a step's icon. */
function iconTint(color: string): CSSProperties {
  return { color, background: `color-mix(in oklab, ${color} 16%, transparent)` };
}

/** Identifies a step across the list and the ribbon. */
function stepKey(span: Span): string {
  return `${span.at}|${span.name}|${seqOf(span) ?? ""}`;
}

function retryText(span: Span): string {
  const a = span.attrs ?? {};
  const first = typeof a.firstFailureAfterMs === "number" ? formatMs(a.firstFailureAfterMs) : "?";
  const of = typeof a.maxAttempts === "number" ? ` of ${a.maxAttempts}` : "";
  return (
    `The model API call failed and the provider retried it ${a.attempts ?? "?"} times${of} before the model answered. ` +
    `The first attempt failed after ${first}; the retries waited ${a.delays ?? "?"} between attempts.` +
    (a.reason ? ` Last error: ${a.reason}` : "")
  );
}

function Cell({ label, value, note, danger }: { label: string; value: string; note?: string; danger?: boolean }) {
  return (
    <div className="px-4 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-sm tabular-nums ${danger ? "text-destructive" : ""}`}>
        {value}
        {note && <span className="ml-1.5 text-xs text-muted-foreground">{note}</span>}
      </div>
    </div>
  );
}

// Rough size of text in tokens; providers do not report tokens per step.
const approxTokens = (chars: number) => Math.round(chars / 3.6);
const fmtChars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * A "generating" gap, explained by its edges: what the model had just been
 * given, and what it produced when the gap ended. bb records nothing while
 * the model streams a tool call's arguments, so the time itself cannot be
 * split any further.
 */
function GeneratingDetail({
  threadId,
  span,
  duration,
  offset,
  onOpenStep,
}: {
  threadId: string;
  span: Span;
  duration: number;
  offset: number;
  onOpenStep: (seq: number) => void;
}) {
  const prevSeq = typeof span.attrs?.prevSeq === "number" ? span.attrs.prevSeq : null;
  const nextSeq = typeof span.attrs?.nextSeq === "number" ? span.attrs.nextSeq : null;
  const query = useRpcQuery({
    contract: rpcContract,
    method: "gapContext",
    input: { threadId, prevSeq, nextSeq },
    enabled: prevSeq !== null || nextSeq !== null,
  });
  const prev = query.data?.prev ?? null;
  const next = query.data?.next ?? null;
  const seconds = Math.max(0.001, duration / 1000);
  const writtenTokens = next ? approxTokens(next.written) : 0;
  const rate = writtenTokens / seconds;
  // Writing faster than ~150 tok/s is not plausible; most of the time was then
  // spent before the first token (reading the new input, queueing).
  const mostlyWaiting = next !== null && (writtenTokens < 40 || rate < 15);

  return (
    <div className="space-y-4 px-3 py-3 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Started</dt>
        <dd className="font-mono">+{formatMs(offset)}</dd>
        <dt className="text-muted-foreground">Duration</dt>
        <dd className="font-mono">{formatMs(duration)}</dd>
      </dl>

      {query.isLoading ? (
        <Spinner style={{ paddingBlock: 12 }} />
      ) : (
        <ol className="space-y-3 border-l border-border pl-3">
          <li className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">1 · The model had just been given</div>
            {prev ? (
              <StepRef
                title={prev.title}
                onOpen={prevSeq !== null ? () => onOpenStep(prevSeq) : undefined}
                note={
                  prev.returned > 0
                    ? `its result: ${fmtChars(prev.returned)} chars ≈ ${fmtChars(approxTokens(prev.returned))} tokens of new input`
                    : "a result with no text"
                }
              />
            ) : (
              <p className="text-xs text-muted-foreground">The turn's start: your message and the context so far.</p>
            )}
          </li>
          <li className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">2 · {formatMs(duration)} with nothing recorded</div>
            <p className="text-xs text-muted-foreground">
              {next === null
                ? "The model was producing its next step."
                : mostlyWaiting
                  ? "Little was written, so most of this was the model reading its new input and starting to answer (time to first token), not writing."
                  : `If all of it was writing, that is about ${Math.round(rate)} tokens/s. Part of it is the wait for the first token.`}
            </p>
          </li>
          <li className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">3 · Then it produced</div>
            {next ? (
              <StepRef
                title={next.title}
                onOpen={nextSeq !== null ? () => onOpenStep(nextSeq) : undefined}
                note={`${fmtChars(next.written)} chars ≈ ${fmtChars(writtenTokens)} tokens written`}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                {span.outcome === "running" ? "Nothing yet; it is still working." : "Its final answer."}
              </p>
            )}
          </li>
        </ol>
      )}

      <p className="text-xs text-muted-foreground">
        bb records nothing while the model streams a tool call, so this time cannot be split further. Token counts here
        are estimated from text length.
      </p>
    </div>
  );
}

function StepRef({ title, note, onOpen }: { title: string; note: string; onOpen?: () => void }) {
  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        className="block max-w-full truncate rounded font-mono text-xs text-foreground enabled:hover:underline"
        title={title}
      >
        {title}
      </button>
      <div className="text-xs tabular-nums text-muted-foreground">{note}</div>
    </div>
  );
}
