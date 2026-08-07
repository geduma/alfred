import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { VectorStoreManager } from '../services/vector-store/index';
import { SnapshotManager } from '../services/snapshot';

export class MemoryTool implements ToolHandler {
  tool: Tool = {
    name: 'memory',
    description: 'Search long-term memory (vector store) or manage snapshots. Query: search with natural language. Snapshots: list, get, or restore session state.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'snapshots', 'snapshot_get', 'snapshot_restore'] },
        query: { type: 'string', description: 'Natural language query for vector search' },
        sessionId: { type: 'string', description: 'Session ID for snapshot operations' },
        snapshotId: { type: 'string', description: 'Snapshot ID for get/restore' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
      },
      required: ['action'],
    },
  };

  private vectorStore: VectorStoreManager | null;
  private snapshotManager: SnapshotManager | null;

  constructor(vectorStore: VectorStoreManager | null, snapshotManager: SnapshotManager | null) {
    this.vectorStore = vectorStore;
    this.snapshotManager = snapshotManager;
  }

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'search':
        return this.search(params);
      case 'snapshots':
        return this.listSnapshots(params);
      case 'snapshot_get':
        return this.getSnapshot(params);
      case 'snapshot_restore':
        return this.restoreSnapshot(params);
      default:
        return { success: false, output: '', error: `Unknown action: ${action}` };
    }
  }

  private async search(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.vectorStore) {
      return { success: false, output: '', error: 'Vector store not available' };
    }

    const query = params.query as string;
    if (!query) return { success: false, output: '', error: 'Query is required' };

    const limit = Math.min((params.limit as number) || 5, 20);

    try {
      const results = await this.vectorStore.search(query, limit);
      if (results.length === 0) {
        return { success: true, output: 'No relevant memories found.' };
      }

      const lines = results.map((r, i) =>
        `[${i + 1}] Score: ${r.score.toFixed(3)} | ${r.metadata.role} | ${r.metadata.timestamp}\n    ${r.text.slice(0, 300)}`
      );

      return {
        success: true,
        output: `Found ${results.length} relevant memories:\n\n${lines.join('\n\n')}`,
      };
    } catch (error: any) {
      return { success: false, output: '', error: `Search failed: ${error.message}` };
    }
  }

  private async listSnapshots(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.snapshotManager) {
      return { success: false, output: '', error: 'Snapshot manager not available' };
    }

    const sessionId = params.sessionId as string;
    if (!sessionId) return { success: false, output: '', error: 'sessionId is required' };

    try {
      const snapshots = await this.snapshotManager.listBySession(sessionId);
      if (snapshots.length === 0) {
        return { success: true, output: 'No snapshots found for this session.' };
      }

      const lines = snapshots.map(s =>
        `[${s.id}] ${s.timestamp} — ${s.messageCount} messages\n  ${s.summary.slice(0, 200)}`
      );

      return {
        success: true,
        output: `Snapshots for session "${sessionId}" (${snapshots.length}):\n\n${lines.join('\n\n')}`,
      };
    } catch (error: any) {
      return { success: false, output: '', error: `Failed to list snapshots: ${error.message}` };
    }
  }

  private async getSnapshot(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.snapshotManager) {
      return { success: false, output: '', error: 'Snapshot manager not available' };
    }

    const snapshotId = params.snapshotId as string;
    if (!snapshotId) return { success: false, output: '', error: 'snapshotId is required' };

    try {
      const snapshot = await this.snapshotManager.get(snapshotId);
      if (!snapshot) return { success: false, output: '', error: `Snapshot ${snapshotId} not found` };

      return {
        success: true,
        output: `Snapshot: ${snapshot.id}\nSession: ${snapshot.sessionId}\nTime: ${snapshot.timestamp}\nMessages: ${snapshot.messageCount}\nSummary: ${snapshot.summary}\nTags: ${(snapshot.tags || []).join(', ') || 'none'}`,
      };
    } catch (error: any) {
      return { success: false, output: '', error: `Failed to get snapshot: ${error.message}` };
    }
  }

  private async restoreSnapshot(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!this.snapshotManager) {
      return { success: false, output: '', error: 'Snapshot manager not available' };
    }

    const snapshotId = params.snapshotId as string;
    if (!snapshotId) return { success: false, output: '', error: 'snapshotId is required' };

    try {
      const snapshot = await this.snapshotManager.get(snapshotId);
      if (!snapshot) return { success: false, output: '', error: `Snapshot ${snapshotId} not found` };

      return {
        success: true,
        output: `Restored context from snapshot ${snapshot.id} (session ${snapshot.sessionId}, ${snapshot.messageCount} messages):\n\n${snapshot.summary}`,
      };
    } catch (error: any) {
      return { success: false, output: '', error: `Failed to restore snapshot: ${error.message}` };
    }
  }
}