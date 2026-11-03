# bb-tracing

Local tracing for [bb](https://getbb.app), modelled on OpenBot's trace logs.

The plugin lives in [`bb-plugin-tracing/`](bb-plugin-tracing/): every turn,
tool call, thinking block, API retry and wait is recorded as a span, with a
trace viewer under each answer, a Tracing page, token spend, and a
`bb tracing` CLI. See its [README](bb-plugin-tracing/README.md).

## Install

```
git clone https://github.com/viartemev/bb-tracing
cd bb-tracing/bb-plugin-tracing
npm install --include=dev
bb plugin install .
```
