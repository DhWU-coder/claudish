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

export function buildFeishuHeadlessCommand(input: FeishuHeadlessRunInput): FeishuHeadlessCommand {
  const args = ["--model", input.model, "--stdin", "--quiet", "--json", "-y", "--"];
  if (input.nativeResume) {
    args.push(input.resume ? "--resume" : "--session-id", input.sessionId);
  }

  return {
    command: process.env.CLAUDISH_COMMAND || "claudish",
    args,
    cwd: input.cwd,
    env: {
      ...(input.env ?? process.env),
      CLAUDISH_ASSUME_AUTO_APPROVE_CONFIRMED: "1",
    },
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
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
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

  return {
    text: extractHeadlessText(stdout),
    rawOutput: stdout,
  };
}

export function extractHeadlessText(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return "";

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

function formatHeadlessFailure(exitCode: number, stdout: string, stderr: string): string {
  const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  return details
    ? `Feishu headless session failed (${exitCode}): ${details}`
    : `Feishu headless session failed (${exitCode})`;
}
