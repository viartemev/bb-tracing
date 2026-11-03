// The RPC contract shared by server.ts and the UI. Both bundle it, so the
// schemas validate on the wire in both directions.
import type { defineRpcContract as SdkDefineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// The SDK's defineRpcContract only returns its argument; it exists for the
// types. The UI bundle cannot import the SDK's root entry (bb shims only
// @get-bb/plugin-sdk/app), so this module keeps the types and drops the call.
const defineRpcContract = ((contract: unknown) => contract) as typeof SdkDefineRpcContract;

const attrsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const recordSchema = z.object({
  at: z.string(),
  kind: z.enum(["turn", "tool", "interaction", "provisioning", "queue", "thread", "error", "reasoning", "message"]),
  name: z.string(),
  durationMs: z.number(),
  outcome: z.string(),
  threadId: z.string().optional(),
  projectId: z.string().optional(),
  turnRequestId: z.string().optional(),
  turnId: z.string().optional(),
  attrs: attrsSchema.optional(),
});
const statsSchema = z.object({
  kind: z.string(),
  name: z.string(),
  count: z.number(),
  errors: z.number(),
  p50Ms: z.number(),
  p95Ms: z.number(),
  maxMs: z.number(),
  totalMs: z.number(),
});
const sampleSchema = z.object({
  at: z.string(),
  rssMb: z.number(),
  heapUsedMb: z.number(),
  cpuPct: z.number(),
  eventLoopMs: z.object({ p99: z.number(), max: z.number() }),
  activeTurns: z.number(),
  openSpans: z.number(),
});
const turnViewSchema = z.object({
  turn: recordSchema,
  spans: z.array(recordSchema),
  running: z.boolean(),
});
const detailSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.string().nullable(),
  fields: z.array(z.object({ label: z.string(), value: z.string() })),
  blocks: z.array(
    z.object({
      label: z.string(),
      kind: z.enum(["code", "diff", "text", "json"]),
      content: z.string(),
      path: z.string().optional(),
      truncatedChars: z.number(),
    }),
  ),
});
const threadInput = z.object({ threadId: z.string().min(1).max(100) }).strict();

/** Reads the UI makes. Tags let the server refresh exactly the open views. */
export const rpcContract = defineRpcContract({
  turn: {
    input: z.object({ threadId: z.string().min(1).max(100), turnId: z.string().min(1).max(200) }).strict(),
    output: z.object({ view: turnViewSchema.nullable() }),
    tags: ({ threadId }) => [`thread:${threadId}`],
  },
  threadTurns: {
    input: threadInput,
    output: z.object({ turns: z.array(recordSchema) }),
    tags: ({ threadId }) => [`thread:${threadId}`],
  },
  // Titles for the timeline rows, read from the thread history by event seq.
  spanTitles: {
    input: z
      .object({ threadId: z.string().min(1).max(100), seqs: z.array(z.number().int().positive()).max(2000) })
      .strict(),
    output: z.object({ titles: z.record(z.string(), z.string()) }),
  },
  // Everything one span did: command and output, arguments and result, diff.
  spanDetail: {
    input: z.object({ threadId: z.string().min(1).max(100), seq: z.number().int().positive() }).strict(),
    output: z.object({ detail: detailSchema.nullable() }),
  },
  // The steps around a "generating" gap: what the model read, what it wrote.
  gapContext: {
    input: z
      .object({
        threadId: z.string().min(1).max(100),
        prevSeq: z.number().int().positive().nullable(),
        nextSeq: z.number().int().positive().nullable(),
      })
      .strict(),
    output: z.object({ prev: z.object({ type: z.string(), title: z.string(), written: z.number(), returned: z.number() }).nullable(), next: z.object({ type: z.string(), title: z.string(), written: z.number(), returned: z.number() }).nullable() }),
  },
  overview: {
    input: z.object({ windowHours: z.number().int().min(1).max(24 * 30) }).strict(),
    output: z.object({
      windowMs: z.number(),
      turns: z.object({ count: z.number(), errors: z.number(), p50Ms: z.number(), p95Ms: z.number() }),
      tools: z.object({ count: z.number(), errors: z.number(), totalMs: z.number() }),
      reasoningMs: z.number(),
      tokens: z.object({
        turns: z.number(),
        total: z.number(),
        input: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
        output: z.number(),
      }),
      top: z.array(statsSchema),
      recentTurns: z.array(recordSchema.extend({ threadTitle: z.string().nullable() })),
      resources: z.array(sampleSchema),
      tracePath: z.string(),
    }),
    tags: () => ["overview"],
  },
});
