import { BaseProvider, DEFAULT_STREAMING_TIMEOUTS_S } from '../../src/agent/providers/base';
import { LLMCallParams, LLMResponse, LLMStreamEvent, ProviderConfig, LLMStreamingConfig } from '../../src/types/llm';

class TestProvider extends BaseProvider {
  protected async callNonStreaming(_params: LLMCallParams): Promise<LLMResponse> {
    return { content: '', stop_reason: 'end_turn' };
  }

  protected async *streamEvents(_params: LLMCallParams, _signal: AbortSignal): AsyncGenerator<LLMStreamEvent> {
    yield { type: 'text_delta', text: 'x' };
    yield { type: 'finish', stop_reason: 'end_turn' };
  }
}

class StalledProvider extends TestProvider {
  protected async *streamEvents(_params: LLMCallParams, signal: AbortSignal): AsyncGenerator<LLMStreamEvent> {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, 1000);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort);
    });
    yield { type: 'text_delta', text: 'x' };
  }
}

function providerConfig(): ProviderConfig {
  return {
    type: 'openai-compatible',
    enabled: true,
    model: 'm',
    config: { api_url: 'http://example.com/v1', api_key: 'k' },
  };
}

describe('BaseProvider streaming timeout resolution', () => {
  test('should apply the documented defaults', () => {
    const provider = new TestProvider(providerConfig());
    const timeouts = (provider as any).getStreamingTimeouts();
    expect(timeouts).toEqual({ initialMs: 120000, idleMs: 60000, totalMs: null });
    expect((provider as any).getStreamTransportTimeoutMs()).toBe(180000);
    expect(DEFAULT_STREAMING_TIMEOUTS_S).toEqual({
      initial_response_timeout_seconds: 120,
      idle_timeout_seconds: 60,
      max_total_time_seconds: null,
    });
  });

  test('should resolve a fully-specified central streaming config', () => {
    const streaming: LLMStreamingConfig = {
      initial_response_timeout_seconds: 200,
      idle_timeout_seconds: 90,
      max_total_time_seconds: 600,
    };
    const provider = new TestProvider(providerConfig(), streaming);
    const timeouts = (provider as any).getStreamingTimeouts();
    expect(timeouts).toEqual({ initialMs: 200000, idleMs: 90000, totalMs: 600000 });
    expect((provider as any).getStreamTransportTimeoutMs()).toBe(600000);
  });

  test('should fall back to defaults for fields not configured', () => {
    const provider = new TestProvider(providerConfig(), { initial_response_timeout_seconds: 200 });
    const timeouts = (provider as any).getStreamingTimeouts();
    expect(timeouts).toEqual({ initialMs: 200000, idleMs: 60000, totalMs: null });
  });

  test('should use initial+idle as the transport bound when no total is set', () => {
    const provider = new TestProvider(providerConfig(), {
      initial_response_timeout_seconds: 300,
      idle_timeout_seconds: 45,
    });
    expect((provider as any).getStreamTransportTimeoutMs()).toBe(345000);
  });

  test('call should apply the configured initial timeout to the stream', async () => {
    const provider = new StalledProvider(providerConfig(), { initial_response_timeout_seconds: 0.02 });
    await expect(provider.call({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      code: 'LLM_STREAM_TIMEOUT',
      kind: 'initial',
    });
  });

  test('call should not be bounded by the configured initial timeout when content arrives', async () => {
    const provider = new TestProvider(providerConfig(), { initial_response_timeout_seconds: 0.02 });
    const response = await provider.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('x');
  });
});
