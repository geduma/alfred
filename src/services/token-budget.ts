interface TokenBudgetConfig {
  max_input_tokens_per_request: number;
  max_output_tokens_per_request: number;
  max_context_tokens: number;
  warn_threshold: number;
}

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export class TokenBudgetTracker {
  private config: TokenBudgetConfig;
  private sessionUsage: Map<string, { input: number; output: number }> = new Map();

  constructor(config?: Partial<TokenBudgetConfig>) {
    this.config = {
      max_input_tokens_per_request: 64000,
      max_output_tokens_per_request: 8192,
      max_context_tokens: 128000,
      warn_threshold: 0.85,
      ...config,
    };
  }

  checkRequest(inputTokens: number, outputTokens: number): { allowed: boolean; reason?: string } {
    if (inputTokens > this.config.max_input_tokens_per_request) {
      return { allowed: false, reason: `Input exceeds max (${inputTokens} > ${this.config.max_input_tokens_per_request})` };
    }
    if (outputTokens > this.config.max_output_tokens_per_request) {
      return { allowed: false, reason: `Output exceeds max (${outputTokens} > ${this.config.max_output_tokens_per_request})` };
    }
    return { allowed: true };
  }

  checkContext(totalTokens: number): { allowed: boolean; shouldCompact: boolean; reason?: string } {
    if (totalTokens > this.config.max_context_tokens) {
      return { allowed: false, shouldCompact: true, reason: `Context exceeds max (${totalTokens} > ${this.config.max_context_tokens})` };
    }
    if (totalTokens > this.config.max_context_tokens * this.config.warn_threshold) {
      return { allowed: true, shouldCompact: true, reason: `Context above ${Math.round(this.config.warn_threshold * 100)}% threshold` };
    }
    return { allowed: true, shouldCompact: false };
  }

  trackUsage(sessionId: string, usage: { input_tokens?: number; output_tokens?: number }): void {
    const current = this.sessionUsage.get(sessionId) || { input: 0, output: 0 };
    current.input += usage.input_tokens || 0;
    current.output += usage.output_tokens || 0;
    this.sessionUsage.set(sessionId, current);
  }

  getSessionUsage(sessionId: string): TokenUsage {
    const u = this.sessionUsage.get(sessionId) || { input: 0, output: 0 };
    return { input_tokens: u.input, output_tokens: u.output, total_tokens: u.input + u.output };
  }

  resetSession(sessionId: string): void {
    this.sessionUsage.delete(sessionId);
  }
}