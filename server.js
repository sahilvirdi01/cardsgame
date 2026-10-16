'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { BhabhiGame } = require('./game/bhabhi');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 2;

/** How long we hold a seat and pause their turns after a drop (ms). */
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 8000);
/** Delay before an away player's turn is auto-played (ms). */
const AUTO_PLAY_DELAY_MS = Number(process.env.AUTO_PLAY_DELAY_MS || 1200);
/** How long a finished, fully-disconnected room lingers before being reaped. */
const ROOM_REAP_MS = Number(process.env.ROOM_REAP_MS || 60000);

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

/** Stable per-seat id, survives reconnects (unlike a socket id). */
function makePlayerId() {
  return crypto.randomBytes(9).toString('base64url');
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
      connected: p.connected !== false,
      away: !!p.auto,
    })),
  };
}

function broadcastLobby(room) {
  io.to(room.id).emit('lobby', lobbyPayload(room));
}

function broadcastState(room, events = []) {
  if (!room.game) return;
  for (const p of room.players.values()) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit('state', { view: room.game.viewFor(p.id), events });
  }
}

function roomOf(socket) {
  return socket.data.roomId ? rooms.get(socket.data.roomId) : null;
}

/* ------------------------------------------------------ disconnect timers */

function clearGrace(player) {
  if (player && player.graceTimer) {
    clearTimeout(player.graceTimer);
    player.graceTimer = null;
  }
}

function clearAutoTimer(room) {
  if (room.autoTimer) {
    clearTimeout(room.autoTimer);
    room.autoTimer = null;
  }
}

function startGrace(room, player) {
  clearGrace(player);
  player.connected = false;
  player.auto = false;
  player.graceTimer = setTimeout(() => {
    player.graceTimer = null;
    if (player.connected) return;
    player.auto = true;
    io.to(room.id).emit('playerConnection', {
      id: player.id, nickname: player.nickname, connected: false, away: true,
    });
    broadcastLobby(room);
    maybeAutoPlay(room);
  }, RECONNECT_GRACE_MS);
}

/* ------------------------------------------------------------- auto-play */

/** Schedule an auto-move if the current turn belongs to an away player. */
function maybeAutoPlay(room) {
  if (!room.game || room.game.over || room.autoTimer) return;
  const p = room.players.get(room.game.turnId);
  if (!p || !p.auto) return;
  room.autoTimer = setTimeout(() => {
    room.autoTimer = null;
    autoPlayTurn(room);
  }, AUTO_PLAY_DELAY_MS);
}

/** Play a random legal card for whoever is away and on turn, then chain. */
function autoPlayTurn(room) {
  if (!room.game || room.game.over) return;
  const id = room.game.turnId;
  const p = room.players.get(id);
  if (!p || !p.auto) return;
  const moves = room.game.legalMoves(id);
  if (!moves.length) return;
  const cardId = moves[Math.floor(Math.random() * moves.length)];
  const res = room.game.playCard(id, cardId);
  if (!res.ok) return;
  broadcastState(room, [{ type: 'autoplay', playerId: id }, ...res.events]);
  maybeAutoPlay(room);
  reapIfDone(room);
}

/* --------------------------------------------------------------- cleanup */

function cleanupRoom(room) {
  clearAutoTimer(room);
  for (const p of room.players.values()) clearGrace(p);
  rooms.delete(room.id);
}

function reapIfDone(room) {
  if (!room.game || !room.game.over) return;
  const anyConnected = [...room.players.values()].some((p) => p.connected && p.socketId);
  if (anyConnected) return;
  setTimeout(() => {
    const stillGone = [...room.players.values()].every((p) => !p.connected || !p.socketId);
    if (stillGone) cleanupRoom(room);
  }, ROOM_REAP_MS).unref?.();
}

function removePlayer(room, playerId) {
  const p = room.players.get(playerId);
  if (!p) return;
  clearGrace(p);
  if (p.socketId) {
    const s = io.sockets.sockets.get(p.socketId);
    if (s) s.leave(room.id);
  }
  room.players.delete(playerId);
  io.to(room.id).emit('peerLeft', { id: playerId });
  if (room.players.size === 0) {
    cleanupRoom(room);
    return;
  }
  if (room.hostId === playerId) {
    room.hostId = room.players.keys().next().value;
  }
  broadcastLobby(room);
}

/* ----------------------------------------------------------------- socket */

io.on('connection', (socket) => {
  socket.on('join', (msg, ack) => {
    msg = msg || {};
    const wanted = String(msg.roomId || '').toUpperCase().trim();
    const token = msg.playerId ? String(msg.playerId) : '';
    let room = wanted ? rooms.get(wanted) : null;
    let created = false;

    // ---- Reconnect: reclaim an existing seat (same room + token) ----
    if (room && token && room.players.has(token)) {
      const p = room.players.get(token);
      clearGrace(p);
      if (p.socketId && p.socketId !== socket.id) {
        const old = io.sockets.sockets.get(p.socketId);
        if (old) old.disconnect(true);
      }
      p.socketId = socket.id;
      p.connected = true;
      p.auto = false;
      socket.data.roomId = room.id;
      socket.data.playerId = p.id;
      socket.data.nickname = p.nickname;
      socket.join(room.id);
      if (ack) {
        ack({
          ok: true, roomId: room.id, playerId: p.id, nickname: p.nickname,
          reconnected: true, started: !!room.game,
        });
      }
      io.to(room.id).emit('playerConnection', {
        id: p.id, nickname: p.nickname, connected: true, away: false,
      });
      broadcastLobby(room);
      if (room.game) socket.emit('state', { view: room.game.viewFor(p.id), events: [] });
      return;
    }

    if (wanted && !room) {
      if (ack) ack({ ok: false, error: `Room ${wanted} not found` });
      return;
    }

    if (!room) {
      const id = makeRoomId();
      room = {
        id,
        hostId: null,
        players: new Map(),
        game: null,
        started: false,
        rules: {},
        autoTimer: null,
      };
      rooms.set(id, room);
      created = true;
    }

    if (room.started && room.game && !room.game.over) {
      if (ack) ack({ ok: false, error: 'Game already in progress' });
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      if (ack) ack({ ok: false, error: 'Room is full (10 players max)' });
      return;
    }

    const id = makePlayerId();
    const nickname = uniqueName(room, cleanName(msg.nickname, `Player ${room.players.size + 1}`));
    room.players.set(id, {
      id, nickname, mic: false, cam: false, connected: true, auto: false, socketId: socket.id,
    });
    socket.data.roomId = room.id;
    socket.data.playerId = id;
    socket.data.nickname = nickname;
    socket.join(room.id);
    if (!room.hostId) room.hostId = id;

    if (ack) ack({ ok: true, roomId: room.id, playerId: id, nickname, created, started: !!room.game });
    broadcastLobby(room);
  });

  socket.on('setRules', (msg) => {
    const room = roomOf(socket);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || room.hostId !== player.id) return;
    if (room.started && room.game && !room.game.over) return;
    room.rules = sanitizeRules(msg);
    broadcastLobby(room);
  });

  socket.on('startGame', (msg) => {
    const room = roomOf(socket);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || room.hostId !== player.id) return;
    if (room.started && room.game && !room.game.over) return;
    if (room.players.size < MIN_PLAYERS) {
      socket.emit('notice', { type: 'error', message: `Need at least ${MIN_PLAYERS} players to start` });
      return;
    }
    if (msg && msg.rules) room.rules = sanitizeRules(msg.rules);
    const players = [...room.players.values()].map((p) => ({ id: p.id, nickname: p.nickname }));
    room.game = new BhabhiGame(players, { rules: room.rules });
    room.started = true;
    for (const p of room.players.values()) p.auto = false;
    io.to(room.id).emit('gameStart');
    broadcastLobby(room);
    broadcastState(room, [{ type: 'deal', numDecks: room.game.numDecks }]);
    maybeAutoPlay(room);
  });

  socket.on('playCard', (msg) => {
    const room = roomOf(socket);
    if (!room || !room.game) return;
    const player = room.players.get(socket.data.playerId);
    if (!player) return;
    const res = room.game.playCard(player.id, msg && msg.cardId);
    if (!res.ok) {
      socket.emit('notice', { type: 'error', message: res.error });
      // Resync the client in case of drift.
      socket.emit('state', { view: room.game.viewFor(player.id), events: [] });
      return;
    }
    broadcastState(room, res.events);
    maybeAutoPlay(room);
    reapIfDone(room);
  });

  socket.on('restart', () => {
    const room = roomOf(socket);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || room.hostId !== player.id) return;
    clearAutoTimer(room);
    room.game = null;
    room.started = false;
    // Drop anyone who is still gone before heading back to the lobby.
    for (const p of [...room.players.values()]) {
      if (!p.connected || !p.socketId) removePlayer(room, p.id);
    }
    if (!rooms.has(room.id)) return;
    io.to(room.id).emit('backToLobby');
    broadcastLobby(room);
  });

  // ---- WebRTC signalling (mesh) ----
  socket.on('signal', (msg) => {
    const room = roomOf(socket);
    if (!room || !msg || !msg.to) return;
    const target = room.players.get(msg.to);
    if (!target || !target.socketId) return;
    io.to(target.socketId).emit('signal', { from: socket.data.playerId, data: msg.data });
  });

  // ---- Soundboard relay ----
  socket.on('sound', (msg) => {
    const room = roomOf(socket);
    if (!room || !msg || !msg.sound) return;
    const sender = room.players.get(socket.data.playerId);
    io.to(room.id).emit('sound', {
      sound: String(msg.sound).slice(0, 40),
      from: socket.data.playerId,
      nickname: sender ? sender.nickname : 'Someone',
    });
  });

  // ---- Chat ----
  socket.on('chat', (msg) => {
    const room = roomOf(socket);
    if (!room) return;
    const text = String((msg && msg.text) || '').slice(0, 200).trim();
    if (!text) return;
    const sender = room.players.get(socket.data.playerId);
    io.to(room.id).emit('chat', {
      from: socket.data.playerId,
      nickname: sender ? sender.nickname : '?',
      text,
    });
  });

  // ---- Media state (mic/cam indicators) ----
  socket.on('mediaState', (msg) => {
    const room = roomOf(socket);
    if (!room) return;
    const p = room.players.get(socket.data.playerId);
    if (!p) return;
    if (typeof (msg || {}).mic === 'boolean') p.mic = msg.mic;
    if (typeof (msg || {}).cam === 'boolean') p.cam = msg.cam;
    broadcastLobby(room);
    socket.to(room.id).emit('peerMedia', { id: p.id, mic: p.mic, cam: p.cam });
  });

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player) return;
    // Ignore a late disconnect from a socket a reconnect has already replaced.
    if (player.socketId && player.socketId !== socket.id) return;
    player.socketId = null;

    const liveGame = room.started && room.game && !room.game.over;
    if (liveGame) {
      startGrace(room, player);
      io.to(room.id).emit('playerConnection', {
        id: player.id, nickname: player.nickname, connected: false, away: false,
        graceMs: RECONNECT_GRACE_MS,
      });
      broadcastLobby(room);
      return;
    }
    removePlayer(room, player.id);
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
