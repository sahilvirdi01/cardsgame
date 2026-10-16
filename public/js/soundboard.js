'use strict';
/* Soundboard: custom sound files dropped into /public/sounds and listed in
 * /public/sounds/manifest.json are played as <audio> elements. A few
 * synthesized cues are kept purely for automatic game events (thulla, pickup,
 * escape, game over) and are not shown on the board.
 *
 * Game SFX (card, deal, shuffle) can be replaced with your own audio file:
 * add an entry to manifest.json with "hidden": true (e.g.
 * { "id": "card", "label": "Card", "file": "/sounds/card.mp3", "hidden": true })
 * — SB.sfx() will then play that file instead of the synth.
 *
 * Only ONE sound plays at a time: starting any new sound stops the previous
 * one immediately. */
(function () {
  const SB = {
    ac: null,
    master: null,
    sounds: new Map(),
    files: new Map(),
    hidden: new Set(),     // file ids that are SFX-only (not shown on the board)
    nodes: new Set(),      // active Web Audio sources (game cues)
    currentAudio: null,    // currently playing <audio>
  };

  function ctx() {
    if (!SB.ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      SB.ac = new AC();
      SB.master = SB.ac.createGain();
      SB.master.gain.value = 0.85;
      SB.master.connect(SB.ac.destination);
    }
    if (SB.ac.state === 'suspended') SB.ac.resume();
    return SB.ac;
  }
  SB.unlock = ctx;

  // Keep a handle on every Web Audio source so the whole cue can be silenced.
  function track(node) {
    SB.nodes.add(node);
    node.onended = () => { SB.nodes.delete(node); };
    return node;
  }

  function tone(o) {
    const ac = ctx();
    const t = ac.currentTime + (o.when || 0);
    const dur = o.dur || 0.3;
    const osc = ac.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.slideTo), t + dur);
    if (o.vibrato) {
      const lfo = ac.createOscillator();
      const lfoGain = ac.createGain();
      lfo.frequency.value = o.vibrato.rate || 6;
      lfoGain.gain.value = o.vibrato.depth || 8;
      lfo.connect(lfoGain).connect(osc.frequency);
      track(lfo);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    const g = ac.createGain();
    const peak = o.gain == null ? 0.3 : o.gain;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(SB.master);
    track(osc);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function noise(o) {
    const ac = ctx();
    const t = ac.currentTime + (o.when || 0);
    const dur = o.dur || 0.3;
    const frame = ac.createBuffer(1, Math.max(1, ac.sampleRate * dur), ac.sampleRate);
    const data = frame.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ac.createBufferSource();
    src.buffer = frame;
    const filter = ac.createBiquadFilter();
    filter.type = o.filter || 'highpass';
    filter.frequency.value = o.freq || 1000;
    filter.Q.value = o.Q || 1;
    const g = ac.createGain();
    g.gain.value = o.gain == null ? 0.3 : o.gain;
    src.connect(filter).connect(g).connect(SB.master);
    track(src);
    src.start(t);
    src.stop(t + dur);
  }

  /* ---- independent SFX (card flicks, shuffles) ----
   * These use their own gain bus and are NOT cut by SB.stop(), so a card
   * flick or shuffle can layer under the memes instead of silencing them. */
  let sfxGain = null;
  function sfxBus() {
    const ac = ctx();
    if (!sfxGain) { sfxGain = ac.createGain(); sfxGain.gain.value = 0.9; sfxGain.connect(ac.destination); }
    return sfxGain;
  }
  function sfxNoise(o) {
    const ac = ctx();
    const t = ac.currentTime + (o.when || 0);
    const dur = o.dur || 0.1;
    const frame = ac.createBuffer(1, Math.max(1, ac.sampleRate * dur), ac.sampleRate);
    const data = frame.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ac.createBufferSource();
    src.buffer = frame;
    const filter = ac.createBiquadFilter();
    filter.type = o.filter || 'highpass';
    filter.frequency.value = o.freq || 2000;
    filter.Q.value = o.Q || 1;
    const g = ac.createGain();
    g.gain.value = o.gain == null ? 0.3 : o.gain;
    src.connect(filter).connect(g);
    g.connect(sfxBus());
    src.start(t);
    src.stop(t + dur);
  }

  const SFX = {
    // A card landing on the table: a crisp high-pass snap.
    card: () => {
      sfxNoise({ freq: 2600, Q: 0.7, dur: 0.08, gain: 0.35 });
      sfxNoise({ freq: 1100, Q: 1.0, dur: 0.05, gain: 0.16, when: 0.004, filter: 'bandpass' });
    },
    // Cards sliding/gathering into the Saar or a deck: a soft multi-swipe.
    shuffle: () => {
      for (let i = 0; i < 5; i++) {
        sfxNoise({ freq: 1500 + i * 350, Q: 0.6, dur: 0.12, gain: 0.16, when: i * 0.045, filter: 'bandpass' });
      }
    },
    // The initial deal: a quick riffle.
    deal: () => {
      for (let i = 0; i < 7; i++) {
        sfxNoise({ freq: 1900 + (i % 3) * 500, Q: 0.6, dur: 0.09, gain: 0.14, when: i * 0.04, filter: 'highpass' });
      }
    },
  };
  // Plays a game SFX. If a sound file is registered under this id (see
  // manifest.json with "hidden": true) it plays that file; otherwise it falls
  // back to the synthesized cue.
  SB.sfx = function (name) {
    const file = SB.files.get(name);
    if (file) {
      try { const a = new Audio(file); a.volume = 0.9; a.play(); return; } catch (e) { /* fall through */ }
    }
    const fn = SFX[name];
    if (fn) { try { fn(); } catch (e) { /* ignore */ } }
  };

  // ---- synthesized cues for automatic game events (not shown on the board) ----
  const defs = [
    ['vineboom', 'Vine Boom', '💥', () => {
      tone({ freq: 130, slideTo: 45, dur: 0.55, type: 'sine', gain: 0.55 });
      tone({ freq: 80, slideTo: 38, dur: 0.6, type: 'triangle', gain: 0.4, when: 0.02 });
    }],
    ['womp', 'Womp Womp', '😭', () => {
      tone({ freq: 300, slideTo: 180, dur: 0.35, type: 'sawtooth', gain: 0.3, vibrato: { rate: 4, depth: 10 } });
      tone({ freq: 260, slideTo: 140, dur: 0.5, type: 'sawtooth', gain: 0.26, when: 0.35, vibrato: { rate: 4, depth: 12 } });
    }],
    ['ding', 'Correct Ding', '🔔', () => {
      tone({ freq: 1318, dur: 0.5, type: 'sine', gain: 0.35 });
      tone({ freq: 1976, dur: 0.4, type: 'sine', gain: 0.18, when: 0.01 });
    }],
    ['sadtrombone', 'Sad Trombone', '🎺', () => {
      [0, 1, 2, 3].forEach((i) => {
        tone({ freq: [220, 208, 196, 165][i], slideTo: [208, 196, 165, 110][i], dur: 0.28, type: 'sawtooth', gain: 0.2, when: i * 0.26, vibrato: { rate: 5, depth: 4 } });
      });
    }],
  ];

  defs.forEach(([id, label, emoji, fn]) => SB.sounds.set(id, { id, label, emoji, synth: fn }));

  /** Silence whatever is playing right now (file or synthesized cue). */
  SB.stop = function () {
    if (SB.currentAudio) {
      try { SB.currentAudio.pause(); SB.currentAudio.currentTime = 0; } catch (e) { /* ignore */ }
      SB.currentAudio = null;
    }
    for (const node of SB.nodes) {
      try { node.onended = null; node.stop(0); } catch (e) { /* ignore */ }
      try { node.disconnect(); } catch (e) { /* ignore */ }
    }
    SB.nodes.clear();
  };

  SB.play = function (id) {
    SB.stop(); // one sound at a time — cut the previous one immediately
    const s = SB.sounds.get(id);
    if (s && s.synth) { try { s.synth(); } catch (e) { /* ignore */ } }
    const file = SB.files.get(id);
    if (file) {
      try {
        const a = new Audio(file);
        a.volume = 0.9;
        SB.currentAudio = a;
        a.play();
      } catch (e) { /* ignore */ }
    }
  };

  SB.registerFileSounds = function (manifest) {
    (manifest || []).forEach((s) => {
      if (!s || !s.id || !s.file) return;
      SB.files.set(s.id, s.file);
      if (s.hidden) SB.hidden.add(s.id);
      if (!SB.sounds.has(s.id)) SB.sounds.set(s.id, { id: s.id, label: s.label || s.id, emoji: s.emoji || '🔊', synth: null });
    });
  };

  SB.renderGrid = function (container, onClick) {
    container.innerHTML = '';
    for (const s of SB.sounds.values()) {
      if (!SB.files.has(s.id) || SB.hidden.has(s.id)) continue; // board shows only visible custom sounds
      const b = document.createElement('button');
      b.className = 'sound-btn';
      b.type = 'button';
      b.dataset.sound = s.id;
      b.innerHTML = `<span class="pb" aria-hidden="true">▶</span><span>${s.label}</span>`;
      b.addEventListener('click', () => onClick(s.id));
      container.appendChild(b);
    }
  };

  window.Soundboard = SB;
})();
