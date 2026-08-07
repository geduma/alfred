import { Message } from '../types/llm';
import { LLMRouter } from '../agent/llm-router';
import { estimateMessagesTokens, estimateTokenCount } from '../utils/token-counter';
import { getLogger } from '../utils/logger';

export interface CompactedContext {
  summary: string;
  messages: Message[];
  wasCompacted: boolean;
  originalTokenCount: number;
  compactedTokenCount: number;
}

export interface MemoryConfig {
  max_context_tokens: number;
  max_verbatim_messages: number;
  compaction_threshold: number;
  compaction_model: 'auto' | string;
  summary_sections: string[];
}

const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  max_context_tokens: 32000,
  max_verbatim_messages: 20,
  compaction_threshold: 0.65,
  compaction_model: 'auto',
  summary_sections: ['decisions', 'preferences', 'pending', 'context'],
};

const SUMMARY_PROMPT = `You are a context compression engine. Condense the following conversation history into a structured summary. Preserve every user preference, decision made, pending task, deadline, file path, command executed, and key fact. Be concise but complete — the user will NOT see this summary, only the AI will use it as context.

DECISIONS: List all decisions made by the user or agreed upon.
PREFERENCES: List all user preferences mentioned (language, tone, style, etc.).
PENDING: List all pending tasks, reminders, or open questions.
CONTEXT: One short paragraph describing the current state and what is being worked on.
KEY_FACTS: Bullet list of specific facts, file paths, commands, dates, names, numbers, or URLs mentioned.

Conversation:
{conversation}

Structured Summary:`;

export class ContextCompressor {
  private config: MemoryConfig;
  private llmRouter: LLMRouter | null = null;
  private contextBudget: number | null = null;

  constructor(config?: Partial<MemoryConfig>) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
  }

  setLlmRouter(router: LLMRouter): void {
    this.llmRouter = router;
  }

  updateConfig(config: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  setContextBudget(budget: number | null): void {
    this.contextBudget = budget;
  }

  private getBudget(): number {
    return this.contextBudget ?? this.config.max_context_tokens;
  }

  shouldCompact(messages: Message[], systemPromptTokens: number, extraTokens = 0): boolean {
    const msgTokens = estimateMessagesTokens(messages);
    const total = msgTokens + systemPromptTokens + extraTokens;
    const threshold = this.getBudget() * this.config.compaction_threshold;
    return total > threshold;
  }

  async compactSession(
    existingSummary: string | undefined,
    messages: Message[],
    systemPromptTokens: number,
    extraTokens = 0,
    force = false
  ): Promise<CompactedContext> {
    const originalTokenCount = estimateMessagesTokens(messages) + extraTokens;
    const totalTokens = originalTokenCount + systemPromptTokens;
    const threshold = this.getBudget() * this.config.compaction_threshold;

    if (!force && totalTokens <= threshold) {
      return {
        summary: existingSummary || '',
        messages,
        wasCompacted: false,
        originalTokenCount,
        compactedTokenCount: originalTokenCount,
      };
    }

    const tailBudget = Math.max(1, threshold - systemPromptTokens - extraTokens);
    const verboseRecentMessages = this.keepWithinBudget(messages, tailBudget);
    const olderMessages = messages.slice(0, messages.length - verboseRecentMessages.length);

    if (olderMessages.length === 0) {
      return {
        summary: existingSummary || '',
        messages,
        wasCompacted: false,
        originalTokenCount,
        compactedTokenCount: originalTokenCount,
      };
    }

    const newSummary = await this.generateSummary(existingSummary, olderMessages);

    const compactedMessages: Message[] = [
      { role: 'user', content: `[COMPRESSED CONTEXT - Summary of earlier conversation]\n${newSummary}` },
      ...verboseRecentMessages,
    ];

    const compactedTokenCount = estimateMessagesTokens(compactedMessages) + extraTokens;

    getLogger().info(
      {
        originalTokens: originalTokenCount,
        compactedTokens: compactedTokenCount,
        reduction: `${Math.round((1 - compactedTokenCount / originalTokenCount) * 100)}%`,
        olderMessages: olderMessages.length,
        keptVerbatim: verboseRecentMessages.length,
      },
      'Context compressed'
    );

    return {
      summary: newSummary,
      messages: compactedMessages,
      wasCompacted: true,
      originalTokenCount,
      compactedTokenCount,
    };
  }

  private keepWithinBudget(messages: Message[], tailBudget: number): Message[] {
    const maxKeep = Math.max(1, this.config.max_verbatim_messages);
    const kept: Message[] = [];
    let keptTokens = 0;

    for (let i = messages.length - 1; i >= 0 && kept.length < maxKeep; i--) {
      const m = messages[i];
      const msgTokens = estimateTokenCount(m.content) + 4 + (m.tool_call_id ? 20 : 0);
      if (kept.length > 0 && keptTokens + msgTokens > tailBudget) break;
      kept.unshift(m);
      keptTokens += msgTokens;
    }

    return kept;
  }

  private async generateSummary(existingSummary: string | undefined, messages: Message[]): Promise<string> {
    const conversationText = messages
      .map(m => {
        const role = m.role.toUpperCase();
        const content = m.content || '';
        if (m.role === 'tool' && content.length > 500) {
          return `${role}:\n${content.slice(0, 500)}...[truncated]`;
        }
        return `${role}:\n${content}`;
      })
      .join('\n\n');

    const fullPrompt = existingSummary
      ? `PREVIOUS SUMMARY:\n${existingSummary}\n\n---\n\nNEW CONVERSATION:\n${conversationText}\n\n---\n\n${SUMMARY_PROMPT.replace('{conversation}', '')}`
      : SUMMARY_PROMPT.replace('{conversation}', conversationText);

    if (this.llmRouter) {
      try {
        const response = await this.llmRouter.call({
          messages: [{ role: 'user', content: fullPrompt }],
          system: 'You are a context compression engine. Output only the structured summary.',
          max_tokens: 2048,
        });
        return response.content;
      } catch (error: any) {
        getLogger().warn({ error: error.message }, 'Summary generation failed, using fallback');
      }
    }

    return this.fallbackSummary(existingSummary, messages);
  }

  private fallbackSummary(existingSummary: string | undefined, messages: Message[]): string {
    const recentMessages = messages.slice(-10);
    const keyPoints: string[] = [];

    if (existingSummary) {
      keyPoints.push(`[Previous Summary]\n${existingSummary}`);
    }

    for (const msg of recentMessages) {
      if (msg.role === 'user') {
        const firstLine = msg.content.split('\n')[0];
        if (firstLine.length > 100) {
          keyPoints.push(`User asked about: ${firstLine.slice(0, 100)}...`);
        } else {
          keyPoints.push(`User: ${firstLine}`);
        }
      }
      if (msg.role === 'tool' && msg.content.length < 200) {
        keyPoints.push(`Tool result: ${msg.content.slice(0, 150)}`);
      }
    }

    return `DECISIONS:\n- Conversation in progress\n\nPREFERENCES:\n- (See preferences.md)\n\nPENDING:\n- Continue current interaction\n\nCONTEXT:\nOlder conversation summarized. Recent topics include: ${keyPoints.slice(0, 5).join('; ')}.\n\nKEY_FACTS:\n- ${messages.length} total messages in original history`;
  }
}
