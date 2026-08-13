import { BaseProvider } from './base';
import { LLMCallParams, LLMResponse, LLMStreamEvent, ToolCall } from '../../types/llm';
import Anthropic from '@anthropic-ai/sdk';

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export class AnthropicProvider extends BaseProvider {
  private client: any = null;

  constructor(config: any) {
    super(config);
    this.client = new Anthropic({
      apiKey: this.config.config.api_key,
      baseURL: this.getApiUrl(),
      timeout: this.getTimeout() * 1000,
      maxRetries: 0,
    });
  }

  private convertMessages(messages: LLMCallParams['messages']): any[] {
    const converted: any[] = [];

    for (const m of messages) {
      if (m.role === 'tool') {
        const block: ToolResultBlock = {
          type: 'tool_result',
          tool_use_id: m.tool_call_id || '',
          content: m.content,
        };
        const last = converted[converted.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((c: any) => c.type === 'tool_result')) {
          last.content.push(block);
        } else {
          converted.push({ role: 'user', content: [block] });
        }
      } else if (m.role === 'assistant') {
        if (m.tool_calls && m.tool_calls.length > 0) {
          const blocks: any[] = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const tc of m.tool_calls) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: this.parseArguments(tc.function.arguments),
            });
          }
          converted.push({ role: 'assistant', content: blocks });
        } else {
          converted.push({ role: 'assistant', content: m.content });
        }
      } else {
        const last = converted[converted.length - 1];
        if (last && last.role === 'user' && typeof last.content === 'string') {
          last.content = `${last.content}\n\n${m.content}`;
        } else {
          converted.push({ role: 'user', content: m.content });
        }
      }
    }

    return converted;
  }

  private parseArguments(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return { raw };
    }
  }

  protected async callNonStreaming(params: LLMCallParams): Promise<LLMResponse> {
    const client = this.client;

    const messages = this.convertMessages(params.messages);

    const response = await client.messages.create({
      model: this.getModel(),
      max_tokens: this.getMaxTokens(),
      system: params.system || '',
      messages: messages.length > 0 ? messages : [{ role: 'user', content: 'Hello' }],
      temperature: params.temperature ?? this.getTemperature(),
      ...(params.tools && params.tools.length > 0
        ? { tools: params.tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })) }
        : {}),
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
      model: response.model || this.getModel(),
      raw: response.content,
    };
  }

  protected async *streamEvents(params: LLMCallParams, signal: AbortSignal): AsyncGenerator<LLMStreamEvent> {
    const client = this.client;
    const messages = this.convertMessages(params.messages);

    const stream = await client.messages.create({
      model: this.getModel(),
      max_tokens: this.getMaxTokens(),
      system: params.system || '',
      messages: messages.length > 0 ? messages : [{ role: 'user', content: 'Hello' }],
      temperature: params.temperature ?? this.getTemperature(),
      ...(params.tools && params.tools.length > 0
        ? { tools: params.tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })) }
        : {}),
      stream: true,
      signal,
    });

    const toolStates = new Map<number, { id?: string; name?: string; arguments?: string }>();
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';
    let model: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const event of stream) {
      switch (event.type) {
        case 'message_start':
          inputTokens = event.message.usage?.input_tokens;
          model = event.message.model || model;
          break;

        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            const state = { id: event.content_block.id, name: event.content_block.name, arguments: '' };
            toolStates.set(event.index, state);
            yield { type: 'tool_call_delta', index: event.index, id: state.id, name: state.name, arguments: '' };
          }
          break;

        case 'content_block_delta':
          if (event.delta.type === 'text_delta' && event.delta.text) {
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
            const state = toolStates.get(event.index) || { arguments: '' };
            state.arguments = (state.arguments || '') + event.delta.partial_json;
            toolStates.set(event.index, state);
            yield { type: 'tool_call_delta', index: event.index, id: state.id, name: state.name, arguments: state.arguments };
          }
          break;

        case 'message_delta':
          if (event.delta.stop_reason === 'tool_use') stopReason = 'tool_use';
          else if (event.delta.stop_reason === 'max_tokens') stopReason = 'max_tokens';
          outputTokens = event.usage?.output_tokens;
          break;

        default:
          break;
      }
    }

    if (inputTokens !== undefined || outputTokens !== undefined) {
      yield { type: 'usage', input_tokens: inputTokens ?? 0, output_tokens: outputTokens ?? 0 };
    }

    yield { type: 'finish', stop_reason: stopReason, model };
  }
}
