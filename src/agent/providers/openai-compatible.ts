import { BaseProvider } from './base';
import { LLMCallParams, LLMResponse, LLMStreamEvent, LLMStreamingConfig } from '../../types/llm';
import OpenAI from 'openai';

const STREAM_OPTIONS_UNSUPPORTED_PATTERN = /(unrecognized|unknown|unexpected|invalid).*(stream_options|parameter)|stream_options.*(not supported|unsupported|unknown)/i;

export class OpenAICompatibleProvider extends BaseProvider {
  private client: any = null;

  constructor(config: any, streaming?: LLMStreamingConfig) {
    super(config, streaming);
    this.client = new OpenAI({
      baseURL: this.getApiUrl(),
      apiKey: this.config.config.api_key,
      timeout: this.getTimeout() * 1000,
      maxRetries: 0,
    });
  }

  private buildRequest(params: LLMCallParams): Record<string, unknown> {
    return {
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
    };
  }

  protected async callNonStreaming(params: LLMCallParams): Promise<LLMResponse> {
    const client = this.client;
    const response = await client.chat.completions.create({
      ...this.buildRequest(params),
      stream: false,
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

  protected async *streamEvents(params: LLMCallParams, signal: AbortSignal): AsyncGenerator<LLMStreamEvent> {
    const client = this.client;
    const base = this.buildRequest(params);

    let stream: any;
    try {
      stream = await client.chat.completions.create({
        ...base,
        stream: true,
        stream_options: { include_usage: true },
        signal,
        timeout: this.getStreamTransportTimeoutMs(),
      });
    } catch (error: any) {
      if (isStreamOptionsUnsupported(error)) {
        stream = await client.chat.completions.create({
          ...base,
          stream: true,
          signal,
          timeout: this.getStreamTransportTimeoutMs(),
        });
      } else {
        throw error;
      }
    }

    const toolStates = new Map<number, { id?: string; name?: string; arguments?: string }>();
    let finishReason: string | null = null;
    let model: string | undefined;

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      model = chunk.model || model;

      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0;
          const state = toolStates.get(index) || {};
          if (tc.id) state.id = tc.id;
          if (tc.function?.name) state.name = tc.function.name;
          if (tc.function?.arguments) state.arguments = (state.arguments || '') + tc.function.arguments;
          toolStates.set(index, state);
          yield { type: 'tool_call_delta', index, id: state.id, name: state.name, arguments: state.arguments };
        }
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }

      if (chunk.usage) {
        yield {
          type: 'usage',
          input_tokens: chunk.usage.prompt_tokens,
          output_tokens: chunk.usage.completion_tokens,
        };
      }
    }

    yield { type: 'finish', stop_reason: mapFinishReason(finishReason), model };
  }
}

function mapFinishReason(reason: string | null): LLMResponse['stop_reason'] {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    default:
      return 'end_turn';
  }
}

function isStreamOptionsUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const status = (error as any)?.status;
  return (status === 400 || status === 404 || status === 422) && STREAM_OPTIONS_UNSUPPORTED_PATTERN.test(message);
}
