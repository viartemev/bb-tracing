// The turn timeline. Each row is a full-width title (the real command, file or
// tool call, read from the thread history) over a bar on the turn's time axis.
// Opening a row loads what the span actually did.
import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import {
  experimental_Diff as Diff,
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../src/contract.ts";
import type { DetailBlock } from "../src/details.ts";
import { CATEGORY, Spinner, categoryOf, displayName, formatMs, isError, liveDuration, type Span } from "./common.tsx";

export const seqOf = (span: Span): number | null => (typeof span.attrs?.seq === "number" ? span.attrs.seq : null);
const keyOf = (span: Span) => `${span.at}|${span.name}|${seqOf(span) ?? ""}`;

export function Waterfall({
  threadId,
  spans,
  start,
  total,
  now,
}: {
  threadId: string;
  spans: Span[];
  start: number;
  total: number;
  now: number;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const seqs = spans.map(seqOf).filter((s): s is number => s !== null);
  const titles = useRpcQuery({
    contract: rpcContract,
    method: "spanTitles",
    input: { threadId, seqs: seqs.slice(0, 2000) },
    enabled: seqs.length > 0,
  }).data?.titles;

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Axis total={total} />
      <ul className="divide-y divide-border">
        {spans.map((span) => {
          const key = keyOf(span);
          const seq = seqOf(span);
          return (
            <Row
              key={key}
              span={span}
              title={(seq !== null && titles?.[seq]) || null}
              start={start}
              total={total}
              now={now}
              expanded={open.has(key)}
              onToggle={() => toggle(key)}
              threadId={threadId}
            />
          );
        })}
      </ul>
    </div>
  );
}

function Axis({ total }: { total: number }) {
  return (
    <div className="relative h-6 border-b border-border bg-muted/40 px-3 text-[10px] tabular-nums text-muted-foreground">
      <div className="relative h-full">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <span
            key={t}
            className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap"
            style={t === 1 ? { right: 0 } : { left: `${t * 100}%`, transform: t === 0 ? "translateY(-50%)" : "translate(-50%, -50%)" }}
          >
            {formatMs(total * t)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Row({
  span,
  title,
  start,
  total,
  now,
  expanded,
  onToggle,
  threadId,
}: {
  span: Span;
  title: string | null;
  start: number;
  total: number;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  threadId: string;
}) {
  const meta = CATEGORY[categoryOf(span)];
  const duration = liveDuration(span, now);
  const offset = Math.max(0, Date.parse(span.at) - start);
  const left = Math.min(99.5, (offset / total) * 100);
  const width = Math.max(0.5, Math.min(100 - left, (duration / total) * 100));
  const failed = isError(span);
  const running = span.outcome === "running";
  const label = displayName(span);
  const exitCode = span.attrs?.exitCode;

  return (
    <li className={expanded ? "bg-muted/20" : undefined}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group block w-full space-y-1.5 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <span className="flex items-start gap-2">
          <Icon
            name="ChevronRight"
            className={`mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span
                className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                style={{
                  color: failed ? "var(--destructive)" : "var(--foreground)",
                  background: `color-mix(in oklab, ${failed ? "var(--destructive)" : meta.color} 18%, transparent)`,
                }}
              >
                {label}
              </span>
              {failed && typeof exitCode === "number" && (
                <span className="text-[10px] font-medium text-destructive">exit {exitCode}</span>
              )}
              {running && <span className="text-[10px] font-medium text-muted-foreground">running…</span>}
              <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{formatMs(duration)}</span>
            </span>
            {title && title !== label && (
              <span
                // The full text is in the detail below, so the row stays two lines.
                className={`mt-1 line-clamp-2 block text-xs leading-relaxed ${
                  span.kind === "reasoning" ? "italic text-muted-foreground" : "break-all font-mono text-foreground"
                }`}
                title={title}
              >
                {title}
              </span>
            )}
          </span>
        </span>
        <span className="relative ml-5 block h-1.5 rounded-full bg-muted">
          <span
            className={`absolute inset-y-0 rounded-full ${running ? "animate-pulse" : ""}`}
            style={{ left: `${left}%`, width: `${width}%`, background: failed ? "var(--destructive)" : meta.color }}
          />
        </span>
      </button>
      {expanded && <SpanDetail threadId={threadId} span={span} offset={offset} duration={duration} />}
    </li>
  );
}

export function SpanDetail({ threadId, span, offset, duration }: { threadId: string; span: Span; offset: number; duration: number }) {
  const seq = seqOf(span);
  const query = useRpcQuery({
    contract: rpcContract,
    method: "spanDetail",
    input: { threadId, seq: seq ?? 1 },
    enabled: seq !== null,
  });
  const detail = query.data?.detail ?? null;

  const timing: { label: string; value: string }[] = [
    { label: "Started", value: `+${formatMs(offset)} · ${new Date(span.at).toLocaleTimeString()}` },
    { label: "Duration", value: formatMs(duration) },
    { label: "Outcome", value: span.outcome },
  ];
  const fields = [...timing, ...(detail?.fields ?? [])];

  return (
    <div className="space-y-3 border-t border-border px-3 pb-3 pt-2.5 pl-8">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {fields.map((f) => (
          <div key={f.label} className="contents">
            <dt className="text-muted-foreground">{f.label}</dt>
            <dd className="min-w-0 break-all font-mono text-foreground">{f.value}</dd>
          </div>
        ))}
      </dl>
      {seq === null ? (
        <p className="text-xs text-muted-foreground">
          This span was recorded before details were linked to the thread history.
        </p>
      ) : query.isLoading ? (
        <Spinner style={{ paddingBlock: 12 }} />
      ) : !detail ? (
        <p className="text-xs text-muted-foreground">The thread history no longer has this event.</p>
      ) : (
        detail.blocks.map((block, i) => <Block key={`${block.label}-${i}`} block={block} />)
      )}
    </div>
  );
}

function Block({ block }: { block: DetailBlock }) {
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const empty = block.content.trim().length === 0;
  const copy = () => {
    void navigator.clipboard?.writeText(block.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const lines = block.content.split("\n").length;

  return (
    <section className="overflow-hidden rounded-md border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border bg-muted/40 px-2.5 py-1 text-xs">
        <span className="font-medium text-foreground">{block.label}</span>
        {!empty && block.kind !== "diff" && <span className="text-muted-foreground tabular-nums">{lines} lines</span>}
        <span className="ml-auto flex items-center gap-1">
          {(block.kind === "text" || block.kind === "json") && !empty && (
            <button
              type="button"
              onClick={() => setWrap(!wrap)}
              className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {wrap ? "No wrap" : "Wrap"}
            </button>
          )}
          {!empty && (
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Icon name={copied ? "Check" : "Copy"} className="size-3" aria-hidden />
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </span>
      </header>
      {empty ? (
        <div className="px-2.5 py-2 text-xs italic text-muted-foreground">empty</div>
      ) : block.kind === "diff" ? (
        // bb's diff viewer is virtualized and can throw inside a small scroll
        // box; a plain patch view takes over instead of an error.
        <div className="max-h-96 overflow-auto text-xs">
          <Fallback fallback={<PatchView patch={block.content} />}>
            <Diff patch={block.content} path={block.path ?? "file"} view="unified" overflow="wrap" />
          </Fallback>
        </div>
      ) : block.kind === "code" ? (
        // Commands are short; a plain block avoids bb's virtualized file view,
        // which fails with "Line doesnt exist" inside a scrolling dialog.
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground">
          {block.content}
        </pre>
      ) : (
        <pre
          className={`max-h-96 overflow-auto px-2.5 py-2 font-mono text-xs leading-relaxed text-foreground ${
            wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"
          }`}
        >
          {block.content}
        </pre>
      )}
      {block.truncatedChars > 0 && (
        <div className="border-t border-border px-2.5 py-1 text-[11px] text-muted-foreground">
          {block.truncatedChars.toLocaleString()} more characters not shown
        </div>
      )}
    </section>
  );
}

/** A unified patch with added and removed lines tinted, for when bb's viewer fails. */
function PatchView({ patch }: { patch: string }) {
  return (
    <pre className="whitespace-pre-wrap break-all px-2.5 py-2 font-mono text-xs leading-relaxed">
      {patch.split("\n").map((line, i) => {
        const added = line.startsWith("+") && !line.startsWith("+++");
        const removed = line.startsWith("-") && !line.startsWith("---");
        const hunk = line.startsWith("@@");
        return (
          <div
            key={i}
            style={
              added
                ? { background: "color-mix(in oklab, var(--diff-added) 16%, transparent)" }
                : removed
                  ? { background: "color-mix(in oklab, var(--diff-removed) 16%, transparent)" }
                  : undefined
            }
            className={hunk || line.startsWith("+++") || line.startsWith("---") ? "text-muted-foreground" : "text-foreground"}
          >
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

/** Renders `fallback` if a child throws, so one bad block never blanks the panel. */
class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[tracing] diff viewer failed; showing the plain patch", error, info.componentStack);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
