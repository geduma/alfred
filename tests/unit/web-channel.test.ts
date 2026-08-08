import { WebChannel } from '../../src/channels/web';
import { WebSocket } from 'ws';

function fakeSocket(): any {
  return { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() };
}

describe('WebChannel', () => {
  test('should start with no clients', () => {
    const channel = new WebChannel();
    expect(channel.clientCount).toBe(0);
  });

  test('should track connected clients', () => {
    const channel = new WebChannel();
    const ws1 = fakeSocket();
    const ws2 = fakeSocket();
    channel.addClient(ws1);
    channel.addClient(ws2);
    expect(channel.clientCount).toBe(2);

    channel.removeClient(ws1);
    expect(channel.clientCount).toBe(1);
  });

  test('should broadcast messages to all open clients', async () => {
    const channel = new WebChannel();
    const ws1 = fakeSocket();
    const ws2 = fakeSocket();
    channel.addClient(ws1);
    channel.addClient(ws2);

    await channel.sendMessage('web-user', 'hola desde alfred', { event: 'digest' });

    const expected = JSON.stringify({
      type: 'notify',
      event: 'message',
      payload: { userId: 'web-user', message: 'hola desde alfred', event: 'digest' },
    });
    expect(ws1.send).toHaveBeenCalledWith(expected);
    expect(ws2.send).toHaveBeenCalledWith(expected);
  });

  test('should not broadcast when there are no clients', async () => {
    const channel = new WebChannel();
    await channel.sendMessage('web-user', 'hola');
    // no throw expected
  });

  test('should skip closed sockets', async () => {
    const channel = new WebChannel();
    const open = fakeSocket();
    const closed = fakeSocket();
    closed.readyState = WebSocket.CLOSED;
    channel.addClient(open);
    channel.addClient(closed);

    await channel.sendMessage('web-user', 'mensaje');

    expect(open.send).toHaveBeenCalledTimes(1);
    expect(closed.send).not.toHaveBeenCalled();
  });

  test('stop should close all clients and clear the set', async () => {
    const channel = new WebChannel();
    const ws1 = fakeSocket();
    channel.addClient(ws1);

    await channel.stop();
    expect(ws1.close).toHaveBeenCalled();
    expect(channel.clientCount).toBe(0);
  });
});
