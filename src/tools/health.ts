import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { HealthMonitor } from '../services/health-monitor';

export class HealthTool implements ToolHandler {
  tool: Tool = {
    name: 'health',
    description: 'Query health monitor status, view recent findings, or trigger an immediate check',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'findings', 'check', 'configure'] },
        severity_threshold: { type: 'string', enum: ['warn', 'error'], description: 'Filter findings by severity' },
        category: { type: 'string', description: 'Filter findings by category' },
      },
      required: ['action'],
    },
  };

  private monitor: HealthMonitor;

  constructor(monitor: HealthMonitor) {
    this.monitor = monitor;
  }

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'status':
        return this.status();
      case 'findings':
        return this.findings(params);
      case 'check':
        return this.runCheck();
      case 'configure':
        return { success: true, output: 'Configure the health monitor via alfred.json → health_monitor section' };
      default:
        return { success: false, output: '', error: `Unknown health action: ${action}` };
    }
  }

  private status(): ToolExecutionResult {
    return {
      success: true,
      output: 'Health monitor is running. Use "health findings" to view recent issues.',
    };
  }

  private findings(params: Record<string, unknown>): ToolExecutionResult {
    const findings = this.monitor.getFindings();
    if (findings.length === 0) {
      return { success: true, output: 'No health issues found in recent logs.' };
    }

    let filtered = findings;
    const severity = params.severity_threshold as string | undefined;
    if (severity) {
      filtered = filtered.filter(f => f.severity === severity);
    }
    const category = params.category as string | undefined;
    if (category) {
      filtered = filtered.filter(f => f.category === category);
    }

    if (filtered.length === 0) {
      return { success: true, output: 'No matching findings.' };
    }

    const lines = filtered.map(f =>
      `[${f.severity.toUpperCase()}] ${f.category} — ${f.message}\n  Count: ${f.count} | First: ${f.first_seen} | Last: ${f.last_seen}\n  Sample: ${f.sample}`
    );

    return { success: true, output: `Health findings (${filtered.length}):\n\n${lines.join('\n\n')}` };
  }

  private async runCheck(): Promise<ToolExecutionResult> {
    await this.monitor.check();
    return { success: true, output: 'Health check triggered. Run "health findings" to see results.' };
  }
}
