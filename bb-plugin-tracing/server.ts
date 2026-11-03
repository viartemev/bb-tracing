// bb-plugin-tracing — local tracing for bb, modelled on OpenBot's
// logs/trace.ndjson + logs/resources.ndjson.
//
// Spans come from two places:
// - each thread's event log (turns, tool calls, interactions, workspace
//   provisioning), read incrementally after `experimental_thread.events`
//   says the thread's sequence advanced;
// - lifecycle announcements (thread created/archived/deleted, failed turns,
//   queued messages).
// A background service samples the server process once a minute.
import { dirname, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { NdjsonSink, readNdjson } from "./src/ndjson.ts";
import type { ResourceSample, TraceRecord } from "./src/record.ts";
import { formatMs, summarize, table, waterfall } from "./src/summary.ts";
import {
  TRACKED_EVENT_TYPES,
  ThreadTracker,
  emptyState,
  type Detail,
  type RawEvent,
  type ThreadTraceState,
  tokenSpend,
} from "./src/tracker.ts";
import { TraceIndex } from "./src/views.ts";
import { itemDetail, itemSize, itemTitle } from "./src/details.ts";
import { providerErrorSpan } from "./src/errors.ts";
import { rpcContract } from "./src/contract.ts";

export { rpcContract };

// bb caps one events.list page at 100 rows.
const PAGE_SIZE = 100;
const SAMPLE_INTERVAL_MS = 60_000;
const MAX_TAIL = 1000;

interface StoredThread {
  cursor: number;
  state: ThreadTraceState;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Record traces", default: true },
    detail: {
      type: "select",
      label: "Span detail",
      options: ["names", "full"],
      experimental_optionLabels: {
        names: "Names only (default): program and tool names, no arguments",
        full: "Full: also the first 200 characters of each command and turn errors",
      },
      default: "names",
    },
    maxFileMb: {
      type: "number",
      label: "Rotate each file at (MB)",
      default: 5,
    },
    sampleResources: {
      type: "boolean",
      label: "Sample server resources every minute",
      default: true,
    },
  });
  let config = await settings.get();
  settings.onChange((next) => {
    config = next;
  });

  // Trace files live next to the plugin's own data.db.
  const db = bb.storage.database();
  const dir = join(dirname(db.name), "logs");
  const maxBytes = () => Math.max(0.1, config.maxFileMb) * 1024 * 1024;
  const onWriteError = (error: unknown) =>
    bb.log.error(`trace write failed: ${String(error)}`);
  const traceFile = new NdjsonSink(join(dir, "trace.ndjson"), maxBytes, onWriteError);
  const resourceFile = new NdjsonSink(join(dir, "resources.ndjson"), maxBytes, onWriteError);

  // Recent spans in memory for the UI; the file is the durable copy.
  const index = new TraceIndex();
  index.load(await readNdjson<TraceRecord>(traceFile.path));
  const resources: ResourceSample[] = (await readNdjson<ResourceSample>(resourceFile.path)).slice(-240);

  // Open views refresh through tags: a thread's views when its spans change,
  // the overview at most every few seconds.
  const dirtyThreads = new Set<string>();
  let overviewDirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const markDirty = (threadId?: string) => {
    if (threadId) dirtyThreads.add(threadId);
    overviewDirty = true;
    flushTimer ??= setTimeout(() => {
      flushTimer = null;
      const tags = [...dirtyThreads].map((id) => `thread:${id}`);
      if (overviewDirty) tags.push("overview");
      dirtyThreads.clear();
      overviewDirty = false;
      if (tags.length > 0) bb.rpc.experimental_invalidate(tags);
    }, 750);
  };

  const emit = (record: TraceRecord) => {
    if (!config.enabled) return;
    void traceFile.write(record);
    index.push(record);
    markDirty(record.threadId);
  };

  // Events older than the first load are history, not traces.
  let installedAt = await bb.storage.kv.get<number>("installedAt");
  if (installedAt == null) {
    installedAt = Date.now();
    await bb.storage.kv.set("installedAt", installedAt);
  }

  // ---- thread event log → spans ------------------------------------------

  const trackers = new Map<string, { tracker: ThreadTracker; cursor: number }>();
  const chains = new Map<string, Promise<void>>();
  const pendingSeq = new Map<string, number>();

  async function loadTracker(threadId: string, projectId: string) {
    const cached = trackers.get(threadId);
    if (cached) return cached;
    const stored = await bb.storage.kv.get<StoredThread>(`thread:${threadId}`);
    const entry = {
      tracker: new ThreadTracker(
        threadId,
        stored?.state ?? emptyState(),
        () => config.detail as Detail,
        projectId,
      ),
      cursor: stored?.cursor ?? 0,
    };
    trackers.set(threadId, entry);
    return entry;
  }

  async function catchUp(threadId: string, projectId: string, signal?: AbortSignal) {
    const entry = await loadTracker(threadId, projectId);
    const target = pendingSeq.get(threadId) ?? 0;
    pendingSeq.delete(threadId);
    for (;;) {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        afterSeq: String(entry.cursor),
        limit: String(PAGE_SIZE),
        order: "asc",
        types: TRACKED_EVENT_TYPES,
        signal,
      });
      const events = (rows as unknown as RawEvent[]).filter(
        (event) => event.createdAt >= installedAt!,
      );
      for (const record of entry.tracker.consume(events)) emit(record);
      const last = rows.at(-1) as RawEvent | undefined;
      if (last) entry.cursor = last.seq;
      if (rows.length < PAGE_SIZE) break;
    }
    // Everything up to the announced sequence has been read, matching or not.
    entry.cursor = Math.max(entry.cursor, target);
    // A running turn's view changes with every batch, closed spans or not.
    if (entry.tracker.activeTurn) markDirty(threadId);
    await bb.storage.kv.set(`thread:${threadId}`, {
      cursor: entry.cursor,
      state: entry.tracker.state,
    } satisfies StoredThread);
  }

  function schedule(threadId: string, projectId: string, sequence: number) {
    pendingSeq.set(threadId, Math.max(pendingSeq.get(threadId) ?? 0, sequence));
    if (chains.has(threadId)) return; // the running pass picks it up below
    const run = async () => {
      try {
        while (pendingSeq.has(threadId)) await catchUp(threadId, projectId);
      } catch (error) {
        bb.log.warn(`tracing ${threadId}: ${String(error)}`);
      } finally {
        chains.delete(threadId);
      }
    };
    chains.set(threadId, run());
  }

  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    if (!config.enabled) return;
    schedule(thread.id, thread.projectId, sequence);
  });

  // ---- lifecycle announcements → point spans ------------------------------

  const point = (
    kind: TraceRecord["kind"],
    name: string,
    outcome: string,
    thread: { id: string; projectId?: string },
    attrs?: TraceRecord["attrs"],
  ) =>
    emit({
      at: new Date().toISOString(),
      kind,
      name,
      durationMs: 0,
      outcome,
      threadId: thread.id,
      ...(thread.projectId ? { projectId: thread.projectId } : {}),
      ...(attrs ? { attrs } : {}),
    });

  bb.events.on("thread.created", ({ thread }) => point("thread", "created", "ok", thread));
  bb.events.on("thread.archived", ({ thread }) => point("thread", "archived", "ok", thread));
  bb.events.on("thread.deleted", ({ thread }) => {
    point("thread", "deleted", "ok", thread);
    trackers.delete(thread.id);
    void bb.storage.kv.delete(`thread:${thread.id}`);
  });
  bb.events.on("turn.failed", (event) =>
    point("error", event.errorInfo?.category ?? "unknown", "failed", { id: event.threadId }, {
      turnRequestId: event.requestId,
      attemptNumber: event.attemptNumber,
      inputAccepted: event.inputAccepted,
      httpStatusCode: event.errorInfo?.httpStatusCode ?? null,
      providerCode: event.errorInfo?.providerCode ?? null,
    }),
  );

  // A queued message is a span from queueing to dispatch or removal; its name
  // is what it waited on (thread-busy, provisioning, a plugin, a time…).
  const queued = new Map<string, { startedAt: number; name: string }>();
  bb.events.on("message.queued", ({ entry }) => {
    const name = entry.waitingOn?.kind ?? (entry.sendAt ? "time" : "queued");
    const open = queued.get(entry.id);
    queued.set(entry.id, { startedAt: open?.startedAt ?? entry.createdAt, name });
  });
  const closeQueued = (id: string, threadId: string, outcome: string) => {
    const open = queued.get(id);
    if (!open) return;
    queued.delete(id);
    emit({
      at: new Date(open.startedAt).toISOString(),
      kind: "queue",
      name: open.name,
      durationMs: Date.now() - open.startedAt,
      outcome,
      threadId,
    });
  };
  bb.events.on("message.dispatched", ({ entry }) => closeQueued(entry.id, entry.threadId, "dispatched"));
  bb.events.on("message.cancelled", ({ entry }) => closeQueued(entry.id, entry.threadId, "cancelled"));

  // ---- resources.ndjson ----------------------------------------------------

  bb.background.service("resources", {
    async start(signal) {
      const loop = monitorEventLoopDelay({ resolution: 20 });
      loop.enable();
      let lastCpu = process.cpuUsage();
      let lastAt = performance.now();
      try {
        while (!signal.aborted) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, SAMPLE_INTERVAL_MS);
            signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
          });
          if (signal.aborted || !config.enabled || !config.sampleResources) {
            loop.reset();
            continue;
          }
          const cpu = process.cpuUsage(lastCpu);
          const now = performance.now();
          const memory = process.memoryUsage();
          const trackerList = [...trackers.values()].map((e) => e.tracker);
          const sample: ResourceSample = {
            at: new Date().toISOString(),
            rssMb: Math.round(memory.rss / 1048576),
            heapUsedMb: Math.round(memory.heapUsed / 1048576),
            cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / (now - lastAt)) * 1000) / 10,
            eventLoopMs: {
              p99: Math.round(loop.percentile(99) / 1e6),
              max: Math.round(loop.max / 1e6),
            },
            activeTurns: trackerList.filter((t) => t.activeTurn).length,
            openSpans: trackerList.reduce((sum, t) => sum + t.openSpans, 0),
          };
          void resourceFile.write(sample);
          resources.push(sample);
          if (resources.length > 240) resources.splice(0, resources.length - 240);
          markDirty();
          loop.reset();
          lastCpu = process.cpuUsage();
          lastAt = now;
        }
      } finally {
        loop.disable();
      }
    },
  });

  // ---- RPC for the UI -------------------------------------------------------

  const liveTurn = (threadId: string) => trackers.get(threadId)?.tracker.live(Date.now()) ?? null;
  const titles = new Map<string, string | null>();
  async function threadTitles(ids: string[]) {
    const missing = [...new Set(ids)].filter((id) => !titles.has(id)).slice(0, 200);
    if (missing.length > 0) {
      const threads = await bb.sdk.threads
        .list({ threadIds: missing, includeHidden: true, limit: missing.length })
        .catch(() => []);
      for (const id of missing) titles.set(id, null);
      for (const thread of threads) titles.set(thread.id, thread.title);
    }
    return titles;
  }

  // Item titles never change once written, so they are cached by seq.
  const titleCache = new Map<string, string>();
  const TITLE_CACHE_MAX = 20_000;
  const MAX_TITLE_EVENTS = 5_000;
  type ItemEvent = { seq: number; data: unknown };
  const itemOf = (event: ItemEvent | undefined) =>
    event ? ((event.data as { item?: Record<string, unknown> } | null)?.item ?? null) : null;

  async function spanTitles(threadId: string, seqs: number[]) {
    const titles: Record<string, string> = {};
    const missing = seqs.filter((seq) => {
      const hit = titleCache.get(`${threadId}:${seq}`);
      if (hit !== undefined) titles[seq] = hit;
      return hit === undefined;
    });
    if (missing.length === 0) return titles;
    const wanted = new Set(missing);
    const last = Math.max(...missing);
    let cursor = Math.min(...missing) - 1;
    for (let read = 0; cursor < last && read < MAX_TITLE_EVENTS; read += PAGE_SIZE) {
      const rows = (await bb.sdk.threads.events.list({
        threadId,
        afterSeq: String(cursor),
        limit: String(PAGE_SIZE),
        order: "asc",
        types: ["item/started", "item/completed"],
      })) as unknown as ItemEvent[];
      for (const row of rows) {
        if (!wanted.has(row.seq)) continue;
        const item = itemOf(row);
        if (!item) continue;
        const title = itemTitle(item);
        titles[row.seq] = title;
        if (titleCache.size >= TITLE_CACHE_MAX) titleCache.clear();
        titleCache.set(`${threadId}:${row.seq}`, title);
      }
      if (rows.length < PAGE_SIZE) break;
      cursor = rows.at(-1)!.seq;
    }
    return titles;
  }

  // bb keeps only the newest token-usage event. If the tracker missed it (the
  // plugin was reloading as the turn ended), it can still be read back for
  // the thread's latest turn.
  async function withLatestSpend(threadId: string, turn: TraceRecord): Promise<TraceRecord> {
    const [row] = (await bb.sdk.threads.events
      .list({ threadId, types: ["thread/tokenUsage/updated"], order: "desc", limit: "1" })
      .catch(() => [])) as unknown as { data: unknown; scope?: { turnId?: string } }[];
    if (!row || row.scope?.turnId !== turn.turnId) return turn;
    const spend = tokenSpend((row.data as { tokenUsage?: unknown } | null)?.tokenUsage);
    return spend ? { ...turn, attrs: { ...turn.attrs, ...spend } } : turn;
  }

  // Provider errors (API retries) are read from the thread history inside the
  // turn's time window, so turns traced before this existed show them too.
  // A finished turn's errors never change and are cached.
  const errorCache = new Map<string, TraceRecord[]>();
  async function turnErrors(threadId: string, view: { turn: TraceRecord; running: boolean }) {
    const key = `${threadId}:${view.turn.turnId}`;
    const cached = errorCache.get(key);
    if (cached) return cached;
    const from = Date.parse(view.turn.at);
    const to = view.running ? Date.now() : from + view.turn.durationMs;
    const rows = (await bb.sdk.threads.events
      .list({ threadId, types: ["provider/error"], order: "desc", limit: String(PAGE_SIZE) })
      .catch(() => [])) as unknown as { seq: number; createdAt: number; data: unknown }[];
    const errors = rows
      .filter((row) => row.createdAt >= from && row.createdAt <= to)
      .map((row) => ({ ...providerErrorSpan(row), threadId, ...(view.turn.turnId ? { turnId: view.turn.turnId } : {}) }));
    if (!view.running) {
      if (errorCache.size > 2000) errorCache.clear();
      errorCache.set(key, errors);
    }
    return errors;
  }

  bb.rpc.register(rpcContract, {
    async spanTitles({ threadId, seqs }) {
      return { titles: await spanTitles(threadId, seqs) };
    },
    async gapContext({ threadId, prevSeq, nextSeq }) {
      const read = async (seq: number | null) => {
        if (seq === null) return null;
        const [row] = (await bb.sdk.threads.events.list({
          threadId,
          afterSeq: String(seq - 1),
          limit: "1",
          order: "asc",
        })) as unknown as ItemEvent[];
        const item = row?.seq === seq ? itemOf(row) : null;
        return item ? itemSize(item) : null;
      };
      const [prev, next] = await Promise.all([read(prevSeq), read(nextSeq)]);
      return { prev, next };
    },
    async spanDetail({ threadId, seq }) {
      const [row] = (await bb.sdk.threads.events.list({
        threadId,
        afterSeq: String(seq - 1),
        limit: "1",
        order: "asc",
      })) as unknown as ItemEvent[];
      const item = row?.seq === seq ? itemOf(row) : null;
      return { detail: item ? itemDetail(item) : null };
    },
    async turn({ threadId, turnId }) {
      const view = index.turn(threadId, turnId, liveTurn(threadId));
      if (!view) return { view };
      const turn = view.turn.attrs?.tokTotal === undefined && !view.running ? await withLatestSpend(threadId, view.turn) : view.turn;
      return { view: { ...view, turn, spans: [...view.spans, ...(await turnErrors(threadId, view))] } };
    },
    threadTurns({ threadId }) {
      return { turns: index.threadTurns(threadId, liveTurn(threadId)) };
    },
    async overview({ windowHours }) {
      const overview = index.overview(Date.now(), windowHours * 3_600_000);
      const names = await threadTitles(overview.recentTurns.flatMap((t) => (t.threadId ? [t.threadId] : [])));
      return {
        ...overview,
        recentTurns: overview.recentTurns.map((t) => ({
          ...t,
          threadTitle: (t.threadId && names.get(t.threadId)) || null,
        })),
        resources: resources.slice(-120),
        tracePath: traceFile.path,
      };
    },
  });

  bb.onDispose(async () => {
    if (flushTimer) clearTimeout(flushTimer);
    await Promise.allSettled(chains.values());
    await Promise.all([traceFile.flush(), resourceFile.flush()]);
  });

  // ---- bb tracing CLI ------------------------------------------------------

  async function readTraces(filter: {
    sinceMs?: number;
    threadId?: string;
    kind?: string;
  }): Promise<TraceRecord[]> {
    const from = filter.sinceMs ? Date.now() - filter.sinceMs : 0;
    return index.all().filter(
      (r) =>
        (!filter.threadId || r.threadId === filter.threadId) &&
        (!filter.kind || r.kind === filter.kind) &&
        Date.parse(r.at) >= from,
    );
  }

  const threadOption = {
    type: "string",
    aliases: ["thread-id"],
    description: "Only spans of this thread (thr_…). Use --self for the calling thread.",
  } as const;
  const selfOption = {
    type: "boolean",
    description: "Only spans of the thread running this command",
  } as const;
  const kindOption = {
    type: "enum",
    values: ["turn", "tool", "reasoning", "message", "interaction", "provisioning", "queue", "thread", "error"],
    description: "Only spans of this kind",
  } as const;
  const jsonOption = { type: "boolean", description: "Emit machine-readable JSON" } as const;

  function resolveThread(options: { thread?: string; self?: boolean }, threadId?: string) {
    if (!options.self) return options.thread;
    if (!threadId) {
      throw new PluginCliError("--self needs to run inside a bb thread", {
        code: "no_thread",
        hint: "Pass --thread thr_… instead.",
      });
    }
    return threadId;
  }

  bb.cli.register(
    defineCli({
      name: "tracing",
      summary: "Read bb traces: turn, tool, interaction and queue spans, and resource samples",
      commands: {
        summary: cliCommand({
          summary: "Count, p50, p95 and max duration per span kind and name",
          options: {
            since: {
              type: "duration",
              defaultUnit: "h",
              default: 24 * 3_600_000,
              description: "Look back this far (default 24h; e.g. 30m, 7d)",
            },
            thread: threadOption,
            self: selfOption,
            kind: kindOption,
            json: jsonOption,
          },
          async run({ options }, ctx) {
            const records = await readTraces({
              sinceMs: options.since,
              threadId: resolveThread(options, ctx.threadId),
              kind: options.kind,
            });
            const stats = summarize(records);
            if (options.json) return { exitCode: 0, stdout: JSON.stringify(stats) };
            if (stats.length === 0) return { exitCode: 0, stdout: "No spans recorded in that window." };
            return {
              exitCode: 0,
              stdout: table([
                ["KIND", "NAME", "COUNT", "ERR", "P50", "P95", "MAX", "TOTAL"],
                ...stats.map((s) => [
                  s.kind,
                  s.name,
                  String(s.count),
                  String(s.errors),
                  formatMs(s.p50Ms),
                  formatMs(s.p95Ms),
                  formatMs(s.maxMs),
                  formatMs(s.totalMs),
                ]),
              ]),
            };
          },
        }),
        tail: cliCommand({
          summary: "The most recent spans, newest last",
          options: {
            lines: {
              type: "integer",
              min: 1,
              max: MAX_TAIL,
              default: 20,
              aliases: ["n", "limit"],
              description: `How many spans (1-${MAX_TAIL}, default 20)`,
            },
            thread: threadOption,
            self: selfOption,
            kind: kindOption,
            json: jsonOption,
          },
          async run({ options }, ctx) {
            const records = (
              await readTraces({ threadId: resolveThread(options, ctx.threadId), kind: options.kind })
            ).slice(-options.lines);
            if (options.json) {
              return { exitCode: 0, stdout: records.map((r) => JSON.stringify(r)).join("\n") };
            }
            if (records.length === 0) return { exitCode: 0, stdout: "No spans recorded yet." };
            return {
              exitCode: 0,
              stdout: table([
                ["AT", "KIND", "NAME", "DURATION", "OUTCOME", "THREAD"],
                ...records.map((r) => [
                  r.at,
                  r.kind,
                  r.name,
                  formatMs(r.durationMs),
                  r.outcome,
                  r.threadId ?? "",
                ]),
              ]),
            };
          },
        }),
        turns: cliCommand({
          summary: "Waterfall of the latest turns with their tool spans",
          options: {
            lines: {
              type: "integer",
              min: 1,
              max: 50,
              default: 3,
              aliases: ["n", "limit"],
              description: "How many turns (1-50, default 3)",
            },
            thread: threadOption,
            self: selfOption,
          },
          async run({ options }, ctx) {
            const records = await readTraces({ threadId: resolveThread(options, ctx.threadId) });
            const turns = records.filter((r) => r.kind === "turn").slice(-options.lines);
            if (turns.length === 0) return { exitCode: 0, stdout: "No completed turns recorded yet." };
            const blocks = turns.map((turn) =>
              waterfall(
                turn,
                records.filter(
                  (r) =>
                    r.kind === "tool" &&
                    r.threadId === turn.threadId &&
                    r.turnRequestId === turn.turnRequestId,
                ),
              ),
            );
            return { exitCode: 0, stdout: blocks.join("\n\n") };
          },
        }),
        resources: cliCommand({
          summary: "The latest per-minute resource samples of the bb server process",
          options: {
            lines: {
              type: "integer",
              min: 1,
              max: MAX_TAIL,
              default: 10,
              aliases: ["n", "limit"],
              description: `How many samples (1-${MAX_TAIL}, default 10)`,
            },
            json: jsonOption,
          },
          async run({ options }) {
            await resourceFile.flush();
            const samples = (await readNdjson<ResourceSample>(resourceFile.path)).slice(-options.lines);
            if (options.json) {
              return { exitCode: 0, stdout: samples.map((s) => JSON.stringify(s)).join("\n") };
            }
            if (samples.length === 0) {
              return { exitCode: 0, stdout: "No samples yet; the first one lands a minute after load." };
            }
            return {
              exitCode: 0,
              stdout: table([
                ["AT", "RSS", "HEAP", "CPU", "LOOP P99", "LOOP MAX", "TURNS", "OPEN"],
                ...samples.map((s) => [
                  s.at,
                  `${s.rssMb}MB`,
                  `${s.heapUsedMb}MB`,
                  `${s.cpuPct}%`,
                  `${s.eventLoopMs.p99}ms`,
                  `${s.eventLoopMs.max}ms`,
                  String(s.activeTurns),
                  String(s.openSpans),
                ]),
              ]),
            };
          },
        }),
        path: cliCommand({
          summary: "Print where trace.ndjson and resources.ndjson live on the bb server",
          options: {},
          async run() {
            return { exitCode: 0, stdout: `${traceFile.path}\n${resourceFile.path}` };
          },
        }),
      },
    }),
  );
}
