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
  testHiddenInfo();
  testRuleVariations();
  testTerminationAndIntegrity();
  console.log('ENGINE TESTS PASSED');
})();
