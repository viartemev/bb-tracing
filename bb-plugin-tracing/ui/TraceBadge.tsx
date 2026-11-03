// A chip in each answer's action row: how long the turn took and how many
// tools it ran. Clicking it opens that turn's trace viewer.
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
  type ExperimentalMessageMetadataProps,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../src/contract.ts";
import { Dot, formatMs, liveDuration, useNow } from "./common.tsx";
import { TraceDialog } from "./TraceDialog.tsx";

export const TRACE_TAB = { id: "turn-trace", context: { kind: "thread" }, availability: "action" } as const;

// A turn can have several assistant messages; only its latest one carries the
// chip. Mounted chips register here and the newest per turn wins.
const mounted = new Map<string, Map<string, number>>();
const listeners = new Set<() => void>();
let version = 0;
const store = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: () => version,
  set(turnId: string, messageId: string, createdAt: number | null) {
    const messages = mounted.get(turnId) ?? new Map<string, number>();
    if (createdAt === null) messages.delete(messageId);
    else messages.set(messageId, createdAt);
    if (messages.size === 0) mounted.delete(turnId);
    else mounted.set(turnId, messages);
    version++;
    for (const listener of listeners) listener();
  },
  isLatest(turnId: string, messageId: string) {
    const messages = mounted.get(turnId);
    if (!messages) return false;
    let latest: [string, number] | null = null;
    for (const entry of messages) if (!latest || entry[1] > latest[1]) latest = entry;
    return latest?.[0] === messageId;
  },
};

export function TraceBadge({ message }: ExperimentalMessageMetadataProps) {
  if (message.role !== "assistant" || !message.turnId) return null;
  return <Badge threadId={message.threadId} turnId={message.turnId} messageId={message.id} createdAt={message.createdAt} />;
}

function Badge({ threadId, turnId, messageId, createdAt }: { threadId: string; turnId: string; messageId: string; createdAt: number }) {
  useEffect(() => {
    store.set(turnId, messageId, createdAt);
    return () => store.set(turnId, messageId, null);
  }, [turnId, messageId, createdAt]);
  useSyncExternalStore(store.subscribe, store.snapshot);
  const latest = store.isLatest(turnId, messageId);

  const [open, setOpen] = useState(false);
  const query = useRpcQuery({ contract: rpcContract, method: "turn", input: { threadId, turnId }, enabled: latest });
  const view = query.data?.view ?? null;
  const now = useNow(view?.running ?? false);
  if (!latest || !view) return null;

  const tools = view.spans.filter((s) => s.kind === "tool");
  const failed = tools.filter((s) => s.outcome !== "ok" && s.outcome !== "running").length;
  const duration = liveDuration(view.turn, now);
  const tone = view.running
    ? "var(--timeline-accent)"
    : failed > 0 || view.turn.outcome !== "completed"
      ? "var(--destructive)"
      : "var(--success)";

  return (
    <TraceDialog threadId={threadId} turnId={turnId} open={open} onOpenChange={setOpen}>
      <button
        type="button"
        title="Open this turn's trace"
        className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Icon name="tracing/activity" className="size-3.5" aria-hidden />
        <span className="text-foreground">{formatMs(duration)}</span>
        <span aria-hidden>·</span>
        <span>
          {tools.length} {tools.length === 1 ? "tool" : "tools"}
        </span>
        {failed > 0 && <span className="text-destructive">{failed} failed</span>}
        <Dot color={tone} pulse={view.running} />
      </button>
    </TraceDialog>
  );
}
