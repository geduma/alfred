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

  test('should not flag single-word patterns as substrings of longer words', async () => {
    const tool = new ExecTool({ denied_patterns: ['dd'] });
    const ok = await tool.execute({ command: 'echo embedding works' });
    expect(ok.success).toBe(true);
    expect(ok.output).toBe('embedding works');
  });

  test('should deny a single-word pattern when used as a standalone word', async () => {
    const tool = new ExecTool({ denied_patterns: ['dd'] });
    const denied = await tool.execute({ command: 'dd if=/dev/zero of=/tmp/x bs=1M' });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('Command denied by policy');
  });

  test('should deny mkfs as a standalone word', async () => {
    const tool = new ExecTool({ denied_patterns: ['mkfs'] });
    const denied = await tool.execute({ command: 'mkfs.ext4 /dev/sda1' });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('Command denied by policy');
  });

  test('should not flag single-word patterns inside similar words', async () => {
    const tool = new ExecTool({ denied_patterns: ['sudo'] });
    const ok = await tool.execute({ command: 'echo pseudo' });
    expect(ok.success).toBe(true);
    expect(ok.output).toBe('pseudo');
  });

  test('should keep substring matching for compound patterns', async () => {
    const tool = new ExecTool({ denied_patterns: ['rm -rf'] });
    const denied = await tool.execute({ command: 'rm -rf /' });
    expect(denied.success).toBe(false);
    expect(denied.error).toBe('Command denied by policy');
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
