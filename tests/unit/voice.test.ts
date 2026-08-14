import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { VoiceService } from '../../src/services/voice';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('VoiceService', () => {
  let testDir: string;
  let audioPath: string;

  const baseConfig = {
    enabled: true,
    timeout_seconds: 30,
    provider: { api_url: 'http://speaches.home/v1', api_key: '' },
    stt: { model: 'Systran/faster-whisper-base', language: 'auto' },
    tts: {
      model: 'speaches-ai/piper-es_MX-ald-medium',
      voice: 'ald',
      response_format: 'wav',
      expose_to_model: true,
    },
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
    audioPath = path.join(testDir, 'sample.ogg');
    fs.writeFileSync(audioPath, Buffer.from('fake-audio-bytes'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('transcribe posts multipart form and parses JSON response', async () => {
    (mockedAxios.post as jest.Mock).mockResolvedValue({ data: { text: 'Hello there', language: 'en' } });

    const service = new VoiceService(baseConfig as any);
    const result = await service.transcribe(audioPath);

    expect(result.text).toBe('Hello there');
    expect(result.language).toBe('en');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://speaches.home/v1/audio/transcriptions',
      expect.any(FormData),
      expect.objectContaining({ timeout: 30000 })
    );
  });

  test('transcribe handles plain-text response', async () => {
    (mockedAxios.post as jest.Mock).mockResolvedValue({ data: 'Texto plano' });

    const service = new VoiceService(baseConfig as any);
    const result = await service.transcribe(audioPath);

    expect(result.text).toBe('Texto plano');
  });

  test('transcribe does not send language when set to auto', async () => {
    (mockedAxios.post as jest.Mock).mockResolvedValue({ data: { text: 'ok' } });

    const service = new VoiceService(baseConfig as any);
    await service.transcribe(audioPath);

    const form = (mockedAxios.post as jest.Mock).mock.calls[0][1] as FormData;
    expect(form.has('language')).toBe(false);
  });

  test('transcribe sends Bearer header when api_key is set', async () => {
    (mockedAxios.post as jest.Mock).mockResolvedValue({ data: { text: 'ok' } });

    const config = {
      ...baseConfig,
      provider: { api_url: 'https://api.groq.com/openai/v1', api_key: 'groq-test-key' },
    } as any;
    const service = new VoiceService(config);
    await service.transcribe(audioPath);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      expect.any(FormData),
      expect.objectContaining({ headers: { Authorization: 'Bearer groq-test-key' } })
    );
  });

  test('stt.provider overrides the base provider url and key', async () => {
    (mockedAxios.post as jest.Mock).mockResolvedValue({ data: { text: 'ok' } });

    const config = {
      ...baseConfig,
      stt: {
        ...baseConfig.stt,
        provider: { api_url: 'https://api.groq.com/openai/v1', api_key: 'groq-test-key' },
      },
    } as any;
    const service = new VoiceService(config);
    await service.transcribe(audioPath);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      expect.any(FormData),
      expect.objectContaining({ headers: { Authorization: 'Bearer groq-test-key' } })
    );
  });

  test('transcribe throws wrapped error on failure', async () => {
    (mockedAxios.post as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

    const service = new VoiceService(baseConfig as any);
    await expect(service.transcribe(audioPath)).rejects.toThrow('Transcription failed');
  });

  test('synthesize posts JSON and returns audio buffer', async () => {
    const audio = Buffer.from('wav-bytes');
    (mockedAxios.post as jest.Mock).mockResolvedValue({ data: audio });

    const service = new VoiceService(baseConfig as any);
    const result = await service.synthesize('Hello there');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://speaches.home/v1/audio/speech',
      {
        model: 'speaches-ai/piper-es_MX-ald-medium',
        voice: 'ald',
        input: 'Hello there',
        response_format: 'wav',
      },
      expect.objectContaining({ responseType: 'arraybuffer', headers: {} })
    );
  });

  test('synthesize omits response_format when not configured', async () => {
    (mockedAxios.post as jest.Mock).mockResolvedValue({ data: Buffer.from('x') });

    const config = {
      ...baseConfig,
      tts: { model: 'tts-1', voice: 'alloy', expose_to_model: false },
    } as any;
    const service = new VoiceService(config);
    await service.synthesize('Hello');

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://speaches.home/v1/audio/speech',
      { model: 'tts-1', voice: 'alloy', input: 'Hello' },
      expect.anything()
    );
  });

  test('synthesize throws wrapped error on failure', async () => {
    (mockedAxios.post as jest.Mock).mockRejectedValue(new Error('timeout'));

    const service = new VoiceService(baseConfig as any);
    await expect(service.synthesize('Hello')).rejects.toThrow('Synthesis failed');
  });

  test('exposes enabled and expose_to_model flags', () => {
    const service = new VoiceService(baseConfig as any);
    expect(service.isEnabled()).toBe(true);
    expect(service.isExposedToModel()).toBe(true);

    const disabled = new VoiceService({ ...baseConfig, enabled: false, tts: { expose_to_model: false } } as any);
    expect(disabled.isEnabled()).toBe(false);
    expect(disabled.isExposedToModel()).toBe(false);
  });
});
