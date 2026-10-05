import { TelegramChannel } from '../../src/channels/telegram';

function buildChannel(): { channel: TelegramChannel; sendMessage: jest.Mock } {
  const channelManager: any = {};
  const channel = new TelegramChannel(channelManager, {
    config: { bot_token: 'test-token' },
    permissions: {},
    voice: { enabled: false },
  });
  const sendMessage = jest.fn();
  (channel as any).bot.api.sendMessage = sendMessage;
  return { channel, sendMessage };
}

describe('TelegramChannel chunking', () => {
  test('short message sends once', async () => {
    const { channel, sendMessage } = buildChannel();
    sendMessage.mockResolvedValue({});

    await channel.sendMessage('42', 'hello', { chat_id: 42 });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toBe('hello');
  });

  test('long message splits into ordered chunks that reassemble exactly', async () => {
    const { channel, sendMessage } = buildChannel();
    sendMessage.mockResolvedValue({});
    const body = `${'a'.repeat(4000)}\n${'b'.repeat(4000)}\n${'c'.repeat(1000)}`;

    await channel.sendMessage('42', body, { chat_id: 42 });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    const joined = sendMessage.mock.calls.map((c: any[]) => c[1]).join('');
    expect(joined).toBe(body);
    for (const call of sendMessage.mock.calls) {
      expect(call[1].length).toBeLessThanOrEqual(4096);
    }
  });

  test('chunk failure propagates instead of silently marking notified', async () => {
    const { channel, sendMessage } = buildChannel();
    sendMessage
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Telegram: Bad Request'))
      .mockResolvedValue({});
    const body = `x`.repeat(9000);

    await expect(channel.sendMessage('42', body, { chat_id: 42 })).rejects.toThrow('Bad Request');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
