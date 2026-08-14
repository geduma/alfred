import { filterSearchResults, ScoredRow } from '../../src/services/vector-store/index';

function scored(id: string, sessionId: string, score: number): ScoredRow {
  return { row: { id, messageId: id, sessionId }, score };
}

describe('filterSearchResults', () => {
  const rows: ScoredRow[] = [
    scored('msg_1', 'session-a', 0.9),
    scored('msg_2', 'session-a', 0.8),
    scored('msg_3', 'session-b', 0.85),
    scored('msg_4', 'session-c', 0.7),
    scored('msg_5', 'session-c', 0.95),
  ];

  test('should exclude rows from the active session', () => {
    const result = filterSearchResults(rows, 5, { excludeSessionId: 'session-a' });
    expect(result.map(r => r.row.messageId)).toEqual(['msg_5', 'msg_3', 'msg_4']);
  });

  test('should exclude specific message ids', () => {
    const result = filterSearchResults(rows, 5, { excludeMessageIds: ['msg_1', 'msg_5'] });
    expect(result.map(r => r.row.messageId)).toEqual(['msg_3', 'msg_2', 'msg_4']);
  });

  test('should respect topK after filtering', () => {
    const result = filterSearchResults(rows, 2, { excludeSessionId: 'session-c' });
    expect(result.map(r => r.row.messageId)).toEqual(['msg_1', 'msg_3']);
  });

  test('should keep order by score (highest first)', () => {
    const result = filterSearchResults(rows, 5, {});
    expect(result[0].row.messageId).toBe('msg_5');
    expect(result[1].row.messageId).toBe('msg_1');
  });
});
