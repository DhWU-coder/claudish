import {
  buildClaudeCodeInputForFeishu,
  extractImageKeys,
  parseFeishuMessageEvent,
  resolveConversationKey,
  shouldHandleMessage,
  stripBotMention,
} from "./events.js";
import { saveFeishuImage } from "./images.js";
import { FeishuOutputRelay } from "./output-relay.js";
import { FeishuSessionRouter, type FeishuRoutedSessionStatus } from "./session-router.js";
import type { FeishuConfig } from "./config.js";
import { sendFeishuText, type FeishuMessageClient } from "./send.js";

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

export interface FeishuSessionRouterLike {
  send(conversationKey: string, text: string): Promise<void>;
  listSessions(): FeishuRoutedSessionStatus[];
  stopAll(): void;
}

export interface FeishuChannelOptions {
  config: FeishuConfig;
  eventClient?: FeishuEventClient;
  mediaClient?: FeishuMediaClient;
  messageClient?: FeishuMessageClient;
  sessionRouter?: FeishuSessionRouterLike;
  outputQuietMs?: number;
  logger?: Pick<Console, "warn" | "error" | "log">;
}

export class FeishuChannel {
  readonly id = "feishu";
  private readonly config: FeishuConfig;
  private readonly eventClient: FeishuEventClient;
  private readonly mediaClient?: FeishuMediaClient;
  private readonly messageClient?: FeishuMessageClient;
  private readonly sessionRouter: FeishuSessionRouterLike;
  private readonly outputQuietMs: number;
  private readonly logger: Pick<Console, "warn" | "error" | "log">;
  private readonly replyTargets = new Map<string, string>();
  private readonly outputRelays = new Map<string, FeishuOutputRelay>();
  private status: string;

  constructor(options: FeishuChannelOptions) {
    this.config = options.config;
    this.eventClient = options.eventClient ?? noopEventClient();
    this.mediaClient = options.mediaClient;
    this.messageClient = options.messageClient;
    this.outputQuietMs = options.outputQuietMs ?? 800;
    this.sessionRouter =
      options.sessionRouter ??
      new FeishuSessionRouter({
        model: options.config.model,
        cwd: options.config.cwd,
        onOutput: (conversationKey, data) => this.handleSessionOutput(conversationKey, data),
      });
    this.logger = options.logger ?? console;
    this.status = options.config.enabled ? "configured" : "not_configured";
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.status = "not_configured";
      return;
    }

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
      id: "feishu",
      status: this.status,
      activeSessions: sessions.filter((session) => session.status === "running").length,
      model: this.config.model,
      cwd: this.config.cwd,
    };
  }

  async handleEvent(payload: unknown): Promise<void> {
    const event = parseFeishuMessageEvent(payload);
    if (!event) return;

    const botOpenId = this.config.botOpenId ?? "";
    if (!shouldHandleMessage(event, botOpenId)) return;

    const imagePaths = await this.saveEventImages(event);
    const text = stripBotMention(event.text, event.mentions, botOpenId);
    if (!text && imagePaths.length === 0) return;

    const conversationKey = resolveConversationKey(event);
    this.replyTargets.set(conversationKey, event.messageId);

    await this.sessionRouter.send(
      conversationKey,
      buildClaudeCodeInputForFeishu({
        chatKind: event.chatKind,
        chatId: event.chatId,
        senderName: event.senderName || event.senderOpenId,
        text,
        imagePaths,
      })
    );
  }

  handleSessionOutput(conversationKey: string, data: string | Uint8Array): void {
    if (!this.messageClient) return;
    this.getOutputRelay(conversationKey).append(data);
  }

  private async saveEventImages(event: ReturnType<typeof parseFeishuMessageEvent>): Promise<string[]> {
    if (!event || !this.mediaClient) return [];

    const imagePaths: string[] = [];
    for (const imageKey of extractImageKeys(event)) {
      try {
        const image = await this.mediaClient.downloadImage(imageKey, event.messageId);
        imagePaths.push(
          saveFeishuImage({
            cwd: this.config.cwd,
            conversationKey: resolveConversationKey(event),
            messageId: event.messageId,
            imageKey,
            buffer: image.buffer,
            contentType: image.contentType,
          }).path
        );
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
      sendText: async (text) => {
        const replyToMessageId = this.replyTargets.get(conversationKey);
        if (!replyToMessageId || !this.messageClient) return;
        await sendFeishuText(this.messageClient, { replyToMessageId, text });
      },
    });
    this.outputRelays.set(conversationKey, relay);
    return relay;
  }
}

function noopEventClient(): FeishuEventClient {
  return {
    start() {},
    stop() {},
  };
}
