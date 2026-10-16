'use strict';
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const { io } = require('socket.io-client');

const PORT = 4299;
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(URL + '/healthz'); if (r.ok) return; } catch (e) {}
    await wait(100);
  }
  throw new Error('server did not start');
}

function client(name) {
  const socket = io(URL, { transports: ['websocket'] });
  const c = {
    socket, name, id: null, view: null, over: false, starts: 0,
    rematch: null, autoPlay: true,
  };
  socket.on('gameStart', () => { c.starts++; c.over = false; });
  socket.on('rematchState', (s) => { c.rematch = s; });
  socket.on('state', ({ view }) => {
    c.view = view;
    if (view.over) c.over = true;
    if (c.autoPlay && view.turnId === c.id && !view.over) {
      const moves = view.you.legalMoves;
      if (moves.length) setTimeout(() => socket.emit('playCard', { cardId: moves[0] }), 1);
    }
  });
  c.join = (roomId, playerId) => new Promise((res) => {
    socket.emit('join', { nickname: name, roomId, playerId }, (r) => {
      if (r && r.ok) c.id = r.playerId;
      res(r);
    });
  });
  return c;
}

async function playUntilOver(clients, label) {
  const deadline = Date.now() + 20000;
  while (!clients.every((c) => c.over)) {
    if (Date.now() > deadline) throw new Error(`${label}: game did not finish`);
    await wait(20);
  }
}

async function testUnanimousRematch() {
  const a = client('MA');
  const a1 = await a.join(null);
  const b = client('MB');
  await b.join(a1.roomId);
  await wait(50);
  a.socket.emit('startGame');
  await wait(80);
  assert.strictEqual(a.starts, 1, 'first game did not start');

  await playUntilOver([a, b], 'first game');

  // One vote alone must NOT start a new game.
  a.socket.emit('rematch');
  await wait(120);
  assert.strictEqual(a.starts, 1, 'game restarted without unanimous agreement');
  assert(a.rematch && a.rematch.ready === 1, 'rematch vote was not counted');
  assert.strictEqual(a.rematch.total, 2, 'rematch total should be 2 players');

  // Second vote completes unanimity → new game starts in place.
  b.socket.emit('rematch');
  const deadline = Date.now() + 5000;
  while (a.starts < 2 || b.starts < 2) {
    if (Date.now() > deadline) throw new Error('unanimous rematch did not start');
    await wait(20);
  }
  assert(!a.over && !b.over, 'view still reports game over after rematch');
  console.log('  unanimous rematch restarts in place OK');
  a.socket.close(); b.socket.close();
}

async function testBhabhiGifEndpoint() {
  const res = await fetch(URL + '/gifs/index.json');
  const data = await res.json();
  assert(Array.isArray(data.gifs), 'gifs should be an array');
  assert(Array.isArray(data.bhabhi), 'bhabhi should be an array (may be empty)');
  console.log(`  gif endpoint exposes thulla(${data.gifs.length}) + bhabhi(${data.bhabhi.length}) OK`);
}

(async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), RECONNECT_GRACE_MS: '400', AUTO_PLAY_DELAY_MS: '40' }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForServer();
    await testBhabhiGifEndpoint();
    await testUnanimousRematch();
    console.log('\nREMATCH TESTS PASSED');
    process.exitCode = 0;
  } catch (e) {
    console.error('\nREMATCH TEST FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
  }
})();
