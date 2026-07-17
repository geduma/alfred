export interface ChunkMetadata {
  sessionId: string;
  channel: string;
  userId: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'tool';
  messageId: string;
  snapshotId?: string;
}

export interface SearchResult {
  text: string;
  score: number;
  metadata: ChunkMetadata;
}

export interface IndexedMessage {
  id: string;
  text: string;
  metadata: ChunkMetadata;
}
