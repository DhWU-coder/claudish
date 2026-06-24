export interface FeishuOutputRelayOptions {
  sendText: (text: string) => Promise<void>;
  onError?: (error: unknown) => void;
  quietMs?: number;
  maxChunkLength?: number;
}

export class FeishuOutputRelay {
  private readonly sendText: (text: string) => Promise<void>;
  private readonly onError?: (error: unknown) => void;
  private readonly quietMs: number;
  private readonly maxChunkLength: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = "";
  private scrollback = "";
  private readonly suppressedEchoes = new Set<string>();

  constructor(options: FeishuOutputRelayOptions) {
    this.sendText = options.sendText;
    this.onError = options.onError;
    this.quietMs = options.quietMs ?? 800;
    this.maxChunkLength = options.maxChunkLength ?? 3500;
  }

  suppressEcho(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const normalized = normalizeComparableLine(line);
      if (normalized) {
        this.suppressedEchoes.add(normalized);
      }
    }
  }

  append(data: string | Uint8Array): void {
    const text = cleanTerminalOutput(
      typeof data === "string" ? data : Buffer.from(data).toString("utf-8"),
      this.suppressedEchoes
    );
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
      this.flush().catch((error) => this.onError?.(error));
    }, this.quietMs);
  }
}

export function stripAnsi(text: string): string {
  const escapeChar = String.fromCharCode(27);
  return text
    .replace(new RegExp(`${escapeChar}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${escapeChar}\\][^\\u0007]*(?:\\u0007|${escapeChar}\\\\)`, "g"), "");
}

export function cleanTerminalOutput(text: string, suppressedEchoes = new Set<string>()): string {
  const stripped = stripControlCharacters(stripAnsi(text).replace(/\r/g, "\n"));
  if (!stripped.includes("\n")) {
    return shouldDropTerminalLine(stripped, suppressedEchoes) ? "" : stripped;
  }

  const lines = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !shouldDropTerminalLine(line, suppressedEchoes));

  return lines.join("\n");
}

function shouldDropTerminalLine(line: string, suppressedEchoes: Set<string>): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (suppressedEchoes.has(normalizeComparableLine(trimmed))) return true;
  if (/^[─━═_\-=—\s]{8,}$/.test(trimmed)) return true;

  const compact = normalizeComparableLine(trimmed);
  if (!compact) return true;
  if (TERMINAL_NOISE_FRAGMENTS.some((fragment) => compact.includes(fragment))) return true;
  if (compact.includes("updateavailable") && compact.includes("claudishupdate")) return true;
  if (/^workspace[•·]?$/.test(trimmed.replace(/\s+/g, ""))) return true;
  if (looksLikeStatusLine(trimmed)) return true;

  return false;
}

const TERMINAL_NOISE_FRAGMENTS = [
  "quicksafetycheck",
  "itrustthisfolder",
  "entertoconfirm",
  "accessingworkspace",
  "securityguide",
  "bypasspermissions",
  "shifttabtocycle",
  "ctrlgtoeditinvim",
];

function stripControlCharacters(text: string): string {
  let output = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      continue;
    }
    output += char;
  }
  return output;
}

function looksLikeStatusLine(line: string): boolean {
  const hasSeparator = line.includes("•") || line.includes("|");
  const hasModel =
    /(?:^|\s)[\w.-]+@[\w./:-]+/.test(line) || /\b(?:gpt|claude|gemini|grok)[\w.-]*/i.test(line);
  const hasCostOrContext = /\$[0-9.]+/.test(line) || /\bN\/A\b/.test(line);
  return hasSeparator && hasModel && hasCostOrContext;
}

function normalizeComparableLine(line: string): string {
  return stripAnsi(line)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function chunkText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength));
  }
  return chunks;
}
