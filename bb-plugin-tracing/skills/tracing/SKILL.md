---
name: tracing
description: Read bb's local traces with `bb tracing` to find out why a turn was slow, which commands or tools took the time or failed, how long messages waited in the queue or for approval, and how the bb server's memory, CPU and event loop behaved. Use when the user asks about slowness, timings, latency, failures or resource use in bb threads.
---

# Tracing

The Tracing plugin records spans from every bb thread into
`trace.ndjson` and samples the bb server process once a minute into
`resources.ndjson` (the same two files OpenBot keeps). `bb tracing path`
prints where they are.

## Span kinds

| Kind | Name | Span |
| --- | --- | --- |
| `turn` | `turn` | From the turn request to `turn/completed`. `attrs` has model, `startLatencyMs`, tool count/errors/time, `reasoningMs`, `usedTokens` (context fill, not spend), and the spend: `tokTotal`, `tokInput`, `tokCacheRead`, `tokCacheWrite`, `tokOutput`, `tokReasoning`, `tokThreadTotal`. |
| `tool` | `command:<program>`, `tool:<Tool>`, `fileChange`, `webSearch`, … | One action inside a turn; `turnRequestId` ties it to its turn. A failed exit code is outcome `error`. |
| `interaction` | `approval`, … | Waiting for the user to answer. |
| `provisioning` | `workspace` | Preparing the thread's workspace. |
| `reasoning` | `reasoning` | One thinking block inside a turn. |
| `queue` | what it waited on (`thread-busy`, `provisioning`, `time`, …) | A message from queueing to dispatch or removal. |
| `thread` | `created`, `archived`, `deleted` | Point events. |
| `error` | the provider error category (`rate-limit`, `overloaded`, …) | A failed turn. |

## UI

The user can see the same data without the CLI: a chip under each answer
opens that turn's waterfall in the side panel, and the **Tracing** page in
the sidebar shows every thread. Point them there for a visual answer.

## Commands

| Command | Shows |
| --- | --- |
| `bb tracing summary [--since 24h] [--kind tool] [--thread thr_… \| --self]` | Count, errors, p50, p95, max and total time per kind and name, slowest total first. |
| `bb tracing turns [--lines 3] [--thread thr_… \| --self]` | A text waterfall of the latest turns with their tool spans. |
| `bb tracing tail [--lines 20] [--kind …] [--thread …]` | The latest spans. |
| `bb tracing resources [--lines 10]` | Per-minute RSS, heap, CPU, event-loop p99/max, active turns. |
| `bb tracing path` | Paths of both files. |

Add `--json` to `summary`, `tail` and `resources` when the output drives code
(`tail --json` prints NDJSON).

## Procedure

1. Start with `bb tracing summary --since <window>` to see where the time goes.
2. Narrow with `--kind` or `--thread`, then `bb tracing turns --thread <id>`
   to see one turn's waterfall.
3. For "bb feels slow", read `bb tracing resources`: an event-loop p99 over
   ~100ms or a growing RSS points at the server rather than the provider.
4. Report numbers from the commands; do not estimate them.

## Notes

- By default only program and tool names are recorded, never command
  arguments. `bb plugin config tracing set detail full` also stores the first
  200 characters of each command and turn error messages.
- Spans start at plugin install; earlier history is not backfilled.
- Each file rotates into `<file>.1` at `maxFileMb` (default 5).
