import {
  type CreatePythonTerminalSessionOptions,
  type WebTerminalSession,
  createPythonTerminalSession,
} from "../../web-terminal-service.js";
import { stripAnsi } from "./output-relay.js";

export interface FeishuSessionRouterOptions {
  createSession?: (options: CreatePythonTerminalSessionOptions) => WebTerminalSession;
  model: string;
  cwd: string;
  onOutput?: (
    conversationKey: string,
    data: string | Uint8Array,
    context: FeishuSessionSendContext | undefined
  ) => void;
  onExit?: (conversationKey: string, code: number | null) => void;
}

export interface FeishuSessionSendContext {
  replyToMessageId?: string;
}

export interface FeishuRoutedSessionStatus {
  conversationKey: string;
  pid: number | null;
  status: "running" | "exited";
}

interface RoutedSession {
  conversationKey: string;
  session: WebTerminalSession;
  queue: Promise<void>;
  exited: boolean;
  trustPromptBuffer: string;
  trustPromptConfirmed: boolean;
  activeContext: FeishuSessionSendContext | undefined;
}

export class FeishuSessionRouter {
  private readonly createSession: (
    options: CreatePythonTerminalSessionOptions
  ) => WebTerminalSession;
  private readonly sessions = new Map<string, RoutedSession>();
  private readonly model: string;
  private readonly cwd: string;
  private readonly onOutput?: (
    conversationKey: string,
    data: string | Uint8Array,
    context: FeishuSessionSendContext | undefined
  ) => void;
  private readonly onExit?: (conversationKey: string, code: number | null) => void;

  constructor(options: FeishuSessionRouterOptions) {
    this.createSession = options.createSession ?? createPythonTerminalSession;
    this.model = options.model;
    this.cwd = options.cwd;
    this.onOutput = options.onOutput;
    this.onExit = options.onExit;
  }

  async send(
    conversationKey: string,
    text: string,
    context?: FeishuSessionSendContext
  ): Promise<void> {
    const routed = this.getOrCreateSession(conversationKey);
    const input = text.endsWith("\n") ? text : `${text}\n`;

    routed.queue = routed.queue
      .catch(() => undefined)
      .then(() => {
        routed.activeContext = context;
        routed.session.write(input);
      });

    return routed.queue;
  }

  listSessions(): FeishuRoutedSessionStatus[] {
    return Array.from(this.sessions.values()).map((routed) => ({
      conversationKey: routed.conversationKey,
      pid: routed.session.pid,
      status: routed.exited ? "exited" : "running",
    }));
  }

  stopSession(conversationKey: string): boolean {
    const routed = this.sessions.get(conversationKey);
    if (!routed) return false;

    routed.session.kill();
    this.sessions.delete(conversationKey);
    return true;
  }

  resetSession(conversationKey: string): boolean {
    return this.stopSession(conversationKey);
  }

  stopAll(): void {
    for (const key of this.sessions.keys()) {
      this.stopSession(key);
    }
  }

  private getOrCreateSession(conversationKey: string): RoutedSession {
    const existing = this.sessions.get(conversationKey);
    if (existing && !existing.exited) return existing;

    // biome-ignore lint/style/useConst: 回调需要在会话创建前引用 routed。
    let routed: RoutedSession;
    const session = this.createSession({
      model: this.model,
      cwd: this.cwd,
      claudishArgs: ["-y"],
      env: {
        ...process.env,
        CLAUDISH_ASSUME_AUTO_APPROVE_CONFIRMED: "1",
      },
      onData: (data) => {
        if (this.maybeHandleTrustPrompt(routed, data)) return;
        this.onOutput?.(conversationKey, data, routed.activeContext);
      },
      onExit: (code) => {
        routed.exited = true;
        this.onExit?.(conversationKey, code);
      },
    });
    routed = {
      conversationKey,
      session,
      queue: Promise.resolve(),
      exited: false,
      trustPromptBuffer: "",
      trustPromptConfirmed: false,
      activeContext: undefined,
    };

    this.sessions.set(conversationKey, routed);
    return routed;
  }

  private maybeHandleTrustPrompt(routed: RoutedSession, data: string | Uint8Array): boolean {
    const text = stripAnsi(typeof data === "string" ? data : Buffer.from(data).toString("utf-8"));
    const compactChunk = compactTrustPromptText(text);
    routed.trustPromptBuffer = (routed.trustPromptBuffer + text).slice(-8000);
    const compactBuffer = compactTrustPromptText(routed.trustPromptBuffer);
    const fullTrustPrompt =
      compactBuffer.includes("quicksafetycheck") &&
      (compactBuffer.includes("itrustthisfolder") || compactBuffer.includes("entertoconfirm"));
    const trustPromptChunk =
      compactChunk.includes("quicksafetycheck") ||
      compactChunk.includes("itrustthisfolder") ||
      compactChunk.includes("entertoconfirm") ||
      compactChunk.includes("accessingworkspace");

    if (fullTrustPrompt && !routed.trustPromptConfirmed) {
      routed.trustPromptConfirmed = true;
      routed.trustPromptBuffer = "";
      routed.session.write("\n");
      return true;
    }

    return trustPromptChunk;
  }
}

function compactTrustPromptText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
