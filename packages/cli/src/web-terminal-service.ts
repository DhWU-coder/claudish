/**
 * Web terminal bridge for the browser config UI.
 *
 * The browser talks WebSocket, while this module starts a real `claudish`
 * process inside a pseudo-terminal wrapper so Claude Code sees a TTY.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export interface TerminalModelInput {
  provider?: string;
  model?: string;
}

export interface PythonTerminalCommandOptions extends TerminalModelInput {
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
}

export interface PythonTerminalCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type TerminalSocketMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "close" };

export interface WebTerminalSession {
  pid: number | null;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface CreatePythonTerminalSessionOptions extends PythonTerminalCommandOptions {
  cwd?: string;
  onData: (data: string | Uint8Array) => void;
  onExit?: (code: number | null) => void;
  onError?: (error: Error) => void;
}

const PYTHON_PTY_BRIDGE = String.raw`
import fcntl
import os
import pty
import select
import struct
import sys
import termios

# The child process runs inside a real pseudo-terminal.
def set_size(fd):
    rows = int(os.environ.get("LINES", "30"))
    cols = int(os.environ.get("COLUMNS", "100"))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

# Fork a PTY and exec the claudish command passed by the TypeScript parent.
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

set_size(fd)
exit_code = 0
try:
    while True:
        ready, _, _ = select.select([sys.stdin.buffer, fd], [], [])
        if sys.stdin.buffer in ready:
            data = os.read(sys.stdin.fileno(), 4096)
            if not data:
                break
            os.write(fd, data)
        if fd in ready:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
            sys.stdout.flush()
finally:
    try:
        _, status = os.waitpid(pid, os.WNOHANG)
        if os.WIFEXITED(status):
            exit_code = os.WEXITSTATUS(status)
    except ChildProcessError:
        pass

sys.exit(exit_code)
`;

/**
 * Convert provider/model form values into the model spec claudish expects.
 */
export function resolveTerminalModelSpec(input: TerminalModelInput): string {
  const provider = (input.provider || "").trim();
  const model = (input.model || "").trim();

  if (!model) {
    throw new Error("Model is required.");
  }

  if (model.includes("@") || !provider) {
    return model;
  }

  return `${provider}@${model}`;
}

/**
 * Build the Python command used as a portable PTY wrapper.
 */
export function buildPythonTerminalCommand(
  options: PythonTerminalCommandOptions
): PythonTerminalCommand {
  const model = resolveTerminalModelSpec(options);
  const cols = clampTerminalDimension(options.cols, 100);
  const rows = clampTerminalDimension(options.rows, 30);
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    TERM: "xterm-256color",
    COLUMNS: String(cols),
    LINES: String(rows),
  };
  const claudishArgs = ["claudish", "--model", model];

  return {
    command: process.env.PYTHON || "python3",
    args: ["-c", PYTHON_PTY_BRIDGE, ...claudishArgs],
    env,
  };
}

/**
 * Start a claudish terminal session using Python's standard-library PTY.
 */
export function createPythonTerminalSession(
  options: CreatePythonTerminalSessionOptions
): WebTerminalSession {
  const command = buildPythonTerminalCommand(options);
  const child = spawn(command.command, command.args, {
    cwd: options.cwd ?? process.cwd(),
    env: command.env,
    stdio: "pipe",
  }) as ChildProcessWithoutNullStreams;

  // Both stdout and stderr belong to the browser terminal surface.
  child.stdout.on("data", (chunk: Buffer) => options.onData(chunk));
  child.stderr.on("data", (chunk: Buffer) => options.onData(chunk));
  child.on("exit", (code) => options.onExit?.(code));
  child.on("error", (error) => options.onError?.(error));

  return {
    pid: child.pid ?? null,
    write(data: string) {
      child.stdin.write(data);
    },
    resize(_cols: number, _rows: number) {
      // The Python bridge sets the initial PTY size. Live resize is accepted by
      // protocol so a later control channel can apply TIOCSWINSZ dynamically.
    },
    kill() {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}

/**
 * Parse one browser WebSocket message into a terminal control message.
 */
export function parseTerminalSocketMessage(raw: string | Buffer): TerminalSocketMessage | null {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : raw;

  try {
    const payload = JSON.parse(text);
    if (payload?.type === "input" && typeof payload.data === "string") {
      return { type: "input", data: payload.data };
    }
    if (payload?.type === "resize") {
      return {
        type: "resize",
        cols: clampTerminalDimension(payload.cols, 100),
        rows: clampTerminalDimension(payload.rows, 30),
      };
    }
    if (payload?.type === "close") {
      return { type: "close" };
    }
    return null;
  } catch {
    return text ? { type: "input", data: text } : null;
  }
}

/**
 * Keep terminal dimensions inside the practical range accepted by xterm UIs.
 */
function clampTerminalDimension(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(300, Math.max(15, Math.floor(numeric)));
}
