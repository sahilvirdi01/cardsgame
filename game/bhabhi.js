'use strict';

/**
 * Bhabhi / Thulla engine — pure rules, no UI, no networking.
 *
 * Implements the traditional Indian shedding game:
 *   - Standard 52-card deck (no jokers); 3–6 players by default (2–10 supported).
 *   - All cards dealt round-robin, as evenly as possible.
 *   - Ace of Spades holder opens by playing it.
 *   - Ranking A>K>Q>J>10>…>2. Play proceeds in a configurable direction.
 *   - Everyone follows the lead suit if they can; otherwise they play any card,
 *     which is a THULLA: the trick stops and the highest card of the original
 *     lead suit collects the whole pile.
 *   - The first trick is exempt (firstTrickToSaar): it always plays out fully
 *     and its cards go to the saar, so nobody can get a Thulla on the opening turn.
 *   - Empty your hand and you escape. The last player holding cards is the Bhabhi.
 *
 * Regional variations are configurable (see DEFAULT_RULES):
 *   direction, escapeTiming, escapeLead (next leader when a player escapes).
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = [
  { r: '2', v: 2 }, { r: '3', v: 3 }, { r: '4', v: 4 }, { r: '5', v: 5 },
  { r: '6', v: 6 }, { r: '7', v: 7 }, { r: '8', v: 8 }, { r: '9', v: 9 },
  { r: '10', v: 10 }, { r: 'J', v: 11 }, { r: 'Q', v: 12 }, { r: 'K', v: 13 },
  { r: 'A', v: 14 },
];
const DECKS_MAX = 4;

const isRed = (suit) => suit === '♥' || suit === '♦';

/** Default shuffle RNG. Prefer Node's crypto for a uniformly unbiased shuffle,
 *  falling back to Math.random when crypto is unavailable (e.g. in a browser). */
let defaultRng = Math.random;
try {
  // eslint-disable-next-line global-require
  const nodeCrypto = require('crypto');
  if (nodeCrypto && typeof nodeCrypto.randomInt === 'function') {
    defaultRng = () => nodeCrypto.randomInt(0, 0x100000000) / 0x100000000;
  }
} catch (e) { /* keep Math.random */ }

function buildDeck(numDecks) {
  const deck = [];
  for (let d = 0; d < numDecks; d++) {
    for (const suit of SUITS) {
      for (const { r, v } of RANKS) {
        deck.push({ id: `${r}${suit}#${d}`, rank: r, value: v, suit, red: isRed(suit) });
      }
    }
  }
  return deck;
}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const DEFAULT_RULES = {
  decks: 'auto',            // 'auto' | 1 | 2 | 3 | 4   (auto: 1 deck up to 6 players, else 2)
  direction: 'clockwise',   // 'clockwise' | 'anticlockwise'
  escapeTiming: 'trickEnd', // 'trickEnd' | 'immediate' | 'lastCardHighest'
  escapeLead: 'nextActive', // 'nextActive' | 'drawFromSaar'
  requireOpeningAce: true,  // the opener must play A♠
  autoPlayOpeningAce: false,// if true the engine plays the opening A♠ itself
  firstTrickToSaar: true,   // opening trick plays out and sweeps to the saar: no thulla
  shuffleFn: null,          // optional deterministic rng for tests
};

class BhabhiGame {
  constructor(players, opts = {}) {
    if (!Array.isArray(players) || players.length < 2) {
      throw new Error('BhabhiGame needs at least 2 players');
    }
    this.rng = opts.rng || opts.rules?.shuffleFn || defaultRng;
    this.rules = Object.assign({}, DEFAULT_RULES, opts.rules || {});
    this._normaliseRules();

    this.players = players.map((p, i) => ({
      id: p.id,
      nickname: p.nickname,
      seat: i,
      hand: [],
      out: false,          // escaped
      escapedOrder: null,
    }));

    this.numDecks = this._deckCount();
    this.deckSize = this.numDecks * 52;

    this.discard = [];       // cards permanently out of the game ("saar")
    this.trick = null;       // { leaderId, ledSuit, plays[], highest, responders[] }
    this.turnId = null;
    this.leaderId = null;
    this.phase = 'setup';    // 'setup' | 'opening' | 'playing' | 'over'
    this.over = false;
    this.loserId = null;
    this.finished = [];      // player ids in escape order
    this.tricks = 0;
    this.turnCount = 0;

    this._deal();
    this._beginOpening();
  }

  /* ------------------------------------------------------------------ setup */

  _normaliseRules() {
    const r = this.rules;
    if (!['clockwise', 'anticlockwise'].includes(r.direction)) r.direction = 'clockwise';
    if (!['trickEnd', 'immediate', 'lastCardHighest'].includes(r.escapeTiming)) r.escapeTiming = 'trickEnd';
    if (!['nextActive', 'drawFromSaar'].includes(r.escapeLead)) r.escapeLead = 'nextActive';
    r.requireOpeningAce = r.requireOpeningAce !== false;
    r.autoPlayOpeningAce = r.autoPlayOpeningAce === true;
    r.firstTrickToSaar = r.firstTrickToSaar !== false;
  }

  _deckCount() {
    if (this.rules.decks === 'auto') return this.players.length > 6 ? 2 : 1;
    const n = parseInt(this.rules.decks, 10);
    return Math.max(1, Math.min(DECKS_MAX, Number.isFinite(n) ? n : 1));
  }

  get clockDir() {
    return this.rules.direction === 'anticlockwise' ? -1 : 1;
  }

  _deal() {
    const deck = shuffle(buildDeck(this.numDecks), this.rng);
    deck.forEach((card, i) => this.players[i % this.players.length].hand.push(card));
    this.players.forEach((p) => this._sortHand(p));
  }

  _sortHand(p) {
    const order = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };
    p.hand.sort((a, b) => order[a.suit] - order[b.suit] || a.value - b.value);
  }

  _beginOpening() {
    const starter =
      this.players.find((p) => p.hand.some((c) => c.rank === 'A' && c.suit === '♠')) ||
      this.players[0];
    this.leaderId = starter.id;
    this.turnId = starter.id;

    if (!this.rules.requireOpeningAce) {
      this.phase = 'playing';
      return;
    }
    this.phase = 'opening';
    if (this.rules.autoPlayOpeningAce) {
      const ace = starter.hand.find((c) => c.rank === 'A' && c.suit === '♠');
      if (ace) this.playCard(starter.id, ace.id, { auto: true });
    }
  }

  /* ------------------------------------------------------------- accessors */

  get(id) {
    return this.players.find((p) => p.id === id);
  }

  get activePlayers() {
    return this.players.filter((p) => !p.out);
  }

  _pub(card) {
    return { id: card.id, rank: card.rank, suit: card.suit, value: card.value, red: card.red };
  }

  _step(idx, steps) {
    const n = this.players.length;
    return this.players[(((idx + this.clockDir * steps) % n) + n) % n];
  }

  _nextActive(fromIdx) {
    const n = this.players.length;
    for (let s = 1; s <= n; s++) {
      const p = this._step(fromIdx, s);
      if (!p.out) return p;
    }
    return null;
  }

  _orderAfterLeader() {
    const leaderIdx = this.players.findIndex((p) => p.id === this.leaderId);
    const n = this.players.length;
    const order = [];
    for (let s = 1; s < n; s++) {
      const p = this._step(leaderIdx, s);
      if (!p.out) order.push(p.id);
    }
    return order;
  }

  /* --------------------------------------------------------------- moves */

  /** Legal card ids for a player right now (empty array if not their turn). */
  legalMoves(playerId) {
    if (this.over || this.turnId !== playerId) return [];
    const p = this.get(playerId);
    if (!p || p.out) return [];
    if (this.phase === 'opening' && this.rules.requireOpeningAce) {
      const ace = p.hand.find((c) => c.rank === 'A' && c.suit === '♠');
      return ace ? [ace.id] : p.hand.map((c) => c.id);
    }
    if (!this.trick) return p.hand.map((c) => c.id);
    const hasSuit = p.hand.some((c) => c.suit === this.trick.ledSuit);
    return hasSuit
      ? p.hand.filter((c) => c.suit === this.trick.ledSuit).map((c) => c.id)
      : p.hand.map((c) => c.id);
  }

  /** Play a card. Returns { ok, error?, events }. Invalid moves never mutate state. */
  playCard(playerId, cardId) {
    if (this.over) return { ok: false, error: 'Game is over' };
    const player = this.get(playerId);
    if (!player) return { ok: false, error: 'Unknown player' };
    if (player.out) return { ok: false, error: 'You have already escaped this round' };
    if (this.turnId !== playerId) return { ok: false, error: 'Not your turn' };

    const idx = player.hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return { ok: false, error: 'Card is not in your hand' };
    const card = player.hand[idx];

    if (this.phase === 'opening' && this.rules.requireOpeningAce) {
      if (!(card.rank === 'A' && card.suit === '♠')) {
        return { ok: false, error: 'You must open with the Ace of Spades' };
      }
    }

    const leading = !this.trick;
    if (!leading) {
      const hasSuit = player.hand.some((c) => c.suit === this.trick.ledSuit);
      if (hasSuit && card.suit !== this.trick.ledSuit) {
        return { ok: false, error: `You must follow ${this.trick.ledSuit}` };
      }
    }

    if (leading) {
      this.trick = { leaderId: player.id, ledSuit: card.suit, plays: [], highest: null, responders: [] };
    }

    // ---- commit ----
    player.hand.splice(idx, 1);
    this.turnCount++;
    const isThulla = !leading && card.suit !== this.trick.ledSuit;
    // The opening/first trick always plays out to the saar, so no thulla can bite yet.
    const firstTrick = this.rules.firstTrickToSaar && this.tricks === 0;
    const effectiveThulla = isThulla && !firstTrick;
    const pub = this._pub(card);
    this.trick.plays.push({ playerId: player.id, card: pub, order: this.trick.plays.length });
    if (card.suit === this.trick.ledSuit) {
      if (!this.trick.highest || card.value > this.trick.highest.value) {
        this.trick.highest = { playerId: player.id, value: card.value, card: pub };
      }
    }

    const events = [{ type: 'play', playerId: player.id, card: pub, thulla: effectiveThulla }];

    if (leading) {
      this.phase = 'playing';
      this.leaderId = player.id;
      this.trick.responders = this._orderAfterLeader();
    } else {
      this.trick.responders = this.trick.responders.filter((id) => id !== player.id);
    }

    if (effectiveThulla || this.trick.responders.length === 0) {
      this._resolveTrick(effectiveThulla, events);
    } else {
      this.turnId = this.trick.responders[0];
    }

    return { ok: true, events };
  }

  _resolveTrick(wasThulla, events) {
    const trick = this.trick;
    const firstTrick = this.rules.firstTrickToSaar && this.tricks === 0;
    this.tricks++;
    const playsForEvent = trick.plays.slice();

    const leadPlays = trick.plays
      .filter((pl) => pl.card.suit === trick.ledSuit)
      .sort((a, b) => b.card.value - a.card.value || a.order - b.order);
    const top = leadPlays[0] || trick.plays[0];

    // Who collects the pile, if anyone. The first trick never collects — it sweeps.
    let collectorId = null;
    if (firstTrick) {
      collectorId = null;
    } else if (wasThulla) {
      const canCollect = (pl) =>
        !(this.rules.escapeTiming === 'immediate' && this.get(pl.playerId).hand.length === 0);
      collectorId = (leadPlays.find(canCollect) || top).playerId;
    } else if (this.rules.escapeTiming === 'lastCardHighest' && this.get(top.playerId).hand.length === 0) {
      collectorId = top.playerId;
    }

    let nextLeaderId;
    if (collectorId) {
      const collector = this.get(collectorId);
      const pile = trick.plays.map((pl) => ({ ...pl.card }));
      collector.hand.push(...pile);
      this._sortHand(collector);
      this.trick = null;
      nextLeaderId = collectorId;
      events.push({
        type: 'pickup', playerId: collectorId, count: pile.length,
        reason: wasThulla ? 'thulla' : 'lastcard', plays: playsForEvent,
      });
    } else {
      this.discard.push(...trick.plays.map((pl) => ({ ...pl.card })));
      this.trick = null;
      nextLeaderId = top.playerId;
      events.push({ type: 'sweep', count: playsForEvent.length, winnerId: top.playerId, plays: playsForEvent });
    }

    // Escapes happen after the trick is resolved.
    const newlyOut = [];
    for (const p of this.players) {
      if (!p.out && p.hand.length === 0) {
        p.out = true;
        p.escapedOrder = this.finished.length;
        this.finished.push(p.id);
        newlyOut.push(p.id);
      }
    }
    if (newlyOut.length) events.push({ type: 'out', playerIds: newlyOut });

    // Choose the next leader (the regional "escapeLead" variation).
    let leader = this.get(nextLeaderId);
    if (!leader || leader.out || leader.hand.length === 0) {
      if (this.rules.escapeLead === 'drawFromSaar' && leader && leader.out && this.discard.length > 0) {
        const drawn = this.discard.pop();
        leader.hand.push(drawn);
        this._sortHand(leader);
        leader.out = false;
        const fi = this.finished.lastIndexOf(leader.id);
        if (fi >= 0) this.finished.splice(fi, 1);
        this.players.forEach((p) => { p.escapedOrder = p.out ? this.finished.indexOf(p.id) : null; });
        nextLeaderId = leader.id;
        events.push({ type: 'reenter', playerId: leader.id });
      } else {
        const from = this.players.findIndex((p) => p.id === nextLeaderId);
        const nextActive = this._nextActive(from);
        nextLeaderId = nextActive ? nextActive.id : null;
      }
    }

    const active = this.activePlayers;
    if (active.length <= 1) {
      this.over = true;
      this.phase = 'over';
      this.turnId = null;
      this.leaderId = null;
      this.loserId = active.length === 1
        ? active[0].id
        : (playsForEvent[playsForEvent.length - 1] || {}).playerId || null;
      events.push({ type: 'gameover', loserId: this.loserId, winners: this.finished.slice() });
      return;
    }

    this.leaderId = nextLeaderId;
    this.turnId = nextLeaderId;
    events.push({ type: 'lead', playerId: nextLeaderId });
  }

  /* ------------------------------------------------------------- integrity */

  /** Verifies no card is duplicated or lost. */
  checkIntegrity() {
    const ids = [];
    for (const p of this.players) for (const c of p.hand) ids.push(c.id);
    if (this.trick) for (const pl of this.trick.plays) ids.push(pl.card.id);
    for (const c of this.discard) ids.push(c.id);
    const unique = new Set(ids);
    return {
      ok: ids.length === this.deckSize && unique.size === ids.length,
      total: ids.length,
      expected: this.deckSize,
      duplicates: ids.length - unique.size,
    };
  }

  /* ------------------------------------------------------------------ view */

  viewFor(playerId) {
    const you = this.get(playerId) || { hand: [] };
    return {
      phase: this.phase,
      over: this.over,
      loserId: this.loserId,
      numDecks: this.numDecks,
      direction: this.rules.direction,
      escapeTiming: this.rules.escapeTiming,
      escapeLead: this.rules.escapeLead,
      turnId: this.turnId,
      leaderId: this.leaderId,
      leadSuit: this.trick ? this.trick.ledSuit : null,
      highest: this.trick ? this.trick.highest : null,
      discardCount: this.discard.length,
      turnCount: this.turnCount,
      tricks: this.tricks,
      finished: this.finished.slice(),
      players: this.players.map((p) => ({
        id: p.id,
        nickname: p.nickname,
        seat: p.seat,
        handCount: p.hand.length,
        out: p.out,
        isYou: p.id === playerId,
      })),
      you: {
        id: playerId,
        hand: you.hand.slice(),
        legalMoves: this.legalMoves(playerId),
      },
      trick: this.trick
        ? {
            leaderId: this.trick.leaderId,
            ledSuit: this.trick.ledSuit,
            plays: this.trick.plays.slice(),
            highest: this.trick.highest,
            responders: this.trick.responders.slice(),
          }
        : null,
    };
  }
}

module.exports = { BhabhiGame, DEFAULT_RULES, buildDeck, shuffle, SUITS };
