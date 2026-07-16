import { ToolHandler } from '../types/tool';
import { ConfigLoader } from '../config/loader';
import { ExecTool } from './exec';
import { FileOpsTool } from './file-ops';
import { WebSearchTool } from './web-search';
import { WebFetchTool } from './web-fetch';

export function createTools(config: ConfigLoader): ToolHandler[] {
  const tools: ToolHandler[] = [];
  const enabledTools = config.enabledTools;

  if (enabledTools.includes('exec')) {
    tools.push(new ExecTool(config.allConfig.tools.exec?.config as any));
  }

  if (enabledTools.includes('file_ops')) {
    tools.push(new FileOpsTool(config.allConfig.tools.file_ops?.config as any));
  }

  if (enabledTools.includes('web_search')) {
    tools.push(new WebSearchTool(config.allConfig.tools.web_search?.config as any));
  }

  if (enabledTools.includes('web_fetch')) {
    tools.push(new WebFetchTool(config.allConfig.tools.web_fetch?.config as any));
  }

  return tools;
}
