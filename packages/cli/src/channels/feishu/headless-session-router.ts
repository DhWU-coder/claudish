import { randomUUID } from "node:crypto";
import type { FeishuHistoryConfig } from "./config.js";
import { sanitizeFeishuLeakedDraftText } from "./draft-sanitizer.js";
import {
  type FeishuHeadlessProgressEvent,
  type FeishuHeadlessRunInput,
  type FeishuHeadlessRunner,
  runFeishuHeadless,
} from "./headless-runner.js";
import {
  type FeishuHistoryMessage,
  FeishuHistoryStore,
  type FeishuSessionAiSummary,
  type FeishuSessionMetadata,
  type FeishuSessionSummary,
} from "./history.js";
import type { FeishuRoutedSessionStatus, FeishuSessionSendContext } from "./session-router.js";

export interface FeishuHeadlessSessionRouterOptions {
  model: string;
  cwd: string;
  history: FeishuHistoryConfig;
  historyBaseDir?: string;
  createSessionId?: () => string;
  runHeadless?: FeishuHeadlessRunner;
  onOutput?: (
    conversationKey: string,
    data: string | Uint8Array,
    context: FeishuSessionSendContext | undefined
  ) => void;
  onProgress?: (
    conversationKey: string,
    event: FeishuHeadlessProgressEvent,
    context: FeishuSessionSendContext | undefined
  ) => void;
}

interface RoutedHeadlessSession {
  conversationKey: string;
  metadata: FeishuSessionMetadata;
  queue: Promise<void>;
  abortController?: AbortController;
}

export interface FeishuArchivedSessionSwitchResult {
  ok: boolean;
  message: string;
  archiveId?: string;
  sessionId?: string;
  forkedFrom?: string;
}

export interface FeishuArchivedSessionDetail {
  session: FeishuSessionSummary;
  messages: FeishuHistoryMessage[];
}

export interface FeishuSessionSummaryWithAi extends FeishuSessionSummary {
  aiSummary: FeishuSessionAiSummary;
}

const FEISHU_SESSION_SUMMARY_CONCURRENCY = 5;

export class FeishuHeadlessSessionRouter {
  private readonly model: string;
  private readonly cwd: string;
  private readonly history: FeishuHistoryConfig;
  private readonly historyStore: FeishuHistoryStore;
  private readonly createSessionId: () => string;
  private readonly runHeadless: FeishuHeadlessRunner;
  private readonly onOutput?: (
    conversationKey: string,
    data: string | Uint8Array,
    context: FeishuSessionSendContext | undefined
  ) => void;
  private readonly onProgress?: (
    conversationKey: string,
    event: FeishuHeadlessProgressEvent,
    context: FeishuSessionSendContext | undefined
  ) => void;
  private readonly sessions = new Map<string, RoutedHeadlessSession>();

  constructor(options: FeishuHeadlessSessionRouterOptions) {
    this.model = options.model;
    this.cwd = options.cwd;
    this.history = options.history;
    this.historyStore = new FeishuHistoryStore({
      baseDir: options.historyBaseDir,
      createSessionId: options.createSessionId,
    });
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.runHeadless = options.runHeadless ?? runFeishuHeadless;
    this.onOutput = options.onOutput;
    this.onProgress = options.onProgress;
  }

  async send(
    conversationKey: string,
    text: string,
    context?: FeishuSessionSendContext
  ): Promise<void> {
    const routed = this.getOrCreateSession(conversationKey);
    routed.queue = routed.queue
      .catch(() => undefined)
      .then(() => this.runQueuedMessage(routed, text, context));
    return routed.queue;
  }

  listSessions(): FeishuRoutedSessionStatus[] {
    return Array.from(this.sessions.values()).map((routed) => ({
      conversationKey: routed.conversationKey,
      pid: null,
      status: "running",
    }));
  }

  stopAll(): void {
    for (const key of this.sessions.keys()) {
      this.stopSession(key);
    }
  }

  stopSession(conversationKey: string): boolean {
    const routed = this.sessions.get(conversationKey);
    if (!routed) return false;

    routed.abortController?.abort();
    this.sessions.delete(conversationKey);
    return true;
  }

  resetSession(conversationKey: string): boolean {
    const existing = this.sessions.get(conversationKey);
    existing?.abortController?.abort();
    this.sessions.set(conversationKey, this.createRoutedSession(conversationKey, true));
    return true;
  }

  listArchivedSessions(conversationKey: string): FeishuSessionSummary[] {
    if (!this.history.persist) return [];
    return this.historyStore.listSessions(conversationKey);
  }

  getCurrentArchivedSession(conversationKey: string): FeishuSessionSummary | null {
    return this.listArchivedSessions(conversationKey).find((session) => session.current) ?? null;
  }

  getArchivedSessionDetail(
    conversationKey: string,
    selection?: number | string
  ): FeishuArchivedSessionDetail | null {
    if (!this.history.persist) return null;
    const session =
      selection === undefined
        ? this.getCurrentArchivedSession(conversationKey)
        : this.selectArchivedSession(conversationKey, selection);
    if (!session) return null;
    return {
      session,
      messages: this.historyStore.readRecentMessages(session, this.history.maxMessages),
    };
  }

  async summarizeArchivedSessions(
    conversationKey: string,
    count: number | "all"
  ): Promise<FeishuSessionSummaryWithAi[]> {
    if (!this.history.persist) return [];
    const sessions = limitArchivedSessions(
      this.listArchivedSessions(conversationKey),
      count
    ).filter((session) => session.messageCount > 0);
    return mapWithConcurrency(sessions, FEISHU_SESSION_SUMMARY_CONCURRENCY, async (session) => ({
      ...session,
      aiSummary: await this.summarizeArchivedSession(session),
    }));
  }

  resumeArchivedSession(
    conversationKey: string,
    selection: number | string
  ): FeishuArchivedSessionSwitchResult {
    if (!this.history.persist) {
      return { ok: false, message: "当前没有启用会话持久化，不能恢复历史 session。" };
    }
    if (this.isProcessing(conversationKey)) {
      return { ok: false, message: "当前会话仍在处理中，请等待完成或先发送 /stop。" };
    }

    const selected = this.selectArchivedSession(conversationKey, selection);
    if (!selected) {
      return { ok: false, message: "没有找到对应的历史 session。" };
    }
    if (!selected.nativeSessionStarted) {
      return { ok: false, message: "这个 session 还没有建立原生会话，不能直接恢复。" };
    }

    const resumed = this.historyStore.resumeSession(conversationKey, selected.archiveId);
    if (!resumed) {
      return { ok: false, message: "恢复失败，历史 session 元信息不存在。" };
    }
    this.sessions.set(conversationKey, this.createRoutedSessionFromMetadata(resumed));
    return {
      ok: true,
      message: "已恢复历史 session。",
      archiveId: resumed.archiveId,
      sessionId: resumed.sessionId,
    };
  }

  forkArchivedSession(
    conversationKey: string,
    selection: number | string
  ): FeishuArchivedSessionSwitchResult {
    if (!this.history.persist) {
      return { ok: false, message: "当前没有启用会话持久化，不能 fork 历史 session。" };
    }
    if (this.isProcessing(conversationKey)) {
      return { ok: false, message: "当前会话仍在处理中，请等待完成或先发送 /stop。" };
    }

    const selected = this.selectArchivedSession(conversationKey, selection);
    if (!selected) {
      return { ok: false, message: "没有找到对应的历史 session。" };
    }

    const fork = this.historyStore.forkSession(conversationKey, selected.archiveId, {
      cwd: this.cwd,
      model: this.model,
    });
    if (!fork) {
      return { ok: false, message: "fork 失败，历史 session 元信息不存在。" };
    }
    this.sessions.set(conversationKey, this.createRoutedSessionFromMetadata(fork));
    return {
      ok: true,
      message: "已 fork 历史 session。",
      archiveId: fork.archiveId,
      sessionId: fork.sessionId,
      forkedFrom: fork.forkedFrom,
    };
  }

  private createRoutedSession(conversationKey: string, forceNew: boolean): RoutedHeadlessSession {
    return {
      conversationKey,
      metadata: this.createSessionMetadata(conversationKey, forceNew),
      queue: Promise.resolve(),
    };
  }

  private createRoutedSessionFromMetadata(metadata: FeishuSessionMetadata): RoutedHeadlessSession {
    return {
      conversationKey: metadata.conversationKey,
      metadata,
      queue: Promise.resolve(),
    };
  }

  private createSessionMetadata(conversationKey: string, forceNew: boolean): FeishuSessionMetadata {
    if (!this.history.persist) {
      return this.createMemorySession(conversationKey);
    }

    if (forceNew) {
      return this.historyStore.createNewSession(conversationKey, {
        cwd: this.cwd,
        model: this.model,
      });
    }

    return this.historyStore.getOrCreateSession(conversationKey, {
      cwd: this.cwd,
      model: this.model,
    });
  }

  private getOrCreateSession(conversationKey: string): RoutedHeadlessSession {
    const existing = this.sessions.get(conversationKey);
    if (existing) return existing;

    const routed = this.createRoutedSession(conversationKey, false);
    this.sessions.set(conversationKey, routed);
    return routed;
  }

  private async runQueuedMessage(
    routed: RoutedHeadlessSession,
    text: string,
    context?: FeishuSessionSendContext
  ): Promise<void> {
    const abortController = new AbortController();
    routed.abortController = abortController;
    this.appendMessage(routed.metadata, { role: "user", text });
    const resume = this.history.nativeResume && routed.metadata.nativeSessionStarted;
    const prompt = this.buildPrompt(routed.metadata, text, resume);
    let resultText: string;

    try {
      resultText = await this.runNativeSession(
        routed.metadata,
        prompt,
        resume,
        abortController.signal,
        context
      );
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (this.sessions.get(routed.conversationKey) === routed) {
        routed.abortController = undefined;
      }
      throw error;
    }
    resultText = sanitizeFeishuLeakedDraftText(resultText);

    if (this.sessions.get(routed.conversationKey) !== routed) return;
    routed.abortController = undefined;
    routed.metadata.nativeSessionStarted = this.history.nativeResume;
    routed.metadata.lastActiveAt = new Date().toISOString();
    this.writeSession(routed.metadata);
    this.appendMessage(routed.metadata, { role: "assistant", text: resultText });
    if (resultText) {
      this.onOutput?.(routed.conversationKey, resultText, context);
    }
  }

  private async runNativeSession(
    metadata: FeishuSessionMetadata,
    prompt: string,
    resume: boolean,
    signal?: AbortSignal,
    context?: FeishuSessionSendContext
  ): Promise<string> {
    const result = await this.runHeadless(
      this.buildRunInput(metadata, prompt, resume, signal, context)
    );
    return result.text;
  }

  private buildRunInput(
    metadata: FeishuSessionMetadata,
    prompt: string,
    resume: boolean,
    signal?: AbortSignal,
    context?: FeishuSessionSendContext
  ): FeishuHeadlessRunInput {
    return {
      model: this.model,
      cwd: this.cwd,
      prompt,
      sessionId: metadata.sessionId,
      resume,
      nativeResume: this.history.nativeResume,
      signal,
      onProgress: (event) => this.onProgress?.(metadata.conversationKey, event, context),
    };
  }

  private createMemorySession(conversationKey: string): FeishuSessionMetadata {
    const now = new Date().toISOString();
    const sessionId = this.createSessionId();
    return {
      archiveId: `memory-${sessionId}`,
      conversationKey,
      sessionId,
      cwd: this.cwd,
      model: this.model,
      nativeSessionStarted: false,
      createdAt: now,
      lastActiveAt: now,
    };
  }

  private appendMessage(metadata: FeishuSessionMetadata, message: FeishuHistoryMessage): void {
    if (this.history.persist) {
      this.historyStore.appendMessage(metadata, message);
    }
  }

  private writeSession(metadata: FeishuSessionMetadata): void {
    if (this.history.persist) {
      this.historyStore.writeSession(metadata);
    }
  }

  private buildPrompt(metadata: FeishuSessionMetadata, text: string, resume: boolean): string {
    if (metadata.forkedFrom && !metadata.nativeSessionStarted) {
      const messages = this.historyStore.readRecentMessages(metadata, this.history.maxMessages + 1);
      return buildForkPrompt(messages.slice(0, -1), text);
    }
    return buildReturnFileInstructionPrompt(metadata, text, resume);
  }

  private isProcessing(conversationKey: string): boolean {
    return Boolean(this.sessions.get(conversationKey)?.abortController);
  }

  private selectArchivedSession(
    conversationKey: string,
    selection: number | string
  ): FeishuSessionSummary | null {
    const sessions = this.listArchivedSessions(conversationKey);
    if (typeof selection === "number") {
      return sessions[selection - 1] ?? null;
    }
    return sessions.find((session) => session.archiveId === selection) ?? null;
  }

  private async summarizeArchivedSession(
    session: FeishuSessionSummary
  ): Promise<FeishuSessionAiSummary> {
    const cached = this.historyStore.readSessionSummary(session);
    if (cached) return cached;

    const messages = this.historyStore.readRecentMessages(session, this.history.maxMessages);
    const result = await this.runHeadless({
      model: this.model,
      cwd: this.cwd,
      prompt: buildSessionSummaryPrompt(session, messages),
      sessionId: this.createSessionId(),
      resume: false,
      nativeResume: true,
    });
    return this.historyStore.writeSessionSummary(
      session,
      parseSessionSummaryText(sanitizeFeishuLeakedDraftText(result.text, { dropWhenNoReply: true }))
    );
  }
}

function limitArchivedSessions<T>(sessions: T[], count: number | "all"): T[] {
  return count === "all" ? sessions : sessions.slice(0, Math.max(0, count));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index], index);
      }
    })
  );

  return results;
}

function buildSessionSummaryPrompt(
  session: FeishuSessionSummary,
  messages: FeishuHistoryMessage[]
): string {
  const historyText = messages.map((message) => `${message.role}: ${message.text}`).join("\n\n");
  return [
    "总结以下飞书历史 session。",
    "只输出 JSON，不要输出 markdown，也不要输出解释文字。",
    'JSON 字段必须是：{"topic":"...","keyInfo":"...","recentAction":"..."}',
    `Archive：${session.archiveId}`,
    `消息数：${session.messageCount}`,
    "历史：",
    historyText,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseSessionSummaryText(text: string): {
  topic: string;
  keyInfo: string;
  recentAction: string;
} {
  const trimmed = text.trim();
  const jsonText = extractJsonObjectText(trimmed);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      return {
        topic: stringifySummaryField(parsed.topic, "未命名 session"),
        keyInfo: stringifySummaryField(parsed.keyInfo, "无"),
        recentAction: stringifySummaryField(parsed.recentAction, "无"),
      };
    } catch {
      // 解析失败时继续走纯文本兜底。
    }
  }

  return {
    topic: firstNonEmptyLine(trimmed) || "未命名 session",
    keyInfo: trimmed || "无",
    recentAction: "无",
  };
}

function extractJsonObjectText(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : null;
}

function stringifySummaryField(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function buildForkPrompt(messages: FeishuHistoryMessage[], latestText: string): string {
  const historyText = messages.map((message) => `${message.role}: ${message.text}`).join("\n\n");
  return [
    RETURN_FILE_INSTRUCTIONS,
    "以下是从已归档会话 fork 出来的上下文，请把它当作新会话的背景。",
    historyText,
    "请回复当前最新用户消息：",
    latestText,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildReturnFileInstructionPrompt(
  metadata: FeishuSessionMetadata,
  prompt: string,
  resume: boolean
): string {
  if (resume || metadata.nativeSessionStarted) return prompt;
  return `${RETURN_FILE_INSTRUCTIONS}\n\n${prompt}`;
}

const RETURN_FILE_INSTRUCTIONS = [
  "如果你需要把本地文件回传给用户，请先确保文件在当前工作目录内，然后在最终回复中单独输出一行：",
  "[[claudish:file:相对路径或绝对路径]]",
  "",
  "示例：",
  "[[claudish:file:output/report.pdf]]",
  "",
  "这行不会展示给用户，系统会解析并发送对应文件。",
].join("\n");
