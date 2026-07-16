import OpenAI from 'openai';
import { BaseProvider } from './base';
import { LLMCallParams, LLMResponse } from '../../types/llm';

export class OpenAICompatibleProvider extends BaseProvider {
  private client: OpenAI;

  constructor(config: any) {
    super(config);
    this.client = new OpenAI({
      baseURL: this.getApiUrl(),
      apiKey: this.config.config.api_key,
      timeout: this.getTimeout() * 1000,
    });
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const response = await this.client.chat.completions.create({
      model: this.getModel(),
      messages: [
        ...(params.system ? [{ role: 'system' as const, content: params.system }] : []),
        ...params.messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        })),
      ],
      tools: params.tools as any[],
      temperature: params.temperature ?? this.getTemperature(),
      max_tokens: params.max_tokens ?? this.getMaxTokens(),
      top_p: params.top_p,
    });

    const choice = response.choices[0];
    return {
      content: choice.message?.content || '',
      tool_calls: choice.message?.tool_calls as any,
      stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
      usage: response.usage ? {
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
      } : undefined,
    };
  }
}
