import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  archiveId: string;
  conversationKey: string;
  sessionId: string;
  cwd: string;
  model: string;
  nativeSessionStarted: boolean;
  createdAt: string;
  lastActiveAt: string;
  forkedFrom?: string;
}

export interface FeishuHistoryMessage {
  role: "user" | "assistant";
  text: string;
  feishuMessageId?: string;
  createdAt?: string;
}

export interface FeishuSessionSummary extends FeishuSessionMetadata {
  current: boolean;
  messageCount: number;
  preview: string;
}

export interface FeishuSessionAiSummary {
  topic: string;
  keyInfo: string;
  recentAction: string;
  messageCount: number;
  updatedAt: string;
}

export interface FeishuSessionAiSummaryInput {
  topic: string;
  keyInfo: string;
  recentAction: string;
}

interface FeishuSessionIndex {
  sessions: Array<{
    archiveId: string;
    sessionId: string;
    createdAt: string;
    lastActiveAt: string;
    forkedFrom?: string;
  }>;
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
    this.writeCurrentArchiveId(conversationKey, session.archiveId);
    return session;
  }

  createNewSession(
    conversationKey: string,
    defaults: FeishuSessionDefaults
  ): FeishuSessionMetadata {
    const session = this.createSessionMetadata(conversationKey, defaults);
    this.writeSession(session);
    this.writeCurrentArchiveId(conversationKey, session.archiveId);
    return session;
  }

  writeSession(session: FeishuSessionMetadata): void {
    const sessionToWrite = {
      ...session,
      archiveId: session.archiveId ?? archiveIdForSessionId(session.sessionId),
    };
    const dir = this.getArchivedSessionDir(
      sessionToWrite.conversationKey,
      sessionToWrite.archiveId
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "session.json"), JSON.stringify(sessionToWrite, null, 2), "utf-8");
    this.upsertIndex(sessionToWrite);
  }

  appendMessage(session: FeishuSessionMetadata, message: FeishuHistoryMessage): void {
    const archiveId = session.archiveId ?? archiveIdForSessionId(session.sessionId);
    const dir = this.getArchivedSessionDir(session.conversationKey, archiveId);
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
    return this.readMessages(session).slice(-maxMessages);
  }

  readMessages(session: FeishuSessionMetadata): FeishuHistoryMessage[] {
    const archiveId = session.archiveId ?? archiveIdForSessionId(session.sessionId);
    const path = join(
      this.getArchivedSessionDir(session.conversationKey, archiveId),
      "messages.jsonl"
    );
    if (!existsSync(path)) return [];

    return readFileSync(path, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FeishuHistoryMessage);
  }

  readSessionSummary(session: FeishuSessionMetadata): FeishuSessionAiSummary | null {
    const path = join(
      this.getArchivedSessionDir(session.conversationKey, session.archiveId),
      "summary.json"
    );
    if (!existsSync(path)) return null;

    try {
      const summary = JSON.parse(readFileSync(path, "utf-8")) as FeishuSessionAiSummary;
      return summary.messageCount === this.readMessages(session).length ? summary : null;
    } catch {
      return null;
    }
  }

  writeSessionSummary(
    session: FeishuSessionMetadata,
    summary: FeishuSessionAiSummaryInput
  ): FeishuSessionAiSummary {
    const dir = this.getArchivedSessionDir(session.conversationKey, session.archiveId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const nextSummary = {
      ...summary,
      messageCount: this.readMessages(session).length,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(dir, "summary.json"), JSON.stringify(nextSummary, null, 2), "utf-8");
    return nextSummary;
  }

  listSessions(conversationKey: string): FeishuSessionSummary[] {
    const currentArchiveId = this.readCurrentArchiveId(conversationKey);
    return this.readIndex(conversationKey)
      .sessions.map((entry, index) => ({
        index,
        session: this.readSessionArchive(conversationKey, entry.archiveId),
      }))
      .filter((item): item is { index: number; session: FeishuSessionMetadata } =>
        Boolean(item.session)
      )
      .sort((left, right) => {
        const timeOrder = right.session.lastActiveAt.localeCompare(left.session.lastActiveAt);
        return timeOrder === 0 ? right.index - left.index : timeOrder;
      })
      .map(({ session }) => {
        const messages = this.readMessages(session);
        return {
          ...session,
          current: session.archiveId === currentArchiveId,
          messageCount: messages.length,
          preview: buildPreview(messages),
        };
      });
  }

  resumeSession(conversationKey: string, archiveId: string): FeishuSessionMetadata | null {
    const session = this.readSessionArchive(conversationKey, archiveId);
    if (!session) return null;
    this.writeCurrentArchiveId(conversationKey, session.archiveId);
    return session;
  }

  forkSession(
    conversationKey: string,
    archiveId: string,
    defaults: FeishuSessionDefaults
  ): FeishuSessionMetadata | null {
    const source = this.readSessionArchive(conversationKey, archiveId);
    if (!source) return null;

    const fork = {
      ...this.createSessionMetadata(conversationKey, defaults),
      forkedFrom: source.archiveId,
    };
    this.writeSession(fork);
    for (const message of this.readMessages(source)) {
      this.appendMessage(fork, message);
    }
    this.writeCurrentArchiveId(conversationKey, fork.archiveId);
    return fork;
  }

  getSessionDir(conversationKey: string): string {
    return join(this.baseDir, sanitizeConversationKey(conversationKey));
  }

  private readSession(conversationKey: string): FeishuSessionMetadata | null {
    const currentArchiveId = this.readCurrentArchiveId(conversationKey);
    if (!currentArchiveId) return null;
    return this.readSessionArchive(conversationKey, currentArchiveId);
  }

  private readSessionArchive(
    conversationKey: string,
    archiveId: string
  ): FeishuSessionMetadata | null {
    const path = join(this.getArchivedSessionDir(conversationKey, archiveId), "session.json");
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
    const sessionId = this.createSessionId();
    return {
      archiveId: archiveIdForSessionId(sessionId),
      conversationKey,
      sessionId,
      cwd: defaults.cwd,
      model: defaults.model,
      nativeSessionStarted: false,
      createdAt: now,
      lastActiveAt: now,
    };
  }

  private getArchivedSessionDir(conversationKey: string, archiveId: string): string {
    return join(this.getSessionDir(conversationKey), sanitizeArchiveId(archiveId));
  }

  private readIndex(conversationKey: string): FeishuSessionIndex {
    const path = join(this.getSessionDir(conversationKey), "index.json");
    if (!existsSync(path)) return { sessions: [] };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as FeishuSessionIndex;
      return {
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      };
    } catch {
      return { sessions: [] };
    }
  }

  private writeIndex(conversationKey: string, index: FeishuSessionIndex): void {
    const dir = this.getSessionDir(conversationKey);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "index.json"), JSON.stringify(index, null, 2), "utf-8");
  }

  private upsertIndex(session: FeishuSessionMetadata): void {
    const index = this.readIndex(session.conversationKey);
    const nextEntry = {
      archiveId: session.archiveId,
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      ...(session.forkedFrom ? { forkedFrom: session.forkedFrom } : {}),
    };
    const sessions = index.sessions.filter((entry) => entry.archiveId !== session.archiveId);
    sessions.push(nextEntry);
    this.writeIndex(session.conversationKey, { sessions });
  }

  private readCurrentArchiveId(conversationKey: string): string | null {
    const path = join(this.getSessionDir(conversationKey), "current.json");
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { archiveId?: unknown };
      return typeof parsed.archiveId === "string" ? parsed.archiveId : null;
    } catch {
      return null;
    }
  }

  private writeCurrentArchiveId(conversationKey: string, archiveId: string): void {
    const dir = this.getSessionDir(conversationKey);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "current.json"), JSON.stringify({ archiveId }, null, 2), "utf-8");
  }
}

export function sanitizeConversationKey(conversationKey: string): string {
  return conversationKey.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function archiveIdForSessionId(sessionId: string): string {
  return sessionId.startsWith("session-") ? sessionId : `session-${sessionId}`;
}

function sanitizeArchiveId(archiveId: string): string {
  return archiveId.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "session";
}

function buildPreview(messages: FeishuHistoryMessage[]): string {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const preview = latestUserMessage?.text ?? messages.at(-1)?.text ?? "";
  return preview.length > 80 ? `${preview.slice(0, 77)}...` : preview;
}
