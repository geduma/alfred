export type ConductorMessageKey =
  | 'ack.enqueued'
  | 'ack.queued_with_position'
  | 'task.done_fallback'
  | 'task.needs_approval'
  | 'task.failed'
  | 'task.failed_retries'
  | 'rate.limited_user'
  | 'rate.limited_channel';

const MESSAGES_EN: Record<ConductorMessageKey, string> = {
  'ack.enqueued': 'Right away, sir...',
  'ack.queued_with_position': 'Right away, sir... ({pending})',
  'task.done_fallback': 'Done.',
  'task.needs_approval': 'I need your approval before continuing:\n\n{result}',
  'task.failed': 'The task could not be completed: {result}\nRetry?',
  'task.failed_retries': 'The task failed after several attempts.',
  'rate.limited_user': 'Rate limit exceeded. Please wait before sending another message.',
  'rate.limited_channel': 'Rate limit exceeded for this channel. Please wait.',
};

export function resolveConductorMessage(key: ConductorMessageKey, vars?: Record<string, string | number>): string {
  let text = MESSAGES_EN[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}

export const CONDUCTOR_ACK = MESSAGES_EN['ack.enqueued'];

function templateToPattern(template: string): RegExp {
  const pattern = template
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^}]+\\\}/g, '.+');
  return new RegExp(`^${pattern}$`);
}

const CONTROL_PATTERNS: RegExp[] = (Object.keys(MESSAGES_EN) as ConductorMessageKey[]).map((key) =>
  templateToPattern(MESSAGES_EN[key])
);

export function isControlMessage(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return CONTROL_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function getCanonicalMessage(key: ConductorMessageKey): string {
  return MESSAGES_EN[key];
}
