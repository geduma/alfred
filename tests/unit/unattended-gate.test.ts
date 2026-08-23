import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigLoader } from '../../src/config/loader';
import { Gateway } from '../../src/gateway';
import { ToolHandler } from '../../src/types/tool';
import { Message } from '../../src/types/llm';
import { SkillLoader } from '../../src/services/skill-loader';
import { WORKSPACE_PATHS } from '../../src/utils/workspace';

function buildConfig() {
  return {
    agent: {
      name: 'Alfred',
      version: '2.1.0',
      personality_file: '/workspace/config/SOUL.md',
      max_tool_iterations: 5,
    },
    llm: { primary_provider: 'primary', fallback_providers: [] },
    providers: {
      primary: {
        type: 'openai-compatible',
        enabled: true,
        model: 'auto',
        config: { api_url: 'https://api.example.com/v1', api_key: 'test-key' },
      },
    },
    channels: { cli: { enabled: true, type: 'cli', config: {} } },
    tools: {
      exec: { enabled: true, config: {} },
      file_ops: { enabled: false, config: {} },
      web: { enabled: false, config: {} },
      job: { enabled: false, config: {} },
      system: { enabled: false, config: {} },
      health: { enabled: false, config: {} },
      memory: { enabled: false, config: {} },
    },
    database: { type: 'sqlite', config: { path: '/tmp/unattended-gate-test/alfred.db' } },
    logging: { level: 'silent', format: 'json', targets: ['console'], config: {} },
    security: {
      gateway_auth_token: 'test-auth-token-12345678',
    },
  };
}

class FakeExecTool implements ToolHandler {
  executed = 0;
  tool = {
    name: 'exec',
    description: 'Run a command',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  };

  async execute(args: Record<string, unknown>) {
    this.executed++;
    return { success: true, output: `ran:${args.command}`, exitCode: 0 };
  }
}

describe('SkillLoader unattended frontmatter', () => {
  let testDir: string;
  let loader: SkillLoader;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-skills-'));
    loader = new SkillLoader(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    loader.stopWatching();
  });

  test('parses unattended:true and approved_actions list', async () => {
    fs.writeFileSync(
      path.join(testDir, 'a.md'),
      '---\nname: Alpha\ndescription: alpha skill\nunattended: true\napproved_actions: exec, Web\n---\nDo things\n',
      'utf-8'
    );
    const skills = await loader.loadSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].unattended).toBe(true);
    expect(skills[0].approvedActions).toEqual(['exec', 'web']);
  });

  test('unattended:false and missing flag parse as not-unattended/undefined', async () => {
    fs.writeFileSync(
      path.join(testDir, 'b.md'),
      '---\nname: Beta\ndescription: beta skill\nunattended: false\n---\nBody\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(testDir, 'c.md'),
      '---\nname: Gamma\ndescription: gamma skill\n---\nBody\n',
      'utf-8'
    );
    const skills = await loader.loadSkills();
    const beta = skills.find(s => s.name === 'Beta');
    const gamma = skills.find(s => s.name === 'Gamma');
    expect(beta?.unattended).toBe(false);
    expect(gamma?.unattended).toBeUndefined();
  });

  test('resolveJobSkill matches by name case-insensitively and returns null otherwise', async () => {
    fs.writeFileSync(
      path.join(testDir, 'd.md'),
      '---\nname: Daily Digest\ndescription: morning summary\nunattended: true\napproved_actions: exec\n---\nBody\n',
      'utf-8'
    );
    expect((await loader.resolveJobSkill('Run Daily Digest now'))?.name).toBe('Daily Digest');
    expect(await loader.resolveJobSkill('nothing relevant here')).toBeNull();
  });
});

describe('Unattended gate in agent loop', () => {
  let testDir: string;
  let configPath: string;
  let gateway: Gateway;
  let routerCall: jest.Mock;
  let execTool: FakeExecTool;
  const skillsRoot = WORKSPACE_PATHS.skills();

  const writeSkillFixture = (): void => {
    fs.mkdirSync(path.join(skillsRoot, 'custom'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsRoot, 'custom', 'gate-test-digest.md'),
      '---\nname: Gate Test Digest\ndescription: fixture for gate tests\nunattended: true\napproved_actions: exec\n---\nBody\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(skillsRoot, 'custom', 'gate-test-manual.md'),
      '---\nname: Gate Test Manual\ndescription: fixture without unattended flag\napproved_actions: exec\n---\nBody\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(skillsRoot, 'custom', 'gate-test-limited.md'),
      '---\nname: Gate Test Limited\ndescription: unattended but exec not approved\nunattended: true\napproved_actions: file_ops\n---\nBody\n',
      'utf-8'
    );
  };

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
    configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');

    writeSkillFixture();

    const config = new ConfigLoader(configPath);
    routerCall = jest.fn();
    const fakeRouter: any = { call: routerCall };
    const fakePromptBuilder: any = { buildPrompt: jest.fn(), reload: jest.fn() };
    const fakeChannelManager: any = { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() };

    gateway = new Gateway(config, fakeRouter, fakePromptBuilder, fakeChannelManager);
    execTool = new FakeExecTool();
    gateway.setTools([execTool]);
  });

  afterEach(async () => {
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
    for (const f of ['gate-test-digest.md', 'gate-test-manual.md', 'gate-test-limited.md']) {
      await fs.promises.rm(path.join(skillsRoot, 'custom', f), { force: true });
    }
    const loader: SkillLoader = (gateway as any).skillLoader;
    loader.stopWatching();
  });

  function makeSession(): any {
    return {
      id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      messages: [] as Message[],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function mockTwoRoundRun(firstContent = 'running command'): void {
    routerCall
      .mockResolvedValueOnce({
        content: firstContent,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'exec', arguments: '{"command":"ls"}' },
        }],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({
        content: 'done',
        tool_calls: [],
        stop_reason: 'end_turn',
      });
  }

  async function runLoop(metadata: Record<string, unknown>, content: string): Promise<any> {
    const session = makeSession();
    session.messages.push({ role: 'user', content });
    const ingestParams = { channel: 'cli', userId: 'test-user', metadata };
    const runId = `run_${Date.now()}`;
    const gate = metadata.source === 'job' ? await (gateway as any).resolveUnattendedGate(content) : undefined;
    return (gateway as any).runAgentLoop(session, 'system prompt', session.messages, ingestParams, runId, () => {}, undefined, gate);
  }

  test('approved action executes when job references an unattended skill', async () => {
    mockTwoRoundRun();
    const result = await runLoop({ source: 'job', jobId: 'j1' }, 'Please run Gate Test Digest');
    expect(execTool.executed).toBe(1);
    expect(result.content).toBe('done');
    expect(result.content).not.toContain('requires approval');
  });

  test('non-approved action is blocked at dispatcher level before execution', async () => {
    mockTwoRoundRun();
    const result = await runLoop({ source: 'job', jobId: 'j2' }, 'Please run Gate Test Limited');
    expect(execTool.executed).toBe(0);
    expect(routerCall).toHaveBeenCalledTimes(2);
  });

  test('blocked call produces a tool message reporting requires approval and final notice', async () => {
    mockTwoRoundRun();
    const result = await runLoop({ source: 'job', jobId: 'j3' }, 'Run Gate Test Limited please');
    expect(result.content).toContain('requires approval');
    expect(result.content).toContain('exec');
  });

  test('skill without unattended:true never dispatches gated tools via job', async () => {
    mockTwoRoundRun();
    const result = await runLoop({ source: 'job', jobId: 'j4' }, 'Start Gate Test Manual');
    expect(execTool.executed).toBe(0);
    expect(result.content).toContain('requires approval');
  });

  test('job referencing no known skill fails closed', async () => {
    mockTwoRoundRun();
    const result = await runLoop({ source: 'job', jobId: 'j5' }, 'Do something completely unrelated');
    expect(execTool.executed).toBe(0);
    expect(result.content).toContain('requires approval');
  });

  test('interactive runs are unaffected by the gate', async () => {
    mockTwoRoundRun();
    const result = await runLoop({}, 'just do a thing');
    expect(execTool.executed).toBe(1);
    expect(result.content).toBe('done');
  });

  test('resolveUnattendedGate returns empty allowlist without unattended flag and populated one with it', async () => {
    const allowed = await (gateway as any).resolveUnattendedGate('run Gate Test Digest');
    expect(allowed.skillName).toBe('Gate Test Digest');
    expect([...allowed.unattendedAllowlist]).toEqual(['exec']);

    const denied = await (gateway as any).resolveUnattendedGate('run Gate Test Manual');
    expect(denied.skillName).toBe('Gate Test Manual');
    expect(denied.unattendedAllowlist.size).toBe(0);

    const none = await (gateway as any).resolveUnattendedGate('nothing matches here');
    expect(none.skillName).toBeUndefined();
    expect(none.unattendedAllowlist.size).toBe(0);
  });
});
