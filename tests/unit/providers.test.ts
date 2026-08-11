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

    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const { AnthropicProvider } = require('../../src/agent/providers/anthropic');
    const provider = new AnthropicProvider({ type: 'anthropic', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: HISTORY, tools: TOOLS });

    expect(response.content).toBe('done');
    const sent = createMock.mock.calls[0][0];
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

    createMock.mockResolvedValue({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'exec', input: { command: 'ls' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const { AnthropicProvider } = require('../../src/agent/providers/anthropic');
    const provider = new AnthropicProvider({ type: 'anthropic', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });

    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls![0].function.name).toBe('exec');
    expect(response.stop_reason).toBe('tool_use');
    expect(JSON.parse(response.tool_calls![0].function.arguments)).toEqual({ command: 'ls' });
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

    createMock.mockResolvedValue({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const { OpenAICompatibleProvider } = require('../../src/agent/providers/openai-compatible');
    const provider = new OpenAICompatibleProvider({ type: 'openai-compatible', ...PROVIDER_CONFIG });

    await provider.call({ messages: HISTORY, tools: TOOLS });

    const sent = createMock.mock.calls[0][0];
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

    createMock.mockResolvedValue({
      choices: [{
        message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const { OpenAICompatibleProvider } = require('../../src/agent/providers/openai-compatible');
    const provider = new OpenAICompatibleProvider({ type: 'openai-compatible', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });

    expect(response.stop_reason).toBe('tool_use');
    expect(response.tool_calls).toHaveLength(1);
  });

  test('should convert internal tools into OpenAI tool format', async () => {
    jest.doMock('openai', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: createMock } },
      })),
    }));

    createMock.mockResolvedValue({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

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

  test('should expose the real served model and raw response for diagnostics', async () => {
    jest.doMock('openai', () => ({
      __esModule: true,
      default: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: createMock } },
      })),
    }));

    createMock.mockResolvedValue({
      model: 'actual-model-served-by-gateway',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const { OpenAICompatibleProvider } = require('../../src/agent/providers/openai-compatible');
    const provider = new OpenAICompatibleProvider({ type: 'openai-compatible', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });

    expect(response.model).toBe('actual-model-served-by-gateway');
    const raw = response.raw as any;
    expect(raw.model).toBe('actual-model-served-by-gateway');
    expect(raw.choices[0].message.content).toBe('hi');
  });
});

describe('GeminiProvider', () => {
  const generateContentMock = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    generateContentMock.mockReset();
  });

  function mockSdk(): void {
    jest.doMock('@google/generative-ai', () => ({
      GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
        getGenerativeModel: jest.fn().mockReturnValue({
          generateContent: generateContentMock,
        }),
      })),
    }));
  }

  test('should send functionCall parts and parse tool_calls from response', async () => {
    mockSdk();
    generateContentMock.mockResolvedValue({
      response: {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'exec', args: { command: 'ls' } } }] },
        }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      },
    });

    const { GeminiProvider } = require('../../src/agent/providers/gemini');
    const provider = new GeminiProvider({ type: 'gemini', ...PROVIDER_CONFIG });

    const response = await provider.call({ messages: [{ role: 'user', content: 'list' }], tools: TOOLS });

    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls![0].function.name).toBe('exec');
    expect(response.stop_reason).toBe('tool_use');

    const request = generateContentMock.mock.calls[0][0];
    expect(request.tools[0].functionDeclarations[0].name).toBe('exec');
    expect(request.contents[0].role).toBe('user');
  });

  test('should map tool results to functionResponse parts using the matching function name', async () => {
    mockSdk();
    generateContentMock.mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      },
    });

    const { GeminiProvider } = require('../../src/agent/providers/gemini');
    const provider = new GeminiProvider({ type: 'gemini', ...PROVIDER_CONFIG });

    await provider.call({ messages: HISTORY, tools: TOOLS });

    const request = generateContentMock.mock.calls[0][0];
    const modelMsg = request.contents.find((c: any) => c.role === 'model');
    expect(modelMsg.parts[0]).toMatchObject({ functionCall: { name: 'exec' } });

    const functionResponse = request.contents.find((c: any) => c.role === 'user' && c.parts[0]?.functionResponse);
    expect(functionResponse.parts[0].functionResponse.name).toBe('exec');
    expect(functionResponse.parts[0].functionResponse.response.result).toBe('file1 file2');
  });
});
