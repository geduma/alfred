import { ToolHandler } from '../types/tool';
import { ConfigLoader } from '../config/loader';
import { ExecTool } from './exec';
import { FileOpsTool } from './file-ops';
import { WebTool } from './web';
import { JobSchedulerTool } from './job-scheduler';
import { Gateway } from '../gateway';

export function createTools(config: ConfigLoader, gateway?: Gateway): ToolHandler[] {
  const tools: ToolHandler[] = [];
  const enabledTools = config.enabledTools;

  if (enabledTools.includes('exec')) {
    tools.push(new ExecTool(config.allConfig.tools.exec?.config as any));
  }

  if (enabledTools.includes('file_ops')) {
    tools.push(new FileOpsTool(config.allConfig.tools.file_ops?.config as any));
  }

  if (enabledTools.includes('web')) {
    tools.push(new WebTool(config.allConfig.tools.web?.config as any));
  }

  if (enabledTools.includes('job') && gateway) {
    tools.push(new JobSchedulerTool());
  }

  return tools;
}
