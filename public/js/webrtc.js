'use strict';
/* WebRTC peer-to-peer mesh for optional mic + camera.
 *
 * Signalling rides on the existing Socket.IO connection and uses the
 * "perfect negotiation" pattern so glare is handled automatically.
 *
 * Audio and video transceivers are created up-front (sendrecv) and media is
 * attached with replaceTrack(). That means turning the mic/camera on or off
 * never triggers a fresh offer/answer round-trip, which removes a whole class
 * of race conditions that used to leave one side sending no media at all. */
(function () {
  const RTC_CONFIG = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    ],
  };
  if (window.__TURN__) RTC_CONFIG.iceServers.push(window.__TURN__);

  const WebRTC = {
    socket: null,
    selfId: null,
    localStream: null,
    peers: new Map(),     // peerId -> peer object
    media: { mic: false, cam: false },
    micDeviceId: safeGet('bhabhi:mic'),
    camDeviceId: safeGet('bhabhi:cam'),
    onUpdate: null,       // (peerId) => void
    onLocalChange: null,  // (media) => void
    onMicLevel: null,     // (0..1) => void
  };

  function safeGet(k) { try { return localStorage.getItem(k) || null; } catch (e) { return null; } }
  function safeSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }

  function currentTrack(kind) {
    if (!WebRTC.localStream) return null;
    const list = kind === 'audio' ? WebRTC.localStream.getAudioTracks() : WebRTC.localStream.getVideoTracks();
    return list.find((t) => t.readyState === 'live') || null;
  }

  function localStream() {
    if (!WebRTC.localStream) WebRTC.localStream = new MediaStream();
    return WebRTC.localStream;
  }

  function notify(peerId) { if (WebRTC.onUpdate) WebRTC.onUpdate(peerId); }

  function ensurePeer(peerId) {
    let peer = WebRTC.peers.get(peerId);
    if (peer) return peer;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peer = {
      id: peerId,
      pc,
      polite: String(WebRTC.selfId || '') > peerId, // who yields on offer glare
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      stream: new MediaStream(),   // remote tracks, assembled locally
      audioEl: null,
      mic: false,
      cam: false,
      // Reserve the m-lines now so toggling media later needs no renegotiation.
      audioTx: pc.addTransceiver('audio', { direction: 'sendrecv' }),
      videoTx: pc.addTransceiver('video', { direction: 'sendrecv' }),
    };
    WebRTC.peers.set(peerId, peer);

    // Attach whatever media we already have.
    const a = currentTrack('audio');
    const v = currentTrack('video');
    if (a) peer.audioTx.sender.replaceTrack(a).catch(() => {});
    if (v) peer.videoTx.sender.replaceTrack(v).catch(() => {});

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        WebRTC.socket.emit('signal', { to: peerId, data: { description: pc.localDescription } });
      } catch (e) { console.warn('nego error', e); }
      finally { peer.makingOffer = false; }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) WebRTC.socket.emit('signal', { to: peerId, data: { candidate } });
    };

    pc.ontrack = (ev) => {
      const track = ev.track;
      if (!peer.stream.getTracks().includes(track)) peer.stream.addTrack(track);
      track.onmute = () => notify(peerId);
      track.onunmute = () => { attachAudioSink(peerId); notify(peerId); };
      track.onended = () => notify(peerId);
      attachAudioSink(peerId);
      notify(peerId);
    };

    pc.onconnectionstatechange = () => notify(peerId);
    return peer;
  }

  function attachAudioSink(peerId) {
    const peer = WebRTC.peers.get(peerId);
    if (!peer || !peer.stream) return;
    if (!peer.audioEl) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      const sink = document.getElementById('audioSink');
      if (sink) sink.appendChild(el);
      else document.body.appendChild(el);
      peer.audioEl = el;
    }
    if (peer.audioEl.srcObject !== peer.stream) peer.audioEl.srcObject = peer.stream;
    peer.audioEl.play().catch(() => {});
  }

  /** Autoplay policies block remote audio until a user gesture — retry on demand. */
  WebRTC.resumeAudio = function () {
    for (const peer of WebRTC.peers.values()) {
      if (peer.audioEl) peer.audioEl.play().catch(() => {});
    }
  };

  WebRTC.init = function (socket) {
    if (WebRTC._inited) return;
    WebRTC._inited = true;
    WebRTC.socket = socket;
    // NOTE: WebRTC.selfId must be the stable *player* id (set after join), not
    // the transient socket id — the server relays signals by player id.
    socket.on('signal', async ({ from, data }) => {
      const peer = ensurePeer(from);
      const pc = peer.pc;
      try {
        if (data.description) {
          const desc = data.description;
          const readyForOffer = !peer.makingOffer &&
            (pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
          const offerCollision = desc.type === 'offer' && !readyForOffer;
          peer.ignoreOffer = !peer.polite && offerCollision;
          if (peer.ignoreOffer) return;
          peer.isSettingRemoteAnswerPending = desc.type === 'answer';
          await pc.setRemoteDescription(desc); // implicit rollback for the polite peer
          peer.isSettingRemoteAnswerPending = false;
          if (desc.type === 'offer') {
            await pc.setLocalDescription();
            socket.emit('signal', { to: from, data: { description: pc.localDescription } });
          }
        } else if (data.candidate) {
          try { await pc.addIceCandidate(data.candidate); }
          catch (e) { if (!peer.ignoreOffer) throw e; }
        }
      } catch (e) { console.warn('signal handling error', e); }
    });
  };

  /** Keep a peer connection open to every other player. */
  WebRTC.syncPeers = function (ids) {
    ids.forEach((id) => { if (id !== WebRTC.selfId) ensurePeer(id); });
    for (const id of [...WebRTC.peers.keys()]) {
      if (!ids.includes(id)) WebRTC.removePeer(id);
    }
  };

  WebRTC.removePeer = function (peerId) {
    const peer = WebRTC.peers.get(peerId);
    if (!peer) return;
    try { peer.pc.close(); } catch (e) {}
    if (peer.audioEl) peer.audioEl.remove();
    WebRTC.peers.delete(peerId);
    notify(peerId);
  };

  async function pushTrack(kind, track) {
    for (const peer of WebRTC.peers.values()) {
      const sender = kind === 'audio' ? peer.audioTx.sender : peer.videoTx.sender;
      try { await sender.replaceTrack(track); } catch (e) { /* ignore */ }
    }
  }

  async function getUserMedia(kind, deviceId) {
    const md = navigator.mediaDevices;
    const withDevice = (base) => (deviceId ? Object.assign({ deviceId: { exact: deviceId } }, base) : base);
    try {
      if (kind === 'audio') {
        return await md.getUserMedia({
          audio: withDevice({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
        });
      }
      return await md.getUserMedia({
        video: withDevice({ width: { ideal: 480 }, height: { ideal: 360 } }),
      });
    } catch (e) {
      // Some microphones/drivers reject the processing constraints — retry with
      // the simplest possible request before giving up.
      if (kind === 'audio') {
        return await md.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      }
      return await md.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true });
    }
  }

  WebRTC.setMic = async function (on, deviceId) {
    if (deviceId !== undefined) {
      WebRTC.micDeviceId = deviceId || null;
      safeSet('bhabhi:mic', WebRTC.micDeviceId);
    }
    if (on) {
      let track = currentTrack('audio');
      if (!track) {
        let stream;
        try {
          stream = await getUserMedia('audio', WebRTC.micDeviceId);
        } catch (e) {
          if (WebRTC.micDeviceId) {
            // Saved device may be gone — retry with the system default.
            WebRTC.micDeviceId = null;
            safeSet('bhabhi:mic', null);
            stream = await getUserMedia('audio', null);
          } else {
            throw e;
          }
        }
        track = stream.getAudioTracks()[0];
        localStream().addTrack(track);
        track.onended = () => { WebRTC.media.mic = false; pushTrack('audio', null); WebRTC.stopMicMeter(); if (WebRTC.onLocalChange) WebRTC.onLocalChange(WebRTC.media); };
      }
      track.enabled = true;
      await pushTrack('audio', track);
      WebRTC.media.mic = true;
      WebRTC.startMicMeter();
    } else {
      const t = currentTrack('audio');
      if (t) t.enabled = false;
      await pushTrack('audio', null);
      WebRTC.media.mic = false;
      WebRTC.stopMicMeter();
    }
    if (WebRTC.onLocalChange) WebRTC.onLocalChange(WebRTC.media);
  };

  WebRTC.setCam = async function (on, deviceId) {
    if (deviceId !== undefined) {
      WebRTC.camDeviceId = deviceId || null;
      safeSet('bhabhi:cam', WebRTC.camDeviceId);
    }
    if (on) {
      let track = currentTrack('video');
      if (!track) {
        let stream;
        try {
          stream = await getUserMedia('video', WebRTC.camDeviceId);
        } catch (e) {
          if (WebRTC.camDeviceId) {
            WebRTC.camDeviceId = null;
            safeSet('bhabhi:cam', null);
            stream = await getUserMedia('video', null);
          } else {
            throw e;
          }
        }
        track = stream.getVideoTracks()[0];
        localStream().addTrack(track);
      }
      track.enabled = true;
      await pushTrack('video', track);
      WebRTC.media.cam = true;
    } else {
      const t = currentTrack('video');
      if (t) t.enabled = false;
      await pushTrack('video', null);
      WebRTC.media.cam = false;
    }
    if (WebRTC.onLocalChange) WebRTC.onLocalChange(WebRTC.media);
  };

  /** Switch the active microphone (used by the device picker). */
  WebRTC.changeMic = async function (deviceId) {
    const wasOn = WebRTC.media.mic;
    if (WebRTC.localStream) {
      WebRTC.localStream.getAudioTracks().forEach((t) => {
        t.onended = null;
        t.stop();
        WebRTC.localStream.removeTrack(t);
      });
    }
    WebRTC.stopMicMeter();
    WebRTC.micDeviceId = deviceId || null;
    safeSet('bhabhi:mic', WebRTC.micDeviceId);
    if (wasOn) await WebRTC.setMic(true, WebRTC.micDeviceId);
  };

  WebRTC.listInputs = async function () {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'audioinput');
    } catch (e) { return []; }
  };

  /* ---------------- microphone level meter (for self-diagnosis) ---------------- */
  let meter = null;
  WebRTC.startMicMeter = async function () {
    if (meter) return;
    const track = currentTrack('audio');
    if (!track) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const src = ac.createMediaStreamSource(new MediaStream([track]));
      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      meter = { ac, src, analyser, data, raf: 0 };
      const tick = () => {
        meter.analyser.getByteFrequencyData(meter.data);
        let sum = 0;
        for (let i = 0; i < meter.data.length; i++) sum += meter.data[i];
        const level = Math.min(1, (sum / meter.data.length) / 60);
        if (WebRTC.onMicLevel) WebRTC.onMicLevel(level);
        meter.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { meter = null; }
  };
  WebRTC.stopMicMeter = function () {
    if (!meter) return;
    cancelAnimationFrame(meter.raf);
    try { meter.src.disconnect(); meter.ac.close(); } catch (e) {}
    meter = null;
    if (WebRTC.onMicLevel) WebRTC.onMicLevel(0);
  };

  WebRTC.attachToVideo = function (videoEl, peerId) {
    if (peerId === 'self') {
      if (WebRTC.localStream) videoEl.srcObject = WebRTC.localStream;
      return;
    }
    const peer = WebRTC.peers.get(peerId);
    if (peer && peer.stream) videoEl.srcObject = peer.stream;
  };

  WebRTC.setRemoteMedia = function (peerId, mic, cam) {
    const peer = WebRTC.peers.get(peerId);
    if (peer) { peer.mic = mic; peer.cam = cam; notify(peerId); }
  };

  WebRTC.cleanup = function () {
    WebRTC.stopMicMeter();
    for (const id of [...WebRTC.peers.keys()]) WebRTC.removePeer(id);
    if (WebRTC.localStream) {
      WebRTC.localStream.getTracks().forEach((t) => t.stop());
      WebRTC.localStream = null;
    }
    WebRTC.media = { mic: false, cam: false };
  };

  window.WebRTC = WebRTC;
})();
