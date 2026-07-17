import { LLMRouter } from '../agent/llm-router';
import { getLogger } from '../utils/logger';

export interface SubTask {
  id: string;
  description: string;
  tool: string;
  params: Record<string, unknown>;
  dependsOn: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
}

export interface DecompositionResult {
  goal: string;
  tasks: SubTask[];
  parallelGroups: string[][];
}

const DECOMPOSITION_PROMPT = `You are a task decomposition engine. Analyze the user's request and break it into parallelizable subtasks that can be executed using available tools.

Available tools: {tools}

For each subtask, specify:
1. A unique ID (task_1, task_2, etc.)
2. Description of what to do
3. Which tool to use
4. Parameters for the tool
5. Dependencies (IDs of tasks that must complete first)

Group independent tasks together for parallel execution.

Respond in this JSON format:
{
  "goal": "concise description of the overall goal",
  "tasks": [
    {
      "id": "task_1",
      "description": "...",
      "tool": "tool_name",
      "params": { "key": "value" },
      "dependsOn": []
    }
  ],
  "parallelGroups": [["task_1", "task_2"], ["task_3"]]
}`;

export class TaskDecomposer {
  private llmRouter: LLMRouter | null = null;

  setLlmRouter(router: LLMRouter): void {
    this.llmRouter = router;
  }

  async decompose(userRequest: string, toolNames: string[]): Promise<DecompositionResult> {
    const prompt = DECOMPOSITION_PROMPT.replace('{tools}', toolNames.join(', '));

    if (this.llmRouter) {
      try {
        const response = await this.llmRouter.call({
          messages: [
            { role: 'user', content: `Decompose this request into subtasks:\n\n${userRequest}` },
          ],
          system: prompt,
          max_tokens: 4096,
        });
        const parsed = JSON.parse(response.content);
        return {
          goal: parsed.goal || userRequest,
          tasks: parsed.tasks || [],
          parallelGroups: parsed.parallelGroups || [],
        };
      } catch (error: any) {
        getLogger().warn({ error: error.message }, 'Task decomposition failed, using single task');
      }
    }

    return {
      goal: userRequest,
      tasks: [{
        id: 'task_1',
        description: userRequest,
        tool: 'none',
        params: {},
        dependsOn: [],
        status: 'pending',
      }],
      parallelGroups: [['task_1']],
    };
  }
}