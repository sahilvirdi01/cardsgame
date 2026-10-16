'use strict';
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const { io } = require('socket.io-client');

const PORT = 4199;
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
  const c = { socket, name, id: null, token: null, view: null, over: false, loserId: null, events: [], autoPlays: 0, conns: [] };
  socket.on('state', ({ view, events }) => {
    c.view = view;
    c.events.push(...events);
    if (events.some((e) => e.type === 'autoplay')) c.autoPlays++;
    const go = events.find((e) => e.type === 'gameover');
    if (go) { c.over = true; c.loserId = go.loserId; }
    if (view.turnId === c.id && !view.over) {
      const moves = view.you.legalMoves;
      if (moves.length) setTimeout(() => socket.emit('playCard', { cardId: moves[Math.floor(Math.random() * moves.length)] }), 1);
    }
  });
  socket.on('playerConnection', (m) => c.conns.push(m));
  c.join = (roomId, playerId) => new Promise((res) => {
    socket.emit('join', { nickname: name, roomId, playerId }, (r) => {
      if (r && r.ok) { c.id = r.playerId; c.token = r.playerId; }
      res(r);
    });
  });
  return c;
}

async function testGraceAutoPlay() {
  const a = client('A');
  const a1 = await a.join(null);
  const b = client('B');
  await b.join(a1.roomId);
  await wait(50);
  a.socket.emit('startGame');
  await wait(100);
  assert(a.view && b.view, 'game did not start');
  // Drop B entirely.
  b.socket.disconnect();
  const deadline = Date.now() + 15000;
  while (!a.over) {
    if (Date.now() > deadline) throw new Error('game did not finish after disconnect');
    await wait(20);
  }
  assert(a.autoPlays > 0, 'no auto-plays recorded');
  console.log('  grace + auto-play OK (autoPlays=' + a.autoPlays + ')');
  a.socket.close();
}

async function testReclaim() {
  const a = client('RA');
  const a1 = await a.join(null);
  const b = client('RB');
  await b.join(a1.roomId);
  await wait(50);
  a.socket.emit('startGame');
  await wait(80);
  const rbId = b.id;
  b.socket.disconnect();
  await wait(150); // within grace
  const b2 = client('RB');
  const res = await b2.join(a1.roomId, rbId);
  assert(res.ok && res.reconnected, 'reconnect was not accepted');
  await wait(60);
  assert(b2.view, 'no state after reconnect');
  assert.strictEqual(b2.id, rbId, 'seat id changed on reconnect');
  console.log('  seat reclaim within grace OK');
  a.socket.close(); b2.socket.close();
}

async function testNewJoinBlocked() {
  const a = client('NA');
  const a1 = await a.join(null);
  const b = client('NB');
  await b.join(a1.roomId);
  await wait(40);
  a.socket.emit('startGame');
  await wait(60);
  const c = client('NC');
  const res = await c.join(a1.roomId);
  assert(!res.ok, 'new player was allowed to join a running game');
  console.log('  mid-game join blocked OK');
  a.socket.close(); b.socket.close(); c.socket.close();
}

(async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), RECONNECT_GRACE_MS: '400', AUTO_PLAY_DELAY_MS: '60' }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForServer();
    await testGraceAutoPlay();
    await testReclaim();
    await testNewJoinBlocked();
    console.log('\nRECONNECT TESTS PASSED');
    process.exitCode = 0;
  } catch (e) {
    console.error('\nRECONNECT TEST FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
  }
})();
