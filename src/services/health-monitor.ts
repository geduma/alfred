import fs from 'fs';
import path from 'path';
import { getLogger } from '../utils/logger';
import { NotificationService } from './notification';
import { HealthMonitorConfig, HealthFinding } from '../types/notification';

const STATE_FILE = path.resolve(__dirname, '../../workspace/memory/health-monitor-state.json');

interface ScanState {
  last_scan_bytes: number;
  last_scan_time: string;
}

export class HealthMonitor {
  private config: HealthMonitorConfig;
  private notifier: NotificationService;
  private logPath: string;
  private state: ScanState;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: HealthMonitorConfig, notifier: NotificationService, logPath: string) {
    this.config = config;
    this.notifier = notifier;
    this.logPath = logPath;
    this.state = this.loadState();
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.config.check_interval_minutes * 60 * 1000;
    this.timer = setInterval(() => this.check(), intervalMs);
    getLogger().info(
      { intervalMinutes: this.config.check_interval_minutes, severity: this.config.severity_threshold },
      'Health monitor started'
    );
    this.check();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<void> {
    try {
      const findings = this.scan();
      if (findings.length > 0) {
        const summary = this.buildSummary(findings);
        await this.notifier.sendAlert(
          `${findings.length} health issue(s) detected`,
          summary,
          findings.some(f => f.severity === 'error') ? 'error' : 'warn'
        );
      }
    } catch (error: any) {
      getLogger().warn({ error: error.message }, 'Health monitor check failed');
    }
  }

  scan(): HealthFinding[] {
    if (!fs.existsSync(this.logPath)) return [];

    const stats = fs.statSync(this.logPath);
    const fileSize = stats.size;
    const startByte = Math.min(this.state.last_scan_bytes, fileSize);

    if (startByte >= fileSize) return [];

    const fd = fs.openSync(this.logPath, 'r');
    const buffer = Buffer.alloc(fileSize - startByte);
    fs.readSync(fd, buffer, 0, buffer.length, startByte);
    fs.closeSync(fd);

    this.state.last_scan_bytes = fileSize;
    this.state.last_scan_time = new Date().toISOString();
    this.saveState();

    const lines = buffer.toString('utf-8').split('\n').filter(Boolean);
    const findingsMap = new Map<string, HealthFinding>();
    const threshold = this.config.severity_threshold === 'error' ? 50 : 40;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if ((entry.level as number) < threshold) continue;
        if (!entry.msg) continue;

        const category = this.categorize(entry.msg);
        const severity = (entry.level as number) >= 50 ? 'error' : 'warn';
        const key = `${severity}:${category}`;
        const errMsg = entry.error?.message || entry.error || '';
        const time = entry.time ? new Date(entry.time as number).toISOString() : new Date().toISOString();

        if (!findingsMap.has(key)) {
          findingsMap.set(key, {
            severity,
            category,
            message: entry.msg as string,
            count: 0,
            first_seen: time,
            last_seen: time,
            sample: errMsg ? `${entry.msg}: ${errMsg}` : (entry.msg as string),
          });
        }

        const f = findingsMap.get(key)!;
        f.count++;
        f.last_seen = time;

        if (errMsg && f.sample.length < 200) {
          f.sample = `${entry.msg}: ${errMsg}`;
        }
      } catch {
        // skip unparseable lines
      }
    }

    return Array.from(findingsMap.values());
  }

  getFindings(): HealthFinding[] {
    return this.scan();
  }

  private categorize(msg: string): string {
    const lower = msg.toLowerCase();
    if (lower.includes('vector store') || lower.includes('embedding') || lower.includes('embedder')) return 'vector_store';
    if (lower.includes('provider') || lower.includes('llm') || lower.includes('anthropic') || lower.includes('openai')) return 'llm_provider';
    if (lower.includes('telegram')) return 'telegram';
    if (lower.includes('database') || lower.includes('sqlite') || lower.includes('db')) return 'database';
    if (lower.includes('tool') || lower.includes('exec')) return 'tool_execution';
    if (lower.includes('session')) return 'session';
    if (lower.includes('snapshot')) return 'snapshot';
    if (lower.includes('job')) return 'job_scheduler';
    return 'other';
  }

  private buildSummary(findings: HealthFinding[]): string {
    const parts = findings.map(f =>
      `[${f.severity.toUpperCase()}] ${f.category}: ${f.message} (${f.count}x, last: ${f.last_seen})\n  Sample: ${f.sample}`
    );
    return parts.join('\n\n');
  }

  private loadState(): ScanState {
    try {
      if (fs.existsSync(STATE_FILE)) {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      }
    } catch {
      // ignore
    }
    return { last_scan_bytes: 0, last_scan_time: new Date().toISOString() };
  }

  private saveState(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }
}
