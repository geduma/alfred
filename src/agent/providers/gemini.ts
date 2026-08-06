import { BaseProvider } from './base';
import { LLMCallParams, LLMResponse, ToolCall, Message } from '../../types/llm';
import { GoogleGenerativeAI } from '@google/generative-ai';

export class GeminiProvider extends BaseProvider {
  private client: any = null;

  constructor(config: any) {
    super(config);
    this.client = new GoogleGenerativeAI(this.config.config.api_key);
  }

  private buildTools(tools?: LLMCallParams['tools']): any {
    if (!tools || tools.length === 0) return undefined;

    return [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as any,
      })),
    }];
  }

  private toGeminiParts(m: Message, nameById: Map<string, string>): any[] {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls) {
        parts.push({ functionCall: { name: tc.function.name, args: this.parseArguments(tc.function.arguments) } });
      }
      return parts;
    }

    if (m.role === 'tool') {
      const name = m.tool_call_id ? (nameById.get(m.tool_call_id) || 'unknown') : 'unknown';
      return [{ functionResponse: { name, response: { result: m.content } } }];
    }

    return [{ text: m.content }];
  }

  private parseArguments(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return { raw };
    }
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const client = this.client;
    const model = client.getGenerativeModel({ model: this.getModel() });

    const nameById: Map<string, string> = new Map();
    for (const m of params.messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) {
          nameById.set(tc.id, tc.function.name);
        }
      }
    }

    const contents: any[] = [];

    for (const m of params.messages) {
      if (m.role === 'assistant') {
        contents.push({ role: 'model', parts: this.toGeminiParts(m, nameById) });
      } else if (m.role === 'tool') {
        contents.push({ role: 'user', parts: this.toGeminiParts(m, nameById) });
      } else {
        contents.push({ role: 'user', parts: this.toGeminiParts(m, nameById) });
      }
    }

    const request: any = {
      contents,
      generationConfig: {
        temperature: params.temperature ?? this.getTemperature(),
        maxOutputTokens: params.max_tokens ?? this.getMaxTokens(),
        topP: params.top_p,
      },
    };

    const tools = this.buildTools(params.tools);
    if (tools) request.tools = tools;
    if (params.system) request.systemInstruction = params.system;

    const result = await model.generateContent(request);
    const response = result.response;

    const parts: any[] = response.candidates?.[0]?.content?.parts || [];
    const textParts = parts.filter((p: any) => p.text !== undefined);
    const functionCalls = parts.filter((p: any) => p.functionCall);

    const toolCalls: ToolCall[] = functionCalls.map((p: any) => ({
      id: `gemini_${p.functionCall.name}`,
      type: 'function' as const,
      function: {
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args || {}),
      },
    }));

    return {
      content: textParts.map((p: any) => p.text).join(''),
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: response.usageMetadata ? {
        input_tokens: response.usageMetadata.promptTokenCount || 0,
        output_tokens: response.usageMetadata.candidatesTokenCount || 0,
      } : undefined,
    };
  }
}
