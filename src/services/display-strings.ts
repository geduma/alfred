import fs from 'fs';
import path from 'path';
import { WORKSPACE_PATHS } from '../utils/workspace';
import { readPreferences } from './preferences-store';
import { ConductorMessageKey, isControlMessage, resolveConductorMessage } from '../agent/conductor-messages';
import { getLogger } from '../utils/logger';

let cachedMessages: Record<string, string> | null = null;

function messagesFilePath(): string {
  try {
    const p = WORKSPACE_PATHS.config();
    return path.join(p, 'messages.json');
  } catch {
    return path.join(process.cwd(), 'workspace', 'config', 'messages.json');
  }
}

function exampleFilePath(): string {
  return path.resolve(__dirname, '../../system/messages.json.example');
}

export function loadDisplayMessages(): Record<string, string> {
  if (cachedMessages) return cachedMessages;
  const candidates = [messagesFilePath(), exampleFilePath()];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (parsed && typeof parsed === 'object') {
        cachedMessages = parsed;
        return cachedMessages;
      }
    } catch {
      // try next candidate
    }
  }
  cachedMessages = {};
  return cachedMessages;
}

export function clearDisplayCache(): void {
  cachedMessages = null;
}

export function getDisplayLanguage(): string {
  try {
    const prefs = readPreferences();
    const raw = (prefs.language || '').toLowerCase();
    if (!raw) return 'en';
    if (raw.includes('spanish') || raw.includes('espa') || raw === 'es' || raw.startsWith('es')) return 'es';
  } catch (error: any) {
    getLogger().debug({ error: error?.message }, 'Display language fallback to English');
  }
  return 'en';
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

export function getDisplay(key: ConductorMessageKey, vars?: Record<string, string | number>): string {
  const lang = getDisplayLanguage();
  if (lang !== 'es') return resolveConductorMessage(key, vars);
  const table = loadDisplayMessages();
  const template = table[key];
  if (!template) return resolveConductorMessage(key, vars);
  return interpolate(template, vars);
}

function templateToPattern(template: string): RegExp {
  const pattern = template
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^}]+\\\}/g, '.+');
  return new RegExp(`^${pattern}$`);
}

export function isDisplayControlMessage(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const table = loadDisplayMessages();
  const templates = Object.values(table).filter((v) => typeof v === 'string' && v.length > 0);
  for (const template of templates) {
    try {
      if (templateToPattern(template).test(normalized)) return true;
    } catch {
      if (normalized === template.trim()) return true;
    }
  }
  return false;
}

export function isControlMessageAny(text: string): boolean {
  if (isControlMessage(text)) return true;
  try {
    return isDisplayControlMessage(text);
  } catch {
    return false;
  }
}
