import { spawn } from "node:child_process";

export interface FeishuHeadlessRunInput {
  model: string;
  cwd: string;
  prompt: string;
  sessionId: string;
  resume: boolean;
  nativeResume: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProgress?: (event: FeishuHeadlessProgressEvent) => void;
}

export interface FeishuHeadlessRunResult {
  text: string;
  rawOutput?: string;
}

export type FeishuHeadlessRunner = (
  input: FeishuHeadlessRunInput
) => Promise<FeishuHeadlessRunResult>;

export interface FeishuHeadlessCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
}

export type FeishuHeadlessProgressEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_start"; name: string; input?: unknown }
  | { type: "tool_result"; text: string; isError?: boolean; toolUseId?: string }
  | { type: "stderr"; text: string };

export interface ParsedHeadlessStreamLine {
  events: FeishuHeadlessProgressEvent[];
  resultText?: string;
}

export function buildFeishuHeadlessCommand(input: FeishuHeadlessRunInput): FeishuHeadlessCommand {
  const args = [
    "--model",
    input.model,
    "--stdin",
    "--quiet",
    "-y",
    "--",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (input.nativeResume) {
    args.push(input.resume ? "--resume" : "--session-id", input.sessionId);
  }
  const env = {
    ...(input.env ?? process.env),
    CLAUDISH_ASSUME_AUTO_APPROVE_CONFIRMED: "1",
  };

  return {
    command: env.CLAUDISH_COMMAND || process.env.CLAUDISH_COMMAND || "claudish",
    args,
    cwd: input.cwd,
    env,
    stdin: input.prompt,
  };
}

export async function runFeishuHeadless(
  input: FeishuHeadlessRunInput
): Promise<FeishuHeadlessRunResult> {
  const command = buildFeishuHeadlessCommand(input);
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: "pipe",
  });
  if (input.signal?.aborted) {
    child.kill("SIGTERM");
    throw new Error("Feishu headless session stopped");
  }

  const abort = () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };
  input.signal?.addEventListener("abort", abort, { once: true });

  let stdout = "";
  let stderr = "";
  let stdoutLineBuffer = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    stdoutLineBuffer = consumeStreamLines(stdoutLineBuffer + chunk, (line) => {
      const parsed = parseHeadlessStreamLine(line);
      for (const event of parsed.events) {
        input.onProgress?.(event);
      }
    });
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    const text = String(chunk).trim();
    if (text) {
      input.onProgress?.({ type: "stderr", text });
    }
  });

  child.stdin.write(command.stdin);
  child.stdin.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  }).finally(() => {
    input.signal?.removeEventListener("abort", abort);
  });

  if (input.signal?.aborted) {
    throw new Error("Feishu headless session stopped");
  }

  if (exitCode !== 0) {
    throw new Error(formatHeadlessFailure(exitCode, stdout, stderr));
  }
  if (stdoutLineBuffer.trim()) {
    const parsed = parseHeadlessStreamLine(stdoutLineBuffer);
    for (const event of parsed.events) {
      input.onProgress?.(event);
    }
  }

  return {
    text: extractHeadlessText(stdout),
    rawOutput: stdout,
  };
}

export function extractHeadlessText(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "";

  const streamResult = extractStreamResultText(trimmed);
  if (streamResult) return streamResult;

  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown; text?: unknown; content?: unknown };
    if (typeof parsed.result === "string") return parsed.result.trim();
    if (typeof parsed.text === "string") return parsed.text.trim();
    if (Array.isArray(parsed.content)) {
      return parsed.content
        .map((block) => {
          if (typeof block === "string") return block;
          if (block && typeof block === "object" && "text" in block) {
            return String((block as { text?: unknown }).text ?? "");
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

export function parseHeadlessStreamLine(line: string): ParsedHeadlessStreamLine {
  const trimmed = line.trim();
  if (!trimmed) return { events: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { events: [] };
  }
  if (!isRecord(parsed)) return { events: [] };

  const type = stringField(parsed.type);
  if (type === "result") {
    const resultText = stringField(parsed.result) || stringField(parsed.text);
    return resultText ? { events: [], resultText: resultText.trim() } : { events: [] };
  }
  if (type === "assistant") {
    return { events: extractAssistantProgressEvents(parsed) };
  }
  if (type === "user") {
    return { events: extractUserProgressEvents(parsed) };
  }
  return { events: [] };
}

function formatHeadlessFailure(exitCode: number, stdout: string, stderr: string): string {
  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  return details
    ? `Feishu headless session failed (${exitCode}): ${details}`
    : `Feishu headless session failed (${exitCode})`;
}

function extractStreamResultText(output: string): string {
  let result = "";
  for (const line of output.split(/\r?\n/)) {
    const parsed = parseHeadlessStreamLine(line);
    if (parsed.resultText) {
      result = parsed.resultText;
    }
  }
  return result.trim();
}

function extractAssistantProgressEvents(input: Record<string, unknown>): FeishuHeadlessProgressEvent[] {
  return contentBlocks(input).flatMap((block) => {
    if (!isRecord(block)) return [];
    const type = stringField(block.type);
    if (type === "text") {
      const text = stringField(block.text);
      return text ? [{ type: "assistant_text", text }] : [];
    }
    if (type === "tool_use") {
      const name = stringField(block.name) || "tool";
      return [{ type: "tool_start", name, input: block.input }];
    }
    return [];
  });
}

function extractUserProgressEvents(input: Record<string, unknown>): FeishuHeadlessProgressEvent[] {
  return contentBlocks(input).flatMap((block) => {
    if (!isRecord(block) || stringField(block.type) !== "tool_result") return [];
    const text = renderToolResultText(block.content);
    if (!text) return [];
    return [
      {
        type: "tool_result",
        text,
        isError: Boolean(block.is_error ?? block.isError),
        toolUseId: stringField(block.tool_use_id) || stringField(block.toolUseId) || undefined,
      },
    ];
  });
}

function contentBlocks(input: Record<string, unknown>): unknown[] {
  const directContent = Array.isArray(input.content) ? input.content : undefined;
  if (directContent) return directContent;
  const message = input.message;
  if (isRecord(message) && Array.isArray(message.content)) return message.content;
  return [];
}

function renderToolResultText(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (!Array.isArray(input)) return "";
  return input
    .map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item) && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function consumeStreamLines(input: string, onLine: (line: string) => void): string {
  const lines = input.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    onLine(line);
  }
  return rest;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function stringField(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}
