import fs from 'fs';
import path from 'path';
import os from 'os';
import { JobSchedulerTool, Job } from '../../src/tools/job-scheduler';

describe('JobSchedulerTool', () => {
  let testDir: string;
  let tool: JobSchedulerTool;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-test-'));
    tool = new JobSchedulerTool(testDir);
    tool.clearCache();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should create a job capturing real channel and user from context', async () => {
    const result = await tool.execute({
      action: 'create',
      message: 'Recordatorios de prueba',
      delay_minutes: 5,
      __context: { channel: 'telegram', userId: '1155903655', chat_id: 12345 },
    });

    expect(result.success).toBe(true);

    const jobs: Job[] = (await (tool as any).loadAllJobs()) as Job[];
    const created = jobs.find(j => j.message === 'Recordatorios de prueba');
    expect(created).toBeDefined();
    expect(created!.created_by.channel).toBe('telegram');
    expect(created!.created_by.user_id).toBe('1155903655');
    expect(created!.created_by.chat_id).toBe(12345);
  });

  test('should default to cli when no context provided', async () => {
    await tool.execute({ action: 'create', message: 'Sin contexto', delay_minutes: 5 });

    const jobs = await (tool as any).loadAllJobs() as Job[];
    const created = jobs.find(j => j.message === 'Sin contexto');
    expect(created!.created_by.channel).toBe('cli');
    expect(created!.created_by.user_id).toBe('cli_user');
  });

  test('should list active jobs', async () => {
    await tool.execute({ action: 'create', message: 'Listar', delay_minutes: 30 });
    const result = await tool.execute({ action: 'list' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Listar');
  });

  test('should cancel a job', async () => {
    const created = await tool.execute({ action: 'create', message: 'Cancelar', delay_minutes: 10 });
    const idMatch = created.output.match(/ID: (job_\w+)/);
    expect(idMatch).not.toBeNull();

    const cancel = await tool.execute({ action: 'cancel', job_id: idMatch![1] });
    expect(cancel.success).toBe(true);

    const list = await tool.execute({ action: 'list' });
    expect(list.output).not.toContain('Cancelar');
  });

  test('should deliver one-time jobs to the originating channel', async () => {
    const result = await tool.execute({
      action: 'create',
      message: 'Entrega',
      delay_minutes: 5,
      __context: { channel: 'telegram', userId: '1155903655', chat_id: 777 },
    });
    expect(result.success).toBe(true);

    const jobs = await (tool as any).loadAllJobs() as Job[];
    const job = jobs.find((j: Job) => j.message === 'Entrega');
    expect(job).toBeDefined();

    job!.next_fire = new Date(Date.now() - 1000).toISOString();

    const sent: Array<[string, string, string, any]> = [];
    const channelManager = {
      sendMessage: async (ch: string, userId: string, message: string, metadata?: any) => {
        sent.push([ch, userId, message, metadata]);
      },
    };

    await (tool as any).fireDueJobs(channelManager);

    expect(sent.length).toBe(1);
    expect(sent[0][0]).toBe('telegram');
    expect(sent[0][1]).toBe('1155903655');
    expect(sent[0][3]).toEqual({ chat_id: 777 });
  });

  test('should persist agent mode on create and update', async () => {
    const created = await tool.execute({
      action: 'create',
      message: 'Digest',
      cron_hour: 7,
      cron_minute: 30,
      mode: 'agent',
      __context: { channel: 'telegram', userId: 'u1' },
    });
    expect(created.success).toBe(true);

    let jobs = await (tool as any).loadAllJobs() as Job[];
    let job = jobs.find((j: Job) => j.message === 'Digest');
    expect(job!.mode).toBe('agent');

    const idMatch = created.output.match(/ID: (job_\w+)/);
    await tool.execute({ action: 'update', job_id: idMatch![1], mode: 'reminder' });
    jobs = await (tool as any).loadAllJobs() as Job[];
    job = jobs.find((j: Job) => j.message === 'Digest');
    expect(job!.mode).toBe('reminder');
  });

  test('should default mode to reminder when not specified', async () => {
    await tool.execute({ action: 'create', message: 'Plain', delay_minutes: 5 });
    const jobs = await (tool as any).loadAllJobs() as Job[];
    expect(jobs.find((j: Job) => j.message === 'Plain')!.mode).toBe('reminder');
  });

  test('should route agent-mode jobs through onJobFire instead of sendMessage', async () => {
    await tool.execute({
      action: 'create',
      message: 'Run the System Check skill',
      delay_minutes: 5,
      mode: 'agent',
      __context: { channel: 'telegram', userId: 'u1', chat_id: 999 },
    });

    const jobs = await (tool as any).loadAllJobs() as Job[];
    const job = jobs.find((j: Job) => j.message === 'Run the System Check skill');
    job!.next_fire = new Date(Date.now() - 1000).toISOString();

    const channelManager = { sendMessage: jest.fn() };
    const onJobFire = jest.fn();

    await tool.fireDueJobs(channelManager, onJobFire);

    expect(onJobFire).toHaveBeenCalledTimes(1);
    expect(onJobFire.mock.calls[0][0]).toMatchObject({ mode: 'agent', message: 'Run the System Check skill' });
    expect(channelManager.sendMessage).not.toHaveBeenCalled();
  });

  test('should fall back to reminder delivery when agent job has no onJobFire handler', async () => {
    await tool.execute({
      action: 'create',
      message: 'Orphan agent job',
      delay_minutes: 5,
      mode: 'agent',
      __context: { channel: 'telegram', userId: 'u1', chat_id: 1 },
    });

    const jobs = await (tool as any).loadAllJobs() as Job[];
    const job = jobs.find((j: Job) => j.message === 'Orphan agent job');
    job!.next_fire = new Date(Date.now() - 1000).toISOString();

    const sent: string[] = [];
    const channelManager = {
      sendMessage: async (_ch: string, _userId: string, message: string) => {
        sent.push(message);
      },
    };

    await tool.fireDueJobs(channelManager);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Orphan agent job');
  });

  test('should advance schedule before firing an agent job to avoid double fire', async () => {
    await tool.execute({
      action: 'create',
      message: 'Once agent',
      delay_minutes: 5,
      mode: 'agent',
      __context: { channel: 'telegram', userId: 'u1' },
    });

    const jobs = await (tool as any).loadAllJobs() as Job[];
    const job = jobs.find((j: Job) => j.message === 'Once agent');
    job!.next_fire = new Date(Date.now() - 1000).toISOString();

    let duringCallback = false;
    const channelManager = { sendMessage: jest.fn() };
    const onJobFire = jest.fn(async () => {
      duringCallback = true;
      const remaining = await (tool as any).loadAllJobs() as Job[];
      expect(remaining.find((j: Job) => j.message === 'Once agent')).toBeUndefined();
    });

    await tool.fireDueJobs(channelManager, onJobFire);

    expect(onJobFire).toHaveBeenCalledTimes(1);
    expect(duringCallback).toBe(true);
  });
});
