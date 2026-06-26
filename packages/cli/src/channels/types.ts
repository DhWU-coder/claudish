export interface ChannelStatus {
  id: string;
  status: string;
  activeSessions?: number;
  model?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface ChannelConnectionCheck {
  name: string;
  ok: boolean;
  message?: string;
}

export interface ChannelConnectionTestResult {
  ok: boolean;
  checks: ChannelConnectionCheck[];
  latencyMs?: number;
  error?: string;
}

export interface Channel {
  id: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  updateConfig?(config: unknown): Promise<void> | void;
  testConnection?(): Promise<ChannelConnectionTestResult> | ChannelConnectionTestResult;
  getStatus(): ChannelStatus;
}

export interface ChannelStatusSnapshot {
  channels: ChannelStatus[];
}
