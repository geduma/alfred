import fs from 'fs';
import path from 'path';
import { ToolHandler, ToolExecutionResult } from '../types/tool';
import { Tool } from '../types/llm';
import { getLogger } from '../utils/logger';
import { resolvePath, resolveInWorkspace } from '../utils/workspace';

interface PathRule {
  path: string;
  realPath: string;
  permissions: 'r' | 'rw';
}

const DEFAULT_RULES: PathRule[] = [
  { path: resolveInWorkspace('files'), permissions: 'rw' },
  { path: resolveInWorkspace('memory'), permissions: 'rw' },
  { path: resolveInWorkspace('skills'), permissions: 'rw' },
  { path: resolveInWorkspace('config'), permissions: 'r' },
];

function realpathPrefix(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const dir = path.dirname(p);
    if (dir === p) return p;
    return path.join(realpathPrefix(dir), path.basename(p));
  }
}

function isWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(base + path.sep);
}

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

  constructor(config?: { allowed_paths?: PathRule[]; max_file_size_mb?: number; base_directory?: string }) {
    this.rules = [...DEFAULT_RULES];
    if (config?.allowed_paths) {
      this.rules.push(...config.allowed_paths);
    }
    if (config?.base_directory) {
      this.rules.push({ path: resolvePath(config.base_directory), permissions: 'rw' });
    }
    this.rules = this.rules.map((rule) => ({
      path: rule.path,
      realPath: realpathPrefix(rule.path),
      permissions: rule.permissions,
    }));
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
    // Anchor relative paths to the workspace root first, but also accept
    // paths that were already resolved against the process CWD (e.g. an
    // agent passing "workspace/files/x" from a repo-style checkout).
    const candidates = [...new Set([resolvePath(filePath), path.resolve(filePath)])];

    for (const normalizedPath of candidates) {
      const candidateReal = realpathPrefix(normalizedPath);
      const matchingRule = this.rules.find(rule => isWithin(rule.realPath, candidateReal));
      if (!matchingRule) continue;
      if (needsWrite && matchingRule.permissions === 'r') continue;

      return normalizedPath;
    }

    return null;
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

  private filterSecrets(_filePath: string, content: string): string {
    const fileName = path.basename(_filePath);
    const isConfigFile = fileName === 'alfred.json' || fileName.endsWith('.env');

    if (isConfigFile) {
      getLogger().debug({ file: fileName }, 'Filtering secrets from config file output');
    }
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
