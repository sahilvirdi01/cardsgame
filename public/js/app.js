'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const socket = io();
  const APP = {
    roomId: null,
    selfId: null,
    nickname: null,
    isHost: false,
    lobby: null,
    lastView: null,
    ready: false,
    sittingOut: false,
  };

  // Wire the WebRTC signalling layer to the socket. Without this no offers,
  // answers or ICE candidates are ever exchanged and media stays local-only.
  WebRTC.init(socket);

  /* ---------------- session persistence (for reconnect) ---------------- */
  function saveSession() {
    try {
      sessionStorage.setItem('bhabhi:session', JSON.stringify({
        roomId: APP.roomId, playerId: APP.selfId, nickname: APP.nickname,
      }));
    } catch (e) { /* ignore */ }
  }
  function clearSession() {
    try { sessionStorage.removeItem('bhabhi:session'); } catch (e) { /* ignore */ }
  }
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem('bhabhi:session') || 'null'); } catch (e) { return null; }
  }

  /* ---------------- utils ---------------- */
  function toast(message, kind) {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-10px)';
      setTimeout(() => el.remove(), 320);
    }, 2200);
  }

  function showScreen(id) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + id));
    APP.screen = id;
    if (id === 'game') renderVideos();
    if (id === 'lobby') renderVideos();
  }

  function playerName(id) {
    const src = (APP.lobby && APP.lobby.players) || (APP.lastView && APP.lastView.players) || [];
    const p = src.find((x) => x.id === id);
    return p ? p.nickname : 'Player';
  }

  function showSound(id) { $('#soundboard').classList.remove('hidden'); }

  /* ---------------- home ---------------- */
  const saved = localStorage.getItem('bhabhi:nick') || '';
  if (saved) $('#nicknameInput').value = saved;

  function handleJoinRes(res, opts = {}) {
    if (!res || !res.ok) {
      if (opts.reconnect) {
        clearSession();
        if (APP.roomId) { APP.roomId = null; APP.selfId = null; showScreen('home'); }
        toast('Could not rejoin the room — it may have ended.', 'error');
      } else {
        $('#homeError').textContent = (res && res.error) || 'Could not join.';
      }
      return false;
    }
    APP.roomId = res.roomId;
    APP.selfId = res.playerId;
    APP.nickname = res.nickname || APP.nickname;
    WebRTC.selfId = res.playerId;
    saveSession();
    $('#homeError').textContent = '';
    if (res.started) {
      APP.ready = true; // skip the deal animation when dropping back into a game
      showScreen('game');
    } else {
      showScreen('lobby');
    }
    toast((res.reconnected ? 'Reconnected to ' : 'Joined room ') + res.roomId, 'sound');
    return true;
  }

  function doJoin(roomId) {
    const nickname = $('#nicknameInput').value.trim();
    if (!nickname) { $('#homeError').textContent = 'Please enter a nickname.'; return; }
    localStorage.setItem('bhabhi:nick', nickname);
    APP.nickname = nickname;
    Soundboard.unlock();
    socket.emit('join', { nickname, roomId }, (res) => handleJoinRes(res, { reconnect: false }));
  }

  let reconnecting = false;
  function attemptReconnect() {
    if (reconnecting) return;
    const s = loadSession();
    if (!s || !s.roomId || !s.playerId) return;
    reconnecting = true;
    APP.nickname = s.nickname || localStorage.getItem('bhabhi:nick') || 'Player';
    socket.timeout(6000).emit(
      'join',
      { roomId: s.roomId, playerId: s.playerId, nickname: APP.nickname },
      (err, res) => {
        reconnecting = false;
        if (err) return; // timed out — retry on the next connect
        handleJoinRes(res, { reconnect: true });
      }
    );
  }

  $('#createBtn').addEventListener('click', () => doJoin(null));
  $('#joinBtn').addEventListener('click', () => doJoin($('#roomInput').value.toUpperCase().trim()));
  $('#roomInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $('#nicknameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#createBtn').click(); });

  /* ---------------- info overlays ---------------- */
  const openEl = (el) => el.classList.remove('hidden');
  const closeEl = (el) => el.classList.add('hidden');
  $('#howBtn').addEventListener('click', () => openEl($('#howOverlay')));
  $('#howClose').addEventListener('click', () => closeEl($('#howOverlay')));

  /* ---------------- room chip ---------------- */
  function setRoomCode(code) {
    $('#lobbyRoomCode').textContent = code;
    $('#gameRoomCode').textContent = code;
  }
  function copyRoom() {
    if (!APP.roomId) return;
    navigator.clipboard && navigator.clipboard.writeText(APP.roomId);
    toast('Room code copied: ' + APP.roomId);
  }
  $('#lobbyRoomChip').addEventListener('click', copyRoom);
  $('#gameRoomChip').addEventListener('click', copyRoom);

  /* ---------------- lobby ---------------- */
  function renderLobby() {
    const l = APP.lobby;
    if (!l) return;
    setRoomCode(l.roomId);
    $('#lobbyCount').textContent = `${l.players.length}/${l.maxPlayers}`;
    const ul = $('#lobbyPlayers');
    ul.innerHTML = '';
    l.players.forEach((p) => {
      const li = document.createElement('li');
      const initial = p.nickname.slice(0, 1).toUpperCase();
      const offline = p.connected === false;
      li.className = offline ? 'offline' : '';
      const status = p.away
        ? '<span class="host-tag away-tag">AWAY</span>'
        : (offline ? '<span class="host-tag away-tag">RECONNECTING…</span>' : '');
      li.innerHTML =
        `<span class="avatar">${initial}</span>` +
        `<span class="nm">${p.nickname}${p.id === APP.selfId ? ' (you)' : ''}</span>` +
        `<span class="medias">${p.mic ? '🎤' : ''}${p.cam ? '📷' : ''}</span>` +
        status +
        (p.isHost ? '<span class="host-tag">HOST</span>' : '');
      ul.appendChild(li);
    });

    APP.isHost = l.hostId === APP.selfId;
    const canStart = APP.isHost && l.players.length >= 2;
    $('#startBtn').disabled = !canStart;
    $('#startBtn').classList.toggle('hidden', !APP.isHost);
    $('#lobbyHint').textContent = !APP.isHost
      ? 'Waiting for the host to start…'
      : (l.players.length < 2 ? 'Waiting for players… (need at least 2)' : 'Ready when you are!');

    $('#rulesBox').classList.toggle('hidden', !APP.isHost);
    if (l.rules) applyRules(l.rules);

    WebRTC.syncPeers(l.players.map((p) => p.id));
    renderVideos();
  }

  const RULE_SELECTORS = { '#ruleDirection': 'direction', '#ruleEscapeTiming': 'escapeTiming', '#ruleEscapeLead': 'escapeLead' };
  function currentRules() {
    const rules = {};
    for (const [sel, key] of Object.entries(RULE_SELECTORS)) rules[key] = $(sel).value;
    return rules;
  }
  function applyRules(rules) {
    for (const [sel, key] of Object.entries(RULE_SELECTORS)) {
      const el = $(sel);
      // Don't fight the host while they're mid-selection.
      if (el && rules[key] && document.activeElement !== el) el.value = rules[key];
    }
  }
  Object.keys(RULE_SELECTORS).forEach((sel) => {
    $(sel).addEventListener('change', () => { if (APP.isHost) socket.emit('setRules', currentRules()); });
  });

  $('#startBtn').addEventListener('click', () => { Soundboard.unlock(); socket.emit('startGame', { rules: currentRules() }); });

  /* ---------------- media controls ---------------- */
  async function toggleMic() {
    Soundboard.unlock();
    const on = !WebRTC.media.mic;
    try { await WebRTC.setMic(on); }
    catch (e) {
      toast(e && e.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Could not start microphone', 'error');
      return;
    }
    if (on) refreshMicList();
    updateMediaButtons();
    socket.emit('mediaState', { mic: WebRTC.media.mic, cam: WebRTC.media.cam });
    renderVideos();
  }
  async function toggleCam() {
    Soundboard.unlock();
    const on = !WebRTC.media.cam;
    try { await WebRTC.setCam(on); }
    catch (e) { toast('Camera permission denied', 'error'); return; }
    updateMediaButtons();
    socket.emit('mediaState', { mic: WebRTC.media.mic, cam: WebRTC.media.cam });
    renderVideos();
  }
  function updateMediaButtons() {
    ['#micBtn', '#lobbyMicBtn'].forEach((s) => $(s) && $(s).classList.toggle('on', WebRTC.media.mic));
    ['#camBtn', '#lobbyCamBtn'].forEach((s) => $(s) && $(s).classList.toggle('on', WebRTC.media.cam));
  }
  $('#micBtn').addEventListener('click', toggleMic);
  $('#lobbyMicBtn').addEventListener('click', toggleMic);
  $('#camBtn').addEventListener('click', toggleCam);
  $('#lobbyCamBtn').addEventListener('click', toggleCam);

  /* ---- microphone device picker + live level meter ---- */
  async function refreshMicList() {
    const sel = $('#micSelect');
    if (!sel) return;
    const inputs = await WebRTC.listInputs();
    const saved = WebRTC.micDeviceId || '';
    sel.innerHTML = '<option value="">System default</option>' +
      inputs.map((d, i) =>
        `<option value="${d.deviceId}">${esc(d.label || `Microphone ${i + 1}`)}</option>`).join('');
    sel.value = saved && inputs.some((d) => d.deviceId === saved) ? saved : '';
  }
  if ($('#micSelect')) {
    $('#micSelect').addEventListener('change', async (e) => {
      Soundboard.unlock();
      await WebRTC.changeMic(e.target.value || null);
      updateMediaButtons();
      renderVideos();
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', refreshMicList);
    }
    refreshMicList();
  }
  WebRTC.onMicLevel = (level) => {
    const bar = $('#micLevel');
    if (bar) bar.style.width = Math.round(level * 100) + '%';
  };

  /* ---------------- video tiles ---------------- */
  const tiles = new Map(); // key -> {video, off, name, icons, tile}

  function renderVideos() {
    const list = (APP.lobby && APP.lobby.players) || [];
    const views = list.map((p) => ({
      id: p.id, nickname: p.nickname, mic: p.mic, cam: p.cam,
      connected: p.connected !== false, away: !!p.away, isYou: p.id === APP.selfId,
    }));
    if (!views.find((v) => v.isYou) && APP.selfId) {
      views.unshift({ id: 'self', nickname: 'You', mic: WebRTC.media.mic, cam: WebRTC.media.cam, connected: true, away: false, isYou: true });
    }
    renderGrid($('#lobbyVideoGrid'), 'lobby', views);
    renderGrid($('#sideVideoGrid'), 'side', views);
  }

  function renderGrid(container, prefix, views) {
    if (!container) return;
    const seen = new Set();
    for (const v of views) {
      const key = prefix + ':' + v.id;
      seen.add(key);
      let t = tiles.get(key);
      if (!t || !container.contains(t.tile)) {
        const tile = document.createElement('div');
        tile.className = 'video-tile' + (v.isYou ? ' self' : '');
        tile.innerHTML =
          '<video autoplay playsinline muted></video>' +
          '<div class="vt-off">🎥</div>' +
          '<div class="vt-name"><span class="nm"></span><span class="vt-icons"></span></div>';
        container.appendChild(tile);
        t = {
          tile,
          video: tile.querySelector('video'),
          off: tile.querySelector('.vt-off'),
          name: tile.querySelector('.nm'),
          icons: tile.querySelector('.vt-icons'),
        };
        tiles.set(key, t);
      }
      const peerId = v.isYou ? 'self' : v.id;
      t.video.muted = true; // remote audio plays through the dedicated audio sink
      const stream = peerId === 'self' ? WebRTC.localStream : (WebRTC.peers.get(peerId) || {}).stream;
      if (stream && t.video.srcObject !== stream) t.video.srcObject = stream;
      const liveVideo = stream && stream.getVideoTracks().some((tr) => tr.readyState === 'live');
      const hasVideo = !!v.cam && !!liveVideo;
      t.off.textContent = v.connected === false ? '📡' : '🎥';
      t.off.style.display = hasVideo ? 'none' : 'grid';
      t.name.textContent = v.nickname;
      t.icons.textContent = (v.mic ? '🎤' : '🔇') + (v.cam ? '📷' : '');
      t.tile.style.order = '';
    }
    // remove stale tiles
    for (const [key, t] of tiles) {
      if (key.startsWith(prefix + ':') && !seen.has(key)) {
        t.tile.remove();
        tiles.delete(key);
      }
    }
  }

  WebRTC.onUpdate = () => { if (APP.screen === 'game' || APP.screen === 'lobby') renderVideos(); };
  WebRTC.onLocalChange = () => { updateMediaButtons(); renderVideos(); };

  /* ---------------- soundboard ---------------- */
  function playSound(id) {
    Soundboard.play(id);
    socket.emit('sound', { sound: id });
  }
  Soundboard.renderGrid($('#soundGrid'), playSound);

  $('#soundsBtn').addEventListener('click', () => {
    Soundboard.unlock();
    $('#soundboard').classList.toggle('hidden');
  });
  $('#sbClose').addEventListener('click', () => $('#soundboard').classList.add('hidden'));

  socket.on('sound', ({ sound, nickname }) => {
    Soundboard.play(sound);
    const meta = Soundboard.sounds.get(sound);
    toast(`${nickname} played ${meta ? meta.emoji + ' ' + meta.label : sound}`, 'sound');
  });

  /* ---------------- chat ---------------- */
  function addChat(line, cls) {
    $$('.chat-log').forEach((log) => {
      const div = document.createElement('div');
      div.className = 'chat-line' + (cls ? ' ' + cls : '');
      div.innerHTML = line;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    });
  }
  $$('.chat-form').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const text = (input.value || '').trim();
      if (!text) return;
      socket.emit('chat', { text });
      input.value = '';
    });
  });
  socket.on('chat', ({ nickname, text }) => {
    addChat(`<b>${esc(nickname)}:</b> ${esc(text)}`);
  });
  // Replay the room's backlog so a reconnecting player hasn't missed anything.
  socket.on('chatHistory', ({ messages }) => {
    $$('.chat-log').forEach((log) => { log.innerHTML = ''; });
    (messages || []).forEach((m) => addChat(`<b>${esc(m.nickname)}:</b> ${esc(m.text)}`));
  });
  $('#chatBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#chatFootBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#chatClose').addEventListener('click', () => $('#sidebar').classList.remove('open'));
  $('#howGameBtn').addEventListener('click', () => openEl($('#howOverlay')));
  $('#copyInviteBtn').addEventListener('click', copyRoom);
  $('#soundsFootBtn').addEventListener('click', () => {
    Soundboard.unlock();
    $('#soundboard').classList.toggle('hidden');
  });
  $('#suggestBtn').addEventListener('click', () => {
    const v = APP.lastView;
    if (!v || v.over) return;
    if (v.turnId !== APP.selfId) { toast('Wait for your turn'); return; }
    const moves = v.you.legalMoves || [];
    if (!moves.length) return;
    const pick = moves[Math.floor(Math.random() * moves.length)];
    const card = document.querySelector(`.hand .card[data-card-id="${pick}"]`);
    const slot = card && card.closest('.slot');
    if (slot) {
      slot.classList.add('suggested');
      setTimeout(() => slot.classList.remove('suggested'), 1800);
    }
  });

  /* ---------------- leaving ---------------- */
  function leave() {
    if (!confirm('Leave the room?')) return;
    clearSession();
    WebRTC.cleanup();
    try { socket.disconnect(); } catch (e) {}
    location.href = '/';
  }
  ['#leaveBtn', '#lobbyLeaveBtn', '#leave2Btn'].forEach((s) => $(s) && $(s).addEventListener('click', leave));
  // Play Again = agree to a rematch; it starts in place once everyone agrees.
  $('#playAgainBtn').addEventListener('click', voteRematch);
  $('#rematchBtn') && $('#rematchBtn').addEventListener('click', voteRematch);
  // Host-only escape hatch back to the lobby (to change rules or add players).
  $('#backToLobbyBtn') && $('#backToLobbyBtn').addEventListener('click', () => socket.emit('restart'));
  $('#backToLobby2Btn') && $('#backToLobby2Btn').addEventListener('click', () => socket.emit('restart'));

  /* ---------------- socket events ---------------- */
  socket.on('connect', () => {
    if (APP.selfId) WebRTC.selfId = APP.selfId;
    attemptReconnect();
  });
  socket.on('lobby', (l) => { APP.lobby = l; renderLobby(); });
  socket.on('playerConnection', ({ id, nickname, connected, away, graceMs }) => {
    if (APP.lobby && APP.lobby.players) {
      const p = APP.lobby.players.find((x) => x.id === id);
      if (p) { p.connected = connected; p.away = !!away; }
    }
    if (!connected && !away) {
      const secs = Math.max(1, Math.round((graceMs || 8000) / 1000));
      toast(`${nickname} lost connection — waiting ${secs}s…`, 'error');
    } else if (!connected && away) {
      toast(`${nickname} is away — auto-playing their turns`, 'error');
    } else if (connected) {
      WebRTC.removePeer(id);
      toast(`${nickname} is back!`, 'sound');
    }
    renderLobby();
    if (APP.ready && APP.lastView) renderGame(APP.lastView, []);
  });
  socket.on('notice', (n) => toast(n.message, n.type === 'error' ? 'error' : ''));

  socket.on('peerMedia', ({ id, mic, cam }) => {
    WebRTC.setRemoteMedia(id, mic, cam);
    if (APP.lobby) {
      const p = APP.lobby.players.find((x) => x.id === id);
      if (p) { p.mic = mic; p.cam = cam; }
      renderVideos();
    }
  });
  socket.on('peerLeft', ({ id }) => {
    WebRTC.removePeer(id);
    if (APP.lobby) APP.lobby.players = APP.lobby.players.filter((p) => p.id !== id);
    renderVideos();
    addChat(`${playerName(id)} left the room.`, 'sys');
  });

  socket.on('gameStart', async () => {
    closeEl($('#gameOverOverlay'));
    APP.gameOver = false;
    APP.rematch = { votes: [], total: 0, ready: 0, need: 2 };
    clearTimeout(goTimer);
    renderRematch();
    APP.ready = false;
    APP.prevHandIds = null;
    showScreen('game');
    addChat('Game started!', 'sys');
    await Anim.playStartAnimation();
    APP.ready = true;
    if (APP.pending) { renderGame(APP.pending.view, APP.pending.events); APP.pending = null; }
  });

  socket.on('state', ({ view, events }) => {
    APP.lastView = view;
    APP.lobby = APP.lobby || {};
    APP.lobby.players = view.players.map((p) => {
      const prev = (APP.lobby.players || []).find((x) => x.id === p.id) || {};
      return {
        id: p.id, nickname: p.nickname, mic: prev.mic, cam: prev.cam,
        connected: prev.connected !== false, away: !!prev.away,
      };
    });
    WebRTC.syncPeers(view.players.map((p) => p.id));
    APP.gameOver = !!view.over;
    if (!APP.ready) { APP.pending = { view, events }; return; }
    renderGame(view, events);
    renderRematch();
  });

  socket.on('rematchState', (s) => { APP.rematch = s; renderRematch(); });

  socket.on('backToLobby', () => {
    closeEl($('#gameOverOverlay'));
    APP.gameOver = false;
    clearTimeout(goTimer);
    renderRematch();
    showScreen('lobby');
    toast('Back to the lobby');
  });
  socket.on('gameAborted', ({ reason }) => {
    closeEl($('#gameOverOverlay'));
    APP.gameOver = false;
    clearTimeout(goTimer);
    renderRematch();
    showScreen('lobby');
    toast(reason || 'Game aborted', 'error');
  });

  /* ---------------- game rendering ---------------- */
  function seatPositions(players, selfId) {
    const mine = players.findIndex((p) => p.id === selfId);
    const n = players.length;
    const map = {};
    players.forEach((p, i) => {
      const offset = (i - (mine < 0 ? 0 : mine) + n) % n;
      const angle = Math.PI / 2 + (offset * 2 * Math.PI) / n;
      map[p.id] = {
        left: 50 + 43 * Math.cos(angle),
        top: 50 + 38 * Math.sin(angle),
      };
    });
    return map;
  }

  function dirFor(selfId, playerId, players) {
    if (playerId === selfId) return 'bottom';
    const pos = seatPositions(players, selfId);
    const p = pos[playerId];
    if (!p) return 'top';
    const dx = p.left - 50, dy = p.top - 50;
    if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right';
    return dy < 0 ? 'top' : 'bottom';
  }

  function renderGame(view, events) {
    events = events || [];
    const players = [...view.players].sort((a, b) => a.seat - b.seat);
    renderSeats(view, players);
    renderCenter(view, events, players);
    renderHand(view);
    renderStats(view, players);
    renderTurnBanner(view, players);
    updateMediaButtons();
    renderVideos();

    for (const ev of events) handleEvent(ev, view, players);
  }

  function renderSeats(view, players) {
    const seatsEl = $('#seats');
    const pos = seatPositions(players, view.you.id);
    seatsEl.innerHTML = '';
    seatsEl.classList.toggle('many', players.length > 4);
    players.forEach((p) => {
      const isYou = p.id === view.you.id;
      const el = document.createElement('div');
      el.className = 'seat' + (p.id === view.turnId ? ' turn' : '') +
        (p.out ? ' out' : '') + (isYou ? ' you' : '');
      el.dataset.playerId = p.id;
      el.style.left = pos[p.id].left + '%';
      el.style.top = pos[p.id].top + '%';
      const initial = (p.nickname || '?').slice(0, 1).toUpperCase();
      let segs = '';
      for (let i = 0; i < Math.min(p.handCount, 20); i++) segs += '<i></i>';
      const role = p.out ? 'Out' : (p.id === view.turnId ? (isYou ? 'Your turn' : 'Playing') : '');
      el.innerHTML =
        `<div class="seat-avatar">${initial}</div>` +
        `<div class="seat-name">${isYou ? 'You' : p.nickname}</div>` +
        `<div class="seat-role">${role}</div>` +
        `<div class="seat-count">${p.handCount} card${p.handCount === 1 ? '' : 's'}</div>` +
        `<div class="seat-bar">${segs}</div>`;
      seatsEl.appendChild(el);
    });
  }

  function renderStats(view, players) {
    const you = view.you.id;
    const count = players.length;
    $('#statsCount').textContent = count;
    $('#statsCode').textContent = APP.roomId || '----';

    const ul = $('#statPlayers');
    ul.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'stat-player' + (p.id === view.turnId ? ' turn' : '') +
        (p.out ? ' out' : '') + (p.id === you ? ' you' : '');
      const initial = (p.nickname || '?').slice(0, 1).toUpperCase();
      const pct = Math.min(100, Math.round((p.handCount / 26) * 100));
      const lp = (APP.lobby && APP.lobby.players || []).find((x) => x.id === p.id) || {};
      const tags = [p.id === view.turnId ? 'turn' : '', p.out ? 'safe ✓' : '',
        p.id === you ? 'you' : '', lp.mic ? '🎤' : '', lp.cam ? '📷' : ''].filter(Boolean).join(' · ');
      li.innerHTML =
        `<div class="sp-avatar">${initial}</div>` +
        `<div class="sp-info"><div class="sp-name">${p.nickname}${p.id === you ? ' (you)' : ''}</div>` +
        `<div class="sp-bar"><i style="width:${pct}%"></i></div>` +
        `<div class="sp-tags">${tags}</div></div>` +
        `<div class="sp-cards">${p.handCount}</div>`;
      ul.appendChild(li);
    });

    const activeCount = players.filter((p) => !p.out).length;
    const RULE_LABEL = {
      direction: { clockwise: 'Clockwise ↻', anticlockwise: 'Counter-clockwise ↺' },
      escapeTiming: { trickEnd: 'When empty (after trick)', immediate: 'Immediate', lastCardHighest: 'Last card highest' },
      escapeLead: { nextActive: 'Next player leads', drawFromSaar: 'Draw from Saar' },
    };
    const ruleRow = (key) => {
      const label = RULE_LABEL[key] && RULE_LABEL[key][view[key]];
      return label ? label : '—';
    };
    const rows = [
      ['Players', `${count} / 10`],
      ['Decks in play', view.numDecks],
      ['Trick', view.tricks + 1],
      ['Still playing', activeCount],
      ['Direction', ruleRow('direction')],
      ['Escape', ruleRow('escapeTiming')],
      ['On escape', ruleRow('escapeLead')],
      ['Saar (used cards)', view.discardCount],
      ['Your cards', view.you.hand.length],
    ];
    const st = $('#statTable');
    st.innerHTML = '';
    rows.forEach(([k, v]) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${k}</span><b>${v}</b>`;
      st.appendChild(li);
    });

    $('#tableMeta').textContent =
      `Trick ${view.tricks + 1} · ${activeCount} playing · Saar ${view.discardCount}`;
  }

  // Collapsed / expanded fan geometry (px) for the trick pile.
  const PILE = { gap: 26, tilt: 2.6, gapHover: 46, tiltHover: 0 };
  function pileTransform(k, gap, tilt) {
    const x = (k * gap).toFixed(1);
    return `translateX(calc(-50% + ${x}px)) rotate(${(k * tilt).toFixed(2)}deg)`;
  }

  function renderCenter(view, events, players) {
    const pile = $('#pile');
    // Clear the animated state from the previous render *before* rebuilding, so
    // a finished sweep/pickup (which ends at opacity:0) can never leave the
    // pile permanently invisible — the original "cards disappear" bug.
    pile.classList.remove('anim-sweep', 'anim-pickup', 'flash-red');
    pile.innerHTML = '';
    const resolveEv = events.find((e) => (e.type === 'pickup' || e.type === 'sweep') && e.plays);
    const plays = view.trick ? view.trick.plays : (resolveEv ? resolveEv.plays : []);
    const n = plays.length;
    const mid = (n - 1) / 2;
    const recent = events.find((e) => e.type === 'play') ||
      (resolveEv ? { playerId: resolveEv.plays[resolveEv.plays.length - 1].playerId } : null);
    plays.forEach((pl, i) => {
      const el = Anim.cardEl(pl.card, { small: true });
      const k = i - mid;
      // Custom properties are read by .pile .card and the fly-in keyframes.
      el.style.setProperty('--base', pileTransform(k, PILE.gap, PILE.tilt));
      el.style.setProperty('--hover', pileTransform(k, PILE.gapHover, PILE.tiltHover));
      el.style.zIndex = i + 1;
      el.title = `${playerName(pl.playerId)} played ${pl.card.rank}${pl.card.suit}`;
      if (recent && i === n - 1) {
        const dir = dirFor(view.you.id, recent.playerId, players);
        el.classList.add('anim-in-' + dir);
      }
      pile.appendChild(el);
    });

    // Pickup (→ seat) and sweep (→ Saar) are animated by handleEvent with
    // flying clones that clear the pile immediately, so no CSS fade is needed.

    // Saar — the stack of used/discarded cards (bottom-right of the felt)
    const saarCount = view.discardCount;
    $('#saarCount').textContent = saarCount;
    const stack = $('#saarStack');
    stack.innerHTML = '';
    const caps = Math.min(saarCount, 6);
    for (let i = 0; i < caps; i++) {
      const sc = document.createElement('div');
      sc.className = 'saar-card';
      sc.style.transform = `translate(${i * 2}px, ${-i * 2}px) rotate(${(i - 2) * 3}deg)`;
      stack.appendChild(sc);
    }
    $('#saar').style.visibility = saarCount ? 'visible' : 'hidden';

    // Led-suit badge (bottom-left of the felt)
    const badge = $('#ledSuitBadge');
    if (view.trick && view.trick.ledSuit) {
      const red = view.trick.ledSuit === '♥' || view.trick.ledSuit === '♦';
      badge.innerHTML = `<div class="fs-label">Led suit</div><div class="fs-suit ${red ? 'red' : 'black'}">${view.trick.ledSuit}</div>`;
    } else {
      badge.innerHTML = '<div class="fs-label">New trick</div><div class="fs-suit black">—</div>';
    }
  }

  function renderHand(view) {
    const handEl = $('#hand');
    handEl.innerHTML = '';
    const hand = view.you.hand;
    const legal = new Set(view.you.legalMoves || []);
    const n = hand.length;
    const maxWidth = Math.min(handEl.clientWidth || 700, 720);
    const cardW = 74;
    const spacing = n > 1 ? Math.min(cardW * 0.72, (maxWidth - 90) / (n - 1)) : 0;
    const mid = (n - 1) / 2;
    const stepRot = n > 1 ? Math.min(4, 50 / n) : 0;

    const prev = APP.prevHandIds;
    const freshIds = new Set();
    hand.forEach((c) => { if (!prev || !prev.has(c.id)) freshIds.add(c.id); });
    APP.prevHandIds = new Set(hand.map((c) => c.id));

    hand.forEach((c, i) => {
      const slot = document.createElement('div');
      const isNew = freshIds.has(c.id);
      slot.className = 'slot' + (legal.has(c.id) ? ' legal' : ' illegal') + (isNew ? ' dealt' : '');
      slot.style.setProperty('--x', ((i - mid) * spacing) + 'px');
      slot.style.setProperty('--rot', ((i - mid) * stepRot) + 'deg');
      slot.style.zIndex = i;
      const card = Anim.cardEl(c);
      if (!legal.has(c.id)) card.classList.add('illegal');
      card.addEventListener('click', () => onCardClick(view, c, legal));
      slot.appendChild(card);
      handEl.appendChild(slot);
    });

    let d = 0;
    handEl.querySelectorAll('.slot.dealt').forEach((s) => {
      s.style.animationDelay = Math.min(d++ * 35, 550) + 'ms';
    });
  }

  function onCardClick(view, card, legal) {
    if (!legal.has(card.id)) {
      const t = view.trick;
      if (view.turnId !== view.you.id) {
        toast('Not your turn');
      } else if (view.phase === 'opening') {
        toast('You must open with the Ace of Spades ♠');
      } else if (t) {
        toast(`You must follow ${t.ledSuit} if you have it`);
      }
      return;
    }
    Soundboard.unlock();
    Soundboard.sfx('card');
    socket.emit('playCard', { cardId: card.id });
  }

  function renderTurnBanner(view, players) {
    const b = $('#turnBanner');
    if (view.over) {
      b.textContent = '';
      b.className = 'turn-banner';
      return;
    }
    const opening = view.phase === 'opening';
    const turnPlayer = (APP.lobby && APP.lobby.players || []).find((x) => x.id === view.turnId);
    if (turnPlayer && turnPlayer.connected === false && view.turnId !== view.you.id) {
      b.textContent = turnPlayer.away
        ? `${playerName(view.turnId)} is away — auto-playing…`
        : `${playerName(view.turnId)} lost connection — waiting…`;
      b.className = 'turn-banner wait';
      return;
    }
    if (view.turnId === view.you.id) {
      b.textContent = opening
        ? 'Your turn — open with the Ace of Spades ♠'
        : (view.trick ? `Your turn — follow ${view.trick.ledSuit} or play a Thulla!` : 'Your turn — lead any card!');
      b.className = 'turn-banner mine';
    } else if (opening) {
      b.textContent = `${playerName(view.turnId)} opens with the Ace of Spades…`;
      b.className = 'turn-banner wait';
    } else {
      b.textContent = `Waiting for ${playerName(view.turnId)}…`;
      b.className = 'turn-banner wait';
    }
  }

  function handleEvent(ev, view, players) {
    if (ev.type === 'autoplay') {
      const me = ev.playerId === view.you.id;
      toast(me ? 'You are away — a random card was auto-played for you'
        : `${playerName(ev.playerId)} is away — auto-played a card`, 'error');
    }
    if (ev.type === 'deal') {
      Soundboard.sfx('deal');
    }
    if (ev.type === 'play') {
      // Own card plays already clicked audibly; others' plays sound on arrival.
      if (ev.playerId !== view.you.id) Soundboard.sfx('card');
      if (ev.thulla) toast(`${playerName(ev.playerId)} played a Thulla!`, 'error');
    }
    if (ev.type === 'pickup') {
      const name = playerName(ev.playerId);
      if (ev.reason === 'thulla') {
        Anim.showThulla(name, ev.callout);
        Soundboard.play('vineboom');
        Soundboard.sfx('shuffle');
      } else {
        toast(`${name} had to pick up ${ev.count} cards`, 'error');
        Soundboard.play('womp');
      }
      const seat = document.querySelector(`.seat[data-player-id="${ev.playerId}"]`);
      if (seat) {
        seat.classList.add('hit');
        setTimeout(() => seat.classList.remove('hit'), 800);
      }
      // Slide the whole pile into the collector's deck.
      Anim.flyPileAway($('#pile'), seat, { duration: 620, stagger: 42, scale: 0.35, rotate: 14 });
    }
    if (ev.type === 'sweep') {
      const seat = document.querySelector(`.seat[data-player-id="${ev.winnerId}"]`);
      if (seat) seat.classList.add('flash-red');
      Soundboard.sfx('shuffle');
      // Slide the beaten trick into the Saar pile.
      Anim.flyPileAway($('#pile'), $('#saarStack') || $('#saar'), { duration: 600, stagger: 42, scale: 0.5 });
    }
    if (ev.type === 'out') {
      ev.playerIds.forEach((id) => {
        const name = playerName(id);
        if (id === view.you.id) toast('You got away! 🎉');
        else toast(`${name} got away!`);
      });
      Soundboard.play('ding');
    }
    if (ev.type === 'reenter') {
      const name = playerName(ev.playerId);
      toast(idIsYou(ev.playerId, view) ? 'You drew a card from the Saar and are back in!' : `${name} is back in from the Saar!`, 'sound');
      const seat = document.querySelector(`.seat[data-player-id="${ev.playerId}"]`);
      Anim.flyCardFromTo($('#saarStack') || $('#saar'), seat, { duration: 560 });
    }
    if (ev.type === 'gameover') {
      showGameOver(ev, view, players);
    }
  }

  function idIsYou(id, view) {
    return !!(view && view.you && id === view.you.id);
  }

  let goTimer = null;

  function showGameOver(ev, view) {
    closeEl($('#thullaOverlay'));
    APP.gameOver = true;
    $('#goLoser').textContent = ev.loserId === view.you.id ? 'You are the Bhabhi!' : playerName(ev.loserId);

    // A dedicated Bhabhi/loser GIF (from /gifs/bhabhi), not the Thulla set.
    const gif = Anim.randomBhabhiGif();
    const img = $('#goGif');
    if (gif) { img.src = gif.file; img.style.display = ''; img.onerror = () => { img.style.display = 'none'; }; }
    else img.style.display = 'none';

    // Leaderboard: escape order first (winner → …), the Bhabhi dead last.
    const ol = $('#goWinners');
    ol.innerHTML = '';
    const order = [...(ev.winners || [])];
    if (ev.loserId && !order.includes(ev.loserId)) order.push(ev.loserId);
    if (!order.length) order.push(ev.loserId);
    order.forEach((id, i) => {
      const li = document.createElement('li');
      const you = id === view.you.id ? ' (you)' : '';
      if (i === order.length - 1) {
        li.className = 'go-loser-row';
        li.textContent = `💀 ${playerName(id)}${you} — Bhabhi`;
      } else {
        li.textContent = `#${i + 1} ${playerName(id)}${you}`;
      }
      ol.appendChild(li);
    });

    APP.rematch = APP.rematch || { votes: [], total: 0, ready: 0, need: 2 };
    renderRematch();
    openEl($('#gameOverOverlay'));
    Soundboard.play('sadtrombone');

    // Leaderboard fades by itself after 10s (or on tap); the Play-Again bar stays.
    clearTimeout(goTimer);
    goTimer = setTimeout(hideGameOverOverlay, 10000);
    $('#gameOverOverlay').onclick = hideGameOverOverlay;
  }

  function hideGameOverOverlay() {
    clearTimeout(goTimer);
    closeEl($('#gameOverOverlay'));
    renderRematch();
  }

  function renderRematch() {
    const bar = $('#rematchBar');
    const voted = !!((APP.rematch && APP.rematch.votes) || []).includes(APP.selfId);
    const r = APP.rematch || { votes: [], total: 0, ready: 0, need: 2 };
    const btnLabel = voted ? 'Ready ✓ — tap to cancel' : 'Play Again';

    if (!APP.gameOver) {
      if (bar) bar.classList.add('hidden');
    } else if (bar) {
      bar.classList.remove('hidden');
    }
    const overlayBtn = $('#playAgainBtn');
    if (overlayBtn) {
      overlayBtn.textContent = btnLabel;
      overlayBtn.classList.toggle('on', voted);
    }
    const barBtn = $('#rematchBtn');
    if (barBtn) {
      barBtn.textContent = btnLabel;
      barBtn.classList.toggle('on', voted);
    }
    $('#backToLobbyBtn') && $('#backToLobbyBtn').classList.toggle('hidden', !APP.isHost);
    $('#backToLobby2Btn') && $('#backToLobby2Btn').classList.toggle('hidden', !APP.isHost);

    const status = $('#rematchStatus');
    if (status) {
      if (r.total < (r.need || 2)) status.textContent = `Waiting for players… (${r.total}/${r.need || 2})`;
      else if (voted) status.textContent = `Waiting for others… ${r.ready}/${r.total} ready`;
      else status.textContent = `${r.ready}/${r.total} ready — tap Play Again`;
    }
  }

  function voteRematch() { if (APP.gameOver) socket.emit('rematch'); }

  /* ---------------- boot ---------------- */
  (async function boot() {
    Anim.loadGifs();
    try {
      const r = await fetch('/sounds/manifest.json', { cache: 'no-cache' });
      Soundboard.registerFileSounds(await r.json());
      Soundboard.renderGrid($('#soundGrid'), playSound);
    } catch (e) { /* optional */ }
    window.addEventListener('resize', () => { if (APP.lastView && APP.ready) renderHand(APP.lastView); });
  })();

  // Unlock audio and remote peer audio on the first (and any) user gesture.
  document.addEventListener('pointerdown', () => {
    Soundboard.unlock();
    WebRTC.resumeAudio();
  });
})();
