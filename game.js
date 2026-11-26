'use strict';
// 2 and a Possible: pure Spades game logic (deck, ranking, tricks, scoring).
// No server state lives here, so the test suite can import these functions
// directly and assert exact math.

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_LABEL = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs', J: 'Joker' };
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

function rankLabel(rank) { return RANK_LABEL[rank] || String(rank); }

function makeCard(suit, rank, extra) {
  const card = { suit, rank };
  if (extra) Object.assign(card, extra);
  card.id = extra && extra.joker ? extra.joker : `${suit}${rank}`;
  card.label = extra && extra.joker
    ? (extra.joker === 'BIG' ? 'Big Joker' : 'Little Joker')
    : `${rankLabel(rank)} of ${SUIT_LABEL[suit]}`;
  return card;
}

// Builds the deck for the active House Rules.
// Standard: 52 cards.
// Joker Joker Deuce Deuce: add Big Joker and Little Joker, remove the
// 2 of Hearts and the 2 of Clubs, still 52 cards. The 2 of Spades and
// the 2 of Diamonds stay in and play as top spades (see trumpPower).
function buildDeck(settings) {
  const deck = [];
  for (const suit of SUITS) for (let rank = 2; rank <= 14; rank++) deck.push(makeCard(suit, rank));
  if (settings && settings.jjdd) {
    const filtered = deck.filter(c => !(c.rank === 2 && (c.suit === 'H' || c.suit === 'C')));
    filtered.push(makeCard('J', 0, { joker: 'BIG' }));
    filtered.push(makeCard('J', 0, { joker: 'LITTLE' }));
    return filtered;
  }
  return deck;
}

function handSizeFor(settings) { return settings && settings.kitty ? 12 : 13; }
function kittySizeFor(settings) { return settings && settings.kitty ? 4 : 0; }

// The suit a card counts as for following suit and for trump purposes.
// Jokers always count as spades. Under JJDD, both deuces count as spades,
// so the 2 of Diamonds is a spade, not a diamond.
function effectiveSuit(card, settings) {
  if (card.joker) return 'S';
  if (settings && settings.jjdd && card.rank === 2 && (card.suit === 'S' || card.suit === 'D')) return 'S';
  return card.suit;
}
function isTrump(card, settings) { return effectiveSuit(card, settings) === 'S'; }

// Power of a card inside the trump suit. Higher wins.
// JJDD order: Big Joker > Little Joker > 2 of Spades > 2 of Diamonds > Ace of Spades > ... > 3 of Spades.
function trumpPower(card, settings) {
  if (card.joker === 'BIG') return 1000;
  if (card.joker === 'LITTLE') return 990;
  if (settings && settings.jjdd && card.rank === 2 && card.suit === 'S') return 980;
  if (settings && settings.jjdd && card.rank === 2 && card.suit === 'D') return 970;
  return card.rank; // Ace of Spades = 14 down to the lowest spade
}

// Power of a card within a plain (non trump) suit: just its rank.
function suitPower(card) { return card.rank; }

// Returns the index (into plays) of the winning play.
// plays: [{ playerIdx, card }]
function trickWinner(plays, settings) {
  const ledSuit = effectiveSuit(plays[0].card, settings);
  let best = 0;
  for (let i = 1; i < plays.length; i++) {
    const challenger = plays[i].card;
    const holder = plays[best].card;
    const cTrump = isTrump(challenger, settings);
    const hTrump = isTrump(holder, settings);
    if (cTrump && !hTrump) { best = i; continue; }
    if (!cTrump && hTrump) continue;
    if (cTrump && hTrump) {
      if (trumpPower(challenger, settings) > trumpPower(holder, settings)) best = i;
      continue;
    }
    // Neither is trump: only the led suit can win, by rank.
    if (effectiveSuit(challenger, settings) === ledSuit && effectiveSuit(holder, settings) !== ledSuit) { best = i; continue; }
    if (effectiveSuit(challenger, settings) === ledSuit && effectiveSuit(holder, settings) === ledSuit) {
      if (suitPower(challenger) > suitPower(holder)) best = i;
    }
  }
  return best;
}

// Legal cards from a hand given the current trick (array of plays, may be
// empty when leading). Must follow the led effective suit if able.
// Lead restriction: spades cannot be led until broken, unless the leader
// holds only spades.
function legalCards(hand, plays, settings, spadesBroken) {
  if (!plays || plays.length === 0) {
    if (spadesBroken) return hand.slice();
    const nonSpades = hand.filter(c => !isTrump(c, settings));
    return nonSpades.length ? nonSpades : hand.slice();
  }
  const ledSuit = effectiveSuit(plays[0].card, settings);
  const follow = hand.filter(c => effectiveSuit(c, settings) === ledSuit);
  return follow.length ? follow : hand.slice();
}

// A bid is one of:
//   { kind: 'num', value: 1..13 }
//   { kind: 'nil' }
//   { kind: 'possible' }  the signature "2 and a Possible" bid, counts as 2
//   { kind: 'blind', value: 6..10 }  a Blind Bids team bid, declared before
//        the declarer saw any cards. It is the whole TEAM bid for the hand.
//   { kind: 'blindCovered' }  the blind declarer's partner. Counts as 0:
//        the partner adds no bid of their own on a blind hand.
function bidValue(bid) {
  if (!bid) return 0;
  if (bid.kind === 'num') return bid.value;
  if (bid.kind === 'possible') return 2;
  if (bid.kind === 'blind') return bid.value;
  return 0; // nil and blindCovered
}

function parseBid(msg) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.bidKind === 'nil') return { kind: 'nil' };
  if (msg.bidKind === 'possible') return { kind: 'possible' };
  const v = msg.bidValue | 0;
  if (msg.bidKind === 'num' && v >= 1 && v <= 13) return { kind: 'num', value: v };
  return null;
}

function bidLabel(bid) {
  if (!bid) return 'no bid';
  if (bid.kind === 'nil') return 'Nil';
  if (bid.kind === 'possible') return '2 and a Possible';
  if (bid.kind === 'blind') return `Blind ${bid.value}`;
  if (bid.kind === 'blindCovered') return 'Blind (team)';
  return String(bid.value);
}

// Scores one team for one hand.
// bids: [bidForSeatA, bidForSeatB] for the team's two players (either may be null in unit tests)
// tricks: [tricksWonBySeatA, tricksWonBySeatB]
// bagsBefore: the team's cumulative sandbags before this hand
// Returns a full breakdown so the client and the tests can show the math.
//
// Rules implemented:
//   Team bid = sum of numeric bid values (Nil counts 0, Possible counts 2).
//   Make the team bid: 10 x bid + 1 per overtrick. Overtricks are sandbags.
//   Every 10 cumulative sandbags: minus 100 (applied when a multiple of 10 is crossed).
//   Miss the team bid: minus 10 x bid (the team is set). Sandbags are not added on a set.
//   Nil: +100 if that player took 0 tricks, else minus 100. A Nil player's
//        tricks still count toward the team total for the partner's bid.
//   2 and a Possible (per player who bid it):
//        3 or more personal tricks: +20 bonus to the team.
//        Exactly 2 personal tricks: no bonus, no penalty. The bid is made.
//        0 or 1 personal tricks: minus 20. The missed guarantee does not by
//        itself set the team; the team set is decided by team tricks vs team bid.
//   Blind bid (a team bid, so at most one per team; the partner's bid is
//   blindCovered and adds 0, which makes teamBid equal the blind number):
//        Team makes the bid: the blind books pay double. That is an extra
//        10 points per blind book on top of the normal 10, so a made
//        Blind 7 scores 140 plus overtricks at 1 point each, with sandbag
//        accounting exactly as usual.
//        Team is set: minus 10 per bid book as usual. The set penalty is
//        NOT doubled.
function scoreTeam(bids, tricks, bagsBefore) {
  const teamBid = bids.reduce((sum, b) => sum + bidValue(b), 0);
  const blindValue = bids.reduce((sum, b) => sum + (b && b.kind === 'blind' ? b.value : 0), 0);
  const teamTricks = tricks[0] + tricks[1];
  let base = 0;
  let bagsEarned = 0;
  let set = false;
  let blindAdj = 0;
  if (teamBid > 0) {
    if (teamTricks >= teamBid) {
      bagsEarned = teamTricks - teamBid;
      blindAdj = 10 * blindValue; // the double pay on the blind books
      base = 10 * teamBid + bagsEarned + blindAdj;
    } else {
      base = -10 * teamBid;
      set = true;
      bagsEarned = 0;
    }
  }
  let nilAdj = 0;
  const nilResults = [];
  bids.forEach((b, i) => {
    if (b && b.kind === 'nil') {
      const ok = tricks[i] === 0;
      nilResults.push({ seat: i, ok });
      nilAdj += ok ? 100 : -100;
    }
  });
  let possibleAdj = 0;
  const possibleResults = [];
  bids.forEach((b, i) => {
    if (b && b.kind === 'possible') {
      let adj = 0;
      if (tricks[i] >= 3) adj = 20;
      else if (tricks[i] < 2) adj = -20;
      possibleResults.push({ seat: i, tricks: tricks[i], adj });
      possibleAdj += adj;
    }
  });
  const bagsAfter = bagsBefore + (set ? 0 : bagsEarned);
  const bagPenalty = (Math.floor(bagsAfter / 10) - Math.floor(bagsBefore / 10)) * 100;
  const total = base + nilAdj + possibleAdj - bagPenalty;
  return {
    teamBid, teamTricks, base, set,
    bagsEarned: set ? 0 : bagsEarned, bagsBefore, bagsAfter, bagPenalty,
    nilAdj, nilResults, possibleAdj, possibleResults, blindAdj, blindValue, total,
  };
}

// Scores one team for a "First Hand Bids Itself" hand (House Rule).
// There are no bids on that hand: the team's bid IS the number of books
// the team actually took, so the hand can never be set and there are no
// overtricks. Exact scoring: 10 points per book taken, no sandbags earned
// (bagsAfter equals bagsBefore, so no sandbag penalty can land on this
// hand), no Nil and no Possible adjustments. Same breakdown shape as
// scoreTeam so the client and tests read it the same way.
function scoreSelfBidTeam(tricks, bagsBefore) {
  const teamTricks = tricks[0] + tricks[1];
  return {
    teamBid: teamTricks, teamTricks, base: 10 * teamTricks, set: false,
    bagsEarned: 0, bagsBefore, bagsAfter: bagsBefore, bagPenalty: 0,
    nilAdj: 0, nilResults: [], possibleAdj: 0, possibleResults: [],
    blindAdj: 0, blindValue: 0,
    total: 10 * teamTricks, selfBid: true,
  };
}

// Sort a hand for display: spades (trump) first by power, then other suits.
function sortHand(hand, settings) {
  const suitOrder = { S: 0, H: 1, D: 2, C: 3, J: 0 };
  return hand.slice().sort((a, b) => {
    const ea = effectiveSuit(a, settings), eb = effectiveSuit(b, settings);
    if (ea !== eb) return suitOrder[ea] - suitOrder[eb];
    if (ea === 'S') return trumpPower(b, settings) - trumpPower(a, settings);
    return b.rank - a.rank;
  });
}

module.exports = {
  SUITS, SUIT_LABEL, buildDeck, handSizeFor, kittySizeFor,
  effectiveSuit, isTrump, trumpPower, trickWinner, legalCards,
  bidValue, parseBid, bidLabel, scoreTeam, scoreSelfBidTeam, sortHand, rankLabel,
};
