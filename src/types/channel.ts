export interface ChannelMessage {
  channel: string;
  userId: string;
  userName?: string;
  content: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
}

export interface Channel {
  start(): Promise<void>;
  sendMessage(userId: string, message: string, metadata?: Record<string, unknown>): Promise<void>;
  stop?(): Promise<void>;
}
