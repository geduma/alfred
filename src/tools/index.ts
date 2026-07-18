import { ToolHandler } from '../types/tool';
import { ConfigLoader } from '../config/loader';
import { ExecTool } from './exec';
import { FileOpsTool } from './file-ops';
import { WebTool } from './web';
import { JobSchedulerTool } from './job-scheduler';
import { SystemTool } from './system';
import { HealthTool } from './health';
import { MemoryTool } from './memory';
import { HealthMonitor } from '../services/health-monitor';
import { VectorStoreManager } from '../services/vector-store/index';
import { SnapshotManager } from '../services/snapshot';

export function createTools(
  config: ConfigLoader,
  healthMonitor?: HealthMonitor,
  vectorStore?: VectorStoreManager | null,
  snapshotManager?: SnapshotManager | null,
): ToolHandler[] {
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

  if (enabledTools.includes('job')) {
    tools.push(new JobSchedulerTool());
  }

  if (enabledTools.includes('system')) {
    tools.push(new SystemTool(config));
  }

  if (enabledTools.includes('health') && healthMonitor) {
    tools.push(new HealthTool(healthMonitor));
  }

  if (vectorStore || snapshotManager) {
    tools.push(new MemoryTool(vectorStore || null, snapshotManager || null));
  }

  return tools;
}
