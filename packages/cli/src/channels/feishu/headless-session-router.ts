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
  type FeishuSessionMetadata,
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

  private createRoutedSession(conversationKey: string, forceNew: boolean): RoutedHeadlessSession {
    return {
      conversationKey,
      metadata: this.createSessionMetadata(conversationKey, forceNew),
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
    let resultText: string;

    try {
      resultText = await this.runNativeSession(
        routed.metadata,
        buildReturnFileInstructionPrompt(routed.metadata, text, resume),
        resume,
        abortController.signal,
        context
      );
    } catch (error) {
      if (abortController.signal.aborted) return;
      if (!resume || !this.history.persist) throw error;
      resultText = await this.runWithJsonlFallback(routed, text, abortController.signal, context);
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

  private async runWithJsonlFallback(
    routed: RoutedHeadlessSession,
    latestText: string,
    signal?: AbortSignal,
    context?: FeishuSessionSendContext
  ): Promise<string> {
    const previousMessages = this.historyStore.readRecentMessages(
      routed.metadata,
      this.history.maxMessages
    );
    routed.metadata.sessionId = this.createSessionId();
    routed.metadata.nativeSessionStarted = false;
    this.writeSession(routed.metadata);

    const result = await this.runHeadless(
      this.buildRunInput(
        routed.metadata,
        buildFallbackPrompt(previousMessages, latestText),
        false,
        signal,
        context
      )
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
    return {
      conversationKey,
      sessionId: this.createSessionId(),
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
}

function buildFallbackPrompt(messages: FeishuHistoryMessage[], latestText: string): string {
  const historyText = messages.map((message) => `${message.role}: ${message.text}`).join("\n\n");
  return [
    "以下是这个飞书会话最近的历史。Claude Code 原生 resume 失败了，请基于这些历史继续回答。",
    historyText,
    "请继续回复最新用户消息：",
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
