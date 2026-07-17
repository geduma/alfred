import { Tool } from './llm';

export interface ToolExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
  duration_ms?: number;
}

export interface ToolHandler {
  tool: Tool;
  execute(params: Record<string, unknown>): Promise<ToolExecutionResult>;
  validate?(params: Record<string, unknown>): { success: boolean; errors?: string[] };
}
