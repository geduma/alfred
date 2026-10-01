import { extractPreferencesFromMessage } from '../../src/services/preference-extractor';

describe('preference-extractor', () => {
  describe('user_name (ES/EN)', () => {
    test.each([
      ['me llamo Geduma', 'Geduma'],
      ['Mi nombre es Felipe', 'Felipe'],
      ['llámame Carlos por favor', 'Carlos'],
      ['my name is Alice', 'Alice'],
      ['call me Bob', 'Bob'],
      ['Hola, me llamo Ana.', 'Ana'],
    ])('should extract %p → %p', (input, expected) => {
      expect(extractPreferencesFromMessage(input)).toContainEqual({ key: 'user_name', value: expected });
    });

    test('should ignore questions about the name', () => {
      expect(extractPreferencesFromMessage('¿cuál es mi nombre?')).toEqual([]);
      expect(extractPreferencesFromMessage('what is my name?')).toEqual([]);
    });

    test('should ignore single-letter matches', () => {
      expect(extractPreferencesFromMessage('call me')).toEqual([]);
    });
  });

  describe('language (ES/EN)', () => {
    test.each([
      ['háblame en español', 'spanish'],
      ['Respóndeme en inglés por favor', 'english'],
      ['answer in Spanish', 'spanish'],
      ['reply in english', 'english'],
      ['cambia el idioma a español', 'spanish'],
      ['cambia el idioma a inglés', 'english'],
      ['prefiero el español', 'spanish'],
      ['prefiero el inglés', 'english'],
      ['switch the language to english', 'english'],
      ['de ahora en adelante en español', 'spanish'],
    ])('should extract %p → %p', (input, expected) => {
      expect(extractPreferencesFromMessage(input)).toContainEqual({ key: 'language', value: expected });
    });

    test('should ignore unrelated chat', () => {
      expect(extractPreferencesFromMessage('hola, ¿qué hora es?')).toEqual([]);
      expect(extractPreferencesFromMessage('dime un chiste')).toEqual([]);
    });
  });

  test('should extract both keys from one message', () => {
    expect(extractPreferencesFromMessage('me llamo Geduma y háblame en español')).toEqual([
      { key: 'user_name', value: 'Geduma' },
      { key: 'language', value: 'spanish' },
    ]);
  });

  test('should handle empty input', () => {
    expect(extractPreferencesFromMessage('')).toEqual([]);
  });
});
