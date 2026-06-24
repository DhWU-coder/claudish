import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveClaudishHome } from "../../service/paths.js";

export interface FeishuHistoryStoreOptions {
  baseDir?: string;
  createSessionId?: () => string;
}

export interface FeishuSessionDefaults {
  cwd: string;
  model: string;
}

export interface FeishuSessionMetadata {
  conversationKey: string;
  sessionId: string;
  cwd: string;
  model: string;
  nativeSessionStarted: boolean;
  createdAt: string;
  lastActiveAt: string;
}

export interface FeishuHistoryMessage {
  role: "user" | "assistant";
  text: string;
  feishuMessageId?: string;
  createdAt?: string;
}

export class FeishuHistoryStore {
  private readonly baseDir: string;
  private readonly createSessionId: () => string;

  constructor(options: FeishuHistoryStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(resolveClaudishHome(), "channels", "feishu", "sessions");
    this.createSessionId = options.createSessionId ?? randomUUID;
  }

  getOrCreateSession(
    conversationKey: string,
    defaults: FeishuSessionDefaults
  ): FeishuSessionMetadata {
    const existing = this.readSession(conversationKey);
    if (existing) return existing;

    const session = this.createSessionMetadata(conversationKey, defaults);
    this.writeSession(session);
    return session;
  }

  createNewSession(
    conversationKey: string,
    defaults: FeishuSessionDefaults
  ): FeishuSessionMetadata {
    const dir = this.getSessionDir(conversationKey);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const messagesPath = join(dir, "messages.jsonl");
    if (existsSync(messagesPath)) {
      renameSync(messagesPath, join(dir, `messages-${Date.now()}.jsonl`));
    }

    const session = this.createSessionMetadata(conversationKey, defaults);
    this.writeSession(session);
    return session;
  }

  writeSession(session: FeishuSessionMetadata): void {
    const dir = this.getSessionDir(session.conversationKey);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "session.json"), JSON.stringify(session, null, 2), "utf-8");
  }

  appendMessage(session: FeishuSessionMetadata, message: FeishuHistoryMessage): void {
    const dir = this.getSessionDir(session.conversationKey);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry = {
      ...message,
      createdAt: message.createdAt ?? new Date().toISOString(),
    };
    appendFileSync(join(dir, "messages.jsonl"), `${JSON.stringify(entry)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  readRecentMessages(session: FeishuSessionMetadata, maxMessages: number): FeishuHistoryMessage[] {
    const path = join(this.getSessionDir(session.conversationKey), "messages.jsonl");
    if (!existsSync(path)) return [];

    return readFileSync(path, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FeishuHistoryMessage)
      .slice(-maxMessages);
  }

  getSessionDir(conversationKey: string): string {
    return join(this.baseDir, sanitizeConversationKey(conversationKey));
  }

  private readSession(conversationKey: string): FeishuSessionMetadata | null {
    const path = join(this.getSessionDir(conversationKey), "session.json");
    if (!existsSync(path)) return null;

    try {
      return JSON.parse(readFileSync(path, "utf-8")) as FeishuSessionMetadata;
    } catch {
      return null;
    }
  }

  private createSessionMetadata(
    conversationKey: string,
    defaults: FeishuSessionDefaults
  ): FeishuSessionMetadata {
    const now = new Date().toISOString();
    return {
      conversationKey,
      sessionId: this.createSessionId(),
      cwd: defaults.cwd,
      model: defaults.model,
      nativeSessionStarted: false,
      createdAt: now,
      lastActiveAt: now,
    };
  }
}

export function sanitizeConversationKey(conversationKey: string): string {
  return conversationKey.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}
