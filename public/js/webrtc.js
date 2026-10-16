'use strict';
/* WebRTC peer-to-peer mesh for optional mic + camera.
 * Signalling rides on the existing Socket.IO connection. Uses the
 * "perfect negotiation" pattern so glare is handled automatically. */
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
    onUpdate: null,       // (peerId) => void
    onLocalChange: null,
  };

  function newStream() {
    try { return new MediaStream(); } catch (e) { return null; }
  }

  function ensurePeer(peerId) {
    let peer = WebRTC.peers.get(peerId);
    if (peer) return peer;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peer = {
      id: peerId,
      pc,
      polite: WebRTC.selfId > peerId,   // determines who yields on offer glare
      makingOffer: false,
      ignoreOffer: false,
      answerPending: false,
      stream: newStream(),
      audioEl: null,
      mic: false,
      cam: false,
    };
    WebRTC.peers.set(peerId, peer);

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
      const { track, streams } = ev;
      if (streams && streams[0] && peer.stream !== streams[0]) {
        peer.stream = streams[0];
      } else if (!peer.stream) {
        peer.stream = newStream();
        peer.stream.addTrack(track);
      }
      track.onunmute = () => notify(peerId);
      attachAudioSink(peerId);
      notify(peerId);
    };

    pc.onconnectionstatechange = () => notify(peerId);

    if (WebRTC.localStream) {
      WebRTC.localStream.getTracks().forEach((t) => pc.addTrack(t, WebRTC.localStream));
    }
    return peer;
  }

  function attachAudioSink(peerId) {
    const peer = WebRTC.peers.get(peerId);
    if (!peer) return;
    if (!peer.stream) return;
    if (!peer.audioEl) {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.playsInline = true;
      document.getElementById('audioSink').appendChild(el);
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

  function notify(peerId) { if (WebRTC.onUpdate) WebRTC.onUpdate(peerId); }

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
          const readyForOffer = !peer.makingOffer &&
            (pc.signalingState === 'stable' || peer.answerPending);
          const offerCollision = data.description.type === 'offer' && !readyForOffer;
          peer.ignoreOffer = !peer.polite && offerCollision;
          if (peer.ignoreOffer) return;
          peer.answerPending = data.description.type === 'answer';
          await pc.setRemoteDescription(data.description);
          peer.answerPending = false;
          if (data.description.type === 'offer') {
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

  function addTrackToAll(track) {
    for (const peer of WebRTC.peers.values()) {
      try { peer.pc.addTrack(track, WebRTC.localStream); } catch (e) {}
    }
  }

  WebRTC.setMic = async function (on) {
    if (on) {
      const existing = WebRTC.localStream &&
        WebRTC.localStream.getAudioTracks().find((t) => t.readyState === 'live');
      if (existing) { existing.enabled = true; }
      else {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        const track = s.getAudioTracks()[0];
        if (!WebRTC.localStream) WebRTC.localStream = newStream();
        WebRTC.localStream.addTrack(track);
        addTrackToAll(track);
      }
      WebRTC.media.mic = true;
    } else {
      const t = WebRTC.localStream && WebRTC.localStream.getAudioTracks()[0];
      if (t) t.enabled = false;
      WebRTC.media.mic = false;
    }
    if (WebRTC.onLocalChange) WebRTC.onLocalChange(WebRTC.media);
  };

  WebRTC.setCam = async function (on) {
    if (on) {
      const existing = WebRTC.localStream &&
        WebRTC.localStream.getVideoTracks().find((t) => t.readyState === 'live');
      if (existing) { existing.enabled = true; }
      else {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 480 }, height: { ideal: 360 } } });
        const track = s.getVideoTracks()[0];
        if (!WebRTC.localStream) WebRTC.localStream = newStream();
        WebRTC.localStream.addTrack(track);
        addTrackToAll(track);
      }
      WebRTC.media.cam = true;
    } else {
      const t = WebRTC.localStream && WebRTC.localStream.getVideoTracks()[0];
      if (t) t.enabled = false;
      WebRTC.media.cam = false;
    }
    if (WebRTC.onLocalChange) WebRTC.onLocalChange(WebRTC.media);
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
    for (const id of [...WebRTC.peers.keys()]) WebRTC.removePeer(id);
    if (WebRTC.localStream) {
      WebRTC.localStream.getTracks().forEach((t) => t.stop());
      WebRTC.localStream = null;
    }
    WebRTC.media = { mic: false, cam: false };
  };

  window.WebRTC = WebRTC;
})();
