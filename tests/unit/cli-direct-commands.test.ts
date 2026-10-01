import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateWebToken } from '../../src/security/web-token';
import {
  handleDirectCommand,
  setDirectCommandContext,
} from '../../src/channels/cli-direct-commands';

describe('CLI direct commands', () => {
  let testDir: string;
  let configPath: string;
  let reloadMock: jest.Mock;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-cmd-'));
    configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ server: { web_auth_token: generateWebToken() } }),
      'utf-8'
    );
    reloadMock = jest.fn().mockResolvedValue(undefined);
    setDirectCommandContext({ configPath, reload: reloadMock });
  });

  afterEach(() => {
    setDirectCommandContext(null as any);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should ignore conversational input', async () => {
    expect(await handleDirectCommand('hola, qué hora es')).toBeNull();
    expect(await handleDirectCommand('')).toBeNull();
  });

  test('should ignore unknown slash commands', async () => {
    expect(await handleDirectCommand('/noexiste')).toBeNull();
  });

  test('should show the current token without touching the LLM', async () => {
    const current = JSON.parse(fs.readFileSync(configPath, 'utf-8')).server.web_auth_token;
    const output = await handleDirectCommand('/web-token');
    expect(output).toContain(current);
    expect(reloadMock).not.toHaveBeenCalled();
  });

  test('should rotate the token on demand', async () => {
    const before = JSON.parse(fs.readFileSync(configPath, 'utf-8')).server.web_auth_token;
    const output = await handleDirectCommand('/web-token rotate');
    const after = JSON.parse(fs.readFileSync(configPath, 'utf-8')).server.web_auth_token;
    expect(after).not.toBe(before);
    expect(output).toContain(after);
  });

  test('should reload through the direct path', async () => {
    const output = await handleDirectCommand('/reload');
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(output).toMatch(/recargada/i);
  });
});
