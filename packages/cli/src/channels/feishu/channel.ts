import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import type { FeishuConfig } from "./config.js";
import { sanitizeFeishuLeakedDraftText } from "./draft-sanitizer.js";
import {
  type FeishuMessageEvent,
  buildClaudeCodeInputForFeishu,
  extractFileResources,
  extractImageKeys,
  parseFeishuMessageEvent,
  resolveConversationKey,
  shouldHandleMessage,
  stripBotMention,
} from "./events.js";
import { type SavedFeishuFile, saveFeishuFile } from "./files.js";
import type { FeishuHeadlessProgressEvent, FeishuHeadlessRunner } from "./headless-runner.js";
import { FeishuHeadlessSessionRouter } from "./headless-session-router.js";
import { type SavedFeishuImage, saveFeishuImage } from "./images.js";
import { FeishuMessageProgressTracker } from "./message-tracker.js";
import { FeishuOutputRelay, cleanTerminalOutput } from "./output-relay.js";
import {
  type FeishuReturnFile,
  extractFeishuReturnFileDirectives,
  resolveFeishuReturnFile,
} from "./return-files.js";
import {
  type FeishuConnectionTestResult,
  type FeishuMessageClient,
  sendFeishuFile,
  sendFeishuText,
} from "./send.js";
import {
  type FeishuRoutedSessionStatus,
  FeishuSessionRouter,
  type FeishuSessionSendContext,
} from "./session-router.js";

export interface FeishuEventClient {
  start(onEvent: (payload: unknown) => Promise<void> | void): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface FeishuMediaClient {
  downloadImage(
    imageKey: string,
    messageId: string
  ): Promise<{ buffer: Buffer | Uint8Array; contentType: string }>;
  downloadFile?(
    fileKey: string,
    messageId: string
  ): Promise<{ buffer: Buffer | Uint8Array; contentType: string }>;
}

export interface FeishuReactionClient {
  addTypingReaction(input: { messageId: string }): Promise<{ reactionId: string | null }>;
  removeTypingReaction(input: { messageId: string; reactionId: string }): Promise<void>;
}

export interface FeishuSessionRouterLike {
  send(conversationKey: string, text: string, context?: FeishuSessionSendContext): Promise<void>;
  listSessions(): FeishuRoutedSessionStatus[];
  resetSession?(conversationKey: string): boolean;
  stopSession?(conversationKey: string): boolean;
  stopAll(): void;
}

export interface FeishuChannelOptions {
  config: FeishuConfig;
  eventClient?: FeishuEventClient;
  mediaClient?: FeishuMediaClient;
  imageVisionEnhancer?: (image: SavedFeishuImage) => Promise<SavedFeishuImage>;
  messageClient?: FeishuMessageClient;
  reactionClient?: FeishuReactionClient;
  sessionRouter?: FeishuSessionRouterLike;
  headlessRunner?: FeishuHeadlessRunner;
  historyBaseDir?: string;
  outputQuietMs?: number;
  messageDedupeTtlMs?: number;
  now?: () => number;
  logger?: Pick<Console, "warn" | "error" | "log">;
}

export class FeishuChannel {
  readonly id: string;
  private config: FeishuConfig;
  private readonly eventClient: FeishuEventClient;
  private readonly mediaClient?: FeishuMediaClient;
  private readonly imageVisionEnhancer: (image: SavedFeishuImage) => Promise<SavedFeishuImage>;
  private readonly messageClient?: FeishuMessageClient;
  private readonly reactionClient?: FeishuReactionClient;
  private readonly sessionRouter: FeishuSessionRouterLike;
  private readonly outputQuietMs: number;
  private readonly messageDedupeTtlMs: number;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "warn" | "error" | "log">;
  private readonly replyTargets = new Map<string, string>();
  private readonly outputRelays = new Map<string, FeishuOutputRelay>();
  private readonly pendingReturnFiles = new Map<string, FeishuReturnFile[]>();
  private readonly handledMessageIds = new Map<string, number>();
  private readonly pendingEventTasks = new Set<Promise<void>>();
  private readonly messageTracker: FeishuMessageProgressTracker;
  private status: string;

  constructor(options: FeishuChannelOptions) {
    this.config = options.config;
    this.id = resolveFeishuChannelId(options.config.id);
    this.eventClient = options.eventClient ?? noopEventClient();
    this.mediaClient = options.mediaClient;
    this.imageVisionEnhancer = options.imageVisionEnhancer ?? ((image) => Promise.resolve(image));
    this.messageClient = options.messageClient;
    this.reactionClient = options.reactionClient;
    this.outputQuietMs = options.outputQuietMs ?? 800;
    this.messageDedupeTtlMs = options.messageDedupeTtlMs ?? 10 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
    this.sessionRouter = options.sessionRouter ?? this.createDefaultSessionRouter(options);
    this.messageTracker = new FeishuMessageProgressTracker({
      accountId: options.config.id || "default",
      now: this.now,
    });
    this.logger = options.logger ?? console;
    this.status = options.config.enabled ? "configured" : "not_configured";
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.status = "not_configured";
      return;
    }

    mkdirSync(this.config.cwd, { recursive: true, mode: 0o700 });
    this.status = "connecting";
    await this.eventClient.start((payload) => this.handleEvent(payload));
    this.status = "connected";
  }

  async stop(): Promise<void> {
    await this.eventClient.stop();
    this.sessionRouter.stopAll();
    for (const relay of this.outputRelays.values()) {
      relay.dispose();
    }
    this.outputRelays.clear();
    this.pendingReturnFiles.clear();
    this.status = this.config.enabled ? "stopped" : "not_configured";
  }

  updateConfig(config: unknown): void {
    const next = config as Partial<FeishuConfig>;
    if (typeof next.sendProgressReplies === "boolean") {
      this.config = {
        ...this.config,
        sendProgressReplies: next.sendProgressReplies,
      };
    }
  }

  getStatus() {
    const sessions = this.sessionRouter.listSessions();
    return {
      id: this.id,
      status: this.status,
      activeSessions: sessions.filter((session) => session.status === "running").length,
      ...(this.config.id && this.config.id !== "default" ? { accountId: this.config.id } : {}),
      model: this.config.model,
      cwd: this.config.cwd,
      recentMessages: this.messageTracker.list(),
      recentSessions: this.messageTracker.listSessions(),
    };
  }

  async testConnection(): Promise<FeishuConnectionTestResult> {
    const startedAt = this.now();
    if (!this.config.enabled) {
      return {
        ok: false,
        latencyMs: this.now() - startedAt,
        checks: [],
        error: "Feishu account is disabled.",
      };
    }
    if (!this.messageClient?.testConnection) {
      return {
        ok: false,
        latencyMs: this.now() - startedAt,
        checks: [],
        error: "Feishu connection test is unavailable.",
      };
    }
    return this.messageClient.testConnection({
      expectedBotOpenId: this.config.botOpenId,
    });
  }

  async handleEvent(payload: unknown): Promise<void> {
    const event = parseFeishuMessageEvent(payload);
    if (!event) return;

    const botOpenId = this.config.botOpenId ?? "";
    if (!shouldHandleMessage(event, botOpenId)) return;
    if (!this.claimMessageId(event.messageId)) return;

    this.enqueueEventProcessing(event);
  }

  private async processMessageEvent(event: FeishuMessageEvent): Promise<void> {
    const botOpenId = this.config.botOpenId ?? "";
    const text = stripBotMention(event.text, event.mentions, botOpenId);
    const imageKeys = extractImageKeys(event);
    const fileResources = extractFileResources(event);
    if (!text && imageKeys.length === 0 && fileResources.length === 0) return;

    const conversationKey = resolveConversationKey(event);
    const trackedMessage = this.messageTracker.start({
      messageId: event.messageId,
      conversationKey,
      chatKind: event.chatKind,
      senderName: event.senderName || event.senderOpenId,
      preview: buildFeishuMessagePreview(text, imageKeys.length, fileResources.length),
      imageCount: imageKeys.length,
      fileCount: fileResources.length,
    });
    const typingReaction = await this.addTypingReaction(event.messageId);
    try {
      if (imageKeys.length > 0) {
        this.messageTracker.update(trackedMessage.messageId, { stage: "downloading_images" });
      }
      const imagePaths = await this.saveEventImages(event);
      if (!text && imageKeys.length > 0 && imagePaths.length === 0) {
        this.messageTracker.update(trackedMessage.messageId, {
          stage: "failed",
          error: "图片下载失败",
        });
        return;
      }
      if (fileResources.length > 0) {
        this.messageTracker.update(trackedMessage.messageId, { stage: "downloading_files" });
      }
      const savedFiles = await this.saveEventFiles(event);
      const filePaths = savedFiles.map((file) => file.path);
      this.messageTracker.setFileAttachments(
        trackedMessage.messageId,
        savedFiles.map((file) => ({
          name: basename(file.path),
          path: file.path,
        }))
      );
      if (!text && imageKeys.length === 0 && fileResources.length > 0 && filePaths.length === 0) {
        this.messageTracker.update(trackedMessage.messageId, {
          stage: "failed",
          error: "文件下载失败",
        });
        return;
      }
      this.replyTargets.set(conversationKey, event.messageId);
      const sendContext: FeishuSessionSendContext = { replyToMessageId: event.messageId };

      const command = parseFeishuCommand(text);
      if (command) {
        await this.handleCommand(
          conversationKey,
          command,
          trackedMessage.messageId,
          event.messageId
        );
        return;
      }

      const claudishInput = buildClaudeCodeInputForFeishu({
        chatKind: event.chatKind,
        chatId: event.chatId,
        senderName: event.senderName || event.senderOpenId,
        text,
        imagePaths,
        filePaths,
      });
      if (this.messageClient) {
        this.getOutputRelay(conversationKey, sendContext).suppressEcho(claudishInput);
      }

      this.messageTracker.update(trackedMessage.messageId, { stage: "queued" });
      this.messageTracker.update(trackedMessage.messageId, { stage: "model_processing" });
      await this.sessionRouter.send(conversationKey, claudishInput, sendContext);
      this.messageTracker.update(trackedMessage.messageId, { stage: "completed" });
    } catch (error) {
      this.messageTracker.update(trackedMessage.messageId, {
        stage: "failed",
        error: formatError(error),
      });
      throw error;
    } finally {
      await this.removeTypingReaction(typingReaction);
    }
  }

  private enqueueEventProcessing(event: FeishuMessageEvent): void {
    const task = this.processMessageEvent(event).catch((error) => {
      this.logger.error(error instanceof Error ? error.message : String(error));
    });
    this.pendingEventTasks.add(task);
    task.finally(() => {
      this.pendingEventTasks.delete(task);
    });
  }

  private claimMessageId(messageId: string): boolean {
    if (!messageId) return true;

    const now = this.now();
    this.pruneHandledMessageIds(now);
    if (this.handledMessageIds.has(messageId)) return false;

    this.handledMessageIds.set(messageId, now);
    return true;
  }

  private pruneHandledMessageIds(now: number): void {
    for (const [messageId, handledAt] of this.handledMessageIds) {
      if (now - handledAt > this.messageDedupeTtlMs) {
        this.handledMessageIds.delete(messageId);
      }
    }
  }

  handleSessionOutput(
    conversationKey: string,
    data: string | Uint8Array,
    context?: FeishuSessionSendContext
  ): void {
    this.messageTracker.updateActiveConversation(conversationKey, "replying");
    if (!this.messageClient) {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf-8");
      const cleanText = extractFeishuReturnFileDirectives(cleanTerminalOutput(text)).text;
      this.messageTracker.appendOutput(conversationKey, cleanText);
      this.messageTracker.appendProgressEvent(conversationKey, {
        type: "assistant_text",
        text: cleanText,
      });
      return;
    }

    const relayKey = this.outputRelayKey(conversationKey, context);
    const relay = this.getOutputRelay(conversationKey, context);
    const text = relay.append(data);
    if (this.pendingReturnFiles.has(relayKey)) {
      this.flushRelayAndReturnFiles(
        relayKey,
        this.resolveReplyToMessageId(conversationKey, context)
      ).catch((error) => {
        this.logger.error(`Feishu file reply failed: ${formatError(error)}`);
      });
    }
    if (text) {
      const event: FeishuHeadlessProgressEvent = {
        type: "assistant_text",
        text,
      };
      this.messageTracker.appendOutput(
        conversationKey,
        formatFeishuProgressEvent({
          ...event,
        })
      );
      this.messageTracker.appendProgressEvent(conversationKey, event);
    }
  }

  handleSessionProgress(
    conversationKey: string,
    event: FeishuHeadlessProgressEvent,
    context?: FeishuSessionSendContext
  ): void {
    this.messageTracker.appendOutput(conversationKey, formatFeishuProgressEvent(event));
    this.messageTracker.appendProgressEvent(conversationKey, event);
    if (this.config.sendProgressReplies && event.type === "assistant_text") {
      this.sendAssistantProgressReply(conversationKey, event.text, context);
    }
  }

  private async saveEventImages(
    event: ReturnType<typeof parseFeishuMessageEvent>
  ): Promise<string[]> {
    if (!event || !this.mediaClient) return [];

    const imagePaths: string[] = [];
    for (const imageKey of extractImageKeys(event)) {
      try {
        const image = await this.mediaClient.downloadImage(imageKey, event.messageId);
        const savedImage = saveFeishuImage({
          cwd: this.config.cwd,
          conversationKey: resolveConversationKey(event),
          messageId: event.messageId,
          imageKey,
          buffer: image.buffer,
          contentType: image.contentType,
        });
        const visionImage = await this.imageVisionEnhancer(savedImage);
        imagePaths.push(visionImage.path);
      } catch (error) {
        this.logger.warn(error instanceof Error ? error.message : String(error));
      }
    }
    return imagePaths;
  }

  private async saveEventFiles(
    event: ReturnType<typeof parseFeishuMessageEvent>
  ): Promise<SavedFeishuFile[]> {
    if (!event || !this.mediaClient?.downloadFile) return [];

    const savedFiles: SavedFeishuFile[] = [];
    for (const resource of extractFileResources(event)) {
      try {
        const file = await this.mediaClient.downloadFile(resource.fileKey, event.messageId);
        const savedFile = saveFeishuFile({
          cwd: this.config.cwd,
          messageId: event.messageId,
          fileKey: resource.fileKey,
          fileName: resource.fileName,
          buffer: file.buffer,
          contentType: file.contentType,
        });
        savedFiles.push(savedFile);
      } catch (error) {
        this.logger.warn(error instanceof Error ? error.message : String(error));
      }
    }
    return savedFiles;
  }

  private getOutputRelay(
    conversationKey: string,
    context?: FeishuSessionSendContext
  ): FeishuOutputRelay {
    const relayKey = this.outputRelayKey(conversationKey, context);
    const existing = this.outputRelays.get(relayKey);
    if (existing) return existing;

    const relay = new FeishuOutputRelay({
      quietMs: this.outputQuietMs,
      onError: (error) => {
        this.logger.error(`Feishu reply failed: ${formatError(error)}`);
      },
      transformText: (text) => this.collectReturnFileDirectives(relayKey, text),
      sendText: async (text) => {
        const replyToMessageId = this.resolveReplyToMessageId(conversationKey, context);
        if (!replyToMessageId || !this.messageClient) return;
        await sendFeishuText(this.messageClient, { replyToMessageId, text });
      },
    });
    this.outputRelays.set(relayKey, relay);
    return relay;
  }

  private collectReturnFileDirectives(relayKey: string, text: string): string {
    const extracted = extractFeishuReturnFileDirectives(text, this.config.cwd);
    const files: FeishuReturnFile[] = [];
    for (const filePath of extracted.filePaths) {
      try {
        files.push(resolveFeishuReturnFile(this.config.cwd, filePath));
      } catch (error) {
        this.logger.error(`Feishu return file ignored: ${formatError(error)}`);
      }
    }
    if (files.length > 0) {
      this.pendingReturnFiles.set(relayKey, [
        ...(this.pendingReturnFiles.get(relayKey) ?? []),
        ...files,
      ]);
    }
    return extracted.text;
  }

  private async flushRelayAndReturnFiles(
    relayKey: string,
    replyToMessageId: string | undefined
  ): Promise<void> {
    await this.outputRelays.get(relayKey)?.flush();
    await this.sendPendingReturnFiles(relayKey, replyToMessageId);
  }

  private async sendPendingReturnFiles(
    relayKey: string,
    replyToMessageId: string | undefined
  ): Promise<void> {
    const files = this.pendingReturnFiles.get(relayKey) ?? [];
    this.pendingReturnFiles.delete(relayKey);
    for (const file of files) {
      await this.replyReturnFile(file, replyToMessageId);
    }
  }

  private sendAssistantProgressReply(
    conversationKey: string,
    text: string,
    context?: FeishuSessionSendContext
  ): void {
    if (!this.messageClient) return;

    const cleanText = sanitizeFeishuLeakedDraftText(text, { dropWhenNoReply: true });
    if (!cleanText) return;

    const relayKey = this.outputRelayKey(conversationKey, context);
    this.getOutputRelay(conversationKey, context).append(cleanText);
    if (this.pendingReturnFiles.has(relayKey)) {
      this.flushRelayAndReturnFiles(
        relayKey,
        this.resolveReplyToMessageId(conversationKey, context)
      ).catch((error) => {
        this.logger.error(`Feishu file reply failed: ${formatError(error)}`);
      });
    }
  }

  private async handleCommand(
    conversationKey: string,
    command: FeishuCommand,
    messageId: string,
    replyToMessageId: string
  ): Promise<void> {
    this.messageTracker.update(messageId, { stage: "replying" });
    if (command.type === "new" || command.type === "clear") {
      if (this.sessionRouter.resetSession) {
        this.sessionRouter.resetSession(conversationKey);
      } else {
        this.sessionRouter.stopSession?.(conversationKey);
      }
      this.disposeRelay(conversationKey);
      await this.replyCommand("已开启新会话。", replyToMessageId);
      this.messageTracker.update(messageId, { stage: "completed" });
      return;
    }

    if (command.type === "file") {
      await this.replyReturnFile(
        resolveFeishuReturnFile(this.config.cwd, command.path),
        replyToMessageId
      );
      this.messageTracker.update(messageId, { stage: "completed" });
      return;
    }

    if (command.type === "status") {
      await this.replyCommand(this.buildStatusReply(conversationKey), replyToMessageId);
      this.messageTracker.update(messageId, { stage: "completed" });
      return;
    }

    this.sessionRouter.stopSession?.(conversationKey);
    this.disposeRelay(conversationKey);
    await this.replyCommand("已停止当前会话。", replyToMessageId);
    this.messageTracker.update(messageId, { stage: "stopped" });
  }

  private buildStatusReply(conversationKey: string): string {
    const sessions = this.sessionRouter.listSessions();
    const session = sessions.find((item) => item.conversationKey === conversationKey);
    const isRunning = session?.status === "running";
    const recentMessages = this.messageTracker
      .list()
      .filter((message) => message.conversationKey === conversationKey);

    return [
      `状态：${isRunning ? "运行中" : "空闲"}`,
      `账号：${this.config.id || "default"}`,
      `会话：${conversationKey}`,
      `模型：${this.config.model}`,
      `工作目录：${this.config.cwd}`,
      `最近消息：${recentMessages.length}`,
    ].join("\n");
  }

  private async replyCommand(text: string, replyToMessageId: string | undefined): Promise<void> {
    if (!replyToMessageId || !this.messageClient) return;
    await sendFeishuText(this.messageClient, { replyToMessageId, text });
  }

  private async replyReturnFile(
    file: FeishuReturnFile,
    replyToMessageId: string | undefined
  ): Promise<void> {
    if (!replyToMessageId || !this.messageClient) return;
    await sendFeishuFile(this.messageClient, {
      replyToMessageId,
      filePath: file.path,
      fileName: file.fileName,
    });
  }

  private disposeRelay(conversationKey: string): void {
    for (const relayKey of this.outputRelays.keys()) {
      if (!this.isRelayKeyForConversation(relayKey, conversationKey)) continue;
      this.outputRelays.get(relayKey)?.dispose();
      this.outputRelays.delete(relayKey);
      this.pendingReturnFiles.delete(relayKey);
    }
    for (const relayKey of this.pendingReturnFiles.keys()) {
      if (this.isRelayKeyForConversation(relayKey, conversationKey)) {
        this.pendingReturnFiles.delete(relayKey);
      }
    }
  }

  private async addTypingReaction(
    messageId: string
  ): Promise<{ messageId: string; reactionId: string | null } | undefined> {
    if (!this.reactionClient || !messageId) return undefined;
    try {
      const result = await this.reactionClient.addTypingReaction({ messageId });
      return {
        messageId,
        reactionId: result.reactionId,
      };
    } catch (error) {
      this.logger.warn(`Feishu typing reaction add failed: ${formatError(error)}`);
      return undefined;
    }
  }

  private async removeTypingReaction(
    state: { messageId: string; reactionId: string | null } | undefined
  ): Promise<void> {
    if (!this.reactionClient || !state?.reactionId) return;
    try {
      await this.reactionClient.removeTypingReaction({
        messageId: state.messageId,
        reactionId: state.reactionId,
      });
    } catch (error) {
      this.logger.warn(`Feishu typing reaction remove failed: ${formatError(error)}`);
    }
  }

  private createDefaultSessionRouter(options: FeishuChannelOptions): FeishuSessionRouterLike {
    const onOutput = (
      conversationKey: string,
      data: string | Uint8Array,
      context: FeishuSessionSendContext | undefined
    ) => this.handleSessionOutput(conversationKey, data, context);
    if (options.config.sessionMode === "terminal") {
      return new FeishuSessionRouter({
        model: options.config.model,
        cwd: options.config.cwd,
        onOutput,
      });
    }

    return new FeishuHeadlessSessionRouter({
      model: options.config.model,
      cwd: options.config.cwd,
      history: options.config.history,
      historyBaseDir: options.historyBaseDir,
      runHeadless: options.headlessRunner,
      onOutput,
      onProgress: (conversationKey, event, context) =>
        this.handleSessionProgress(conversationKey, event, context),
    });
  }

  private outputRelayKey(conversationKey: string, context?: FeishuSessionSendContext): string {
    return context?.replyToMessageId
      ? `${conversationKey}\u0000${context.replyToMessageId}`
      : conversationKey;
  }

  private resolveReplyToMessageId(
    conversationKey: string,
    context?: FeishuSessionSendContext
  ): string | undefined {
    return context?.replyToMessageId ?? this.replyTargets.get(conversationKey);
  }

  private isRelayKeyForConversation(relayKey: string, conversationKey: string): boolean {
    return relayKey === conversationKey || relayKey.startsWith(`${conversationKey}\u0000`);
  }
}

function resolveFeishuChannelId(accountId: string | undefined): string {
  return !accountId || accountId === "default" ? "feishu" : `feishu:${accountId}`;
}

type FeishuCommand =
  | { type: "new" }
  | { type: "clear" }
  | { type: "stop" }
  | { type: "status" }
  | { type: "file"; path: string };

function parseFeishuCommand(text: string): FeishuCommand | null {
  const command = text.trim().toLowerCase();
  if (command === "/new") return { type: "new" };
  if (command === "/clear") return { type: "clear" };
  if (command === "/stop") return { type: "stop" };
  if (command === "/status") return { type: "status" };
  const file = text.trim().match(/^\/(?:file|sendfile)\s+(.+)$/i);
  if (file) return { type: "file", path: file[1].trim() };
  return null;
}

function buildFeishuMessagePreview(text: string, imageCount: number, fileCount = 0): string {
  const parts: string[] = [];
  if (imageCount > 0) parts.push(`[图片 x${imageCount}]`);
  if (fileCount > 0) parts.push(`[文件 x${fileCount}]`);
  if (text) parts.push(text);
  const preview = parts.join(" ").trim();
  return preview.length > 80 ? `${preview.slice(0, 77)}...` : preview;
}

function noopEventClient(): FeishuEventClient {
  return {
    start() {},
    stop() {},
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatFeishuProgressEvent(event: FeishuHeadlessProgressEvent): string {
  if (event.type === "assistant_text") {
    return `[assistant] ${event.text}\n`;
  }
  if (event.type === "tool_start") {
    const input = formatProgressPayload(event.input);
    return input ? `[tool] ${event.name} ${input}\n` : `[tool] ${event.name}\n`;
  }
  if (event.type === "tool_result") {
    const prefix = event.isError ? "[tool:error]" : "[tool:result]";
    return `${prefix} ${event.text}\n`;
  }
  return `[stderr] ${event.text}\n`;
}

function formatProgressPayload(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    const text = JSON.stringify(input);
    return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
  } catch {
    return String(input);
  }
}
