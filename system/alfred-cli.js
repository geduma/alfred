#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const configPath = process.env.CONFIG_PATH || '/workspace/config/alfred.json';
const wsPort = 18789;

function loadToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return raw.security?.gateway_auth_token || null;
  } catch {
    return null;
  }
}

async function main() {
  const token = loadToken();
  if (!token) {
    console.error('❌ Could not read gateway_auth_token from', configPath);
    process.exit(1);
  }

  let WebSocket;
  try {
    WebSocket = require('ws');
  } catch {
    console.error('❌ "ws" module not found. Run this script from within the Alfred container.');
    process.exit(1);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'req',
      id: 'cli_connect',
      method: 'connect',
      params: { clientId: 'alfred-cli', auth: { token } },
    }));

    console.log('\n╔═══════════════════════════════════════════╗');
    console.log('║     Alfred CLI — Interactive Chat         ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log(' Type "exit" or Ctrl+C to quit.\n');
    prompt();
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'event' && msg.event === 'agent_complete') {
        console.log(`\n🤖 ${msg.payload.content}\n`);
        prompt();
      } else if (msg.type === 'error') {
        console.error(`\n❌ Error: ${msg.message}\n`);
        prompt();
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on('close', () => {
    console.log('\n👋 Disconnected from Alfred.');
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error(`\n❌ Connection error: ${err.message}`);
    console.error(`   Make sure Alfred is running on ws://127.0.0.1:${wsPort}`);
    process.exit(1);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  function prompt() {
    rl.question('🧐 ', (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }
      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('\n👋 Goodbye.\n');
        ws.close();
        rl.close();
        return;
      }

      ws.send(JSON.stringify({
        type: 'req',
        id: `cli_${Date.now()}`,
        method: 'agent',
        params: { message: trimmed, sessionId: 'cli_session' },
      }));
    });
  }

  rl.on('close', () => {
    ws.close();
    process.exit(0);
  });
}

main();
