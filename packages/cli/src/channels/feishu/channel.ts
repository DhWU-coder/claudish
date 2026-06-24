import { mkdirSync } from "node:fs";
import type { FeishuConfig } from "./config.js";
import {
  type FeishuMessageEvent,
  buildClaudeCodeInputForFeishu,
  extractImageKeys,
  parseFeishuMessageEvent,
  resolveConversationKey,
  shouldHandleMessage,
  stripBotMention,
} from "./events.js";
import type { FeishuHeadlessRunner } from "./headless-runner.js";
import { FeishuHeadlessSessionRouter } from "./headless-session-router.js";
import { type SavedFeishuImage, saveFeishuImage } from "./images.js";
import { FeishuMessageProgressTracker } from "./message-tracker.js";
import { FeishuOutputRelay } from "./output-relay.js";
import { type FeishuMessageClient, sendFeishuText } from "./send.js";
import { type FeishuRoutedSessionStatus, FeishuSessionRouter } from "./session-router.js";

export interface FeishuEventClient {
  start(onEvent: (payload: unknown) => Promise<void> | void): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface FeishuMediaClient {
  downloadImage(
    imageKey: string,
    messageId: string
  ): Promise<{ buffer: Buffer | Uint8Array; contentType: string }>;
}

export interface FeishuReactionClient {
  addTypingReaction(input: { messageId: string }): Promise<{ reactionId: string | null }>;
  removeTypingReaction(input: { messageId: string; reactionId: string }): Promise<void>;
}

export interface FeishuSessionRouterLike {
  send(conversationKey: string, text: string): Promise<void>;
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
  private readonly config: FeishuConfig;
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
    this.status = this.config.enabled ? "stopped" : "not_configured";
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
    };
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
    if (!text && imageKeys.length === 0) return;

    const conversationKey = resolveConversationKey(event);
    const trackedMessage = this.messageTracker.start({
      messageId: event.messageId,
      conversationKey,
      chatKind: event.chatKind,
      senderName: event.senderName || event.senderOpenId,
      preview: buildFeishuMessagePreview(text, imageKeys.length),
      imageCount: imageKeys.length,
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
      this.replyTargets.set(conversationKey, event.messageId);

      const command = parseFeishuCommand(text);
      if (command) {
        await this.handleCommand(conversationKey, command, trackedMessage.messageId);
        return;
      }

      const claudishInput = buildClaudeCodeInputForFeishu({
        chatKind: event.chatKind,
        chatId: event.chatId,
        senderName: event.senderName || event.senderOpenId,
        text,
        imagePaths,
      });
      if (this.messageClient) {
        this.getOutputRelay(conversationKey).suppressEcho(claudishInput);
      }

      this.messageTracker.update(trackedMessage.messageId, { stage: "queued" });
      this.messageTracker.update(trackedMessage.messageId, { stage: "model_processing" });
      await this.sessionRouter.send(conversationKey, claudishInput);
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

  handleSessionOutput(conversationKey: string, data: string | Uint8Array): void {
    if (!this.messageClient) return;
    this.messageTracker.updateActiveConversation(conversationKey, "replying");
    this.getOutputRelay(conversationKey).append(data);
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

  private getOutputRelay(conversationKey: string): FeishuOutputRelay {
    const existing = this.outputRelays.get(conversationKey);
    if (existing) return existing;

    const relay = new FeishuOutputRelay({
      quietMs: this.outputQuietMs,
      onError: (error) => {
        this.logger.error(`Feishu reply failed: ${formatError(error)}`);
      },
      sendText: async (text) => {
        const replyToMessageId = this.replyTargets.get(conversationKey);
        if (!replyToMessageId || !this.messageClient) return;
        await sendFeishuText(this.messageClient, { replyToMessageId, text });
      },
    });
    this.outputRelays.set(conversationKey, relay);
    return relay;
  }

  private async handleCommand(
    conversationKey: string,
    command: FeishuCommand,
    messageId: string
  ): Promise<void> {
    this.messageTracker.update(messageId, { stage: "replying" });
    if (command === "new" || command === "clear") {
      if (this.sessionRouter.resetSession) {
        this.sessionRouter.resetSession(conversationKey);
      } else {
        this.sessionRouter.stopSession?.(conversationKey);
      }
      this.disposeRelay(conversationKey);
      await this.replyCommand(conversationKey, "已开启新会话。");
      this.messageTracker.update(messageId, { stage: "completed" });
      return;
    }

    this.sessionRouter.stopSession?.(conversationKey);
    this.disposeRelay(conversationKey);
    await this.replyCommand(conversationKey, "已停止当前会话。");
    this.messageTracker.update(messageId, { stage: "stopped" });
  }

  private async replyCommand(conversationKey: string, text: string): Promise<void> {
    const replyToMessageId = this.replyTargets.get(conversationKey);
    if (!replyToMessageId || !this.messageClient) return;
    await sendFeishuText(this.messageClient, { replyToMessageId, text });
  }

  private disposeRelay(conversationKey: string): void {
    this.outputRelays.get(conversationKey)?.dispose();
    this.outputRelays.delete(conversationKey);
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
    const onOutput = (conversationKey: string, data: string | Uint8Array) =>
      this.handleSessionOutput(conversationKey, data);
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
    });
  }
}

function resolveFeishuChannelId(accountId: string | undefined): string {
  return !accountId || accountId === "default" ? "feishu" : `feishu:${accountId}`;
}

type FeishuCommand = "new" | "clear" | "stop";

function parseFeishuCommand(text: string): FeishuCommand | null {
  const command = text.trim().toLowerCase();
  if (command === "/new") return "new";
  if (command === "/clear") return "clear";
  if (command === "/stop") return "stop";
  return null;
}

function buildFeishuMessagePreview(text: string, imageCount: number): string {
  const parts: string[] = [];
  if (imageCount > 0) parts.push(`[图片 x${imageCount}]`);
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
