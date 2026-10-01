/**
 * Deterministic post-turn preference extractor (EN/ES).
 *
 * The agent sometimes answers "done" without calling file_ops, so explicit
 * user statements ("me llamo X", "my name is X", "háblame en español")
 * are persisted without relying on the model. Only fires on explicit
 * self-statements — never on questions or quoted text.
 */
export interface ExtractedPreference {
  key: string;
  value: string;
}

const NAME_PATTERNS = [
  /(?:me llamo|mi nombre es)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]+)/i,
  /(?:my name is)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]+)/i,
  /(?:llámame|llamame|call me)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]+)/i,
];

const LANGUAGE_PATTERNS: Array<{ re: RegExp; value: string }> = [
  { re: /(?:respóndeme|respondeme|háblame|hablame|escríbeme|escribeme)\s+en\s+español/i, value: 'spanish' },
  { re: /(?:respóndeme|respondeme|háblame|hablame|escríbeme|escribeme)\s+en\s+(?:inglés|ingles|english)/i, value: 'english' },
  { re: /(?:answer|reply|respond|talk|write)(?:\s+to\s+me)?\s+in\s+spanish/i, value: 'spanish' },
  { re: /(?:respóndeme|respondeme|háblame|hablame|escríbeme|escribeme)\s+en\s+(english)/i, value: 'english' },
  { re: /(?:answer|reply|respond|talk|write)(?:\s+to\s+me)?\s+in\s+english/i, value: 'english' },
  { re: /cambia(?:r)?\s+(?:el\s+)?idioma\s+a(?:l)?\s+español/i, value: 'spanish' },
  { re: /cambia(?:r)?\s+(?:el\s+)?idioma\s+a(?:l)?\s+(?:inglés|ingles|english)/i, value: 'english' },
  { re: /prefiero\s+(?:el\s+)?español/i, value: 'spanish' },
  { re: /prefiero\s+(?:el\s+)?(?:inglés|ingles|english)/i, value: 'english' },
  { re: /(?:switch|change)(?:\s+the)?\s+language\s+to\s+spanish/i, value: 'spanish' },
  { re: /(?:switch|change)(?:\s+the)?\s+language\s+to\s+english/i, value: 'english' },
  { re: /de ahora en adelante\s+(?:háblame|hablame|respóndeme|respondeme)?\s*(?:en\s+)?español/i, value: 'spanish' },
  { re: /de ahora en adelante\s+(?:háblame|hablame|respóndeme|respondeme)?\s*(?:en\s+)?(?:inglés|ingles|english)/i, value: 'english' },
];

function cleanName(raw: string): string {
  return raw.replace(/[.,;:!?¿¡]+$/, '').trim();
}

export function extractPreferencesFromMessage(text: string): ExtractedPreference[] {
  if (!text || typeof text !== 'string') return [];
  const found: ExtractedPreference[] = [];
  const seen = new Set<string>();

  const push = (key: string, value: string) => {
    if (seen.has(key) || !value) return;
    seen.add(key);
    found.push({ key, value });
  };

  for (const re of NAME_PATTERNS) {
    const m = text.match(re);
    if (m && m[1]) {
      const name = cleanName(m[1]);
      if (name.length >= 2) push('user_name', name);
      break;
    }
  }

  for (const { re, value } of LANGUAGE_PATTERNS) {
    if (re.test(text)) {
      push('language', value);
      break;
    }
  }

  return found;
}
