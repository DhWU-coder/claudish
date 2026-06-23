import {
  type CreatePythonTerminalSessionOptions,
  type WebTerminalSession,
  createPythonTerminalSession,
} from "../../web-terminal-service.js";

export interface FeishuSessionRouterOptions {
  createSession?: (options: CreatePythonTerminalSessionOptions) => WebTerminalSession;
  model: string;
  cwd: string;
  onOutput?: (conversationKey: string, data: string | Uint8Array) => void;
  onExit?: (conversationKey: string, code: number | null) => void;
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
}

export class FeishuSessionRouter {
  private readonly createSession: (options: CreatePythonTerminalSessionOptions) => WebTerminalSession;
  private readonly sessions = new Map<string, RoutedSession>();
  private readonly model: string;
  private readonly cwd: string;
  private readonly onOutput?: (conversationKey: string, data: string | Uint8Array) => void;
  private readonly onExit?: (conversationKey: string, code: number | null) => void;

  constructor(options: FeishuSessionRouterOptions) {
    this.createSession = options.createSession ?? createPythonTerminalSession;
    this.model = options.model;
    this.cwd = options.cwd;
    this.onOutput = options.onOutput;
    this.onExit = options.onExit;
  }

  async send(conversationKey: string, text: string): Promise<void> {
    const routed = this.getOrCreateSession(conversationKey);
    const input = text.endsWith("\n") ? text : `${text}\n`;

    routed.queue = routed.queue
      .catch(() => undefined)
      .then(() => {
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

  stopAll(): void {
    for (const key of this.sessions.keys()) {
      this.stopSession(key);
    }
  }

  private getOrCreateSession(conversationKey: string): RoutedSession {
    const existing = this.sessions.get(conversationKey);
    if (existing && !existing.exited) return existing;

    const routed: RoutedSession = {
      conversationKey,
      session: this.createSession({
        model: this.model,
        cwd: this.cwd,
        onData: (data) => this.onOutput?.(conversationKey, data),
        onExit: (code) => {
          routed.exited = true;
          this.onExit?.(conversationKey, code);
        },
      }),
      queue: Promise.resolve(),
      exited: false,
    };

    this.sessions.set(conversationKey, routed);
    return routed;
  }
}
