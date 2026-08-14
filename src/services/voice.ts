import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { VoiceConfig } from '../types/config';
import { getLogger } from '../utils/logger';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_STT_MODEL = 'Systran/faster-whisper-base';
const DEFAULT_TTS_MODEL = 'speaches-ai/piper-es_MX-ald-medium';
const DEFAULT_TTS_VOICE = 'ald';
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

export interface TranscriptionResult {
  text: string;
  language?: string;
}

export interface SynthesizeOptions {
  model?: string;
  voice?: string;
  response_format?: string;
}

export class VoiceService {
  private config: VoiceConfig;
  private timeoutMs: number;

  constructor(config: VoiceConfig) {
    this.config = config;
    this.timeoutMs = (config.timeout_seconds || DEFAULT_TIMEOUT_MS / 1000) * 1000;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  isExposedToModel(): boolean {
    return this.config.tts?.expose_to_model === true;
  }

  private resolveBaseUrl(provider?: { api_url?: string }): string {
    const url = provider?.api_url || this.config.provider?.api_url;
    if (!url) {
      throw new Error('Voice provider api_url is not configured');
    }
    return url.replace(/\/+$/, '');
  }

  private authHeaders(provider?: { api_key?: string }): Record<string, string> {
    const key = provider?.api_key || this.config.provider?.api_key;
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  async transcribe(audioPath: string, opts?: { model?: string; language?: string }): Promise<TranscriptionResult> {
    const stt = this.config.stt;
    const url = `${this.resolveBaseUrl(stt?.provider)}/audio/transcriptions`;

    const file = await fs.promises.readFile(audioPath);
    const form = new FormData();
    form.append('file', new Blob([file]), path.basename(audioPath));
    form.append('model', opts?.model || stt?.model || DEFAULT_STT_MODEL);

    const language = opts?.language ?? stt?.language;
    if (language && language !== 'auto') {
      form.append('language', language);
    }

    try {
      const response = await axios.post(url, form, {
        timeout: this.timeoutMs,
        maxContentLength: MAX_AUDIO_BYTES,
        headers: this.authHeaders(stt?.provider),
      });

      const data = response.data;
      if (typeof data === 'string') {
        return { text: data.trim() };
      }
      return { text: data?.text || '', language: data?.language };
    } catch (error: any) {
      getLogger().error({ error: error.message, url }, 'Voice transcription failed');
      throw new Error(`Transcription failed: ${error.message}`);
    }
  }

  async synthesize(text: string, opts?: SynthesizeOptions): Promise<Buffer> {
    const tts = this.config.tts;
    const url = `${this.resolveBaseUrl(tts?.provider)}/audio/speech`;

    const payload: Record<string, string> = {
      model: opts?.model || tts?.model || DEFAULT_TTS_MODEL,
      voice: opts?.voice || tts?.voice || DEFAULT_TTS_VOICE,
      input: text,
    };
    const format = opts?.response_format || tts?.response_format;
    if (format) {
      payload.response_format = format;
    }

    try {
      const response = await axios.post(url, payload, {
        timeout: this.timeoutMs,
        responseType: 'arraybuffer',
        headers: this.authHeaders(tts?.provider),
      });
      return Buffer.from(response.data);
    } catch (error: any) {
      getLogger().error({ error: error.message, url }, 'Voice synthesis failed');
      throw new Error(`Synthesis failed: ${error.message}`);
    }
  }
}
