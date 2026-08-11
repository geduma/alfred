import { BaseProvider } from './base';
import { LLMCallParams, LLMResponse } from '../../types/llm';
import OpenAI from 'openai';

export class OpenAICompatibleProvider extends BaseProvider {
  private client: any = null;

  constructor(config: any) {
    super(config);
    this.client = new OpenAI({
      baseURL: this.getApiUrl(),
      apiKey: this.config.config.api_key,
      timeout: this.getTimeout() * 1000,
    });
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const client = this.client;
    const response = await client.chat.completions.create({
      model: this.getModel(),
      messages: [
        ...(params.system ? [{ role: 'system' as const, content: params.system }] : []),
        ...params.messages.map(m => ({
          role: m.role,
          content: m.content,
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(m.tool_calls && m.tool_calls.length > 0 ? { tool_calls: m.tool_calls } : {}),
        })),
      ],
      tools: params.tools?.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      })),
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
      model: response.model || this.getModel(),
      raw: response,
    };
  }
}
