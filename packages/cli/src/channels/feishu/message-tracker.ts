import type { FeishuHeadlessProgressEvent } from "./headless-runner.js";

export type FeishuMessageProgressStage =
  | "received"
  | "downloading_images"
  | "downloading_files"
  | "queued"
  | "model_processing"
  | "replying"
  | "completed"
  | "failed"
  | "stopped";

export type FeishuTrackedProgressEvent = FeishuHeadlessProgressEvent & {
  at: number;
};

export interface FeishuTrackedFileAttachment {
  name: string;
  path: string;
}

export interface FeishuTrackedMessage {
  accountId: string;
  messageId: string;
  conversationKey: string;
  chatKind: "group" | "direct";
  senderName: string;
  preview: string;
  imageCount: number;
  fileCount: number;
  stage: FeishuMessageProgressStage;
  receivedAt: number;
  updatedAt: number;
  elapsedMs: number;
  error?: string;
  output?: string;
  progressEvents?: FeishuTrackedProgressEvent[];
  fileAttachments?: FeishuTrackedFileAttachment[];
}

export interface FeishuTrackedSession {
  accountId: string;
  conversationKey: string;
  chatKind: "group" | "direct";
  senderName: string;
  preview: string;
  imageCount: number;
  fileCount: number;
  messageCount: number;
  stage: FeishuMessageProgressStage;
  startedAt: number;
  updatedAt: number;
  elapsedMs: number;
  error?: string;
  output?: string;
  progressEvents?: FeishuTrackedProgressEvent[];
  fileAttachments?: FeishuTrackedFileAttachment[];
  currentMessage: FeishuTrackedMessage;
  messages: FeishuTrackedMessage[];
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
  fileCount?: number;
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
      fileCount: input.fileCount ?? 0,
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

  update(messageId: string, patch: { stage?: FeishuMessageProgressStage; error?: string }): void {
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

  appendOutput(conversationKey: string, output: string): void {
    const messageId = this.activeByConversation.get(conversationKey);
    if (!messageId) return;
    const message = this.messages.get(messageId);
    if (!message || !output) return;

    const timestamp = this.now();
    message.output = trimOutput(`${message.output ?? ""}${output}`);
    message.updatedAt = timestamp;
    message.elapsedMs = Math.max(0, timestamp - message.receivedAt);
  }

  appendProgressEvent(conversationKey: string, event: FeishuHeadlessProgressEvent): void {
    const messageId = this.activeByConversation.get(conversationKey);
    if (!messageId) return;
    const message = this.messages.get(messageId);
    if (!message) return;

    const timestamp = this.now();
    message.progressEvents = trimProgressEvents([
      ...(message.progressEvents ?? []),
      { at: timestamp, ...event },
    ]);
    message.updatedAt = timestamp;
    message.elapsedMs = Math.max(0, timestamp - message.receivedAt);
  }

  setFileAttachments(messageId: string, fileAttachments: FeishuTrackedFileAttachment[]): void {
    const message = this.messages.get(messageId);
    if (!message) return;

    const timestamp = this.now();
    message.fileAttachments = fileAttachments.map((file) => ({ ...file }));
    message.updatedAt = timestamp;
    message.elapsedMs = Math.max(0, timestamp - message.receivedAt);
  }

  setOutput(conversationKey: string, output: string): void {
    const messageId = this.activeByConversation.get(conversationKey);
    if (!messageId) return;
    const message = this.messages.get(messageId);
    if (!message) return;

    const timestamp = this.now();
    message.output = trimOutput(output);
    message.updatedAt = timestamp;
    message.elapsedMs = Math.max(0, timestamp - message.receivedAt);
  }

  list(): FeishuTrackedMessage[] {
    const timestamp = this.now();
    return this.messageOrder
      .map((messageId) => this.messages.get(messageId))
      .filter((message): message is FeishuTrackedMessage => Boolean(message))
      .map((message) => ({
        ...message,
        fileAttachments: cloneFileAttachments(message.fileAttachments),
        elapsedMs: isFinalStage(message.stage)
          ? message.elapsedMs
          : Math.max(0, timestamp - message.receivedAt),
      }));
  }

  listSessions(): FeishuTrackedSession[] {
    const sessions = new Map<string, FeishuTrackedSession>();

    for (const message of this.list()) {
      const existing = sessions.get(message.conversationKey);
      if (!existing) {
        sessions.set(message.conversationKey, {
          accountId: message.accountId,
          conversationKey: message.conversationKey,
          chatKind: message.chatKind,
          senderName: message.senderName,
          preview: message.preview,
          imageCount: message.imageCount,
          fileCount: message.fileCount,
          messageCount: 1,
          stage: message.stage,
          startedAt: message.receivedAt,
          updatedAt: message.updatedAt,
          elapsedMs: message.elapsedMs,
          error: message.error,
          output: message.output,
          progressEvents: cloneProgressEvents(message.progressEvents),
          fileAttachments: cloneFileAttachments(message.fileAttachments),
          currentMessage: message,
          messages: [message],
        });
        continue;
      }

      existing.messageCount += 1;
      existing.startedAt = Math.min(existing.startedAt, message.receivedAt);
      existing.updatedAt = Math.max(existing.updatedAt, message.updatedAt);
      existing.fileAttachments = mergeFileAttachments(
        existing.fileAttachments,
        message.fileAttachments
      );
      existing.progressEvents = mergeProgressEvents(
        existing.progressEvents,
        message.progressEvents
      );
      existing.messages.push(message);
    }

    return Array.from(sessions.values());
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

function trimOutput(output: string): string {
  return output.length > 12000 ? output.slice(-12000) : output;
}

function trimProgressEvents(events: FeishuTrackedProgressEvent[]): FeishuTrackedProgressEvent[] {
  return events.length > 160 ? events.slice(-160) : events;
}

function cloneProgressEvents(
  events: FeishuTrackedProgressEvent[] | undefined
): FeishuTrackedProgressEvent[] | undefined {
  return events ? events.map((event) => ({ ...event })) : undefined;
}

function mergeProgressEvents(
  left: FeishuTrackedProgressEvent[] | undefined,
  right: FeishuTrackedProgressEvent[] | undefined
): FeishuTrackedProgressEvent[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  if (merged.length === 0) return undefined;
  return trimProgressEvents(merged.sort((a, b) => a.at - b.at));
}

function cloneFileAttachments(
  files: FeishuTrackedFileAttachment[] | undefined
): FeishuTrackedFileAttachment[] | undefined {
  return files ? files.map((file) => ({ ...file })) : undefined;
}

function mergeFileAttachments(
  left: FeishuTrackedFileAttachment[] | undefined,
  right: FeishuTrackedFileAttachment[] | undefined
): FeishuTrackedFileAttachment[] | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  return merged.length > 0 ? merged.map((file) => ({ ...file })) : undefined;
}
