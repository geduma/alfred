import { ContextCompressor } from '../../src/services/context-compressor';
import { Message } from '../../src/types/llm';

function longMessage(role: 'user' | 'assistant' | 'tool', content: string): Message {
  return { role, content };
}

describe('ContextCompressor', () => {
  test('should compact when the request exceeds the provider context budget', () => {
    const compressor = new ContextCompressor({ max_context_tokens: 32000, compaction_threshold: 0.8 });
    compressor.setContextBudget(2000);

    const messages = Array.from({ length: 10 }, () => longMessage('user', 'x'.repeat(1000)));
    const systemTokens = 100;

    expect(compressor.shouldCompact(messages, systemTokens)).toBe(true);
  });

  test('should not compact when below the provider context budget', () => {
    const compressor = new ContextCompressor({ max_context_tokens: 32000, compaction_threshold: 0.8 });
    compressor.setContextBudget(20000);

    const messages = [longMessage('user', 'short')];
    const systemTokens = 100;

    expect(compressor.shouldCompact(messages, systemTokens)).toBe(false);
  });

  test('should count tool schema tokens as extra overhead when compacting', () => {
    const compressor = new ContextCompressor({ max_context_tokens: 1000, compaction_threshold: 0.8 });

    const messages = [longMessage('user', 'hello there')];
    const systemTokens = 50;
    const toolsTokens = 800;

    expect(compressor.shouldCompact(messages, systemTokens, toolsTokens)).toBe(true);
  });

  test('should keep the tail of the history within the token budget', async () => {
    const compressor = new ContextCompressor({ max_context_tokens: 32000, compaction_threshold: 0.8 });
    compressor.setContextBudget(1000);

    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(longMessage('user', `message number ${i} `.repeat(30)));
    }

    const result = await compressor.compactSession(undefined, messages, 50);

    expect(result.wasCompacted).toBe(true);
    const keptTail = result.messages.filter(m => m.role !== 'user' || !m.content.startsWith('[COMPRESSED'));
    expect(keptTail.length).toBeGreaterThan(0);
    expect(keptTail.length).toBeLessThan(messages.length);
  });
});
