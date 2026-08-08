import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { HealthMonitor } from '../services/health-monitor';
import { TokenBudgetTracker } from '../services/token-budget';
import { LLMRouter } from '../agent/llm-router';

export class HealthTool implements ToolHandler {
  tool: Tool = {
    name: 'health',
    description: 'Query consolidated system status, view recent health findings, trigger an immediate health check, or view token budget usage',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'findings', 'check', 'budget', 'configure'] },
        severity_threshold: { type: 'string', enum: ['warn', 'error'], description: 'Filter findings by severity' },
        category: { type: 'string', description: 'Filter findings by category' },
      },
      required: ['action'],
    },
  };

  private monitor: HealthMonitor;
  private budgetTracker: TokenBudgetTracker | null;
  private router: LLMRouter | null;

  constructor(monitor: HealthMonitor, budgetTracker?: TokenBudgetTracker | null, router?: LLMRouter | null) {
    this.monitor = monitor;
    this.budgetTracker = budgetTracker || null;
    this.router = router || null;
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
      case 'budget':
        return this.budget();
      case 'configure':
        return { success: true, output: 'Configure the health monitor via alfred.json → health_monitor section' };
      default:
        return { success: false, output: '', error: `Unknown health action: ${action}` };
    }
  }

  private async status(): Promise<ToolExecutionResult> {
    const lines: string[] = ['Consolidated status:'];
    lines.push(`- Health monitor: running`);

    const findings = await this.monitor.getFindings();
    const errors = findings.filter(f => f.severity === 'error');
    lines.push(`- Health findings: ${findings.length} total, ${errors.length} errors`);

    if (this.budgetTracker) {
      const budget = await this.budgetTracker.checkBudget();
      const usage = await this.budgetTracker.getTokenUsage();
      lines.push(
        `- Token budget: ${budget.allowed ? 'within limits' : `EXCEEDED (${budget.reason})`} | today: ${usage.today.toLocaleString()}, this month: ${usage.thisMonth.toLocaleString()} | remaining: ${Math.round(budget.remainingPercent)}%`
      );
    } else {
      lines.push('- Token budget: not configured (no spending_limits section)');
    }

    if (this.router) {
      const states = this.router.getCircuitStates();
      if (states.length > 0) {
        lines.push(`- Providers: ${states.map(s => `${s.provider}:${s.open ? 'OPEN' : 'ok'}`).join(', ')}`);
      }
    }

    return { success: true, output: lines.join('\n') };
  }

  private async budget(): Promise<ToolExecutionResult> {
    if (!this.budgetTracker) {
      return { success: true, output: 'Token budget tracking is not enabled. Add a "spending_limits" section to alfred.json to enable it.' };
    }

    const budget = await this.budgetTracker.checkBudget();
    const usage = await this.budgetTracker.getTokenUsage();
    const lines: string[] = ['Token budget status:'];

    lines.push(`- Allowed: ${budget.allowed ? 'yes' : `no (${budget.reason})`}`);
    lines.push(`- Today: ${usage.today.toLocaleString()} tokens`);
    lines.push(`- This month: ${usage.thisMonth.toLocaleString()} tokens`);
    lines.push(`- Remaining: ${Math.round(budget.remainingPercent)}% (daily ${Math.round(budget.dailyRemainingPercent)}% / monthly ${Math.round(budget.monthlyRemainingPercent)}%)`);

    const providers = Object.entries(usage.byProvider);
    if (providers.length > 0) {
      lines.push(`- By provider: ${providers.map(([name, p]) => `${name}: ${p.tokens.toLocaleString()}`).join(', ')}`);
    }

    return { success: true, output: lines.join('\n') };
  }

  private async findings(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const findings = await this.monitor.getFindings();
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
