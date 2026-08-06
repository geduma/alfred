import { ExecTool } from '../../src/tools/exec';

describe('ExecTool', () => {
  test('should require a command', async () => {
    const tool = new ExecTool();
    const result = await tool.execute({});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Command is required');
  });

  test('should deny blocked patterns', async () => {
    const tool = new ExecTool();
    const result = await tool.execute({ command: 'rm -rf /' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Command denied by policy');
  });

  test('should enforce allowed patterns when configured', async () => {
    const tool = new ExecTool({ allowed_patterns: ['ls'] });
    const ok = await tool.execute({ command: 'ls -la' });
    expect(ok.success).toBe(true);

    const denied = await tool.execute({ command: 'cat /etc/passwd' });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('Command denied by policy');
  });

  test('should run a successful command', async () => {
    const tool = new ExecTool();
    const result = await tool.execute({ command: 'echo hello' });
    expect(result.success).toBe(true);
    expect(result.output).toBe('hello');
    expect(result.exitCode).toBe(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test('should capture failure output and exit code', async () => {
    const tool = new ExecTool();
    const result = await tool.execute({ command: 'sh -c "echo oops >&2; exit 3"' });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.error).toContain('oops');
  });

  test('should not block the event loop while running', async () => {
    const tool = new ExecTool();
    let timerTicked = false;
    const timer = setInterval(() => { timerTicked = true; }, 1);

    await tool.execute({ command: 'sleep 0.2' });
    clearInterval(timer);
    expect(timerTicked).toBe(true);
  });

  test('should time out long-running commands', async () => {
    const tool = new ExecTool({ timeout_seconds: 1 });
    const result = await tool.execute({ command: 'sleep 5' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });
});
