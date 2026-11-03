Every bb thread leaves a trail of spans you can query, in the same local
NDJSON format OpenBot uses for `trace.ndjson` and `resources.ndjson`.

## What it records

- **Turns**, from request to completion, with the model, start latency,
  token usage, and how much of the turn went to tools and reasoning.
- **Tool spans** inside each turn: shell commands by program name, tool
  calls, file changes, web fetches, with failures marked.
- **Waits**: approvals and questions the user had to answer, workspace
  provisioning, and messages sitting in the queue.
- **Failures**: failed turns by provider error category, such as
  `rate-limit` or `overloaded`.
- **Resources**: the bb server's memory, CPU and event-loop delay, once a
  minute.

## Reading it

Every answer gets a small chip with the turn's duration and tool count.
Click it for a trace viewer of that turn: each command, tool
call and thinking block on one timeline, failures in red, live while the
turn runs. The **Tracing** page in the sidebar shows all threads at once.

`bb tracing summary` gives p50, p95 and max per span name.
`bb tracing turns` draws a text waterfall of a turn's tools, and
`bb tracing resources` shows the minute samples. The bundled skill teaches
agents to answer "why was that slow?" from these commands.

## Privacy

Everything stays on the bb server, in the plugin's own data directory. By
default only program and tool names are stored, never command arguments;
the `detail` setting opts into short command previews.
