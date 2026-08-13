import { Message, Tool } from '../../src/types/llm';

const TOOLS: Tool[] = [{
  name: 'exec',
  description: 'Run a command',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}];

const HISTORY: Message[] = [
  { role: 'user', content: 'list files' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } }],
  },
  { role: 'tool', content: 'file1 file2', tool_call_id: 'call_1' },
  { role: 'user', content: 'thanks' },
];

const PROVIDER_CONFIG = {
  enabled: true,
  model: 'auto',
  config: { api_url: 'http://example.com/v1', api_key: 'k' },
};

function makeStream(...events: any[]): any {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) yield event;
    },
  };
}

describe('AnthropicProvider', () => {
  const createMock = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    createMock.mockReset();
  });

  test('should convert assistant tool_calls into tool_use blocks and tool results into tool_result blocks', async () => {
    jest.doMock('@anthropic-ai/sdk', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        messages: { create: createMock },
      })),
    }));

    createMock.mockReturnValue(makeStream(
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ));

    const { AnthropicProvider } = require('../../src/agent/providers/anthropic');
    const provider = new AnthropicProvider({ type: 'anthropic', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: HISTORY, tools: TOOLS });

    expect(response.content).toBe('done');
    expect(response.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    const sent = createMock.mock.calls[0][0];
    expect(sent.stream).toBe(true);
    expect(sent.messages[0]).toEqual({ role: 'user', content: 'list files' });

    expect(sent.tools[0]).toEqual({
      name: 'exec',
      description: 'Run a command',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    });

    const assistant = sent.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content[0]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'exec' });
    expect(assistant.content[0].input).toEqual({ command: 'ls' });

    const toolResult = sent.messages[2];
    expect(toolResult.role).toBe('user');
    expect(toolResult.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: 'file1 file2' });
  });

  test('should parse tool_use response into tool_calls', async () => {
    jest.doMock('@anthropic-ai/sdk', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        messages: { create: createMock },
      })),
    }));

    createMock.mockReturnValue(makeStream(
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'exec', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ));

    const { AnthropicProvider } = require('../../src/agent/providers/anthropic');
    const provider = new AnthropicProvider({ type: 'anthropic', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });

    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls![0].function.name).toBe('exec');
    expect(response.stop_reason).toBe('tool_use');
    expect(JSON.parse(response.tool_calls![0].function.arguments)).toEqual({ command: 'ls' });
  });

  test('should pass the stream transport timeout on streaming requests', async () => {
    jest.doMock('@anthropic-ai/sdk', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        messages: { create: createMock },
      })),
    }));

    createMock.mockReturnValue(makeStream(
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    ));

    const { AnthropicProvider } = require('../../src/agent/providers/anthropic');
    const provider = new AnthropicProvider(
      { type: 'anthropic', ...PROVIDER_CONFIG },
      { initial_response_timeout_seconds: 200, idle_timeout_seconds: 100 }
    );

    await provider.call({ messages: [{ role: 'user', content: 'hi' }] });
    const sent = createMock.mock.calls[0][0];
    expect(sent.stream).toBe(true);
    expect(sent.timeout).toBe(300000);
  });
});

describe('OpenAICompatibleProvider', () => {
  const createMock = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    createMock.mockReset();
  });

  test('should include tool_call_id on tool messages for multi-turn tool use', async () => {
    jest.doMock('openai', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: createMock } },
      })),
    }));

    createMock.mockReturnValue(makeStream(
      { model: 'm', choices: [{ delta: { content: 'done' }, finish_reason: null }] },
      { model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
      { model: 'm', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ));

    const { OpenAICompatibleProvider } = require('../../src/agent/providers/openai-compatible');
    const provider = new OpenAICompatibleProvider({ type: 'openai-compatible', ...PROVIDER_CONFIG });

    await provider.call({ messages: HISTORY, tools: TOOLS });

    const sent = createMock.mock.calls[0][0];
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    const toolMsg = sent.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.content).toBe('file1 file2');

    const assistantMsg = sent.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg.tool_calls).toBeDefined();

    expect(sent.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'exec',
        description: 'Run a command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    });
  });

  test('should map tool_calls finish reason to tool_use', async () => {
    jest.doMock('openai', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: createMock } },
      })),
    }));

    createMock.mockReturnValue(makeStream(
      { model: 'm', choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'exec', arguments: '' } }] }, finish_reason: null }] },
      { model: 'm', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] }, finish_reason: null }] },
      { model: 'm', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ));

    const { OpenAICompatibleProvider } = require('../../src/agent/providers/openai-compatible');
    const provider = new OpenAICompatibleProvider({ type: 'openai-compatible', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });

    expect(response.stop_reason).toBe('tool_use');
    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls![0].function.arguments).toBe('{"command":"ls"}');
  });

  test('should retry once without stream_options when the server rejects it', async () => {
    jest.doMock('openai', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: createMock } },
      })),
    }));

    const streamOptionsError = new Error('Unrecognized request argument supplied: stream_options');
    (streamOptionsError as any).status = 400;
    createMock
      .mockRejectedValueOnce(streamOptionsError)
      .mockReturnValueOnce(makeStream(
        { model: 'm', choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
        { model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ));

    const { OpenAICompatibleProvider } = require('../../src/agent/providers/openai-compatible');
    const provider = new OpenAICompatibleProvider({ type: 'openai-compatible', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('ok');
    expect(createMock).toHaveBeenCalledTimes(2);
    const first = createMock.mock.calls[0][0];
    const second = createMock.mock.calls[1][0];
    expect(first.stream_options).toBeDefined();
    expect(second.stream_options).toBeUndefined();
    expect(second.stream).toBe(true);
  });

  test('should convert internal tools into OpenAI tool format', async () => {
    jest.doMock('openai', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: createMock } },
      })),
    }));

    createMock.mockReturnValue(makeStream(
      { model: 'm', choices: [{ delta: { content: 'done' }, finish_reason: null }] },
      { model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ));

    const { OpenAICompatibleProvider } = require('../../src/agent/providers/openai-compatible');
    const provider = new OpenAICompatibleProvider({ type: 'openai-compatible', ...PROVIDER_CONFIG });

    await provider.call({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });

    const sent = createMock.mock.calls[0][0];
    expect(sent.tools).toEqual([{
      type: 'function',
      function: {
        name: 'exec',
        description: 'Run a command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    }]);
  });

  test('should expose the served model and raw stream events for diagnostics', async () => {
    jest.doMock('openai', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: createMock } },
      })),
    }));

    createMock.mockReturnValue(makeStream(
      { model: 'actual-model-served-by-gateway', choices: [{ delta: { content: 'hi' }, finish_reason: null }] },
      { model: 'actual-model-served-by-gateway', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ));

    const { OpenAICompatibleProvider } = require('../../src/agent/providers/openai-compatible');
    const provider = new OpenAICompatibleProvider({ type: 'openai-compatible', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: [{ role: 'user', content: 'hi' }] });

    expect(response.model).toBe('actual-model-served-by-gateway');
    expect(response.content).toBe('hi');
    const raw = response.raw as any[];
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.some(e => e.type === 'text_delta' && e.text === 'hi')).toBe(true);
  });

  test('should emit text_delta events progressively via onEvent', async () => {
    jest.doMock('openai', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: createMock } },
      })),
    }));

    createMock.mockReturnValue(makeStream(
      { model: 'm', choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
      { model: 'm', choices: [{ delta: { content: 'lo' }, finish_reason: null }] },
      { model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ));

    const { OpenAICompatibleProvider } = require('../../src/agent/providers/openai-compatible');
    const provider = new OpenAICompatibleProvider({ type: 'openai-compatible', ...PROVIDER_CONFIG });

    const deltas: string[] = [];
    const response = await provider.call({
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: (event) => {
        if (event.type === 'text_delta') deltas.push(event.text);
      },
    });

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(response.content).toBe('Hello');
  });

  test('should pass the stream transport timeout on streaming requests (defaults)', async () => {
    jest.doMock('openai', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: createMock } },
      })),
    }));

    createMock.mockReturnValue(makeStream(
      { model: 'm', choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
      { model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ));

    const { OpenAICompatibleProvider } = require('../../src/agent/providers/openai-compatible');
    const provider = new OpenAICompatibleProvider({ type: 'openai-compatible', ...PROVIDER_CONFIG });

    await provider.call({ messages: [{ role: 'user', content: 'hi' }] });
    const sent = createMock.mock.calls[0][0];
    expect(sent.stream).toBe(true);
    expect(sent.timeout).toBe(180000);
  });

  test('should pass the stream transport timeout on both stream_options attempts', async () => {
    jest.doMock('openai', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: createMock } },
      })),
    }));

    const streamOptionsError = new Error('Unrecognized request argument supplied: stream_options');
    (streamOptionsError as any).status = 400;
    createMock
      .mockRejectedValueOnce(streamOptionsError)
      .mockReturnValueOnce(makeStream(
        { model: 'm', choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
        { model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ));

    const { OpenAICompatibleProvider } = require('../../src/agent/providers/openai-compatible');
    const provider = new OpenAICompatibleProvider(
      { type: 'openai-compatible', ...PROVIDER_CONFIG },
      { initial_response_timeout_seconds: 200, idle_timeout_seconds: 100 }
    );

    const response = await provider.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('ok');
    expect(createMock).toHaveBeenCalledTimes(2);
    const first = createMock.mock.calls[0][0];
    const second = createMock.mock.calls[1][0];
    expect(first.timeout).toBe(300000);
    expect(second.timeout).toBe(300000);
  });
});

describe('GeminiProvider', () => {
  const generateContentMock = jest.fn();
  const generateContentStreamMock = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    generateContentMock.mockReset();
    generateContentStreamMock.mockReset();
  });

  function mockSdk(): void {
    jest.doMock('@google/generative-ai', () => ({
      GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
        getGenerativeModel: jest.fn().mockReturnValue({
          generateContent: generateContentMock,
          generateContentStream: generateContentStreamMock,
        }),
      })),
    }));
  }

  function mockStream(chunks: any[], finalResponse: any): void {
    generateContentStreamMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
      response: Promise.resolve(finalResponse),
    });
  }

  test('should send functionCall parts and parse tool_calls from streamed response', async () => {
    mockSdk();
    mockStream(
      [{ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] }],
      {
        candidates: [{ content: { parts: [{ functionCall: { name: 'exec', args: { command: 'ls' } } }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
        functionCalls: () => [{ name: 'exec', args: { command: 'ls' } }],
      }
    );

    const { GeminiProvider } = require('../../src/agent/providers/gemini');
    const provider = new GeminiProvider({ type: 'gemini', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: [{ role: 'user', content: 'list' }], tools: TOOLS });

    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls![0].function.name).toBe('exec');
    expect(response.stop_reason).toBe('tool_use');
    expect(JSON.parse(response.tool_calls![0].function.arguments)).toEqual({ command: 'ls' });

    const request = generateContentStreamMock.mock.calls[0][0];
    expect(request.tools[0].functionDeclarations[0].name).toBe('exec');
    expect(request.contents[0].role).toBe('user');
  });

  test('should map tool results to functionResponse parts using the matching function name', async () => {
    mockSdk();
    mockStream(
      [{ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }],
      {
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
        functionCalls: () => [],
      }
    );

    const { GeminiProvider } = require('../../src/agent/providers/gemini');
    const provider = new GeminiProvider({ type: 'gemini', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: HISTORY, tools: TOOLS });
    expect(response.content).toBe('ok');

    const request = generateContentStreamMock.mock.calls[0][0];
    const modelMsg = request.contents.find((c: any) => c.role === 'model');
    expect(modelMsg.parts[0]).toMatchObject({ functionCall: { name: 'exec' } });

    const functionResponse = request.contents.find((c: any) => c.role === 'user' && c.parts[0]?.functionResponse);
    expect(functionResponse.parts[0].functionResponse.name).toBe('exec');
    expect(functionResponse.parts[0].functionResponse.response.result).toBe('file1 file2');
  });

  test('should accept the centralized streaming config and still stream', async () => {
    mockSdk();
    mockStream(
      [{ candidates: [{ content: { parts: [{ text: 'streamed' }] }, finishReason: 'STOP' }] }],
      {
        candidates: [{ content: { parts: [{ text: 'streamed' }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
        functionCalls: () => [],
      }
    );

    const { GeminiProvider } = require('../../src/agent/providers/gemini');
    const provider = new GeminiProvider(
      { type: 'gemini', ...PROVIDER_CONFIG },
      { initial_response_timeout_seconds: 200, idle_timeout_seconds: 100 }
    );

    const response = await provider.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('streamed');
  });
});
