import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from './base';
import { LLMCallParams, LLMResponse, ToolCall } from '../../types/llm';

export class AnthropicProvider extends BaseProvider {
  private client: Anthropic;

  constructor(config: any) {
    super(config);
    this.client = new Anthropic({
      apiKey: this.config.config.api_key,
      baseURL: this.getApiUrl(),
    });
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const systemMessage = params.messages.find(m => m.role === 'user')?.content || '';
    const messages = params.messages
      .filter(m => m.role !== 'user' || m !== params.messages[0])
      .map(m => ({
        role: m.role === 'tool' ? 'user' as const : m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const response = await this.client.messages.create({
      model: this.getModel(),
      max_tokens: this.getMaxTokens(),
      system: params.system || systemMessage,
      messages: messages.length > 0 ? messages : [{ role: 'user', content: 'Hello' }],
      temperature: params.temperature ?? this.getTemperature(),
    });

    const contentBlock = response.content[0];
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content: contentBlock?.type === 'text' ? contentBlock.text : '',
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      stop_reason: response.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
      usage: response.usage ? {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      } : undefined,
    };
  }
}
