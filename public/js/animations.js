'use strict';
/* Visual helpers: card DOM, the game-start sequence, the Thulla reaction
 * overlay and the GIF library loader. */
(function () {
  const Anim = { gifs: [] };

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
    try {
      const res = await fetch('/gifs/manifest.json', { cache: 'no-cache' });
      const data = await res.json();
      Anim.gifs = (Array.isArray(data) ? data : data.gifs || []).map((g) =>
        typeof g === 'string' ? { file: g } : g
      );
    } catch (e) {
      Anim.gifs = [];
    }
    return Anim.gifs;
  };

  Anim.randomGif = function () {
    if (!Anim.gifs.length) return null;
    return Anim.gifs[Math.floor(Math.random() * Anim.gifs.length)];
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
  Anim.showThulla = function (who) {
    const overlay = document.getElementById('thullaOverlay');
    const img = document.getElementById('thullaGif');
    const whoEl = document.getElementById('thullaWho');

    const gif = Anim.randomGif();
    if (gif) {
      img.src = gif.file;
      img.style.display = '';
      img.onerror = () => { img.style.display = 'none'; };
    } else {
      img.style.display = 'none';
    }
    whoEl.textContent = who ? `${who} gets a Thulla!` : 'Thulla!';

    overlay.classList.remove('hidden');
    const inner = overlay.querySelector('.thulla-inner');
    inner.style.animation = 'none';
    void inner.offsetWidth;
    inner.style.animation = '';

    clearTimeout(thullaTimer);
    thullaTimer = setTimeout(() => overlay.classList.add('hidden'), 2400);
  };

  /* ---------------- flying card helper ---------------- */
  Anim.fly = function (fromRect, toRect, cardData, container) {
    const el = Anim.cardEl(cardData, { small: true });
    el.style.position = 'fixed';
    el.style.left = fromRect.left + 'px';
    el.style.top = fromRect.top + 'px';
    el.style.zIndex = 55;
    el.style.transition = 'transform .42s cubic-bezier(.2,.8,.2,1), opacity .42s';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
    const dx = toRect.left - fromRect.left + (toRect.width - fromRect.width) / 2;
    const dy = toRect.top - fromRect.top + (toRect.height - fromRect.height) / 2;
    requestAnimationFrame(() => {
      el.style.transform = `translate(${dx}px, ${dy}px) scale(.9) rotate(8deg)`;
    });
    setTimeout(() => el.remove(), 460);
  };

  window.Anim = Anim;
})();
