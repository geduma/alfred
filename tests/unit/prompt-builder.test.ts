import fs from 'fs';
import path from 'path';
import { PromptBuilder } from '../../src/agent/prompt-builder';
import { WORKSPACE_PATHS } from '../../src/utils/workspace';

describe('PromptBuilder shared memory', () => {
  let builder: PromptBuilder;

  const writeWorkspaceFile = (p: string, content: string): void => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  };

  beforeEach(() => {
    builder = new PromptBuilder();
  });

  afterEach(() => {
    fs.rmSync(path.join(process.env.WORKSPACE || '', 'memory'), { recursive: true, force: true });
  });

  test('should inject Shared Memory into the system prompt', async () => {
    writeWorkspaceFile(WORKSPACE_PATHS.preferences(), '## Dynamic Preferences\nlanguage: spanish\nuser_name: Felipe\n');
    writeWorkspaceFile(WORKSPACE_PATHS.memoryFile(), '# Shared Memory\n- User name is Felipe\n- Prefers concise answers\n');

    const prompt = await builder.buildSystemPrompt();

    expect(prompt).toContain('## Shared Memory');
    expect(prompt).toContain('- User name is Felipe');
    expect(prompt).toContain('- Prefers concise answers');
    expect(prompt).toContain('Your user\'s name is "Felipe"');
  });

  test('should omit Shared Memory block when memory file is absent', async () => {
    writeWorkspaceFile(WORKSPACE_PATHS.preferences(), '## Dynamic Preferences\nlanguage: english\nuser_name: unknown\n');

    const prompt = await builder.buildSystemPrompt();

    expect(prompt).not.toContain('## Shared Memory\n');
  });
});
