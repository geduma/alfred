import { TelegramChannel } from '../../src/channels/telegram';

function buildChannel(voice: unknown): TelegramChannel {
  const channelManager: any = {};
  return new TelegramChannel(channelManager, {
    config: { bot_token: 'test-token' },
    permissions: {},
    voice,
  });
}

function decide(channel: TelegramChannel, response: string, inputType: string): { text: string; synthesizeVoice: boolean } {
  return (channel as any).shouldSynthesizeVoice(response, inputType);
}

const enabledVoice = {
  enabled: true,
  provider: { api_url: 'http://voice.test/v1', api_key: '' },
  stt: { model: 'stt-model', language: 'auto' },
  tts: { model: 'tts-model', voice: 'test-voice', response_format: 'wav', expose_to_model: true },
};

describe('TelegramChannel voice mirror', () => {
  test('voice input mirrors to voice without marker', () => {
    const channel = buildChannel(enabledVoice);
    expect(decide(channel, 'Hello there', 'voice')).toEqual({ text: 'Hello there', synthesizeVoice: true });
  });

  test('text input mirrors to text without marker', () => {
    const channel = buildChannel(enabledVoice);
    expect(decide(channel, 'Hello there', 'text')).toEqual({ text: 'Hello there', synthesizeVoice: false });
  });

  test('audio marker forces voice for text input', () => {
    const channel = buildChannel(enabledVoice);
    expect(decide(channel, 'Here is the summary\n[AUDIO]', 'text')).toEqual({
      text: 'Here is the summary',
      synthesizeVoice: true,
    });
  });

  test('text marker forces text for voice input', () => {
    const channel = buildChannel(enabledVoice);
    expect(decide(channel, 'Here is the code\n[TEXT]', 'voice')).toEqual({
      text: 'Here is the code',
      synthesizeVoice: false,
    });
  });

  test('last marker wins when both are present', () => {
    const channel = buildChannel(enabledVoice);
    expect(decide(channel, 'Body\n[AUDIO]\n[TEXT]', 'text').synthesizeVoice).toBe(false);
    expect(decide(channel, 'Body\n[TEXT]\n[AUDIO]', 'voice').synthesizeVoice).toBe(true);
  });

  test('markers are always stripped from visible text', () => {
    const channel = buildChannel(enabledVoice);
    expect(decide(channel, 'Body\n[AUDIO]  ', 'text').text).toBe('Body');
    expect(decide(channel, 'Body\n[TEXT]', 'voice').text).toBe('Body');
  });

  test('disabled voice service never synthesizes', () => {
    const channel = buildChannel({ enabled: false });
    expect(decide(channel, 'Hello', 'voice').synthesizeVoice).toBe(false);
    expect(decide(channel, 'Hello\n[AUDIO]', 'voice').synthesizeVoice).toBe(false);
  });

  test('unexposed model ignores markers and falls back to mirror', () => {
    const channel = buildChannel({
      ...enabledVoice,
      tts: { ...enabledVoice.tts, expose_to_model: false },
    });
    expect(decide(channel, 'Hello\n[AUDIO]', 'text')).toEqual({ text: 'Hello', synthesizeVoice: false });
    expect(decide(channel, 'Hello', 'voice').synthesizeVoice).toBe(true);
  });
});
