// Shared pieces of the tracing UI: formatting, span colors, small widgets.
// Colors come from bb's theme variables so every palette and dark mode work.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { TraceRecord } from "../src/record.ts";

export type Span = TraceRecord;

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatAgo(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

export type Category =
  | "reasoning"
  | "message"
  | "generating"
  | "command"
  | "tool"
  | "file"
  | "web"
  | "wait"
  | "retry"
  | "other";

export function categoryOf(span: Span): Category {
  if (span.kind === "reasoning") return "reasoning";
  if (span.kind === "message") return span.name === "generating" ? "generating" : "message";
  if (span.kind === "queue" && span.name === "retrying") return "retry";
  if (span.kind === "interaction" || span.kind === "provisioning" || span.kind === "queue") return "wait";
  if (span.name.startsWith("command:")) return "command";
  if (span.name.startsWith("tool:")) return "tool";
  if (span.name === "fileChange" || span.name === "fileRead" || span.name === "listFiles") return "file";
  if (span.name === "webSearch" || span.name === "webFetch" || span.name === "search") return "web";
  return "other";
}

// One hue per kind of work, all from bb theme variables so light, dark and
// custom palettes stay legible. The model's own time is purple, getting
// lighter from thinking to answering to generating the next step.
const mix = (color: string, percent: number) => `color-mix(in oklab, ${color} ${percent}%, transparent)`;
const stripes = (color: string) =>
  `repeating-linear-gradient(135deg, ${mix(color, 60)} 0 3px, ${mix(color, 18)} 3px 6px)`;

export const CATEGORY: Record<Category, { label: string; icon: string; color: string }> = {
  reasoning: { label: "Thinking", icon: "Brain", color: "var(--pr-merged)" },
  message: { label: "Response", icon: "MessageSquare", color: mix("var(--pr-merged)", 55) },
  generating: { label: "Generating", icon: "MessageSquare", color: mix("var(--pr-merged)", 22) },
  command: { label: "Commands", icon: "ComputerTerminal01", color: "var(--timeline-accent)" },
  tool: { label: "Tools", icon: "ToolCase", color: "var(--success)" },
  file: { label: "Files", icon: "FileText", color: "var(--attention)" },
  web: { label: "Web", icon: "Globe", color: "var(--warning)" },
  wait: { label: "Waiting", icon: "TimeSchedule", color: mix("var(--muted-foreground)", 60) },
  retry: { label: "API retries", icon: "AlertTriangle", color: "var(--destructive)" },
  other: { label: "Other", icon: "Circle", color: "var(--muted-foreground)" },
};

/** The fill for one category, as the legend shows it. */
export function swatch(category: Category): CSSProperties {
  if (category === "wait") return { background: stripes("var(--muted-foreground)") };
  if (category === "retry") return { background: stripes("var(--destructive)") };
  return { background: CATEGORY[category].color };
}

/** The fill for a span's bar: its category's color, stripes for waits, red when it failed. */
export function paint(span: Span): CSSProperties {
  const category = categoryOf(span);
  return isError(span) && category !== "retry" ? { background: "var(--destructive)" } : swatch(category);
}

const OK = new Set(["ok", "completed", "resolved", "dispatched", "running"]);
export const isError = (span: Span) => !OK.has(span.outcome);

/** `command:npm` → `npm`, `tool:Read` → `Read`, `fileChange` → `File change`. */
export function displayName(span: Span): string {
  const [prefix, rest] = span.name.split(":", 2);
  if (rest && (prefix === "command" || prefix === "tool")) return rest;
  if (span.kind === "reasoning") return "Thinking";
  if (span.kind === "message") return span.name === "generating" ? "Generating" : "Response";
  if (span.kind === "provisioning") return "Workspace setup";
  if (span.kind === "queue" && span.name === "queued") return "Queued";
  if (span.kind === "queue" && span.name === "retrying") return `API retries ×${span.attrs?.attempts ?? "?"}`;
  if (span.kind === "interaction") return `Waiting for ${span.name}`;
  return span.name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

/** Re-renders every `ms` while `active`, for live durations. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

/** A running span's duration grows with the clock; a closed one is fixed. */
export function liveDuration(span: Span, now: number): number {
  return span.outcome === "running" ? Math.max(span.durationMs, now - Date.parse(span.at)) : span.durationMs;
}

export function Dot({ color, pulse, className = "" }: { color: string; pulse?: boolean; className?: string }) {
  return (
    <span className={`relative inline-flex size-2 shrink-0 ${className}`}>
      {pulse && (
        <span className="absolute inline-flex size-full animate-ping rounded-full opacity-60" style={{ background: color }} />
      )}
      <span className="relative inline-flex size-2 rounded-full" style={{ background: color }} />
    </span>
  );
}

export function OutcomePill({ outcome }: { outcome: string }) {
  const tone =
    outcome === "running"
      ? { color: "var(--timeline-accent)", label: "Running" }
      : OK.has(outcome)
        ? { color: "var(--success)", label: outcome === "completed" ? "Completed" : "OK" }
        : outcome === "interrupted"
          ? { color: "var(--warning)", label: "Interrupted" }
          : { color: "var(--destructive)", label: outcome[0]!.toUpperCase() + outcome.slice(1) };
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
      style={{ borderColor: `color-mix(in oklab, ${tone.color} 40%, transparent)`, color: tone.color }}
    >
      <Dot color={tone.color} pulse={outcome === "running"} />
      {tone.label}
    </span>
  );
}

export function Metric({ label, value, note, icon }: { label: string; value: ReactNode; note?: ReactNode; icon?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon && <Icon name={icon} className="size-3.5" aria-hidden />}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums text-foreground">{value}</div>
      {note && <div className="truncate text-xs text-muted-foreground tabular-nums">{note}</div>}
    </div>
  );
}

/** One whole split into colored shares, with a legend. */
export function ShareBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  if (total <= 0) return null;
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
        {shown.map((p) => (
          <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${formatMs(p.value)}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {shown.map((p) => (
          <span key={p.label} className="inline-flex items-center gap-1.5 tabular-nums">
            <Dot color={p.color} />
            {p.label}
            <span className="text-foreground">{formatMs(p.value)}</span>
            <span>{Math.round((p.value / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Sparkline({ values, color, height = 36 }: { values: number[]; color: string; height?: number }) {
  if (values.length < 2) return <div style={{ height }} className="text-xs text-muted-foreground">Collecting samples…</div>;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${100 - ((v - min) / span) * 92 - 4}`);
  const line = points.join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
      <polygon points={`0,100 ${line} 100,100`} style={{ fill: `color-mix(in oklab, ${color} 18%, transparent)` }} />
      <polyline points={line} fill="none" style={{ stroke: color }} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon name={icon} className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <div className="text-sm font-medium text-foreground">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function Spinner({ style }: { style?: CSSProperties }) {
  return (
    <div className="flex items-center justify-center py-12" style={style}>
      <Icon name="Loading" className="size-5 animate-spin text-muted-foreground" aria-hidden />
    </div>
  );
}
