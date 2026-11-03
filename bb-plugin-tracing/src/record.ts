// One line of trace.ndjson. The first five fields match OpenBot's
// logs/trace.ndjson (`at`, `kind`, `name`, `durationMs`, `outcome`), so tools
// written for that file read this one too; the rest is bb context.
export type TraceKind =
  | "turn"
  | "tool"
  | "interaction"
  | "provisioning"
  | "queue"
  | "thread"
  | "error"
  | "reasoning"
  | "message";

export interface TraceRecord {
  /** Span start, ISO 8601. Point events have durationMs 0. */
  at: string;
  kind: TraceKind;
  name: string;
  durationMs: number;
  outcome: string;
  threadId?: string;
  projectId?: string;
  /** The turn's `client/turn/requested` id; ties tool spans to their turn. */
  turnRequestId?: string;
  /** The provider turn id, the `turnId` bb's timeline gives each message. */
  turnId?: string;
  attrs?: Record<string, string | number | boolean | null>;
}

/** One line of resources.ndjson, sampled every minute like OpenBot's. */
export interface ResourceSample {
  at: string;
  rssMb: number;
  heapUsedMb: number;
  cpuPct: number;
  eventLoopMs: { p99: number; max: number };
  activeTurns: number;
  openSpans: number;
}
