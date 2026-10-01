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
    agent: { name: 'Alfred', version: '2.1.0', personality_file: '/workspace/config/SOUL.md', max_tool_iterations: 5 },
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
    },
    database: { type: 'sqlite', config: { path: '/tmp/strict-gate-test/alfred.db' } },
    logging: { level: 'silent', format: 'json', targets: ['console'], config: {} },
    security: { gateway_auth_token: 'test-auth-token-12345678' },
  };
}

class FakeExecTool implements ToolHandler {
  executed = 0;
  tool = {
    name: 'exec',
    description: 'Run a command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  };

  async execute(args: Record<string, unknown>) {
    this.executed++;
    return { success: true, output: `ran:${args.command}`, exitCode: 0 };
  }
}

describe('Strict manifest gate in agent loop', () => {
  let testDir: string;
  let configPath: string;
  let gateway: Gateway;
  let routerCall: jest.Mock;
  let execTool: FakeExecTool;
  const skillsRoot = WORKSPACE_PATHS.skills();
  const fixtures = ['strict-struct.md', 'strict-bare.md', 'strict-legacy.md'];

  const writeFixtures = (): void => {
    fs.mkdirSync(path.join(skillsRoot, 'custom'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsRoot, 'custom', 'strict-struct.md'),
      '---\nname: Strict Struct\ndescription: structured manifest\nunattended: true\npermissions:\n  tools: [exec]\n  exec:\n    allowed_commands: [ls]\n---\nBody\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(skillsRoot, 'custom', 'strict-bare.md'),
      '---\nname: Strict Bare\ndescription: unattended without any manifest\nunattended: true\n---\nBody\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(skillsRoot, 'custom', 'strict-legacy.md'),
      '---\nname: Strict Legacy\ndescription: legacy manifest\nunattended: true\napproved_actions: file_ops\n---\nBody\n',
      'utf-8'
    );
  };

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-gate-'));
    configPath = path.join(testDir, 'alfred.json');
    fs.writeFileSync(configPath, JSON.stringify(buildConfig(), null, 2), 'utf-8');
    writeFixtures();

    const config = new ConfigLoader(configPath);
    routerCall = jest.fn();
    gateway = new Gateway(
      config,
      { call: routerCall } as any,
      { buildPrompt: jest.fn(), reload: jest.fn() } as any,
      { startAll: jest.fn(), stopAll: jest.fn(), sendMessage: jest.fn() } as any
    );
    execTool = new FakeExecTool();
    gateway.setTools([execTool]);
  });

  afterEach(async () => {
    (gateway as any).rateLimiter.stop();
    fs.rmSync(testDir, { recursive: true, force: true });
    for (const f of fixtures) {
      await fs.promises.rm(path.join(skillsRoot, 'custom', f), { force: true });
    }
    const loader: SkillLoader = (gateway as any).skillLoader;
    loader.stopWatching();
  });

  function mockExecRound(command: string, finalContent = 'done'): void {
    routerCall
      .mockResolvedValueOnce({
        content: 'running',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec', arguments: JSON.stringify({ command }) } }],
        stop_reason: 'tool_use',
      })
      .mockResolvedValueOnce({ content: finalContent, tool_calls: [], stop_reason: 'end_turn' });
  }

  async function runStrictLoop(content: string): Promise<any> {
    const session: any = {
      id: `session-${Date.now()}`,
      messages: [{ role: 'user', content } as Message],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const gate = await (gateway as any).resolveUnattendedGate(content, true);
    return (gateway as any).runAgentLoop(
      session, 'system prompt', session.messages,
      { channel: 'cli', userId: 'u', metadata: { source: 'job' } },
      'run_strict', () => {}, undefined, gate
    );
  }

  test('should execute an allowed command under a structured manifest', async () => {
    mockExecRound('ls /tmp');
    const result = await runStrictLoop('Run Strict Struct now');
    expect(execTool.executed).toBe(1);
    expect(result.content).toBe('done');
  });

  test('should block a command outside allowed_commands', async () => {
    mockExecRound('rm -rf /tmp/x');
    const result = await runStrictLoop('Run Strict Struct now');
    expect(execTool.executed).toBe(0);
    expect(result.content).toContain('requires approval');
    expect(result.blockedActions).toContain('exec');
  });

  test('should block every tool without any manifest in strict mode', async () => {
    mockExecRound('ls');
    const result = await runStrictLoop('Run Strict Bare now');
    expect(execTool.executed).toBe(0);
    expect(result.content).toContain('requires approval');
  });

  test('should keep the legacy allowlist working until migrated', async () => {
    mockExecRound('ls');
    const result = await runStrictLoop('Run Strict Legacy now');
    expect(execTool.executed).toBe(0);
    expect(result.content).toContain('requires approval');
  });
});
