'use strict';
/* Visual helpers: card DOM, the game-start sequence, the Thulla reaction
 * overlay and the GIF library loader. */
(function () {
  const Anim = { gifs: [], bhabhiGifs: [] };

  const SUIT_GLYPH = { '♠': '♠', '♥': '♥', '♦': '♦', '♣': '♣' };

  Anim.cardEl = function (card, opts = {}) {
    const el = document.createElement('div');
    el.className = 'card' + (card.red ? ' red' : '') + (opts.small ? ' small' : '') +
      (opts.back ? ' back' : '');
    el.dataset.cardId = card.id || '';
    if (!opts.back) {
      const suit = SUIT_GLYPH[card.suit] || card.suit;
      el.innerHTML =
        `<div class="tl">${card.rank}<span>${suit}</span></div>` +
        `<div class="pip">${suit}</div>` +
        `<div class="br">${card.rank}<span>${suit}</span></div>`;
    }
    return el;
  };

  /* ---------------- GIF library ---------------- */
  Anim.loadGifs = async function () {
    // The server auto-discovers every image, so you can add or replace GIFs by
    // dropping files into public/gifs/ (Thulla) or public/gifs/bhabhi/ (loser).
    try {
      const res = await fetch('/gifs/index.json', { cache: 'no-cache' });
      const data = await res.json();
      const norm = (arr) => (Array.isArray(arr) ? arr : []).map((g) => (typeof g === 'string' ? { file: g } : g));
      Anim.gifs = norm(data.gifs);
      Anim.bhabhiGifs = norm(data.bhabhi);
    } catch (e) {
      Anim.gifs = [];
      Anim.bhabhiGifs = [];
    }
    return Anim.gifs;
  };

  Anim.randomGif = function () {
    if (!Anim.gifs.length) return null;
    return Anim.gifs[Math.floor(Math.random() * Anim.gifs.length)];
  };

  /** Random loser/Bhabhi GIF; falls back to the Thulla pool if that folder is empty. */
  Anim.randomBhabhiGif = function () {
    const pool = Anim.bhabhiGifs.length ? Anim.bhabhiGifs : Anim.gifs;
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  };

  /* ---------------- game start sequence ---------------- */
  Anim.playStartAnimation = function () {
    return new Promise((resolve) => {
      const overlay = document.getElementById('startOverlay');
      const title = document.getElementById('startTitle');
      const count = document.getElementById('startCount');
      const deck = document.getElementById('dealDeck');

      deck.innerHTML = '';
      for (let i = 0; i < 3; i++) {
        const c = document.createElement('div');
        c.className = 'card back';
        deck.appendChild(c);
      }
      title.textContent = 'Shuffling the deck…';
      count.textContent = '';
      overlay.classList.remove('hidden');

      const steps = ['3', '2', '1', 'DEAL!'];
      let i = 0;
      const tick = () => {
        if (i >= steps.length) {
          overlay.classList.add('hidden');
          resolve();
          return;
        }
        const s = steps[i++];
        count.textContent = s;
        count.style.animation = 'none';
        void count.offsetWidth;
        count.style.animation = '';
        if (i === 1) title.textContent = 'Get ready!';
        setTimeout(tick, i === steps.length ? 650 : 700);
      };
      setTimeout(tick, 700);
    });
  };

  /* ---------------- Thulla reaction overlay ---------------- */
  let thullaTimer = null;
  // `callout` is chosen by the server so every player sees the same shout.
  Anim.showThulla = function (who, callout) {
    const overlay = document.getElementById('thullaOverlay');
    const textEl = document.getElementById('thullaCallout');
    const whoEl = document.getElementById('thullaWho');

    if (textEl) textEl.textContent = callout || 'THULLA!';
    if (whoEl) whoEl.textContent = who ? `${who} gets a Thulla!` : 'Thulla!';

    overlay.classList.remove('hidden');
    const inner = overlay.querySelector('.thulla-inner');
    inner.style.animation = 'none';
    void inner.offsetWidth;
    inner.style.animation = '';

    clearTimeout(thullaTimer);
    thullaTimer = setTimeout(() => overlay.classList.add('hidden'), 2600);
  };

  /* ---------------- card-flight helpers (pickup / sweep / saar draws) ---------------- */

  const FLY_CLASSES = ['anim-in-bottom', 'anim-in-top', 'anim-in-left', 'anim-in-right',
    'anim-pickup', 'anim-sweep', 'dealt'];
  const FLY_EASE = 'cubic-bezier(.45,.05,.35,1)';

  /**
   * Move every card currently in `pileEl` into `targetEl` with a slide, clearing
   * the pile immediately so nothing lingers. Used for Thulla pickups (→ seat)
   * and unbeaten tricks (→ Saar).
   */
  Anim.flyPileAway = function (pileEl, targetEl, opts = {}) {
    if (!pileEl) return;
    const cards = Array.from(pileEl.querySelectorAll('.card'));
    const rects = cards.map((c) => c.getBoundingClientRect());
    pileEl.innerHTML = '';
    if (!targetEl || !cards.length) return;
    const tr = targetEl.getBoundingClientRect();
    if (!tr.width) return;
    const tx = tr.left + tr.width / 2;
    const ty = tr.top + tr.height / 2;
    const dur = opts.duration || 600;
    const stagger = opts.stagger != null ? opts.stagger : 40;
    cards.forEach((card, i) => {
      const r = rects[i];
      if (!r.width) return;
      const ghost = card.cloneNode(true);
      FLY_CLASSES.forEach((c) => ghost.classList.remove(c));
      Object.assign(ghost.style, {
        position: 'fixed', left: r.left + 'px', top: r.top + 'px',
        width: r.width + 'px', height: r.height + 'px', margin: '0',
        zIndex: '85', pointerEvents: 'none', animation: 'none',
        transition: `transform ${dur}ms ${FLY_EASE}, opacity ${dur}ms ease`,
      });
      document.body.appendChild(ghost);
      const dx = tx - (r.left + r.width / 2);
      const dy = ty - (r.top + r.height / 2);
      const delay = i * stagger;
      requestAnimationFrame(() => {
        setTimeout(() => {
          ghost.style.transform =
            `translate(${dx}px, ${dy}px) scale(${opts.scale != null ? opts.scale : 0.4}) rotate(${opts.rotate || 0}deg)`;
          ghost.style.opacity = '0';
        }, delay);
      });
      setTimeout(() => ghost.remove(), dur + delay + 80);
    });
  };

  /** Slide a single face-down card from one element to another (e.g. Saar → seat). */
  Anim.flyCardFromTo = function (fromEl, toEl, opts = {}) {
    if (!fromEl || !toEl) return;
    const fr = fromEl.getBoundingClientRect();
    const tr = toEl.getBoundingClientRect();
    if (!fr.width || !tr.width) return;
    const w = 52, h = 74;
    const dur = opts.duration || 560;
    const ghost = document.createElement('div');
    ghost.className = 'card back small';
    Object.assign(ghost.style, {
      position: 'fixed', left: (fr.left + fr.width / 2 - w / 2) + 'px',
      top: (fr.top + fr.height / 2 - h / 2) + 'px', width: w + 'px', height: h + 'px',
      margin: '0', zIndex: '85', pointerEvents: 'none',
      transition: `transform ${dur}ms ${FLY_EASE}, opacity ${dur}ms ease`,
    });
    document.body.appendChild(ghost);
    const dx = (tr.left + tr.width / 2) - (fr.left + fr.width / 2);
    const dy = (tr.top + tr.height / 2) - (fr.top + fr.height / 2);
    requestAnimationFrame(() => {
      ghost.style.transform = `translate(${dx}px, ${dy}px) scale(.6) rotate(-8deg)`;
      ghost.style.opacity = '0';
    });
    setTimeout(() => ghost.remove(), dur + 80);
  };

  window.Anim = Anim;
})();
