export interface ChannelStatus {
  id: string;
  status: string;
  activeSessions?: number;
  model?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface Channel {
  id: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  updateConfig?(config: unknown): Promise<void> | void;
  getStatus(): ChannelStatus;
}

export interface ChannelStatusSnapshot {
  channels: ChannelStatus[];
}
