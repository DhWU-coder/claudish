export interface FeishuOutputRelayOptions {
  sendText: (text: string) => Promise<void>;
  quietMs?: number;
  maxChunkLength?: number;
}

export class FeishuOutputRelay {
  private readonly sendText: (text: string) => Promise<void>;
  private readonly quietMs: number;
  private readonly maxChunkLength: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = "";
  private scrollback = "";

  constructor(options: FeishuOutputRelayOptions) {
    this.sendText = options.sendText;
    this.quietMs = options.quietMs ?? 800;
    this.maxChunkLength = options.maxChunkLength ?? 3500;
  }

  append(data: string | Uint8Array): void {
    const text = stripAnsi(typeof data === "string" ? data : Buffer.from(data).toString("utf-8"));
    if (!text) return;

    this.pending += text;
    this.scrollback += text;
    this.scheduleFlush();
  }

  getScrollback(): string {
    return this.scrollback;
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const text = this.pending.trim();
    this.pending = "";
    if (!text) return;

    for (const chunk of chunkText(text, this.maxChunkLength)) {
      await this.sendText(chunk);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush().catch(() => undefined);
    }, this.quietMs);
  }
}

export function stripAnsi(text: string): string {
  const escapeChar = String.fromCharCode(27);
  return text.replace(new RegExp(`${escapeChar}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
}

function chunkText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength));
  }
  return chunks;
}
