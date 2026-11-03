// Turns a thread's raw event log into spans. Pure: no I/O, no clock, so the
// tests feed it recorded events and check the spans it emits.
import type { TraceRecord } from "./record.ts";

/** The slice of a bb thread event row the tracker reads. */
export interface RawEvent {
  seq: number;
  createdAt: number;
  type: string;
  data: unknown;
  /** `{ kind: "turn", turnId }` for events inside a provider turn. */
  scope?: unknown;
}

export type Detail = "names" | "full";

/** The event types the tracker consumes; the server lists only these. */
export const TRACKED_EVENT_TYPES = [
  "client/turn/requested",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "thread/contextWindowUsage/updated",
  "thread/tokenUsage/updated",
  "system/interaction/lifecycle",
  "system/thread-provisioning",
] as const;

interface OpenTurn {
  requestId: string | null;
  /** The provider turn id: what the timeline's messages carry as `turnId`. */
  turnId: string | null;
  requestedAt: number;
  startedAt: number | null;
  model: string | null;
  initiator: string | null;
  source: string | null;
  tools: number;
  toolErrors: number;
  toolMs: number;
  reasoningMs: number;
}

interface OpenSpan {
  startedAt: number;
  /** The `item/started` event's seq: where the UI reads a running item from. */
  seq?: number;
  kind: "tool" | "reasoning" | "message";
  name: string;
  attrs: Record<string, string | number | boolean | null>;
}

/** Per-thread state carried between batches; JSON so it survives a reload. */
export interface ThreadTraceState {
  turn: OpenTurn | null;
  items: Record<string, OpenSpan>;
  interactions: Record<string, Omit<OpenSpan, "kind">>;
  provisioning: Record<string, Omit<OpenSpan, "kind">>;
  usedTokens: number | null;
  contextWindow: number | null;
  costAmount: number | null;
  /**
   * The provider's token spend for the running turn (`tokenUsage.last`) and
   * the thread so far. bb sends it just before `turn/completed` and keeps only
   * the latest event, so it is captured here or lost.
   */
  tokens?: TokenSpend | null;
}

/** Token spend, in the attribute names a turn span carries. */
export interface TokenSpend {
  tokTotal: number;
  tokInput: number;
  tokCacheRead: number;
  tokCacheWrite: number;
  tokOutput: number;
  tokReasoning: number;
  tokThreadTotal: number | null;
}

/** Reads `thread/tokenUsage/updated`; null when it carries no per-turn numbers. */
export function tokenSpend(tokenUsage: unknown): TokenSpend | null {
  const usage = tokenUsage !== null && typeof tokenUsage === "object" ? (tokenUsage as Record<string, unknown>) : {};
  const last = usage.last !== null && typeof usage.last === "object" ? (usage.last as Record<string, unknown>) : null;
  if (!last) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const total = usage.total !== null && typeof usage.total === "object" ? (usage.total as Record<string, unknown>) : null;
  const cacheRead = n(last.cacheReadInputTokens);
  const cacheWrite = n(last.cacheWriteInputTokens);
  return {
    tokTotal: n(last.totalTokens),
    tokInput: n(last.inputTokens),
    // Providers that report only a combined cached figure count it as read.
    tokCacheRead: cacheRead || Math.max(0, n(last.cachedInputTokens) - cacheWrite),
    tokCacheWrite: cacheWrite,
    tokOutput: n(last.outputTokens),
    tokReasoning: n(last.reasoningOutputTokens),
    tokThreadTotal: total ? n(total.totalTokens) : null,
  };
}

export function emptyState(): ThreadTraceState {
  return {
    turn: null,
    items: {},
    interactions: {},
    provisioning: {},
    usedTokens: null,
    contextWindow: null,
    costAmount: null,
  };
}

/** The user's own message is not something the turn spent time on. */
const SKIPPED_ITEMS = new Set(["userMessage"]);
const COMMAND_PREVIEW_CHARS = 200;
/** Wrappers that run the next word as the program. */
const COMMAND_PREFIXES = new Set(["command", "exec", "sudo", "env", "time", "nohup", "nice"]);
/** A command that opens with a shell construct is shell code, not a program. */
const SHELL_KEYWORDS = new Set(["for", "while", "until", "if", "case", "{", "("]);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v !== null && typeof v === "object" ? (v as Obj) : {};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The program a shell command runs, skipping `cd …` and env assignments:
 * `cd x && FOO=1 command npm test` → `npm`. Only the program name is recorded unless
 * detail is "full", so arguments (paths, tokens) stay out of the trace.
 */
export function commandProgram(command: string): string {
  for (const part of command.split(/&&|\|\||;|\|/)) {
    // `$(find …)`, `"$x"`: the program is the first bare word.
    const words = part.trim().replace(/^[$(`"'{]+/, "").split(/\s+/).filter(Boolean);
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
      words.shift();
    }
    while (words.length > 1 && COMMAND_PREFIXES.has(words[0]!)) words.shift();
    const program = words[0];
    if (!program || program === "cd") continue;
    if (SHELL_KEYWORDS.has(program)) return "shell";
    return program.split("/").pop() ?? program;
  }
  return "sh";
}

function describeItem(item: Obj, detail: Detail): Omit<OpenSpan, "startedAt"> {
  const type = str(item.type) ?? "unknown";
  if (type === "reasoning") return { kind: "reasoning", name: "reasoning", attrs: {} };
  if (type === "agentMessage") return { kind: "message", name: "response", attrs: {} };
  if (type === "commandExecution") {
    const command = str(item.command) ?? "";
    return {
      kind: "tool",
      name: `command:${commandProgram(command)}`,
      attrs: detail === "full" ? { command: command.slice(0, COMMAND_PREVIEW_CHARS) } : {},
    };
  }
  if (type === "toolCall") {
    return { kind: "tool", name: `tool:${str(item.tool) ?? "unknown"}`, attrs: {} };
  }
  if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes.length : null;
    return { kind: "tool", name: "fileChange", attrs: { files: changes } };
  }
  return { kind: "tool", name: type, attrs: {} };
}

function itemOutcome(item: Obj): string {
  const exitCode = num(item.exitCode);
  if (exitCode !== null && exitCode !== 0) return "error";
  const status = str(item.status);
  if (status === "failed" || status === "declined") return status;
  return "ok";
}

/** A turn still running: its spans so far, the open ones ending at `now`. */
export interface LiveTurn {
  turn: TraceRecord;
  spans: TraceRecord[];
}

export class ThreadTracker {
  readonly threadId: string;
  state: ThreadTraceState;
  private readonly detail: () => Detail;
  private readonly projectId: string | undefined;

  constructor(
    threadId: string,
    state: ThreadTraceState,
    detail: () => Detail,
    projectId?: string,
  ) {
    this.threadId = threadId;
    this.state = state;
    this.detail = detail;
    this.projectId = projectId;
  }

  /** Feeds events in seq order; returns the spans they closed. */
  consume(events: readonly RawEvent[]): TraceRecord[] {
    const out: TraceRecord[] = [];
    for (const event of events) this.apply(event, out);
    return out;
  }

  get activeTurn(): boolean {
    return this.state.turn !== null;
  }

  get openSpans(): number {
    const s = this.state;
    return (
      Object.keys(s.items).length +
      Object.keys(s.interactions).length +
      Object.keys(s.provisioning).length
    );
  }

  /**
   * The running turn as of `now`: a provisional turn span (outcome
   * "running") and its still-open spans, each running up to `now`. Spans the
   * turn already closed were emitted and are found by `turnRequestId`.
   */
  live(now: number): LiveTurn | null {
    const turn = this.state.turn;
    if (!turn) return null;
    const open = Object.values(this.state.items)
      .filter((span) => span.startedAt <= now)
      .map((span) =>
        this.record(span.kind, span.name, span.startedAt, now, "running", {
          ...span.attrs,
          ...(span.seq !== undefined ? { seq: span.seq } : {}),
        }),
      );
    return {
      turn: this.turnRecord(turn, now, "running"),
      spans: open,
    };
  }

  private record(
    kind: TraceRecord["kind"],
    name: string,
    startedAt: number,
    endedAt: number,
    outcome: string,
    attrs?: TraceRecord["attrs"],
  ): TraceRecord {
    const turn = this.state.turn;
    return {
      at: iso(startedAt),
      kind,
      name,
      durationMs: Math.max(0, endedAt - startedAt),
      outcome,
      threadId: this.threadId,
      ...(this.projectId ? { projectId: this.projectId } : {}),
      ...(turn?.requestId ? { turnRequestId: turn.requestId } : {}),
      ...(turn?.turnId ? { turnId: turn.turnId } : {}),
      ...(attrs && Object.keys(attrs).length > 0 ? { attrs } : {}),
    };
  }

  private turnRecord(turn: OpenTurn, endedAt: number, outcome: string): TraceRecord {
    const s = this.state;
    return this.record("turn", "turn", turn.requestedAt, endedAt, outcome, {
      model: turn.model,
      initiator: turn.initiator,
      source: turn.source,
      startLatencyMs: turn.startedAt !== null ? turn.startedAt - turn.requestedAt : null,
      tools: turn.tools,
      toolErrors: turn.toolErrors,
      toolMs: turn.toolMs,
      reasoningMs: turn.reasoningMs,
      usedTokens: s.usedTokens,
      contextWindow: s.contextWindow,
      ...(s.costAmount !== null ? { costAmount: s.costAmount } : {}),
      ...(s.tokens ?? {}),
    });
  }

  private apply(event: RawEvent, out: TraceRecord[]): void {
    const data = obj(event.data);
    const scopeTurnId = str(obj(event.scope).turnId);
    const at = event.createdAt;
    const s = this.state;
    const newTurn = (requestId: string | null): OpenTurn => ({
      requestId,
      turnId: null,
      requestedAt: at,
      startedAt: null,
      model: null,
      initiator: null,
      source: null,
      tools: 0,
      toolErrors: 0,
      toolMs: 0,
      reasoningMs: 0,
    });
    switch (event.type) {
      case "client/turn/requested": {
        const execution = obj(data.execution);
        s.tokens = null;
        s.turn = {
          ...newTurn(str(data.requestId)),
          model: str(execution.model),
          initiator: str(data.initiator),
          source: str(data.source),
        };
        return;
      }
      case "turn/started": {
        // A nested turn (a subagent) carries parentToolCallId; it belongs to
        // the outer turn's span, not a new one.
        if (str(data.parentToolCallId)) return;
        if (!s.turn) {
          s.tokens = null;
          s.turn = newTurn(null);
          }
        s.turn.startedAt ??= at;
        s.turn.turnId ??= scopeTurnId;
        return;
      }
      case "item/started": {
        const item = obj(data.item);
        const id = str(item.id);
        if (!id || SKIPPED_ITEMS.has(str(item.type) ?? "")) return;
        if (s.turn && !s.turn.turnId) s.turn.turnId = scopeTurnId;
        s.items[id] = { startedAt: at, seq: event.seq, ...describeItem(item, this.detail()) };
        return;
      }
      case "item/completed": {
        const item = obj(data.item);
        const id = str(item.id);
        if (!id) return;
        const open = s.items[id];
        delete s.items[id];
        // A start we never saw (it predates the install): duration unknown.
        if (!open) return;
        const duration = at - open.startedAt;
        if (open.kind === "message") {
          out.push(this.record("message", "response", open.startedAt, at, "ok", { seq: event.seq }));
          return;
        }
        if (open.kind === "reasoning") {
          if (s.turn) s.turn.reasoningMs += duration;
          out.push(this.record("reasoning", "reasoning", open.startedAt, at, "ok", { seq: event.seq }));
          return;
        }
        // Only the event's seq is stored. The command, output, arguments and
        // diff stay in bb's own thread history; the UI reads them from there.
        const attrs: OpenSpan["attrs"] = { ...open.attrs, seq: event.seq };
        const exitCode = num(item.exitCode);
        if (exitCode !== null) attrs.exitCode = exitCode;
        const outcome = itemOutcome(item);
        if (s.turn) {
          s.turn.tools += 1;
          s.turn.toolMs += duration;
          if (outcome !== "ok") s.turn.toolErrors += 1;
        }
        out.push(this.record("tool", open.name, open.startedAt, at, outcome, attrs));
        return;
      }
      case "thread/tokenUsage/updated": {
        s.tokens = tokenSpend(data.tokenUsage);
        return;
      }
      case "thread/contextWindowUsage/updated": {
        const usage = obj(data.contextWindowUsage);
        s.usedTokens = num(usage.usedTokens) ?? s.usedTokens;
        s.contextWindow = num(usage.modelContextWindow) ?? s.contextWindow;
        s.costAmount = num(obj(usage.cost).amount) ?? s.costAmount;
        return;
      }
      case "turn/completed": {
        const turn = s.turn;
        // Items the provider never closed end with the turn.
        for (const [id, open] of Object.entries(s.items)) {
          delete s.items[id];
          out.push(this.record(open.kind, open.name, open.startedAt, at, "abandoned", open.attrs));
        }
        if (!turn) return; // began before the install
        turn.turnId ??= scopeTurnId;
        const record = this.turnRecord(turn, at, str(data.status) ?? "completed");
        const message = str(obj(data.error).message);
        if (message && this.detail() === "full") record.attrs!.error = message.slice(0, 500);
        out.push(record);
        s.turn = null;
        return;
      }
      case "system/interaction/lifecycle": {
        const interaction = obj(data.interaction);
        const id = str(interaction.id);
        const status = str(interaction.status);
        if (!id) return;
        const kind = str(obj(interaction.payload).kind) ?? "interaction";
        if (status === "pending") {
          s.interactions[id] ??= { startedAt: at, name: kind, attrs: {} };
          return;
        }
        if (status === "resolved" || status === "interrupted") {
          const open = s.interactions[id];
          delete s.interactions[id];
          if (!open) return;
          out.push(this.record("interaction", open.name, open.startedAt, at, status));
        }
        return;
      }
      case "system/thread-provisioning": {
        const id = str(data.provisioningId);
        const status = str(data.status);
        if (!id) return;
        if (status === "active") {
          s.provisioning[id] ??= { startedAt: at, name: "workspace", attrs: {} };
          return;
        }
        const open = s.provisioning[id];
        delete s.provisioning[id];
        if (!open) return;
        out.push(
          this.record("provisioning", "workspace", open.startedAt, at, status ?? "unknown"),
        );
        return;
      }
    }
  }
}
