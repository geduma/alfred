import { checkUnattendedPolicy } from '../../src/agent/skill-policy';

const STRUCTURED = {
  tools: ['exec', 'file_ops', 'web'],
  file_ops: { paths: ['/tmp/allowed/'], modes: ['read'] },
  web: { domains: ['example.com'] },
  exec: { allowed_commands: ['cat', 'ls'] },
  requires_secrets: [],
};

describe('skill policy', () => {
  test('should allow tools within a structured manifest', () => {
    const gate = { strict: true, permissions: STRUCTURED, skillName: 's' };
    expect(checkUnattendedPolicy('exec', { command: 'cat /tmp/allowed/a.txt' }, gate).allowed).toBe(true);
    expect(checkUnattendedPolicy('file_ops', { action: 'read', path: '/tmp/allowed/a.txt' }, gate).allowed).toBe(true);
    expect(checkUnattendedPolicy('web', { action: 'search', query: 'x' }, gate).allowed).toBe(true);
    expect(checkUnattendedPolicy('web', { action: 'fetch', url: 'https://example.com/p' }, gate).allowed).toBe(true);
  });

  test('should block tools outside the manifest tools list', () => {
    const gate = { strict: true, permissions: STRUCTURED };
    const verdict = checkUnattendedPolicy('system', {}, gate);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('requires approval');
  });

  test('should block file_ops writes without write mode and paths outside the manifest', () => {
    const gate = { strict: true, permissions: STRUCTURED };
    expect(checkUnattendedPolicy('file_ops', { action: 'write', path: '/tmp/allowed/a.txt' }, gate).allowed).toBe(false);
    expect(checkUnattendedPolicy('file_ops', { action: 'read', path: '/tmp/other/a.txt' }, gate).allowed).toBe(false);
    expect(checkUnattendedPolicy('file_ops', { action: 'frobnicate', path: '/tmp/allowed/a.txt' }, gate).allowed).toBe(false);
  });

  test('should block web fetch from unlisted domains and unparseable urls', () => {
    const gate = { strict: true, permissions: STRUCTURED };
    expect(checkUnattendedPolicy('web', { action: 'fetch', url: 'https://evil.com/x' }, gate).allowed).toBe(false);
    expect(checkUnattendedPolicy('web', { action: 'fetch', url: '::not a url::' }, gate).allowed).toBe(false);
  });

  test('should block exec commands outside allowed_commands', () => {
    const gate = { strict: true, permissions: STRUCTURED };
    expect(checkUnattendedPolicy('exec', { command: 'rm -rf /' }, gate).allowed).toBe(false);
    expect(checkUnattendedPolicy('exec', { command: 'catalog' }, gate).allowed).toBe(false);
    expect(checkUnattendedPolicy('exec', { command: 'ls /tmp' }, gate).allowed).toBe(true);
  });

  test('should block exec entirely when allowed_commands is empty', () => {
    const gate = { strict: true, permissions: { tools: ['exec'], exec: { allowed_commands: [] } } };
    expect(checkUnattendedPolicy('exec', { command: 'ls' }, gate).allowed).toBe(false);
  });

  test('should keep the legacy gated-tools behavior', () => {
    const gate = { strict: false, unattendedAllowlist: new Set(['exec']) };
    expect(checkUnattendedPolicy('exec', { command: 'anything' }, gate).allowed).toBe(true);
    expect(checkUnattendedPolicy('system', {}, gate).allowed).toBe(true);
    const blocked = checkUnattendedPolicy('file_ops', { action: 'read', path: 'x' }, gate);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('requires approval');
  });

  test('should block every tool call for strict tasks without any manifest', () => {
    const gate = { strict: true, unattendedAllowlist: new Set(), noManifest: true };
    expect(checkUnattendedPolicy('exec', { command: 'ls' }, gate).allowed).toBe(false);
    expect(checkUnattendedPolicy('system', {}, gate).allowed).toBe(false);
    expect(checkUnattendedPolicy('job', {}, gate).allowed).toBe(false);
  });
});
