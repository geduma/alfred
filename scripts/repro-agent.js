#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CONFIG_PATH = process.env.ALFRED_CONFIG || path.resolve(process.cwd(), 'workspace/config/alfred.json');
const HOST = process.env.ALFRED_HOST || 'localhost';
const PORT = process.env.ALFRED_PORT || '18789';
const MESSAGE = process.env.ALFRED_MESSAGE || 'Run the Daily Digest skill';
const SESSION = process.env.ALFRED_SESSION || 'telegram_1155903655_jobs';
const TIMEOUT_MS = parseInt(process.env.ALFRED_TIMEOUT_MS || '60000', 10);

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  const token = raw.security && raw.security.gateway_auth_token;
  if (!token) {
    console.error(`No gateway_auth_token found in ${CONFIG_PATH}`);
    process.exit(2);
  }
  return { token, config: raw };
}

const { token } = loadConfig();
const url = `ws://${HOST}:${PORT}`;
const ws = new WebSocket(url);

const timer = setTimeout(() => {
  console.error(`Timed out after ${TIMEOUT_MS}ms waiting for agent_complete`);
  ws.close();
  process.exit(3);
}, TIMEOUT_MS);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'req', id: 'connect', method: 'connect', params: { auth: { token } } }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  if (msg.type === 'error') {
    console.error('Gateway error:', msg.message);
    clearTimeout(timer);
    ws.close();
    process.exit(4);
  }

  if (msg.type === 'res' && msg.id === 'connect') {
    console.log(`Connected to ${url}`);
    ws.send(JSON.stringify({
      type: 'req',
      id: 'agent',
      method: 'agent',
      params: { message: MESSAGE, sessionId: SESSION },
    }));
    return;
  }

  if (msg.type === 'event' && msg.event === 'agent_complete') {
    clearTimeout(timer);
    const payload = msg.payload;
    console.log('\n=== RUN COMPLETE ===');
    console.log(`runId: ${payload.runId}`);
    console.log(`degraded: ${payload.degraded === true}`);
    console.log('\n--- content ---');
    console.log(payload.content);
    if (payload.toolCalls && payload.toolCalls.length) {
      console.log('\n--- tool calls ---');
      for (const tc of payload.toolCalls) {
        console.log(`- ${tc.function.name} ${tc.function.arguments}`);
      }
    }
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  clearTimeout(timer);
  process.exit(1);
});
