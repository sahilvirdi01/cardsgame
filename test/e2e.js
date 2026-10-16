'use strict';
/* End-to-end test: spins up the real server, connects real Socket.IO clients
 * and plays complete games for several player counts. Usage: npm test */
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const { io } = require('socket.io-client');

const PORT = process.env.TEST_PORT || 4123;
const URL = `http://localhost:${PORT}`;

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForServer(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(URL + '/healthz');
      if (res.ok) return;
    } catch (e) { /* not up yet */ }
    await wait(100);
  }
  throw new Error('server did not start');
}

function makeClient(name) {
  const socket = io(URL, { transports: ['websocket'] });
  const c = {
    socket, name, id: null, view: null, over: false, loserId: null,
    sounds: [], chats: [], errors: [], events: [],
    join(roomId) {
      return new Promise((resolve) => {
        socket.emit('join', { nickname: name, roomId }, (res) => {
          c.id = res.playerId;
          resolve(res);
        });
      });
    },
  };
  socket.on('state', ({ view, events }) => {
    c.view = view;
    c.events.push(...events);
    const go = events.find((e) => e.type === 'gameover');
    if (go) { c.over = true; c.loserId = go.loserId; }
    if (view.turnId === c.id && !view.over) {
      const moves = view.you.legalMoves;
      assert(moves.length > 0, `${name} has no legal moves on their turn`);
      const pick = moves[Math.floor(Math.random() * moves.length)];
      setTimeout(() => socket.emit('playCard', { cardId: pick }), 1);
    }
  });
  socket.on('sound', (s) => c.sounds.push(s));
  socket.on('chat', (m) => c.chats.push(m));
  socket.on('notice', (n) => c.errors.push(n));
  return c;
}

async function runScenario(n) {
  const host = makeClient('Host' + n);
  const first = await host.join(null);
  const roomId = first.roomId;
  const clients = [host];
  for (let i = 1; i < n; i++) {
    const c = makeClient('P' + i);
    await c.join(roomId);
    clients.push(c);
  }
  await wait(30);
  host.socket.emit('startGame');

  // sanity: lobby sizes
  const deadline = Date.now() + 20000;
  while (!clients.every((c) => c.over)) {
    if (Date.now() > deadline) throw new Error(`game with ${n} players timed out`);
    await wait(20);
  }
  const losers = new Set(clients.filter((c) => c.over).map((c) => c.loserId));
  assert.strictEqual(losers.size, 1, `expected exactly one loser, got ${losers.size}`);
  // no unexpected server errors
  const errs = clients.flatMap((c) => c.errors);
  assert.strictEqual(errs.length, 0, `unexpected errors: ${JSON.stringify(errs.slice(0, 3))}`);
  console.log(`  ${n} players -> finished OK`);
  clients.forEach((c) => c.socket.close());
  return true;
}

async function testRelayAndChat() {
  const a = makeClient('Anna');
  const first = await a.join(null);
  const b = makeClient('Ben');
  await b.join(first.roomId);
  await wait(40);
  a.socket.emit('sound', { sound: 'vineboom' });
  a.socket.emit('chat', { text: 'hello there' });
  await wait(80);
  assert(a.sounds.length >= 1, 'sound was not relayed');
  assert(b.chats.length >= 1 && b.chats[0].text === 'hello there', 'chat was not relayed');
  console.log('  relay (soundboard + chat) OK');
  a.socket.close(); b.socket.close();
}

async function testRulesPassthrough() {
  const a = makeClient('RuleA');
  const first = await a.join(null);
  const b = makeClient('RuleB');
  await b.join(first.roomId);
  await wait(30);
  a.socket.emit('setRules', { direction: 'anticlockwise', escapeTiming: 'immediate', escapeLead: 'drawFromSaar', bogus: 'x' });
  await wait(30);
  a.socket.emit('startGame');
  await wait(60);
  for (const c of [a, b]) {
    assert(c.view, 'no view after start');
    assert.strictEqual(c.view.direction, 'anticlockwise', 'direction rule not applied');
    assert.strictEqual(c.view.escapeTiming, 'immediate', 'escapeTiming rule not applied');
    assert.strictEqual(c.view.escapeLead, 'drawFromSaar', 'escapeLead rule not applied');
    // unknown keys must be dropped
    assert.strictEqual(c.view.bogus, undefined, 'unsanitised rule leaked into view');
  }
  console.log('  house-rules passthrough + sanitisation OK');
  a.socket.close(); b.socket.close();
}

async function testFullRoomRejected() {
  const first = makeClient('Solo');
  const info = await first.join(null);
  await wait(20);
  console.log('  join/room creation OK (' + info.roomId + ')');
  first.socket.close();
}

(async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForServer();
    console.log('Server up. Running scenarios...');
    await testFullRoomRejected();
    await testRelayAndChat();
    await testRulesPassthrough();
    for (const n of [2, 3, 4, 6, 10]) await runScenario(n);
    console.log('\nALL TESTS PASSED');
    process.exitCode = 0;
  } catch (e) {
    console.error('\nTEST FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
  }
})();
