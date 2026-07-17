import { Message } from '../types/llm';
import { LLMRouter } from '../agent/llm-router';
import { estimateMessagesTokens } from '../utils/token-counter';
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

  constructor(config?: Partial<MemoryConfig>) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
  }

  setLlmRouter(router: LLMRouter): void {
    this.llmRouter = router;
  }

  updateConfig(config: Partial<MemoryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  shouldCompact(messages: Message[], systemPromptTokens: number): boolean {
    const msgTokens = estimateMessagesTokens(messages);
    const total = msgTokens + systemPromptTokens;
    const threshold = this.config.max_context_tokens * this.config.compaction_threshold;
    return total > threshold;
  }

  estimateMessageTokens(messages: Message[]): number {
    return estimateMessagesTokens(messages);
  }

  estimateTotalTokens(messages: Message[], systemPromptTokens: number): number {
    return estimateMessagesTokens(messages) + systemPromptTokens;
  }

  async compactSession(
    existingSummary: string | undefined,
    messages: Message[],
    systemPromptTokens: number
  ): Promise<CompactedContext> {
    const originalTokenCount = estimateMessagesTokens(messages);
    const totalTokens = originalTokenCount + systemPromptTokens;

    if (totalTokens <= this.config.max_context_tokens * this.config.compaction_threshold) {
      return {
        summary: existingSummary || '',
        messages,
        wasCompacted: false,
        originalTokenCount,
        compactedTokenCount: originalTokenCount,
      };
    }

    const verboseRecentMessages = messages.slice(-this.config.max_verbatim_messages);
    const olderMessages = messages.slice(0, -this.config.max_verbatim_messages);

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

    const compactedTokenCount = estimateMessagesTokens(compactedMessages);

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
