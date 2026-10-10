import { readPreferences } from '../services/preferences-store';

export type ConductorMessageKey =
  | 'ack.enqueued'
  | 'ack.queued_with_position'
  | 'task.done_fallback'
  | 'task.needs_approval'
  | 'task.failed'
  | 'task.failed_retries'
  | 'rate.limited_user'
  | 'rate.limited_channel';

const MESSAGES: Record<ConductorMessageKey, { en: string; es: string }> = {
  'ack.enqueued': {
    en: 'Right away, sir. I will notify you.',
    es: 'Enseguida, señor. Le aviso.',
  },
  'ack.queued_with_position': {
    en: 'Right away, sir. {pending} ahead in queue — I will notify you.',
    es: 'Enseguida, señor. {pending} en cola — le aviso.',
  },
  'task.done_fallback': {
    en: 'Done.',
    es: 'Listo.',
  },
  'task.needs_approval': {
    en: 'I need your approval before continuing:\n\n{result}',
    es: 'Necesito su aprobación antes de continuar:\n\n{result}',
  },
  'task.failed': {
    en: 'The task could not be completed: {result}\nRetry?',
    es: 'La tarea no pudo completarse: {result}\n¿Reintento?',
  },
  'task.failed_retries': {
    en: 'The task failed after several attempts.',
    es: 'La tarea falló tras varios intentos.',
  },
  'rate.limited_user': {
    en: 'Rate limit exceeded. Please wait before sending another message.',
    es: 'Límite de peticiones excedido. Espere antes de enviar otro mensaje.',
  },
  'rate.limited_channel': {
    en: 'Rate limit exceeded for this channel. Please wait.',
    es: 'Límite de peticiones excedido para este canal. Espere.',
  },
};

function resolveLanguage(): 'es' | 'en' {
  try {
    const prefs = readPreferences();
    const raw = (prefs.language || '').toLowerCase();
    if (raw.includes('spanish') || raw.includes('espa') || raw === 'es') return 'es';
  } catch {
    // preferences unavailable — default to English
  }
  return 'en';
}

export function resolveConductorMessage(key: ConductorMessageKey, vars?: Record<string, string | number>): string {
  const lang = resolveLanguage();
  let text = MESSAGES[key][lang];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}

export const CONDUCTOR_ACK = MESSAGES['ack.enqueued'].en;

const CONTROL_PATTERNS: RegExp[] = (Object.keys(MESSAGES) as ConductorMessageKey[]).flatMap((key) =>
  (['en', 'es'] as const).map((lang) => {
    const template = MESSAGES[key][lang]
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\{[^}]+\\\}/g, '.+');
    return new RegExp(`^${template}$`);
  })
);

export function isControlMessage(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return CONTROL_PATTERNS.some((pattern) => pattern.test(normalized));
}
