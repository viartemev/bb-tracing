// What a span actually did, read back from bb's thread history: the command
// and its output, a tool's arguments and result, a file diff, the thinking
// text. Nothing here is written to trace.ndjson; the UI asks for it on demand.

export interface DetailBlock {
  label: string;
  /** How the UI draws it: a shell/source view, a diff, plain text or JSON. */
  kind: "code" | "diff" | "text" | "json";
  content: string;
  /** For `code` and `diff`: the file name that picks highlighting. */
  path?: string;
  /** Characters cut from the end to keep the response bounded. */
  truncatedChars: number;
}

export interface ItemDetail {
  type: string;
  title: string;
  status: string | null;
  fields: { label: string; value: string }[];
  blocks: DetailBlock[];
}

/** Per block; a few of these fit comfortably in one RPC response. */
export const BLOCK_MAX_CHARS = 100_000;
const TITLE_MAX_CHARS = 300;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function block(label: string, kind: DetailBlock["kind"], content: string, path?: string): DetailBlock {
  const truncatedChars = Math.max(0, content.length - BLOCK_MAX_CHARS);
  return {
    label,
    kind,
    content: truncatedChars > 0 ? content.slice(0, BLOCK_MAX_CHARS) : content,
    ...(path ? { path } : {}),
    truncatedChars,
  };
}

const json = (v: unknown) => JSON.stringify(v, null, 2);
const firstLine = (text: string) => text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";

/** Text of a tool result, which providers send as a string, parts or JSON. */
function resultText(result: unknown): { text: string; kind: "text" | "json" } {
  if (typeof result === "string") return { text: result, kind: "text" };
  if (Array.isArray(result) && result.every((p) => typeof obj(p).text === "string")) {
    return { text: result.map((p) => obj(p).text as string).join("\n"), kind: "text" };
  }
  return { text: json(result), kind: "json" };
}

const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

/** The one-line label a timeline row shows for an item. */
export function itemTitle(item: Obj): string {
  const presented = str(obj(item.presentation).title);
  const type = str(item.type) ?? "item";
  let title: string;
  if (type === "commandExecution") title = firstLine(str(item.command) ?? "");
  else if (type === "reasoning") title = firstLine(reasoningText(item));
  else if (type === "agentMessage") title = firstLine(str(item.text) ?? "");
  else title = presented ?? str(item.path) ?? str(item.query) ?? str(item.url) ?? str(item.tool) ?? type;
  return (title || presented || type).slice(0, TITLE_MAX_CHARS);
}

function reasoningText(item: Obj): string {
  const parts = [item.summary, item.content].flatMap((v) => (Array.isArray(v) ? v : []));
  return parts.filter((p): p is string => typeof p === "string").join("\n\n").trim();
}

export function itemDetail(item: Obj): ItemDetail {
  const type = str(item.type) ?? "unknown";
  const fields: ItemDetail["fields"] = [];
  const blocks: DetailBlock[] = [];
  const field = (label: string, value: unknown) => {
    if (value === null || value === undefined || value === "") return;
    fields.push({ label, value: typeof value === "string" ? value : JSON.stringify(value) });
  };

  switch (type) {
    case "commandExecution": {
      field("Directory", item.cwd);
      field("Exit code", item.exitCode);
      field("Approval", item.approvalStatus);
      blocks.push(block("Command", "code", str(item.command) ?? "", "command.sh"));
      const output = str(item.aggregatedOutput);
      if (output) blocks.push(block("Output", "text", output));
      break;
    }
    case "toolCall": {
      field("Tool", item.tool);
      if (item.arguments !== undefined) blocks.push(block("Arguments", "json", json(item.arguments)));
      if (item.result !== undefined && item.result !== null) {
        const { text, kind } = resultText(item.result);
        blocks.push(block("Result", kind, text));
      }
      if (item.error !== undefined && item.error !== null) blocks.push(block("Error", "text", resultText(item.error).text));
      break;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes.map(obj) : [];
      field("Files", changes.length);
      for (const change of changes) {
        const path = str(change.path) ?? "file";
        const diff = str(change.diff);
        const label = `${baseName(path)}${change.kind ? ` · ${String(change.kind)}` : ""}`;
        blocks.push(diff ? block(label, "diff", diff, path) : block(label, "text", path));
      }
      break;
    }
    case "agentMessage": {
      blocks.push(block("Response", "text", str(item.text) ?? ""));
      break;
    }
    case "reasoning": {
      blocks.push(block("Thinking", "text", reasoningText(item) || "(the provider sent no thinking text)"));
      break;
    }
    default: {
      for (const key of ["path", "query", "url", "tool"]) field(key[0]!.toUpperCase() + key.slice(1), item[key]);
      const { presentation: _p, id: _i, type: _t, status: _s, ...rest } = item;
      if (Object.keys(rest).length > 0) blocks.push(block("Data", "json", json(rest)));
    }
  }
  return { type, title: itemTitle(item), status: str(item.status), fields, blocks };
}

/**
 * How much text an item carries, for explaining the gap around it: what the
 * model wrote to produce it (`written`) and what it returned for the model to
 * read next (`returned`).
 */
export function itemSize(item: Obj): { type: string; title: string; written: number; returned: number } {
  const type = str(item.type) ?? "unknown";
  let written = 0;
  let returned = 0;
  switch (type) {
    case "commandExecution":
      written = (str(item.command) ?? "").length;
      returned = (str(item.aggregatedOutput) ?? "").length;
      break;
    case "toolCall":
      written = item.arguments === undefined ? 0 : JSON.stringify(item.arguments).length;
      returned = item.result === undefined || item.result === null ? 0 : resultText(item.result).text.length;
      break;
    case "fileChange":
      // Only the lines the model wrote, not the diff's context.
      for (const change of Array.isArray(item.changes) ? item.changes.map(obj) : []) {
        for (const line of (str(change.diff) ?? "").split("\n")) {
          if (line.startsWith("+") && !line.startsWith("+++")) written += line.length - 1;
        }
      }
      break;
    case "reasoning":
      written = reasoningText(item).length;
      break;
    case "agentMessage":
      written = (str(item.text) ?? "").length;
      break;
  }
  return { type, title: itemTitle(item), written, returned };
}
