import fs from 'fs';
import path from 'path';
import { WORKSPACE_PATHS } from '../utils/workspace';
import { getLogger } from '../utils/logger';

/** Canonical preference keys shared by the web UI and the agent. */
export const PREFERENCE_KEYS = new Set([
  'language',
  'tone',
  'formality',
  'verbosity',
  'user_name',
  'voice_replies',
]);

const HEADER = '## Dynamic Preferences';

export function preferencesFilePath(): string {
  return WORKSPACE_PATHS.preferences();
}

export function readPreferences(): Record<string, string> {
  const prefs: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(preferencesFilePath(), 'utf-8');
    const hasHeader = /^#+\s*Dynamic Preferences\s*$/im.test(raw);
    let inDynamic = !hasHeader;
    for (const line of raw.split('\n')) {
      if (!inDynamic && /^#+\s*Dynamic Preferences\s*$/i.test(line)) {
        inDynamic = true;
        continue;
      }
      if (!inDynamic) continue;
      if (hasHeader && /^#+/.test(line)) break;
      const m = line.match(/^([a-z_]+):\s*(.*)$/i);
      if (m) prefs[m[1].toLowerCase()] = m[2].trim();
    }
  } catch {
    // preferences file missing — return empty map
  }
  return prefs;
}

export function writePreference(key: string, value: string): void {
  const normalizedKey = key.toLowerCase();
  if (!PREFERENCE_KEYS.has(normalizedKey)) {
    throw new Error(`Unknown preference key: ${key}`);
  }
  const filePath = preferencesFilePath();
  const cleanValue = value.trim();
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // file missing — will create it
  }

  let content = raw.trimEnd();
  const hasHeader = /^#+\s*Dynamic Preferences\s*$/m.test(content);
  if (!hasHeader) {
    content = content ? `${HEADER}\n${content}\n` : `${HEADER}\n`;
  }

  const keyRe = new RegExp(`^(${normalizedKey}:).*$`, 'm');
  if (keyRe.test(content)) {
    content = content.replace(keyRe, `${normalizedKey}: ${cleanValue}`);
  } else {
    const headerMatch = content.match(/^#+\s*Dynamic Preferences\s*$/m);
    const insertAt = headerMatch ? (headerMatch.index || 0) + headerMatch[0].length : 0;
    content = `${content.slice(0, insertAt)}\n${normalizedKey}: ${cleanValue}${content.slice(insertAt)}`;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  getLogger().info({ key: normalizedKey }, 'Preference updated');
}
