import { ToolHandler } from '../types/tool';
import { getLogger } from '../utils/logger';
import { SubTask } from './task-decomposer';

interface ToolExecution {
  task: SubTask;
  result?: { success: boolean; output: string; error?: string };
}

const MAX_RETRIES = 2;

export class ToolOrchestrator {
  private tools: Map<string, ToolHandler> = new Map();

  setTools(toolList: ToolHandler[]): void {
    this.tools.clear();
    for (const t of toolList) {
      this.tools.set(t.tool.name, t);
    }
  }

  getToolNames(): string[] {
    return [...this.tools.keys()];
  }

  async executePlan(tasks: SubTask[], parallelGroups: string[][]): Promise<{
    results: Map<string, ToolExecution>;
    allSucceeded: boolean;
  }> {
    const results = new Map<string, ToolExecution>();
    let allSucceeded = true;

    for (const group of parallelGroups) {
      const executions = group.map(taskId => {
        const task = tasks.find(t => t.id === taskId);
        if (!task) return null;
        const deps = task.dependsOn.map(d => results.get(d));
        const failedDep = deps.find(d => d && !d.result?.success);
        if (failedDep) {
          task.status = 'failed';
          task.error = `Dependency ${failedDep.task.id} failed`;
          results.set(task.id, { task, result: { success: false, output: '', error: task.error } });
          allSucceeded = false;
          return null;
        }
        return this.executeWithRetry(task);
      }).filter(Boolean) as Promise<ToolExecution>[];

      const groupResults = await Promise.allSettled(executions);
      for (const gr of groupResults) {
        if (gr.status === 'fulfilled') {
          results.set(gr.value.task.id, gr.value);
          if (!gr.value.result?.success) allSucceeded = false;
        }
      }
    }

    return { results, allSucceeded };
  }

  private async executeWithRetry(task: SubTask, attempt = 0): Promise<ToolExecution> {
    task.status = 'running';

    const tool = this.tools.get(task.tool);
    if (!tool) {
      task.status = 'failed';
      task.error = `Tool "${task.tool}" not available`;
      return { task, result: { success: false, output: '', error: task.error } };
    }

    try {
      if (tool.validate) {
        const validation = tool.validate(task.params);
        if (!validation.success) {
          task.status = 'failed';
          task.error = `Validation: ${(validation.errors || []).join(', ')}`;
          return { task, result: { success: false, output: '', error: task.error } };
        }
      }

      const result = await tool.execute(task.params);
      task.status = result.success ? 'completed' : 'failed';
      task.result = result.output;
      if (!result.success) task.error = result.error;

      if (!result.success && attempt < MAX_RETRIES) {
        getLogger().info({ task: task.id, attempt, error: result.error }, 'Retrying task');
        return this.executeWithRetry(task, attempt + 1);
      }

      return { task, result };
    } catch (error: any) {
      if (attempt < MAX_RETRIES) {
        getLogger().info({ task: task.id, attempt, error: error.message }, 'Retrying task after exception');
        return this.executeWithRetry(task, attempt + 1);
      }

      task.status = 'failed';
      task.error = error.message;
      return { task, result: { success: false, output: '', error: error.message } };
    }
  }
}