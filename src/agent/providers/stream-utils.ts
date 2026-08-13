import { LLMCallParams, LLMResponse, LLMStreamEvent, ToolCall } from '../../types/llm';

export type StreamTimeoutKind = 'initial' | 'idle' | 'total';

export interface StreamTimeoutConfig {
  initialMs: number;
  idleMs: number;
  totalMs: number | null;
}

export class LLMStreamTimeoutError extends Error {
  readonly code = 'LLM_STREAM_TIMEOUT';
  readonly kind: StreamTimeoutKind;

  constructor(kind: StreamTimeoutKind, message: string) {
    super(message);
    this.name = 'LLMStreamTimeoutError';
    this.kind = kind;
  }
}

export class LLMStreamInterruptedError extends Error {
  readonly code = 'LLM_STREAM_INTERRUPTED';

  constructor(message: string) {
    super(message);
    this.name = 'LLMStreamInterruptedError';
  }
}

interface ToolCallState {
  id?: string;
  name?: string;
  arguments?: string;
}

export async function accumulateStream(
  events: AsyncGenerator<LLMStreamEvent>,
  params: LLMCallParams,
  controller: AbortController,
  timeouts: StreamTimeoutConfig,
  defaultModel: string
): Promise<LLMResponse> {
  let text = '';
  const toolCalls: Map<number, ToolCallState> = new Map();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let stopReason: LLMResponse['stop_reason'] = 'end_turn';
  let model: string | undefined;
  const collected: LLMStreamEvent[] = [];

  let timeoutKind: StreamTimeoutKind | null = null;
  let firstEvent = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const armIdle = (): void => {
    clearIdle();
    idleTimer = setTimeout(() => {
      timeoutKind = 'idle';
      controller.abort();
    }, timeouts.idleMs);
  };

  const initialTimer = setTimeout(() => {
    timeoutKind = 'initial';
    controller.abort();
  }, timeouts.initialMs);

  const totalTimer = timeouts.totalMs !== null
    ? setTimeout(() => {
        timeoutKind = 'total';
        controller.abort();
      }, timeouts.totalMs)
    : null;

  const emit = (event: LLMStreamEvent): void => {
    collected.push(event);
    params.onEvent?.(event);
  };

  const finalizeToolCalls = (): ToolCall[] | undefined => {
    if (toolCalls.size === 0) return undefined;
    const result: ToolCall[] = [];
    for (const [index, tc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      result.push({
        id: tc.id || `call_${index}`,
        type: 'function',
        function: {
          name: tc.name || '',
          arguments: tc.arguments || '{}',
        },
      });
    }
    return result;
  };

  try {
    for await (const event of events) {
      if (!firstEvent) {
        firstEvent = true;
        clearTimeout(initialTimer);
      }
      armIdle();

      switch (event.type) {
        case 'text_delta':
          text += event.text;
          break;
        case 'tool_call_delta':
          toolCalls.set(event.index, {
            id: event.id ?? toolCalls.get(event.index)?.id,
            name: event.name ?? toolCalls.get(event.index)?.name,
            arguments: event.arguments ?? toolCalls.get(event.index)?.arguments,
          });
          break;
        case 'tool_call_complete':
          break;
        case 'usage':
          if (event.input_tokens !== undefined) inputTokens = event.input_tokens;
          if (event.output_tokens !== undefined) outputTokens = event.output_tokens;
          break;
        case 'finish':
          stopReason = event.stop_reason;
          if (event.model) model = event.model;
          break;
        case 'error':
          throw event.error instanceof Error ? event.error : new Error(String(event.error ?? 'LLM stream error'));
      }

      emit(event);
    }

    if (timeoutKind) {
      throw timeoutError(timeoutKind, timeouts);
    }

    if (controller.signal.aborted) {
      throw timeoutError(timeoutKind ?? 'idle', timeouts);
    }

    clearTimeout(initialTimer);
    clearIdle();

    const finalized = finalizeToolCalls();
    for (const tc of finalized || []) {
      emit({ type: 'tool_call_complete', toolCall: tc });
    }

    return {
      content: text,
      tool_calls: finalized,
      stop_reason: stopReason,
      usage: inputTokens !== undefined || outputTokens !== undefined
        ? { input_tokens: inputTokens ?? 0, output_tokens: outputTokens ?? 0 }
        : undefined,
      model: model || defaultModel,
      raw: collected,
    };
  } catch (error) {
    clearTimeout(initialTimer);
    clearIdle();
    if (totalTimer) clearTimeout(totalTimer);

    if (timeoutKind) {
      throw timeoutError(timeoutKind, timeouts);
    }
    if (isAbortError(error) && controller.signal.aborted) {
      throw timeoutError('idle', timeouts);
    }

    emit({ type: 'error', error });
    throw error;
  } finally {
    clearTimeout(initialTimer);
    clearIdle();
    if (totalTimer) clearTimeout(totalTimer);
  }
}

function timeoutError(kind: StreamTimeoutKind, timeouts: StreamTimeoutConfig): LLMStreamTimeoutError {
  switch (kind) {
    case 'initial':
      return new LLMStreamTimeoutError(kind, `Request timed out waiting for the first response from the provider after ${Math.round(timeouts.initialMs / 1000)}s.`);
    case 'idle':
      return new LLMStreamTimeoutError(kind, `Request timed out: no data received from the provider for ${Math.round(timeouts.idleMs / 1000)}s.`);
    case 'total':
      return new LLMStreamTimeoutError(kind, `Request timed out: total duration exceeded ${Math.round((timeouts.totalMs || 0) / 1000)}s.`);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError');
}
