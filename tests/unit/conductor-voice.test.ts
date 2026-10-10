import fs from 'fs';
import path from 'path';
import os from 'os';
import { initializeDatabase, closeDatabase, getDatabase } from '../../src/db';
import { TaskRepository } from '../../src/db/repositories/tasks';
import { Conductor } from '../../src/agent/conductor';
import { resolveConductorMessage, isControlMessage } from '../../src/agent/conductor-messages';
import { getDisplay, isDisplayControlMessage, isControlMessageAny, clearDisplayCache } from '../../src/services/display-strings';
import { TelegramChannel } from '../../src/channels/telegram';
import { Executor } from '../../src/agent/executor';

let mockLang = 'en';
jest.mock('../../src/services/preferences-store', () => {
  const actual = jest.requireActual('../../src/services/preferences-store');
  return { ...actual, readPreferences: () => ({ language: mockLang }) };
});

const ECO: any = {
  executor_poll_interval_ms: 50,
  conductor_poll_interval_ms: 50,
  sync_fast_path_timeout_ms: 8000,
  max_task_attempts: 2,
  orphan_reap_on_startup: true,
};

function buildChannel(): TelegramChannel {
  return new TelegramChannel({} as any, {
    config: { bot_token: 'test-token' },
    permissions: {},
    voice: {
      enabled: true,
      provider: { api_url: 'http://voice.test/v1', api_key: '' },
      stt: { model: 'stt-model', language: 'auto' },
      tts: { model: 'tts-model', voice: 'test-voice', response_format: 'wav', expose_to_model: true },
    },
  });
}

describe('voice async + ack', () => {
  let testDir: string;
  let tasks: TaskRepository;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-async-'));
    await initializeDatabase(path.join(testDir, 'test.db'));
    tasks = new TaskRepository();
    clearDisplayCache();
  });

  afterEach(async () => {
    await closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('ack message is brief', () => {
    mockLang = 'en';
    expect(resolveConductorMessage('ack.enqueued')).toBe('Right away, sir...');
    expect(resolveConductorMessage('ack.queued_with_position', { pending: 2 })).toContain('2');
    expect(resolveConductorMessage('ack.enqueued').length).toBeLessThan(60);
  });

  test('control messages are detected (canonical EN + display ES)', () => {
    mockLang = 'en';
    const ackEn = resolveConductorMessage('ack.enqueued');
    const queuedEn = resolveConductorMessage('ack.queued_with_position', { pending: 3 });
    expect(isControlMessage(ackEn)).toBe(true);
    expect(isControlMessage(queuedEn)).toBe(true);
    mockLang = 'es';
    clearDisplayCache();
    const ackEs = getDisplay('ack.enqueued');
    const queuedEs = getDisplay('ack.queued_with_position', { pending: 3 });
    expect(isControlMessage(ackEs)).toBe(false);
    expect(isDisplayControlMessage(ackEs)).toBe(true);
    expect(isDisplayControlMessage(queuedEs)).toBe(true);
    mockLang = 'en';
    clearDisplayCache();
    for (const text of [ackEn, queuedEn, ackEs, queuedEs]) {
      expect(isControlMessageAny(text)).toBe(true);
    }
    expect(isControlMessage(resolveConductorMessage('task.done_fallback'))).toBe(true);
    expect(isControlMessage('')).toBe(false);
    expect(isControlMessage('Right away, here is your report')).toBe(false);
  });

  test('control messages never synthesize even for voice input', () => {
    const channel = buildChannel();
    const decide = (text: string, inputType: string): boolean =>
      (channel as any).shouldSynthesizeVoice(text, inputType).synthesizeVoice;
    mockLang = 'es';
    clearDisplayCache();
    const ackEs = getDisplay('ack.enqueued');
    mockLang = 'en';
    clearDisplayCache();
    expect(decide(resolveConductorMessage('ack.enqueued'), 'voice')).toBe(false);
    expect(decide(ackEs, 'voice')).toBe(false);
    expect(decide('Regular answer', 'voice')).toBe(true);
  });

  test('queued voice request stores modality and notifies with it', async () => {
    const gateway: any = {
      checkRateLimit: jest.fn().mockReturnValue(null),
      tryFastPath: jest.fn().mockResolvedValue({ completed: false }),
      executeTask: jest.fn().mockResolvedValue({ content: 'task result', blockedActions: [] }),
    };
    const sendMessage = jest.fn();
    const conductor = new Conductor({ gateway, tasks, channelManager: { sendMessage } as any, getEcosystem: () => ECO });
    const executor = new Executor({ gateway, tasks, getEcosystem: () => ECO });

    await conductor.handleMessage({
      channel: 'telegram',
      userId: 'u1',
      content: 'do the thing',
      sessionId: 'telegram_u1',
      metadata: { chat_id: 'chat-1', input_type: 'voice' },
    });
    const row = getDatabase().prepare("SELECT * FROM tasks LIMIT 1").get() as any;
    expect(row.input_type).toBe('voice');

    await executor.tick();
    await conductor.pollUnnotified();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][3]).toMatchObject({ chat_id: 'chat-1', input_type: 'voice' });
  });

  test('queued text request notifies as text', async () => {
    const gateway: any = {
      checkRateLimit: jest.fn().mockReturnValue(null),
      tryFastPath: jest.fn().mockResolvedValue({ completed: false }),
      executeTask: jest.fn().mockResolvedValue({ content: 'done', blockedActions: [] }),
    };
    const sendMessage = jest.fn();
    const conductor = new Conductor({ gateway, tasks, channelManager: { sendMessage } as any, getEcosystem: () => ECO });
    const executor = new Executor({ gateway, tasks, getEcosystem: () => ECO });

    await conductor.handleMessage({
      channel: 'telegram',
      userId: 'u2',
      content: 'do the other thing',
      sessionId: 'telegram_u2',
      metadata: { chat_id: 'chat-2' },
    });
    await executor.tick();
    await conductor.pollUnnotified();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][3]).toMatchObject({ input_type: 'text' });
  });
});
