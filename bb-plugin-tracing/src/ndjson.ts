import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only NDJSON file with one rotated generation (`<file>.1`), the same
 * scheme OpenBot uses for trace.ndjson. Writes are serialized so lines never
 * interleave and rotation never races an append.
 */
export class NdjsonSink {
  readonly path: string;
  private readonly maxBytes: () => number;
  private readonly onError: (error: unknown) => void;
  private chain: Promise<void> = Promise.resolve();
  private size: number | null = null;

  constructor(
    path: string,
    maxBytes: () => number,
    onError: (error: unknown) => void = () => {},
  ) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.onError = onError;
  }

  write(value: unknown): Promise<void> {
    const line = `${JSON.stringify(value)}\n`;
    this.chain = this.chain
      .then(() => this.append(line))
      .catch(this.onError);
    return this.chain;
  }

  /** Resolves once every write issued so far has landed. */
  flush(): Promise<void> {
    return this.chain;
  }

  private async append(line: string): Promise<void> {
    if (this.size === null) {
      await mkdir(dirname(this.path), { recursive: true });
      this.size = await stat(this.path).then(
        (s) => s.size,
        () => 0,
      );
    }
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes()) {
      await rename(this.path, `${this.path}.1`);
      this.size = 0;
    }
    await appendFile(this.path, line, { mode: 0o600 });
    this.size += bytes;
  }
}

/** Reads the rotated generation then the live file, oldest line first. */
export async function readNdjson<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (const file of [`${path}.1`, path]) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // A torn last line after a crash; skip it.
      }
    }
  }
  return out;
}
