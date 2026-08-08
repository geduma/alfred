import { WebSocket } from 'ws';
import { Channel } from '../types/channel';
import { getLogger } from '../utils/logger';

export class WebChannel implements Channel {
  private clients: Set<WebSocket> = new Set();

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    getLogger().info({ clientCount: this.clients.size }, 'Web client connected');
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
    getLogger().info({ clientCount: this.clients.size }, 'Web client disconnected');
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    // The gateway owns the WebSocket transport; this channel is passive.
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  async sendMessage(userId: string, message: string, metadata?: Record<string, unknown>): Promise<void> {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({
      type: 'notify',
      event: 'message',
      payload: { userId, message, ...(metadata || {}) },
    });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }
}
