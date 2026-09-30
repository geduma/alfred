import { getLogger } from '../utils/logger';
import { rotateWebToken, showWebToken } from '../security/web-token';

export interface DirectCommandContext {
  configPath: string;
  reload: () => Promise<void>;
}

export type DirectCommandHandler = (args: string) => Promise<string>;

let context: DirectCommandContext | null = null;

export function setDirectCommandContext(ctx: DirectCommandContext): void {
  context = ctx;
}

export function getDirectCommandContext(): DirectCommandContext | null {
  return context;
}

async function handleWebToken(args: string): Promise<string> {
  if (!context) throw new Error('Direct commands are not initialized');
  if (args === 'rotate') {
    const token = rotateWebToken(context.configPath);
    return `Nuevo token de acceso web: ${token}\nLas sesiones ya conectadas siguen activas; las nuevas conexiones deben usar el token nuevo.`;
  }
  return `Token de acceso web actual: ${showWebToken(context.configPath)}`;
}

async function handleReload(): Promise<string> {
  if (!context) throw new Error('Direct commands are not initialized');
  await context.reload();
  return 'Configuración recargada.';
}

const registry = new Map<string, DirectCommandHandler>([
  ['web-token', handleWebToken],
  ['reload', handleReload],
]);

export async function handleDirectCommand(input: string): Promise<string | null> {
  if (!input.startsWith('/')) return null;
  const space = input.indexOf(' ');
  const name = (space === -1 ? input.slice(1) : input.slice(1, space)).toLowerCase();
  const args = (space === -1 ? '' : input.slice(space + 1)).trim();
  const handler = registry.get(name);
  if (!handler) return null;

  getLogger().info({ category: 'direct_command', command: name }, 'Direct command executed');
  try {
    return await handler(args);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}
