import { GoogleGenerativeAI } from '@google/generative-ai';
import { BaseProvider } from './base';
import { LLMCallParams, LLMResponse } from '../../types/llm';

export class GeminiProvider extends BaseProvider {
  private client: GoogleGenerativeAI;

  constructor(config: any) {
    super(config);
    this.client = new GoogleGenerativeAI(this.config.config.api_key);
  }

  async call(params: LLMCallParams): Promise<LLMResponse> {
    const model = this.client.getGenerativeModel({ model: this.getModel() });

    const prompt = [
      ...(params.system ? [{ role: 'user', parts: [{ text: `System: ${params.system}` }] }] : []),
      ...params.messages.map(m => ({
        role: m.role === 'assistant' ? 'model' as const : 'user' as const,
        parts: [{ text: m.content }],
      })),
    ];

    const chat = model.startChat({
      history: prompt.slice(0, -1),
      generationConfig: {
        temperature: params.temperature ?? this.getTemperature(),
        maxOutputTokens: params.max_tokens ?? this.getMaxTokens(),
        topP: params.top_p,
      },
    });

    const lastMessage = prompt[prompt.length - 1];
    const result = await chat.sendMessage(lastMessage.parts[0].text);
    const response = result.response;

    return {
      content: response.text(),
      stop_reason: 'end_turn',
      usage: undefined,
    };
  }
}
