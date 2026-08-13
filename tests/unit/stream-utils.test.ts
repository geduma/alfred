import { accumulateStream, LLMStreamTimeoutError, LLMStreamAbortedError } from '../../src/agent/providers/stream-utils';

function abortableSleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort);
  });
}

function timeouts(overrides?: Partial<{ initialMs: number; idleMs: number; totalMs: number | null }>) {
  return { initialMs: 5000, idleMs: 5000, totalMs: null, ...overrides };
}

describe('accumulateStream', () => {
  test('should accumulate text, tool calls, usage and finish into a final response', async () => {
    async function* events() {
      yield { type: 'text_delta', text: 'Hel' };
      yield { type: 'text_delta', text: 'lo' };
      yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'exec', arguments: '{"com' };
      yield { type: 'tool_call_delta', index: 0, arguments: '{"command":"ls"}' };
      yield { type: 'usage', input_tokens: 10, output_tokens: 5 };
      yield { type: 'finish', stop_reason: 'tool_use', model: 'served-model' };
    }

    const result = await accumulateStream(events(), {}, new AbortController(), timeouts(), 'default-model');

    expect(result.content).toBe('Hello');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0].function.name).toBe('exec');
    expect(result.tool_calls![0].function.arguments).toBe('{"command":"ls"}');
    expect(result.stop_reason).toBe('tool_use');
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(result.model).toBe('served-model');
  });

  test('should deliver events progressively via onEvent and emit tool_call_complete', async () => {
    async function* events() {
      yield { type: 'text_delta', text: 'a' };
      yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'exec', arguments: '{}' };
      yield { type: 'finish', stop_reason: 'tool_use' };
    }

    const seen: string[] = [];
    await accumulateStream(events(), {
      onEvent: (event) => {
        seen.push(event.type);
        if (event.type === 'tool_call_delta') expect(event.arguments).toBe('{}');
      },
    }, new AbortController(), timeouts(), 'm');

    expect(seen).toEqual(['text_delta', 'tool_call_delta', 'finish', 'tool_call_complete']);
  });

  test('should throw initial timeout when no event arrives in time', async () => {
    async function* stalled(signal: AbortSignal) {
      await abortableSleep(signal, 1000);
      yield { type: 'text_delta', text: 'x' };
    }

    const controller = new AbortController();
    await expect(
      accumulateStream(stalled(controller.signal) as any, {}, controller, timeouts({ initialMs: 20 }), 'm')
    ).rejects.toMatchObject({ code: 'LLM_STREAM_TIMEOUT', kind: 'initial' });
  });

  test('should throw idle timeout when a gap between events exceeds the idle limit', async () => {
    async function* gappy(signal: AbortSignal) {
      yield { type: 'text_delta', text: 'first' };
      await abortableSleep(signal, 1000);
      yield { type: 'text_delta', text: 'second' };
    }

    const controller = new AbortController();
    await expect(
      accumulateStream(gappy(controller.signal) as any, {}, controller, timeouts({ idleMs: 20 }), 'm')
    ).rejects.toMatchObject({ code: 'LLM_STREAM_TIMEOUT', kind: 'idle' });
  });

  test('should throw total timeout when overall duration is exceeded', async () => {
    async function* slow(signal: AbortSignal) {
      await abortableSleep(signal, 1000);
      yield { type: 'text_delta', text: 'x' };
    }

    const controller = new AbortController();
    await expect(
      accumulateStream(slow(controller.signal) as any, {}, controller, timeouts({ totalMs: 30 }), 'm')
    ).rejects.toMatchObject({ code: 'LLM_STREAM_TIMEOUT', kind: 'total' });
  });

  test('should NOT throw a timeout when the stream completes within the limits', async () => {
    async function* quick() {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'finish', stop_reason: 'end_turn' };
    }

    const result = await accumulateStream(quick(), {}, new AbortController(), timeouts({ initialMs: 30, idleMs: 30 }), 'm');
    expect(result.content).toBe('ok');
  });

  test('should emit an error event and rethrow generator errors', async () => {
    async function* boom() {
      yield { type: 'text_delta', text: 'a' };
      throw new Error('provider exploded');
    }

    const seen: string[] = [];
    await expect(
      accumulateStream(boom(), { onEvent: (e) => seen.push(e.type) }, new AbortController(), timeouts(), 'm')
    ).rejects.toThrow('provider exploded');
    expect(seen).toContain('error');
  });

  test('should complete normally when the first token arrives before the initial timeout', async () => {
    async function* slowFirstToken(signal: AbortSignal) {
      await abortableSleep(signal, 30);
      yield { type: 'text_delta', text: 'late but ok' };
      yield { type: 'finish', stop_reason: 'end_turn' };
    }

    const controller = new AbortController();
    const result = await accumulateStream(
      slowFirstToken(controller.signal) as any,
      {},
      controller,
      timeouts({ initialMs: 200 }),
      'm'
    );
    expect(result.content).toBe('late but ok');
  });

  test('should throw initial timeout when only heartbeats arrive (heartbeats are not content)', async () => {
    async function* heartbeatsOnly(signal: AbortSignal) {
      for (let i = 0; i < 20; i++) {
        await abortableSleep(signal, 5);
        yield { type: 'heartbeat' };
      }
    }

    const controller = new AbortController();
    const seen: string[] = [];
    await expect(
      accumulateStream(heartbeatsOnly(controller.signal) as any, {
        onEvent: (e) => seen.push(e.type),
      }, controller, timeouts({ initialMs: 30 }), 'm')
    ).rejects.toMatchObject({ code: 'LLM_STREAM_TIMEOUT', kind: 'initial' });
    expect(seen).toContain('heartbeat');
  });

  test('should keep the stream alive when heartbeats arrive after content has started', async () => {
    async function* gappyWithHeartbeats(signal: AbortSignal) {
      yield { type: 'text_delta', text: 'a' };
      for (let i = 0; i < 4; i++) {
        await abortableSleep(signal, 60);
        yield { type: 'heartbeat' };
      }
      yield { type: 'text_delta', text: 'b' };
    }

    const controller = new AbortController();
    const result = await accumulateStream(
      gappyWithHeartbeats(controller.signal) as any,
      {},
      controller,
      timeouts({ idleMs: 100 }),
      'm'
    );
    expect(result.content).toBe('ab');
  });

  test('should throw idle timeout when content stops and no activity follows', async () => {
    async function* stalledAfterContent(signal: AbortSignal) {
      yield { type: 'text_delta', text: 'partial' };
      await abortableSleep(signal, 1000);
      yield { type: 'text_delta', text: 'never' };
    }

    const controller = new AbortController();
    await expect(
      accumulateStream(stalledAfterContent(controller.signal) as any, {}, controller, timeouts({ idleMs: 20 }), 'm')
    ).rejects.toMatchObject({ code: 'LLM_STREAM_TIMEOUT', kind: 'idle' });
  });

  test('should rethrow an error thrown before any content is delivered', async () => {
    async function* boom() {
      throw new Error('provider exploded before any content');
    }

    await expect(
      accumulateStream(boom(), {}, new AbortController(), timeouts(), 'm')
    ).rejects.toThrow('provider exploded before any content');
  });

  test('should rethrow an error thrown after content was delivered', async () => {
    async function* boom() {
      yield { type: 'text_delta', text: 'partial' };
      throw new Error('provider exploded after content');
    }

    const seen: string[] = [];
    await expect(
      accumulateStream(boom(), { onEvent: (e) => seen.push(e.type) }, new AbortController(), timeouts(), 'm')
    ).rejects.toThrow('provider exploded after content');
    expect(seen).toContain('text_delta');
  });

  test('should not label an external abort as an idle timeout', async () => {
    async function* stalled(signal: AbortSignal) {
      await abortableSleep(signal, 1000);
      yield { type: 'text_delta', text: 'x' };
    }

    const controller = new AbortController();
    const pending = accumulateStream(stalled(controller.signal) as any, {}, controller, timeouts(), 'm');
    setTimeout(() => controller.abort(), 20);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LLMStreamAbortedError);
    expect((error as { code?: string }).code).toBe('LLM_STREAM_ABORTED');
  });

  test('should finalize tool calls emitted incrementally into complete tool_calls', async () => {
    async function* events() {
      yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'exec', arguments: '{"c' };
      yield { type: 'tool_call_delta', index: 0, arguments: '{"com' };
      yield { type: 'tool_call_delta', index: 0, arguments: '{"command":"ls"}' };
      yield { type: 'finish', stop_reason: 'tool_use' };
    }

    const result = await accumulateStream(events(), {}, new AbortController(), timeouts(), 'm');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0].function.arguments).toBe('{"command":"ls"}');
    expect(result.stop_reason).toBe('tool_use');
  });
});
