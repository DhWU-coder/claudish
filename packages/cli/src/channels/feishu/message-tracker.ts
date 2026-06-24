export type FeishuMessageProgressStage =
  | "received"
  | "downloading_images"
  | "queued"
  | "model_processing"
  | "replying"
  | "completed"
  | "failed"
  | "stopped";

export interface FeishuTrackedMessage {
  accountId: string;
  messageId: string;
  conversationKey: string;
  chatKind: "group" | "direct";
  senderName: string;
  preview: string;
  imageCount: number;
  stage: FeishuMessageProgressStage;
  receivedAt: number;
  updatedAt: number;
  elapsedMs: number;
  error?: string;
}

export interface FeishuMessageProgressTrackerOptions {
  accountId: string;
  maxMessages?: number;
  now?: () => number;
}

export interface StartFeishuMessageProgressInput {
  messageId: string;
  conversationKey: string;
  chatKind: "group" | "direct";
  senderName: string;
  preview: string;
  imageCount: number;
}

export class FeishuMessageProgressTracker {
  private readonly accountId: string;
  private readonly maxMessages: number;
  private readonly now: () => number;
  private readonly messages = new Map<string, FeishuTrackedMessage>();
  private readonly messageOrder: string[] = [];
  private readonly activeByConversation = new Map<string, string>();

  constructor(options: FeishuMessageProgressTrackerOptions) {
    this.accountId = options.accountId || "default";
    this.maxMessages = options.maxMessages ?? 50;
    this.now = options.now ?? (() => Date.now());
  }

  start(input: StartFeishuMessageProgressInput): FeishuTrackedMessage {
    const timestamp = this.now();
    const message: FeishuTrackedMessage = {
      accountId: this.accountId,
      messageId: input.messageId,
      conversationKey: input.conversationKey,
      chatKind: input.chatKind,
      senderName: input.senderName || "-",
      preview: input.preview,
      imageCount: input.imageCount,
      stage: "received",
      receivedAt: timestamp,
      updatedAt: timestamp,
      elapsedMs: 0,
    };
    this.messages.set(input.messageId, message);
    this.messageOrder.unshift(input.messageId);
    this.activeByConversation.set(input.conversationKey, input.messageId);
    this.prune();
    return message;
  }

  update(
    messageId: string,
    patch: { stage?: FeishuMessageProgressStage; error?: string }
  ): void {
    const message = this.messages.get(messageId);
    if (!message) return;

    const timestamp = this.now();
    if (patch.stage) message.stage = patch.stage;
    if (patch.error) message.error = patch.error;
    message.updatedAt = timestamp;
    message.elapsedMs = Math.max(0, timestamp - message.receivedAt);
    if (isFinalStage(message.stage)) {
      this.clearActiveConversation(message);
    }
  }

  updateActiveConversation(conversationKey: string, stage: FeishuMessageProgressStage): void {
    const messageId = this.activeByConversation.get(conversationKey);
    if (!messageId) return;
    this.update(messageId, { stage });
  }

  list(): FeishuTrackedMessage[] {
    const timestamp = this.now();
    return this.messageOrder
      .map((messageId) => this.messages.get(messageId))
      .filter((message): message is FeishuTrackedMessage => Boolean(message))
      .map((message) => ({
        ...message,
        elapsedMs: isFinalStage(message.stage)
          ? message.elapsedMs
          : Math.max(0, timestamp - message.receivedAt),
      }));
  }

  private prune(): void {
    while (this.messageOrder.length > this.maxMessages) {
      const messageId = this.messageOrder.pop();
      if (!messageId) return;
      const message = this.messages.get(messageId);
      if (message) this.clearActiveConversation(message);
      this.messages.delete(messageId);
    }
  }

  private clearActiveConversation(message: FeishuTrackedMessage): void {
    if (this.activeByConversation.get(message.conversationKey) === message.messageId) {
      this.activeByConversation.delete(message.conversationKey);
    }
  }
}

function isFinalStage(stage: FeishuMessageProgressStage): boolean {
  return stage === "completed" || stage === "failed" || stage === "stopped";
}
