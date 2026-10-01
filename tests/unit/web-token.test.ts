import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  ensureWebAuthToken,
  generateWebToken,
  isWebTokenConfigured,
  rotateWebToken,
  showWebToken,
  readWebTokenFile,
} from '../../src/security/web-token';

describe('web-token lifecycle', () => {
  let testDir: string;
  let configPath: string;
  let configDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-token-'));
    configDir = path.join(testDir, 'config');
    configPath = path.join(configDir, 'alfred.json');
    fs.mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should generate a token when CHANGE_ME and persist it with restricted permissions', () => {
    const raw: any = { server: { port: 18789, host: '0.0.0.0', web_auth_token: 'CHANGE_ME' } };
    const { token, generated } = ensureWebAuthToken(raw, configPath, configDir);

    expect(generated).toBe(true);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(raw.server.web_auth_token).toBe(token);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).server.web_auth_token).toBe(token);
    expect(readWebTokenFile(configDir)).toBe(token);
    expect(fs.statSync(path.join(configDir, 'web-token.txt')).mode & 0o777).toBe(0o600);
  });

  test('should keep an already configured token untouched', () => {
    const existing = generateWebToken();
    const raw: any = { server: { web_auth_token: existing } };
    const { token, generated } = ensureWebAuthToken(raw, configPath, configDir);

    expect(generated).toBe(false);
    expect(token).toBe(existing);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test('should classify configured vs fail-closed tokens', () => {
    expect(isWebTokenConfigured(generateWebToken())).toBe(true);
    expect(isWebTokenConfigured('CHANGE_ME')).toBe(false);
    expect(isWebTokenConfigured('')).toBe(false);
    expect(isWebTokenConfigured(undefined)).toBe(false);
    expect(isWebTokenConfigured(null)).toBe(false);
  });

  test('should rotate the token and persist it in both places', () => {
    const first = generateWebToken();
    fs.writeFileSync(configPath, JSON.stringify({ server: { web_auth_token: first } }), 'utf-8');

    const second = rotateWebToken(configPath, configDir);

    expect(second).not.toBe(first);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(showWebToken(configPath)).toBe(second);
    expect(readWebTokenFile(configDir)).toBe(second);
  });

  test('should throw when showing an unconfigured token', () => {
    fs.writeFileSync(configPath, JSON.stringify({ server: { web_auth_token: 'CHANGE_ME' } }), 'utf-8');
    expect(() => showWebToken(configPath)).toThrow('not configured');
  });
});
