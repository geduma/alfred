import * as readline from 'readline';
import { CLIChannel } from '../../src/channels/cli';
import { ChannelManager } from '../../src/channels/channel-manager';

jest.mock('readline', () => ({ createInterface: jest.fn() }));

const createInterfaceMock = readline.createInterface as unknown as jest.Mock;

describe('CLIChannel service safety (no TTY)', () => {
  let channelManager: ChannelManager;
  let exitSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let originalIsTTY: unknown;
  let originalNoCli: string | undefined;

  const fakeRl = () => ({
    on: jest.fn(),
    close: jest.fn(),
    prompt: jest.fn(),
  });

  beforeEach(() => {
    channelManager = new ChannelManager();
    createInterfaceMock.mockReset();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    originalIsTTY = process.stdin.isTTY;
    originalNoCli = process.env.ALFRED_NO_CLI;
    delete process.env.ALFRED_NO_CLI;
  });

  afterEach(async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    if (originalNoCli === undefined) delete process.env.ALFRED_NO_CLI;
    else process.env.ALFRED_NO_CLI = originalNoCli;
    exitSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  test('should not create a prompt or exit when stdin is not a TTY (systemd)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const channel = new CLIChannel(channelManager);

    await channel.start();

    expect(createInterfaceMock).not.toHaveBeenCalled();
    expect((channel as any).rl).toBeNull();
    expect(exitSpy).not.toHaveBeenCalled();

    expect(() => channel.signalReady()).not.toThrow();
    expect(consoleLogSpy).not.toHaveBeenCalled();

    await channel.stop();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('should stay disabled via ALFRED_NO_CLI even with a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    process.env.ALFRED_NO_CLI = '1';
    const channel = new CLIChannel(channelManager);

    await channel.start();

    expect(createInterfaceMock).not.toHaveBeenCalled();
    expect((channel as any).rl).toBeNull();
    expect(exitSpy).not.toHaveBeenCalled();
    await channel.stop();
  });

  test('should keep the gateway alive if stdin is lost mid-run (non-TTY close)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const rl: any = fakeRl();
    createInterfaceMock.mockReturnValue(rl);
    const channel = new CLIChannel(channelManager);

    await channel.start();
    expect(createInterfaceMock).toHaveBeenCalledTimes(1);

    const closeCb = rl.on.mock.calls.find((c: unknown[]) => c[0] === 'close')?.[1];
    expect(closeCb).toBeDefined();

    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    closeCb();

    expect(exitSpy).not.toHaveBeenCalled();
    expect((channel as any).rl).toBeNull();
  });

  test('should still exit on close for a real interactive TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const rl: any = fakeRl();
    createInterfaceMock.mockReturnValue(rl);
    const channel = new CLIChannel(channelManager);

    await channel.start();

    const closeCb = rl.on.mock.calls.find((c: unknown[]) => c[0] === 'close')?.[1];
    closeCb();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
