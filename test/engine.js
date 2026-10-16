'use strict';
/* Deterministic-ish engine tests: rules integrity, termination, illegal-move
 * immutability and hidden-information safety. Run with: node test/engine.js */
const assert = require('assert');
const { BhabhiGame, DEFAULT_RULES, buildDeck } = require('../game/bhabhi');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: 'p' + i, nickname: 'P' + i }));
}

/** Plays a whole game with random legal moves, asserting invariants each move. */
function playRandom(n, rules, seed) {
  const g = new BhabhiGame(makePlayers(n), { rules, rng: mulberry32(seed) });
  let moves = 0;
  while (!g.over) {
    assert(moves++ < 100000, `n=${n} seed=${seed}: game did not terminate`);
    const id = g.turnId;
    const legal = g.legalMoves(id);
    assert(legal.length > 0, `n=${n} seed=${seed}: no legal moves (phase=${g.phase})`);
    const pick = legal[Math.floor((seed * 2654435761 + moves) % legal.length)];
    const res = g.playCard(id, pick);
    assert(res.ok, `n=${n} seed=${seed}: legal move rejected: ${res.error}`);
    const integ = g.checkIntegrity();
    assert(integ.ok, `n=${n} seed=${seed}: integrity broken: ${JSON.stringify(integ)}`);
  }
  const active = g.players.filter((p) => !p.out);
  assert(active.length <= 1, `n=${n} seed=${seed}: ${active.length} players still active`);
  assert.strictEqual(g.phase, 'over', `n=${n}: phase not 'over'`);
  const final = g.checkIntegrity();
  assert(final.ok && final.total === g.deckSize, `n=${n}: final integrity ${JSON.stringify(final)}`);
  return g;
}

function testTerminationAndIntegrity() {
  for (const n of [2, 3, 4, 5, 6, 7, 10]) {
    for (let seed = 1; seed <= 8; seed++) playRandom(n, {}, seed);
  }
  console.log('  termination + integrity (n=2..10) OK');
}

function testRuleVariations() {
  const dirs = ['clockwise', 'anticlockwise'];
  const timings = ['trickEnd', 'immediate', 'lastCardHighest'];
  const leads = ['nextActive', 'drawFromSaar'];
  let count = 0;
  for (const direction of dirs) {
    for (const escapeTiming of timings) {
      for (const escapeLead of leads) {
        for (const n of [3, 4, 6]) {
          playRandom(n, { direction, escapeTiming, escapeLead }, 7 + count);
          count++;
        }
      }
    }
  }
  console.log(`  rule variations (${count} games) OK`);
}

function testOpeningAce() {
  const g = new BhabhiGame(makePlayers(3));
  assert.strictEqual(g.phase, 'opening', 'expected opening phase');
  const opener = g.get(g.turnId);
  const ace = opener.hand.find((c) => c.rank === 'A' && c.suit === '♠');
  assert(ace, 'opener should hold the Ace of Spades');
  const nonAce = opener.hand.find((c) => !(c.rank === 'A' && c.suit === '♠'));

  const before = JSON.stringify({ trick: g.trick, turn: g.turnId, hand: opener.hand.map((c) => c.id) });
  const bad = g.playCard(opener.id, nonAce.id);
  assert(!bad.ok, 'non-ace opening should be rejected');
  const after = JSON.stringify({ trick: g.trick, turn: g.turnId, hand: opener.hand.map((c) => c.id) });
  assert.strictEqual(before, after, 'illegal opening mutated state');

  const good = g.playCard(opener.id, ace.id);
  assert(good.ok, 'ace opening should be accepted: ' + good.error);
  assert.strictEqual(g.phase, 'playing', 'phase should move to playing');
  console.log('  opening Ace of Spades enforcement + immutability OK');
}

function testIllegalMoveImmutability() {
  const g = new BhabhiGame(makePlayers(4), { rng: mulberry32(3) });
  // Advance past opening if needed.
  if (g.phase === 'opening') {
    const opener = g.get(g.turnId);
    const ace = opener.hand.find((c) => c.rank === 'A' && c.suit === '♠');
    g.playCard(opener.id, ace.id);
  }
  const other = g.players.find((p) => p.id !== g.turnId);
  const snap = () => JSON.stringify({ trick: g.trick, turn: g.turnId, hands: g.players.map((p) => p.hand.map((c) => c.id)), discard: g.discard.length });
  const before = snap();
  const r = g.playCard(other.id, other.hand[0].id);
  assert(!r.ok, 'out-of-turn move should be rejected');
  assert.strictEqual(before, snap(), 'out-of-turn move mutated state');

  const mover = g.get(g.turnId);
  const wrong = mover.hand[0];
  // If following a suit, playing an off-suit card when we can follow must fail.
  if (g.trick) {
    const legal = g.legalMoves(mover.id);
    const illegal = mover.hand.find((c) => !legal.includes(c.id));
    if (illegal) {
      const b2 = snap();
      const r2 = g.playCard(mover.id, illegal.id);
      assert(!r2.ok, 'off-suit follow should be rejected');
      assert.strictEqual(b2, snap(), 'off-suit rejection mutated state');
    }
  }
  console.log('  illegal-move immutability OK');
}

function testFirstTrickToSaar() {
  for (let seed = 1; seed <= 12; seed++) {
    const g = new BhabhiGame(makePlayers(4), { rng: mulberry32(seed) });
    const plays = [];
    let resolved = null;
    while (!g.over && !resolved) {
      const id = g.turnId;
      const res = g.playCard(id, g.legalMoves(id)[0]);
      assert(res.ok, `seed ${seed}: ${res.error}`);
      for (const e of res.events) {
        if (e.type === 'play') plays.push(e);
        if (e.type === 'sweep' || e.type === 'pickup') resolved = e;
      }
    }
    assert(resolved, `seed ${seed}: first trick never resolved`);
    assert.strictEqual(resolved.type, 'sweep', `seed ${seed}: first trick was ${resolved.type}, expected sweep`);
    assert(plays.length >= 2, `seed ${seed}: first trick had too few plays`);
    assert(plays.every((e) => !e.thulla), `seed ${seed}: a thulla was flagged on the first trick`);
  }

  // With the rule disabled the old behaviour is allowed again.
  const off = new BhabhiGame(makePlayers(4), { rng: mulberry32(1), rules: { firstTrickToSaar: false } });
  assert.strictEqual(off.rules.firstTrickToSaar, false, 'rule override not honoured');
  console.log('  first trick sweeps to saar (no thulla) OK');
}

function testFirstTrickOffSuitNotThulla() {
  // p0 leads ♥; neither opponent holds a heart, so both must play off-suit.
  // On the first trick that must NOT count as a thulla and the pile must sweep.
  const g = new BhabhiGame(makePlayers(3), { rules: { requireOpeningAce: false }, rng: mulberry32(5) });
  g.phase = 'playing';
  g.over = false;
  g.tricks = 0;
  g.trick = null;
  g.players.forEach((p) => { p.out = false; p.escapedOrder = null; });
  g.players[0].hand = [
    { id: 'lead-h5', rank: '5', value: 5, suit: '♥', red: true },
    { id: 'p0-a', rank: '2', value: 2, suit: '♠', red: false },
  ];
  g.players[1].hand = [
    { id: 'p1-a', rank: '3', value: 3, suit: '♣', red: false },
    { id: 'p1-b', rank: '4', value: 4, suit: '♠', red: false },
  ];
  g.players[2].hand = [
    { id: 'p2-a', rank: '6', value: 6, suit: '♦', red: true },
    { id: 'p2-b', rank: '7', value: 7, suit: '♠', red: false },
  ];
  g.leaderId = 'p0';
  g.turnId = 'p0';

  const discardBefore = g.discard.length;
  const events = [];
  for (const [pid, card] of [['p0', 'lead-h5'], ['p1', 'p1-a'], ['p2', 'p2-a']]) {
    const res = g.playCard(pid, card);
    assert(res.ok, `off-suit follow rejected: ${res.error}`);
    events.push(...res.events);
  }

  const plays = events.filter((e) => e.type === 'play');
  assert.strictEqual(plays.length, 3, 'first trick should have 3 plays');
  assert(plays.every((e) => !e.thulla), 'first-trick off-suit was flagged as a thulla');
  assert(!events.some((e) => e.type === 'pickup'), 'first trick must not pick up');
  const sweep = events.find((e) => e.type === 'sweep');
  assert(sweep && sweep.winnerId === 'p0', 'first trick should sweep to the saar (p0 highest lead suit)');
  assert.strictEqual(g.discard.length, discardBefore + 3, 'first-trick cards should go to the saar');
  assert.strictEqual(g.turnId, 'p0', 'highest lead-suit card should lead next');
  console.log('  first-trick off-suit is not a thulla and sweeps OK');
}

function testDealsVary() {
  const sig = (g) => g.players.map((p) => p.hand.map((c) => c.id).join(',')).join('|');
  const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(sig(new BhabhiGame(makePlayers(4))));
  assert(seen.size >= 19, `fresh deals repeat too often (${seen.size}/20 unique)`);
  console.log('  fresh deals vary between games OK');
}

function testHiddenInfo() {
  const g = new BhabhiGame(makePlayers(5), { rng: mulberry32(11) });
  const view = g.viewFor('p0');
  for (const p of view.players) {
    assert(!('hand' in p), 'opponent view leaks hand cards');
    assert(!('cards' in p), 'opponent view leaks cards');
  }
  assert(Array.isArray(view.you.hand), 'own hand missing');
  const other = g.viewFor('p1');
  assert(other.you.id === 'p1', 'viewFor returns wrong player');
  console.log('  hidden-information safety OK');
}

function testDeck() {
  const deck = buildDeck(1);
  assert.strictEqual(deck.length, 52, 'single deck should have 52 cards');
  assert.strictEqual(new Set(deck.map((c) => c.id)).size, 52, 'deck has duplicate ids');
  const two = buildDeck(2);
  assert.strictEqual(two.length, 104, 'double deck should have 104 cards');
  assert.strictEqual(new Set(two.map((c) => c.id)).size, 104, 'double deck has duplicate ids');
  assert.strictEqual(DEFAULT_RULES.direction, 'clockwise', 'default direction changed');
  console.log('  deck construction OK');
}

(function main() {
  console.log('Engine tests:');
  testDeck();
  testOpeningAce();
  testIllegalMoveImmutability();
  testFirstTrickToSaar();
  testFirstTrickOffSuitNotThulla();
  testDealsVary();
  testHiddenInfo();
  testRuleVariations();
  testTerminationAndIntegrity();
  console.log('ENGINE TESTS PASSED');
})();
