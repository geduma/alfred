const TOKEN_PER_CHAR_ESTIMATE = 4;
const TOKEN_PER_WORD_ESTIMATE = 1.3;
const TOOL_CALL_OVERHEAD = 20;

export function estimateTokenCount(text: string): number {
  const charEstimate = Math.ceil(text.length / TOKEN_PER_CHAR_ESTIMATE);
  const wordEstimate = Math.ceil(text.split(/\s+/).length * TOKEN_PER_WORD_ESTIMATE);
  return Math.max(charEstimate, wordEstimate);
}

export function estimateMessagesTokens(messages: { role: string; content: string; tool_call_id?: string }[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokenCount(msg.content);
    if (msg.tool_call_id) {
      total += TOOL_CALL_OVERHEAD;
    }
    total += 4;
  }
  return total;
}

export function approximateSystemPromptTokens(systemPrompt: string): number {
  return estimateTokenCount(systemPrompt);
}
