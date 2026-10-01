import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { WORKSPACE_PATHS } from '../utils/workspace';

export const WEB_TOKEN_UNSET = 'CHANGE_ME';
export const WEB_TOKEN_FILE = 'web-token.txt';

export function generateWebToken(): string {
  return randomBytes(32).toString('hex');
}

export function isWebTokenConfigured(token: unknown): boolean {
  return typeof token === 'string' && token.length > 0 && token !== WEB_TOKEN_UNSET;
}

function tokenFilePath(configDir?: string): string {
  return path.join(configDir || WORKSPACE_PATHS.config(), WEB_TOKEN_FILE);
}

function persistTokenFile(token: string, configDir?: string): void {
  const filePath = tokenFilePath(configDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function writeConfigToken(rawConfig: any, configPath: string, token: string): void {
  rawConfig.server = rawConfig.server || {};
  rawConfig.server.web_auth_token = token;
  fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), 'utf-8');
}

export function ensureWebAuthToken(
  rawConfig: any,
  configPath: string,
  configDir?: string
): { token: string; generated: boolean } {
  const current = rawConfig?.server?.web_auth_token;
  if (isWebTokenConfigured(current)) {
    return { token: current, generated: false };
  }
  const token = generateWebToken();
  writeConfigToken(rawConfig, configPath, token);
  persistTokenFile(token, configDir);
  return { token, generated: true };
}

export function showWebToken(configPath: string): string {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const token = raw?.server?.web_auth_token;
  if (!isWebTokenConfigured(token)) {
    throw new Error('Web auth token is not configured');
  }
  return token;
}

export function rotateWebToken(configPath: string, configDir?: string): string {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const token = generateWebToken();
  writeConfigToken(raw, configPath, token);
  persistTokenFile(token, configDir);
  return token;
}

export function readWebTokenFile(configDir?: string): string | null {
  try {
    return fs.readFileSync(tokenFilePath(configDir), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}
