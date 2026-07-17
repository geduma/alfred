import { getLogger } from '../../utils/logger';
import { Embedder, createEmbedder } from './embedder';
import { VectorStoreConfig } from '../../types/config';
import { ProviderConfig } from '../../types/llm';
import { ChunkMetadata, SearchResult, IndexedMessage } from '../../types/vector';

const DEFAULT_TABLE_NAME = 'messages';

type LanceDB = typeof import('@lancedb/lancedb');

export class VectorStoreManager {
  private db: any = null;
  private table: any = null;
  private embedder: Embedder;
  private config: VectorStoreConfig;
  private initialized = false;
  private static lancedbModule: LanceDB | null = null;

  constructor(config: VectorStoreConfig, allProviders?: Record<string, ProviderConfig>) {
    this.config = config;
    this.embedder = createEmbedder(config.embedding, allProviders);
  }

  private static async getLanceDB(): Promise<LanceDB> {
    if (!VectorStoreManager.lancedbModule) {
      VectorStoreManager.lancedbModule = await import('@lancedb/lancedb');
    }
    return VectorStoreManager.lancedbModule;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const lancedb = await VectorStoreManager.getLanceDB();
      this.db = await lancedb.connect(this.config.path);
      const tableNames = await this.db.tableNames();

      if (tableNames.includes(DEFAULT_TABLE_NAME)) {
        this.table = await this.db.openTable(DEFAULT_TABLE_NAME);
        getLogger().info({ path: this.config.path }, 'Vector store opened');
      } else {
        this.table = await this.db.createTable(DEFAULT_TABLE_NAME, [
          {
            id: '',
            vector: new Array(this.embedder.dimension).fill(0),
            text: '',
            sessionId: '',
            channel: '',
            userId: '',
            timestamp: '',
            role: '',
            messageId: '',
          },
        ]);
        getLogger().info({ path: this.config.path }, 'Vector store created');
      }

      // test embedding to verify embedder is reachable
      try {
        await this.embedder.embed('ping');
        getLogger().info({ dimension: this.embedder.dimension }, 'Embedder verified');
      } catch (embedError: any) {
        getLogger().warn(
          { error: { message: embedError.message, stack: embedError.stack }, embeddingType: this.config.embedding.type, model: this.config.embedding.model },
          'Embedder test failed — vector store disabled'
        );
        this.db.close();
        this.db = null;
        this.table = null;
        throw embedError;
      }

      this.initialized = true;
    } catch (error: any) {
      getLogger().error(
        { error: { message: error.message, code: error.code, stack: error.stack } },
        'Failed to initialize vector store'
      );
      throw error;
    }
  }

  async ingest(text: string, metadata: ChunkMetadata): Promise<void> {
    if (!this.initialized || !this.table) return;
    if (!text || text.trim().length < 10) return;

    try {
      const chunks = this.chunkText(text, metadata);
      for (const chunk of chunks) {
        const vector = await this.embedder.embed(chunk.text);
        await this.table.add([
          {
            id: chunk.id,
            vector,
            text: chunk.text,
            sessionId: chunk.metadata.sessionId,
            channel: chunk.metadata.channel,
            userId: chunk.metadata.userId,
            timestamp: chunk.metadata.timestamp,
            role: chunk.metadata.role,
            messageId: chunk.metadata.messageId,
          },
        ]);
      }
    } catch (error: any) {
      getLogger().warn(
        { error: { message: error.message, code: error.code, stack: error.stack } },
        'Failed to ingest into vector store'
      );
    }
  }

  async search(query: string, topK?: number): Promise<SearchResult[]> {
    if (!this.initialized || !this.table) return [];

    const k = topK || this.config.search.top_k || 5;

    try {
      const queryVector = await this.embedder.embed(query);
      const results = await this.table.search(queryVector).limit(k * 2).execute();

      return results
        .filter((r: any) => {
          const score = this.cosineSimilarity(queryVector, r.vector as number[]);
          return score >= (this.config.search.min_score || 0.5);
        })
        .slice(0, k)
        .map((r: any) => ({
          text: r.text as string,
          score: this.cosineSimilarity(queryVector, r.vector as number[]),
          metadata: {
            sessionId: r.sessionId as string,
            channel: r.channel as string,
            userId: r.userId as string,
            timestamp: r.timestamp as string,
            role: r.role as 'user' | 'assistant' | 'tool',
            messageId: r.messageId as string,
          },
        }));
    } catch (error: any) {
      getLogger().warn(
        { error: { message: error.message, code: error.code, stack: error.stack } },
        'Vector search failed'
      );
      return [];
    }
  }

  async deleteBySession(sessionId: string): Promise<void> {
    if (!this.initialized || !this.table) return;

    try {
      await this.table.delete(`sessionId = '${sessionId.replace(/'/g, "''")}'`);
    } catch (error: any) {
      getLogger().warn({ error: error.message, sessionId }, 'Failed to delete vectors');
    }
  }

  private chunkText(text: string, metadata: ChunkMetadata): IndexedMessage[] {
    const maxSize = this.config.ingest.max_chunk_size || 512;
    if (text.length <= maxSize) {
      return [{ id: metadata.messageId, text, metadata }];
    }

    const chunks: IndexedMessage[] = [];
    const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
    let current = '';
    let chunkIndex = 0;

    for (const sentence of sentences) {
      if ((current + sentence).length > maxSize && current.length > 0) {
        chunks.push({
          id: `${metadata.messageId}_chunk_${chunkIndex}`,
          text: current.trim(),
          metadata: { ...metadata, messageId: `${metadata.messageId}_chunk_${chunkIndex}` },
        });
        current = sentence;
        chunkIndex++;
      } else {
        current += sentence;
      }
    }

    if (current.trim().length > 0) {
      chunks.push({
        id: `${metadata.messageId}_chunk_${chunkIndex}`,
        text: current.trim(),
        metadata: { ...metadata, messageId: `${metadata.messageId}_chunk_${chunkIndex}` },
      });
    }

    return chunks;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.initialized = false;
      getLogger().info('Vector store closed');
    }
  }

  get isReady(): boolean {
    return this.initialized;
  }

  get embeddingDimension(): number {
    return this.embedder.dimension;
  }
}
