'use strict';
// 2 and a Possible: bot players.
// Bots judge only their own hand and the public trick in front of them.
// Personalities change how boldly they bid and how they spend high cards.

const { effectiveSuit, isTrump, trumpPower, legalCards, trickWinner } = require('./game');

const PERSONALITIES = {
  steady: { key: 'steady', label: 'Steady Eddie', blurb: 'Bids what the hand shows, not a trick more.' },
  bold: { key: 'bold', label: 'Bold Talker', blurb: 'Talks big at the table and bids like it.' },
  quiet: { key: 'quiet', label: 'Quiet Storm', blurb: 'Says little, cuts hard, keeps the Ace late.' },
  wildcard: { key: 'wildcard', label: 'Wild Card', blurb: 'Might bid Nil with a King of Spades. Might not.' },
};
const PERSONALITY_ORDER = ['steady', 'bold', 'quiet', 'wildcard'];
const BOT_NAMES = [
  'Uncle June Bug',
  'Auntie Bertha',
  'Cousin Peaches',
  'Deacon Earl',
  'Miss Tootie',
  'PawPaw Slim',
  'Cousin Skeeter',
  'Big Mama Rose',
];

// Rough trick expectation for one hand.
function estimateTricks(hand, settings) {
  let est = 0;
  const bySuit = {};
  for (const c of hand) {
    const s = effectiveSuit(c, settings);
    bySuit[s] = bySuit[s] || [];
    bySuit[s].push(c);
  }
  for (const c of hand) {
    if (c.joker === 'BIG') { est += 1; continue; }
    if (c.joker === 'LITTLE') { est += 1; continue; }
    if (settings.jjdd && c.rank === 2 && (c.suit === 'S' || c.suit === 'D')) { est += 1; continue; }
    if (c.rank === 14) { est += 1; continue; }                    // any Ace
    if (c.rank === 13) { est += (bySuit[c.suit] || []).length >= 2 ? 0.7 : 0.3; continue; }
    if (c.rank === 12 && isTrump(c, settings)) { est += 0.4; continue; }
    if (isTrump(c, settings) && c.rank >= 10) { est += 0.35; continue; }
  }
  // Short side suits with trump in hand can ruff for extra tricks.
  const trumpCount = (bySuit.S || []).length;
  for (const s of ['H', 'D', 'C']) {
    const len = (bySuit[s] || []).length;
    if (len === 0 && trumpCount >= 2) est += 0.8;
    else if (len === 1 && trumpCount >= 3) est += 0.4;
  }
  return est;
}

function chooseBid(personalityKey, hand, settings, rng = Math.random) {
  const est = estimateTricks(hand, settings);
  const maxBid = hand.length;
  let value = Math.round(est);
  if (personalityKey === 'bold') value = Math.round(est + 0.6);
  if (personalityKey === 'quiet') value = Math.max(1, Math.round(est - 0.3));
  if (personalityKey === 'wildcard') value = Math.round(est + (rng() * 2 - 0.7));
  value = Math.max(1, Math.min(maxBid, value));
  // The signature bid: a bot sitting on about 2 sometimes calls it by name.
  if (value === 2 && rng() < 0.35) return { kind: 'possible' };
  // Nil: only on a genuinely empty looking hand, and not every time.
  if (est < 0.6 && rng() < 0.5) return { kind: 'nil' };
  return { kind: 'num', value };
}

function cardCost(card, settings) {
  if (isTrump(card, settings)) return 100 + trumpPower(card, settings);
  return card.rank;
}

// Picks a card id to play from the legal list.
// Plays cheap when the partner is already winning, tries to win cheap
// when an opponent is winning, and ducks under when it cannot win.
function chooseCard(personalityKey, hand, plays, settings, spadesBroken, mySeat, rng = Math.random) {
  const legal = legalCards(hand, plays, settings, spadesBroken);
  if (legal.length === 1) return legal[0].id;
  const sorted = legal.slice().sort((a, b) => cardCost(a, settings) - cardCost(b, settings));
  if (!plays.length) {
    // Leading: mostly a mid card from a long suit; the quiet bot leads low.
    if (personalityKey === 'quiet') return sorted[0].id;
    const nonTrump = sorted.filter(c => !isTrump(c, settings));
    const pool = nonTrump.length ? nonTrump : sorted;
    return pool[Math.floor(pool.length / 2)].id;
  }
  const winIdx = trickWinner(plays, settings);
  const winnerSeat = plays[winIdx].playerIdx;
  const partnerWinning = ((winnerSeat + 2) % 4) === mySeat || winnerSeat === mySeat;
  if (partnerWinning) return sorted[0].id; // stay cheap, do not overtake partner
  // Try the cheapest legal card that would take the trick.
  for (const c of sorted) {
    const trial = plays.concat([{ playerIdx: mySeat, card: c }]);
    if (trickWinner(trial, settings) === trial.length - 1) {
      // Wild Card sometimes burns a bigger card than it needs to.
      if (personalityKey === 'wildcard' && rng() < 0.25) {
        const bigger = sorted.filter(x => cardCost(x, settings) > cardCost(c, settings));
        if (bigger.length) return bigger[bigger.length - 1].id;
      }
      return c.id;
    }
  }
  return sorted[0].id; // cannot win: shed the cheapest card
}

// Blind Bids call, made from the bot's own dealt hand (the server holds
// the cards; the bot has not "seen" them in story terms, this is just its
// fixed rule). A bot declares Blind 6, the floor, only on a strong hand:
// 5 or more expected books (Bold Talker swings at 4.5). Anything less and
// the bot looks at its cards and bids normally. Returns 6 or null.
function chooseBlind(personalityKey, hand, settings) {
  const est = estimateTricks(hand, settings);
  const bar = personalityKey === 'bold' ? 4.5 : 5;
  return est >= bar ? 6 : null;
}

// Kitty exchange: keep trump and high cards, shed low plain cards.
function chooseKittyDiscards(personalityKey, hand, settings, count) {
  const sorted = hand.slice().sort((a, b) => cardCost(a, settings) - cardCost(b, settings));
  return sorted.slice(0, count).map(c => c.id);
}

module.exports = { PERSONALITIES, PERSONALITY_ORDER, BOT_NAMES, estimateTricks, chooseBid, chooseBlind, chooseCard, chooseKittyDiscards };
