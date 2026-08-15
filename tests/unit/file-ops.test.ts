import fs from 'fs';
import path from 'path';
import os from 'os';
import { FileOpsTool } from '../../src/tools/file-ops';
import { WORKSPACE_ROOT, resolveInWorkspace } from '../../src/utils/workspace';

describe('FileOpsTool path resolution', () => {
  let tool: FileOpsTool;

  beforeEach(() => {
    tool = new FileOpsTool();
    fs.mkdirSync(resolveInWorkspace('files'), { recursive: true });
    fs.mkdirSync(resolveInWorkspace('memory', 'personality'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  });

  test('should resolve workspace-relative paths from a foreign CWD', async () => {
    const rel = 'memory/personality/preferences.md';
    const abs = resolveInWorkspace(rel);
    fs.writeFileSync(abs, 'language: spanish\n', 'utf-8');

    const result = await tool.execute({ action: 'read', path: rel });
    expect(result.success).toBe(true);
    expect(result.output).toContain('language: spanish');
  });

  test('should write a workspace-relative path from a foreign CWD', async () => {
    const rel = 'files/notes.txt';
    const result = await tool.execute({ action: 'write', path: rel, content: 'hello' });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(resolveInWorkspace(rel), 'utf-8')).toBe('hello');
  });

  test('should still accept paths resolved against the CWD (repo-style prefix)', async () => {
    const repoStyle = path.join(WORKSPACE_ROOT, 'files', 'repo-style.txt');
    fs.mkdirSync(path.dirname(repoStyle), { recursive: true });
    fs.writeFileSync(repoStyle, 'x', 'utf-8');

    const result = await tool.execute({ action: 'read', path: repoStyle });
    expect(result.success).toBe(true);
    expect(result.output).toBe('x');
  });

  test('should deny writes to the read-only config path', async () => {
    const result = await tool.execute({ action: 'write', path: 'config/alfred.json', content: '{}' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('do not have write permission');
  });

  test('should deny access to paths outside the workspace', async () => {
    const outside = path.join(os.tmpdir(), `file-ops-outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'secret', 'utf-8');

    const read = await tool.execute({ action: 'read', path: outside });
    expect(read.success).toBe(false);
    expect(read.error).toContain('not accessible');

    const write = await tool.execute({ action: 'write', path: outside, content: 'x' });
    expect(write.success).toBe(false);
    expect(write.error).toContain('do not have write permission');
  });

  test('should deny relative traversal escaping the workspace', async () => {
    const result = await tool.execute({ action: 'write', path: '../../etc/pwned', content: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('do not have write permission');
  });

  test('should edit an existing workspace-relative file', async () => {
    const rel = 'memory/personality/preferences.md';
    fs.writeFileSync(resolveInWorkspace(rel), 'language: spanish\n', 'utf-8');

    const result = await tool.execute({ action: 'edit', path: rel, content: 'language: english\n' });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(resolveInWorkspace(rel), 'utf-8')).toBe('language: english\n');
  });
});
