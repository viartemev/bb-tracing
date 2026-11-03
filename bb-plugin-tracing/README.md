# bb-plugin-tracing

Local tracing for bb, modelled on OpenBot's `logs/trace.ndjson` and
`logs/resources.ndjson`.

## UI

- **Under every answer**, in the message's action row: a chip with the
  turn's duration and tool count (a pulsing dot while it runs, red when
  something failed). Clicking it opens that turn's trace viewer.
- **Trace viewer** (click the chip): a large window modelled on OpenBot's.
  A strip of duration, tokens, model calls, tool calls and errors; the turn
  as a root row with every step on one overview track; one row per step
  (thinking, response, command, tool, file) on a time grid; search with
  Mod+F; replay with a playhead at 1–25×; and the selected step's full
  content (command and output, arguments and result, diff, thinking text)
  in a side pane. Bars follow OpenBot's legend: model call, tool call,
  waiting, failed.
- **Tokens**: the viewer's *Tokens spent* opens the turn's breakdown: cache
  read, cache write, uncached input and output (with reasoning), each with
  its share, the cache hit rate and the thread's running total. *Context* is
  separate: how full the context window was when the turn ended. bb sends
  the spend just before `turn/completed` and keeps only the newest such
  event, so the tracker stores it on the turn span (`tok*` attributes);
  turns that ended before this was added show "—".
- **Trace tab** (side panel, also under the panel's `+` as *Traces*): the
  turn's total time, first-response latency, tool calls, thinking time and
  context use; a bar of where the time went (commands, files, tools,
  thinking, model); and a waterfall of every span. Each row shows the real
  command, file or tool call; opening it shows everything the span did: the
  full command and its output, a tool's arguments and result, file diffs, or
  the thinking text, with Copy and Wrap. Filter by tools, thinking or
  errors. A running turn updates live.

  Span contents are not copied into `trace.ndjson`: each span stores the
  `seq` of its event, and the panel reads the content from bb's own thread
  history when you open it (blocks are cut at 100,000 characters).
  *All turns* lists every traced turn of the thread.
- **Tracing page** in the sidebar: turns, p50/p95, tool failures, thinking
  time and token spend for the last 1h/24h/7d; recent turns across threads
  (click one for its trace viewer, the arrow goes to the thread); the
  slowest span names; and sparklines of the bb server's memory, CPU and
  event loop.

UI sources are in `ui/`; the RPC contract both sides share is
`src/contract.ts`. Colors are bb theme variables, so custom palettes and dark
mode work.

## Files

Both live in `<bb data dir>/plugins/tracing/logs/` (`bb tracing path`), and
each rotates into `<file>.1` at `maxFileMb`.

`trace.ndjson`: one span per line. The first five fields are OpenBot's:

```json
{"at":"2026-11-03T10:51:21.398Z","kind":"tool","name":"command:npm","durationMs":4800,"outcome":"ok","threadId":"thr_…","projectId":"proj_…","turnRequestId":"creq_…","attrs":{"exitCode":0}}
```

`at` is the span start. `kind` is one of `turn`, `tool`, `interaction`,
`provisioning`, `queue`, `thread`, `error` or `reasoning`; see
[skills/tracing/SKILL.md](skills/tracing/SKILL.md) for each.

`resources.ndjson`: one sample of the bb server process per minute:

```json
{"at":"…","rssMb":412,"heapUsedMb":180,"cpuPct":3.1,"eventLoopMs":{"p99":12,"max":40},"activeTurns":2,"openSpans":3}
```

## How it works

- `experimental_thread.events` (at most once a second per thread) triggers
  an incremental read of that thread's event log with
  `bb.sdk.threads.events.list`, filtered to the event types in
  `src/tracker.ts`. A per-thread cursor and the open spans are stored in
  `bb.storage.kv`, so a reload mid-turn loses nothing.
- `src/tracker.ts` pairs `client/turn/requested` with `turn/completed`,
  `item/started` with `item/completed`, and the interaction and
  provisioning lifecycle events into spans. It is pure and covered by
  `test/`.
- Lifecycle announcements (`thread.*`, `turn.failed`, `message.*`) add
  point spans and queue spans.
- A background service samples `process.memoryUsage`, `process.cpuUsage`
  and `monitorEventLoopDelay` every minute.

## Settings

```
bb plugin config tracing set enabled false          # stop recording
bb plugin config tracing set detail full            # also store command previews and turn errors
bb plugin config tracing set maxFileMb 20
bb plugin config tracing set sampleResources false
```

## Develop

```
npm install --include=dev
npm test           # node --test on src/
npm run typecheck
bb plugin build && bb plugin install .
bb plugin reload tracing
```
