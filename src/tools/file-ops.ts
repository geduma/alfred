import fs from 'fs';
import path from 'path';
import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { getLogger } from '../utils/logger';

interface PathRule {
  path: string;
  permissions: 'r' | 'rw';
}

const DEFAULT_RULES: PathRule[] = [
  { path: '/workspace/files', permissions: 'rw' },
  { path: '/workspace/memory', permissions: 'rw' },
  { path: '/workspace/skills', permissions: 'rw' },
  { path: '/workspace/config', permissions: 'r' },
];

export class FileOpsTool implements ToolHandler {
  private rules: PathRule[];
  private maxFileSize: number;

  tool: Tool = {
    name: 'file_ops',
    description: 'Read/write/edit/list files in the workspace with permission control',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write', 'edit', 'delete', 'list'] },
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['action', 'path'],
    },
  };

  constructor(config?: { allowed_paths?: PathRule[]; max_file_size_mb?: number }) {
    this.rules = config?.allowed_paths || DEFAULT_RULES;
    this.maxFileSize = (config?.max_file_size_mb || 100) * 1024 * 1024;
  }

  async execute(params: Record<string, unknown>): Promise<ToolExecutionResult> {
    const action = params.action as string;
    const filePath = params.path as string;
    const content = params.content as string | undefined;

    if (!action || !filePath) {
      return { success: false, output: '', error: 'action and path are required' };
    }

    const needsWrite = ['write', 'edit', 'delete'].includes(action);
    const safePath = this.resolveSafePath(filePath, needsWrite);
    if (!safePath) {
      return {
        success: false,
        output: '',
        error: needsWrite
          ? 'Access denied: you do not have write permission for this path'
          : 'Access denied: path is not accessible',
      };
    }

    try {
      switch (action) {
        case 'read':
          return this.readFile(safePath);
        case 'write':
          return this.writeFile(safePath, content);
        case 'edit':
          return this.editFile(safePath, content);
        case 'delete':
          return this.deleteFile(safePath);
        case 'list':
          return this.listFiles(safePath);
        default:
          return { success: false, output: '', error: `Unknown action: ${action}` };
      }
    } catch (error: any) {
      return { success: false, output: '', error: error.message };
    }
  }

  private resolveSafePath(filePath: string, needsWrite: boolean): string | null {
    const resolved = path.resolve(filePath);
    let realPath: string;
    try {
      realPath = fs.realpathSync(resolved);
    } catch {
      realPath = resolved;
    }
    const matchingRule = this.rules.find(rule => realPath.startsWith(rule.path));

    if (!matchingRule) {
      return null;
    }

    if (needsWrite && matchingRule.permissions === 'r') {
      return null;
    }

    return resolved;
  }

  private readFile(filePath: string): ToolExecutionResult {
    if (!fs.existsSync(filePath)) {
      return { success: false, output: '', error: 'File not found' };
    }

    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      return this.listFiles(filePath);
    }

    if (stats.size > this.maxFileSize) {
      return { success: false, output: '', error: 'File exceeds maximum size' };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, output: this.filterSecrets(filePath, content) };
  }

  private writeFile(filePath: string, content?: string): ToolExecutionResult {
    if (content === undefined) {
      return { success: false, output: '', error: 'content is required for write' };
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, output: `File written: ${filePath}` };
  }

  private editFile(filePath: string, content?: string): ToolExecutionResult {
    if (content === undefined) {
      return { success: false, output: '', error: 'content is required for edit' };
    }

    if (!fs.existsSync(filePath)) {
      return { success: false, output: '', error: 'File not found' };
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, output: `File edited: ${filePath}` };
  }

  private deleteFile(filePath: string): ToolExecutionResult {
    if (!fs.existsSync(filePath)) {
      return { success: false, output: '', error: 'File not found' };
    }

    fs.unlinkSync(filePath);
    return { success: true, output: `File deleted: ${filePath}` };
  }

  private filterSecrets(filePath: string, content: string): string {
    const fileName = path.basename(filePath);
    if (fileName !== 'alfred.json' && !fileName.endsWith('.env')) return content;

    getLogger().debug({ file: fileName }, 'Filtering secrets from file output');
    return content
      .replace(/"api_key"\s*:\s*"[^"]+"/g, '"api_key": "***"')
      .replace(/"bot_token"\s*:\s*"[^"]+"/g, '"bot_token": "***"')
      .replace(/"auth_token"\s*:\s*"[^"]+"/g, '"auth_token": "***"')
      .replace(/"password"\s*:\s*"[^"]+"/g, '"password": "***"')
      .replace(/"token"\s*:\s*"[^"]+"/g, '"token": "***"')
      .replace(/^.*_KEY=.*$/gm, (m) => m.replace(/=.*/, '=***'))
      .replace(/^.*_TOKEN=.*$/gm, (m) => m.replace(/=.*/, '=***'))
      .replace(/^.*_SECRET=.*$/gm, (m) => m.replace(/=.*/, '=***'))
      .replace(/^.*PASSWORD=.*$/gm, (m) => m.replace(/=.*/, '=***'));
  }

  private listFiles(filePath: string): ToolExecutionResult {
    if (!fs.existsSync(filePath)) {
      return { success: false, output: '', error: 'Path not found' };
    }

    const stats = fs.statSync(filePath);
    if (!stats.isDirectory()) {
      return { success: true, output: `File: ${filePath}` };
    }

    const entries = fs.readdirSync(filePath, { withFileTypes: true });
    const listing = entries.map(e => {
      const type = e.isDirectory() ? 'dir' : 'file';
      return `  ${type}\t${e.name}`;
    }).join('\n');

    return { success: true, output: `Contents of ${filePath}:\n${listing}` };
  }
}
