'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { BhabhiGame } = require('./game/bhabhi');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;

/** House rules a host may choose — everything else uses the engine defaults. */
const ALLOWED_RULES = {
  decks: ['auto', '1', '2', '3', '4'],
  direction: ['clockwise', 'anticlockwise'],
  escapeTiming: ['trickEnd', 'immediate', 'lastCardHighest'],
  escapeLead: ['nextActive', 'drawFromSaar'],
};

function sanitizeRules(input) {
  const rules = {};
  if (!input || typeof input !== 'object') return rules;
  for (const [key, allowed] of Object.entries(ALLOWED_RULES)) {
    const val = input[key];
    if (val !== undefined && allowed.includes(String(val))) rules[key] = String(val);
  }
  return rules;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/** roomId -> Room */
const rooms = new Map();

function makeRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function cleanName(name, fallback) {
  const n = String(name || '').replace(/[<>&"'`]/g, '').trim().slice(0, 16);
  return n || fallback;
}

function uniqueName(room, name) {
  const taken = new Set([...room.players.values()].map((p) => p.nickname.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let i = 2;
  while (taken.has(`${name} ${i}`.toLowerCase())) i++;
  return `${name} ${i}`;
}

function lobbyPayload(room) {
  return {
    roomId: room.id,
    hostId: room.hostId,
    started: room.started,
    maxPlayers: MAX_PLAYERS,
    rules: room.rules || {},
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      nickname: p.nickname,
      mic: !!p.mic,
      cam: !!p.cam,
      isHost: p.id === room.hostId,
    })),
  };
}

function broadcastLobby(room) {
  io.to(room.id).emit('lobby', lobbyPayload(room));
}

function broadcastState(room, events = []) {
  if (!room.game) return;
  for (const p of room.players.values()) {
    io.to(p.id).emit('state', { view: room.game.viewFor(p.id), events });
  }
}

function roomOf(socket) {
  return socket.data.roomId ? rooms.get(socket.data.roomId) : null;
}

io.on('connection', (socket) => {
  socket.on('join', (msg, ack) => {
    msg = msg || {};
    const wanted = String(msg.roomId || '').toUpperCase().trim();
    let room = wanted ? rooms.get(wanted) : null;
    let created = false;

    if (wanted && !room) {
      if (ack) ack({ ok: false, error: `Room ${wanted} not found` });
      return;
    }

    if (!room) {
      const id = makeRoomId();
      room = {
        id,
        hostId: socket.id,
        players: new Map(),
        game: null,
        started: false,
        rules: {},
      };
      rooms.set(id, room);
      created = true;
    }

    if (room.started) {
      if (ack) ack({ ok: false, error: 'Game already in progress' });
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      if (ack) ack({ ok: false, error: 'Room is full (10 players max)' });
      return;
    }

    const nickname = uniqueName(room, cleanName(msg.nickname, `Player ${room.players.size + 1}`));
    room.players.set(socket.id, {
      id: socket.id,
      nickname,
      mic: false,
      cam: false,
    });
    socket.data.roomId = room.id;
    socket.data.nickname = nickname;
    socket.join(room.id);

    if (ack) ack({ ok: true, roomId: room.id, playerId: socket.id, created });
    broadcastLobby(room);
  });

  socket.on('setRules', (msg) => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id || room.started) return;
    room.rules = sanitizeRules(msg);
    broadcastLobby(room);
  });

  socket.on('startGame', (msg) => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id) return;
    if (room.started) return;
    if (room.players.size < MIN_PLAYERS) {
      socket.emit('notice', { type: 'error', message: `Need at least ${MIN_PLAYERS} players to start` });
      return;
    }
    if (msg && msg.rules) room.rules = sanitizeRules(msg.rules);
    const players = [...room.players.values()].map((p) => ({ id: p.id, nickname: p.nickname }));
    room.game = new BhabhiGame(players, { rules: room.rules });
    room.started = true;
    io.to(room.id).emit('gameStart');
    broadcastLobby(room);
    broadcastState(room, [{ type: 'deal', numDecks: room.game.numDecks }]);
  });

  socket.on('playCard', (msg) => {
    const room = roomOf(socket);
    if (!room || !room.game) return;
    const res = room.game.playCard(socket.id, msg && msg.cardId);
    if (!res.ok) {
      socket.emit('notice', { type: 'error', message: res.error });
      // Resync the client in case of drift.
      socket.emit('state', { view: room.game.viewFor(socket.id), events: [] });
      return;
    }
    broadcastState(room, res.events);
  });

  socket.on('restart', () => {
    const room = roomOf(socket);
    if (!room || room.hostId !== socket.id) return;
    room.game = null;
    room.started = false;
    io.to(room.id).emit('backToLobby');
    broadcastLobby(room);
  });

  // ---- WebRTC signalling (mesh) ----
  socket.on('signal', (msg) => {
    const room = roomOf(socket);
    if (!room || !msg || !msg.to || !room.players.has(msg.to)) return;
    io.to(msg.to).emit('signal', { from: socket.id, data: msg.data });
  });

  // ---- Soundboard relay ----
  socket.on('sound', (msg) => {
    const room = roomOf(socket);
    if (!room || !msg || !msg.sound) return;
    const sender = room.players.get(socket.id);
    io.to(room.id).emit('sound', {
      sound: String(msg.sound).slice(0, 40),
      from: socket.id,
      nickname: sender ? sender.nickname : 'Someone',
    });
  });

  // ---- Chat ----
  socket.on('chat', (msg) => {
    const room = roomOf(socket);
    if (!room) return;
    const text = String((msg && msg.text) || '').slice(0, 200).trim();
    if (!text) return;
    const sender = room.players.get(socket.id);
    io.to(room.id).emit('chat', {
      from: socket.id,
      nickname: sender ? sender.nickname : '?',
      text,
    });
  });

  // ---- Media state (mic/cam indicators) ----
  socket.on('mediaState', (msg) => {
    const room = roomOf(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (typeof (msg || {}).mic === 'boolean') p.mic = msg.mic;
    if (typeof (msg || {}).cam === 'boolean') p.cam = msg.cam;
    broadcastLobby(room);
    socket.to(room.id).emit('peerMedia', { id: socket.id, mic: p.mic, cam: p.cam });
  });

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;
    room.players.delete(socket.id);
    io.to(room.id).emit('peerLeft', { id: socket.id });

    if (room.players.size === 0) {
      rooms.delete(room.id);
      return;
    }
    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
    }
    // If a game was running, abort it back to the lobby.
    if (room.started) {
      room.started = false;
      room.game = null;
      io.to(room.id).emit('gameAborted', { reason: 'A player left the game' });
    }
    broadcastLobby(room);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use — another server is probably still running.\n` +
      `  Free it and try again:\n` +
      `      fuser -k ${PORT}/tcp        # or: kill $(lsof -t -i:${PORT})\n` +
      `  Or start on a different port:\n` +
      `      PORT=3001 npm start\n`
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  Bhabhi Thulla server running:`);
  console.log(`    http://localhost:${PORT}\n`);
});
