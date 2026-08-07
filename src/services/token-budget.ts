export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export class TokenBudgetTracker {
  private totalInput = 0;
  private totalOutput = 0;
  private requestCount = 0;

  trackUsage(usage: { input_tokens?: number; output_tokens?: number }): void {
    this.totalInput += usage.input_tokens || 0;
    this.totalOutput += usage.output_tokens || 0;
    this.requestCount++;
  }

  getTotalUsage(): TokenUsage {
    return {
      input_tokens: this.totalInput,
      output_tokens: this.totalOutput,
      total_tokens: this.totalInput + this.totalOutput,
    };
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  reset(): void {
    this.totalInput = 0;
    this.totalOutput = 0;
    this.requestCount = 0;
  }
}