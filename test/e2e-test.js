'use strict';
// 2 and a Possible: end to end test.
// Part 1 unit checks the pure logic in game.js (scoring math, JJDD ranking,
// follow suit, kitty deck shape). Part 2 spawns the real server and drives
// WebSocket clients: a scripted 4 human hand with Nil and the signature bid,
// a JJDD plus Kitty bot game played all the way to a winner, and a rejoin.
const { spawn } = require('child_process');
const path = require('path');
const G = require('../game');
const BOTS = require('../bots');

const PORT = 3217;
const WSURL = `ws://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${extra !== undefined ? ' - got: ' + JSON.stringify(extra) : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, desc, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(100); }
  throw new Error('timeout waiting for: ' + desc);
}
const C = (suit, rank, joker) => {
  const card = { suit, rank, id: joker ? joker : `${suit}${rank}` };
  if (joker) card.joker = joker;
  card.label = card.id;
  return card;
};
const num = v => ({ kind: 'num', value: v });
const nil = { kind: 'nil' };
const possible = { kind: 'possible' };

function unitTests() {
  console.log('\nUNIT - deck shape');
  const std = G.buildDeck({});
  check('standard deck has 52 cards', std.length === 52, std.length);
  check('standard deck ids are unique', new Set(std.map(c => c.id)).size === 52);
  const jj = G.buildDeck({ jjdd: true });
  check('JJDD deck has 52 cards', jj.length === 52, jj.length);
  check('JJDD deck ids are unique', new Set(jj.map(c => c.id)).size === 52);
  check('JJDD has both jokers', jj.some(c => c.joker === 'BIG') && jj.some(c => c.joker === 'LITTLE'));
  check('JJDD removes 2 of Hearts and 2 of Clubs', !jj.some(c => c.id === 'H2') && !jj.some(c => c.id === 'C2'));
  check('JJDD keeps both trump deuces', jj.some(c => c.id === 'S2') && jj.some(c => c.id === 'D2'));
  check('kitty hand size is 12 and kitty is 4', G.handSizeFor({ kitty: true }) === 12 && G.kittySizeFor({ kitty: true }) === 4);
  check('standard hand size is 13 and no kitty', G.handSizeFor({}) === 13 && G.kittySizeFor({}) === 0);

  console.log('\nUNIT - JJDD trump ranking');
  const s = { jjdd: true };
  check('Big Joker over Little Joker', G.trumpPower(C('J', 0, 'BIG'), s) > G.trumpPower(C('J', 0, 'LITTLE'), s));
  check('Little Joker over 2 of Spades', G.trumpPower(C('J', 0, 'LITTLE'), s) > G.trumpPower(C('S', 2), s));
  check('2 of Spades over 2 of Diamonds', G.trumpPower(C('S', 2), s) > G.trumpPower(C('D', 2), s));
  check('2 of Diamonds over Ace of Spades', G.trumpPower(C('D', 2), s) > G.trumpPower(C('S', 14), s));
  check('2 of Diamonds counts as a spade under JJDD', G.effectiveSuit(C('D', 2), s) === 'S');
  check('2 of Diamonds is a diamond in standard play', G.effectiveSuit(C('D', 2), {}) === 'D');

  console.log('\nUNIT - trick winner');
  const plays = (...cards) => cards.map((card, i) => ({ playerIdx: i, card }));
  check('JJDD: 2 of Diamonds cuts a led Ace of Hearts', G.trickWinner(plays(C('H', 14), C('D', 2), C('H', 13), C('C', 14)), s) === 1);
  check('JJDD: Big Joker takes a trick over the 2 of Spades', G.trickWinner(plays(C('S', 2), C('J', 0, 'BIG'), C('S', 14), C('S', 13)), s) === 1);
  check('JJDD: Little Joker beats Ace of Spades', G.trickWinner(plays(C('S', 14), C('J', 0, 'LITTLE'), C('S', 13), C('S', 12)), s) === 1);
  check('standard: Ace of Spades trumps a led King of Diamonds', G.trickWinner(plays(C('D', 13), C('D', 2), C('S', 14), C('D', 12)), {}) === 2);
  check('standard: highest led suit wins with no trump', G.trickWinner(plays(C('H', 10), C('H', 12), C('C', 14), C('H', 9)), {}) === 1);
  check('off suit Ace cannot win', G.trickWinner(plays(C('H', 10), C('C', 14), C('H', 9), C('D', 14)), {}) === 0);

  console.log('\nUNIT - follow suit and lead rules');
  check('must follow led suit', JSON.stringify(G.legalCards([C('H', 5), C('S', 3)], plays(C('H', 9)), {}, false).map(c => c.id)) === '["H5"]');
  check('JJDD: 2 of Diamonds does not follow diamonds (it is a spade)', JSON.stringify(G.legalCards([C('D', 2), C('H', 5)], plays(C('D', 9)), s, false).map(c => c.id)) === '["D2","H5"]');
  check('JJDD: 2 of Diamonds must follow a spade lead', JSON.stringify(G.legalCards([C('D', 2), C('H', 5)], plays(C('S', 9)), s, false).map(c => c.id)) === '["D2"]');
  check('cannot lead spades before they break', JSON.stringify(G.legalCards([C('S', 14), C('H', 4)], [], {}, false).map(c => c.id)) === '["H4"]');
  check('all spade hand may lead spades', G.legalCards([C('S', 14), C('S', 4)], [], {}, false).length === 2);
  check('broken spades may be led', G.legalCards([C('S', 14), C('H', 4)], [], {}, true).length === 2);

  console.log('\nUNIT - scoring');
  let r = G.scoreTeam([num(4), num(3)], [5, 3], 0);
  check('make bid: 10x bid plus overtricks', r.total === 71 && r.bagsEarned === 1, r);
  r = G.scoreTeam([num(5), num(4)], [3, 3], 0);
  check('missed bid is a set at minus 10x', r.total === -90 && r.set === true, r);
  r = G.scoreTeam([nil, num(5)], [0, 6], 0);
  check('Nil made pays 100 on top of partner bid', r.total === 151, r);
  r = G.scoreTeam([nil, num(5)], [1, 5], 0);
  check('Nil busted costs 100 (the busted trick still counts for the team: 51 minus 100)', r.total === -49 && r.nilAdj === -100, r);
  r = G.scoreTeam([possible, num(4)], [2, 4], 0);
  check('Possible with exactly 2: bid made, no bonus, no penalty', r.total === 60 && r.possibleAdj === 0, r);
  r = G.scoreTeam([possible, num(4)], [3, 3], 0);
  check('Possible with 3 or more pays the 20 bonus', r.total === 80 && r.possibleAdj === 20, r);
  r = G.scoreTeam([possible, num(4)], [1, 5], 0);
  check('Possible under 2 costs 20 but does not set the team', r.total === 40 && r.possibleAdj === -20 && r.set === false, r);
  r = G.scoreTeam([num(3), num(3)], [4, 3], 9);
  check('tenth sandbag triggers the 100 penalty', r.total === -39 && r.bagPenalty === 100 && r.bagsAfter === 10, r);
  r = G.scoreTeam([nil, nil], [0, 0], 0);
  check('double Nil made pays 200', r.total === 200, r);
  r = G.scoreTeam([num(6), num(6)], [6, 6], 5);
  check('exact bid, no bags, no penalty', r.total === 120 && r.bagsEarned === 0, r);

  console.log('\nUNIT - First Hand Bids Itself scoring');
  r = G.scoreSelfBidTeam([4, 3], 9);
  check('self bid hand: bid equals books, 10 points per book', r.total === 70 && r.teamBid === 7 && r.teamTricks === 7 && r.base === 70, r);
  check('self bid hand: no sandbags earned, bag count does not move, no penalty at 9 bags', r.bagsEarned === 0 && r.bagsAfter === 9 && r.bagPenalty === 0, r);
  check('self bid hand: never a set, no Nil or Possible adjustments', r.set === false && r.nilAdj === 0 && r.possibleAdj === 0, r);
  r = G.scoreSelfBidTeam([0, 0], 0);
  check('self bid hand: a team taking zero books scores 0 and is not set', r.total === 0 && r.set === false, r);
  r = G.scoreSelfBidTeam([7, 6], 0);
  check('self bid hand: taking all 13 books scores 130', r.total === 130 && r.teamBid === 13, r);

  console.log('\nUNIT - Blind Bids scoring (a blind bid is a team bid)');
  const blindBid = v => ({ kind: 'blind', value: v });
  const coveredBid = { kind: 'blindCovered' };
  check('blind bid value counts in full, covered partner adds 0', G.bidValue(blindBid(7)) === 7 && G.bidValue(coveredBid) === 0);
  check('blind bid labels read as a team bid', G.bidLabel(blindBid(7)) === 'Blind 7' && G.bidLabel(coveredBid) === 'Blind (team)');
  r = G.scoreTeam([blindBid(7), coveredBid], [2, 5], 0);
  check('Blind 7 is the team total: made on combined books even though the declarer took only 2', r.teamBid === 7 && r.teamTricks === 7, r);
  check('made Blind 7 pays double on the blind books: 140', r.total === 140 && r.blindAdj === 70, r);
  r = G.scoreTeam([blindBid(7), coveredBid], [4, 5], 0);
  check('made Blind 7 with 2 overtricks: 142 and 2 sandbags', r.total === 142 && r.bagsEarned === 2 && r.blindAdj === 70, r);
  r = G.scoreTeam([blindBid(7), coveredBid], [3, 3], 0);
  check('set on a blind bid costs the normal rate, not doubled: minus 70', r.total === -70 && r.set === true && r.blindAdj === 0, r);
  r = G.scoreTeam([blindBid(6), coveredBid], [6, 0], 4);
  check('Blind 6 made exactly: 120, bags untouched', r.total === 120 && r.bagsAfter === 4, r);
  check('bot calls Blind 6 only on a strong hand', BOTS.chooseBlind('steady', [C('J', 0, 'BIG'), C('S', 14), C('S', 13), C('H', 14), C('D', 14), C('C', 14), C('S', 12), C('H', 4), C('D', 5), C('C', 6), C('H', 7), C('D', 8), C('C', 9)], { jjdd: true }) === 6);
  check('bot looks on a weak hand instead of calling blind', BOTS.chooseBlind('steady', [C('H', 3), C('D', 4), C('C', 5), C('H', 6), C('D', 7), C('C', 8), C('H', 9), C('D', 10), C('C', 3), C('H', 2), C('D', 3), C('C', 4), C('S', 3)], { jjdd: true }) === null);

  console.log('\nUNIT - bots');
  const strong = [C('J', 0, 'BIG'), C('S', 14), C('S', 13), C('H', 14), C('D', 14), C('C', 14), C('S', 12), C('H', 4), C('D', 5), C('C', 6), C('H', 7), C('D', 8), C('C', 9)];
  const weak = [C('H', 3), C('D', 4), C('C', 5), C('H', 6), C('D', 7), C('C', 8), C('H', 9), C('D', 10), C('C', 3), C('H', 2), C('D', 3), C('C', 4), C('S', 3)];
  check('bot rates a strong hand above a weak one', BOTS.estimateTricks(strong, s) > BOTS.estimateTricks(weak, s) + 2, [BOTS.estimateTricks(strong, s), BOTS.estimateTricks(weak, s)]);
  const bid = BOTS.chooseBid('steady', strong, s, () => 0.99);
  check('bot bid is a valid bid object', !!G.parseBid(bid.kind === 'num' ? { bidKind: 'num', bidValue: bid.value } : { bidKind: bid.kind }), bid);
  const pick = BOTS.chooseCard('steady', [C('H', 5), C('S', 3), C('H', 12)], plays(C('H', 9)), {}, false, 1, () => 0.5);
  check('bot follows suit when it can', pick === 'H5' || pick === 'H12', pick);
}

class Client {
  constructor(name) { this.name = name; this.inbox = []; this.state = null; this.waiters = []; this.token = null; this.id = null; this.errors = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WSURL);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('ws error ' + this.name)));
      this.ws.addEventListener('message', ev => {
        const msg = JSON.parse(ev.data.toString());
        this.inbox.push(msg);
        if (msg.type === 'state') this.state = msg;
        if (msg.type === 'joined') { this.token = msg.token; this.id = msg.playerId; this.joined = msg; }
        if (msg.type === 'error') this.errors.push(msg.message);
        this.waiters = this.waiters.filter(w => { if (w.pred(msg)) { w.resolve(msg); return false; } return true; });
      });
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  waitMsg(pred, desc, timeout = 15000) {
    const found = this.inbox.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      this.waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error(`timeout waiting for ${desc} (${this.name})`)), timeout);
    });
  }
  async waitFor(pred, desc, timeout = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (this.state && pred(this.state)) return this.state;
      await sleep(90);
    }
    throw new Error(`timeout waiting for state: ${desc} (${this.name}); last phase=${this.state && this.state.phase}`);
  }
  close() { try { this.ws.close(); } catch {} }
}

// Drives one human client through whatever phase is live.
// plan: { bid(state) -> msg, blind(state) -> msg or null, card(state) -> id,
//         onPhase(state) optional }
function autoplay(client, plan) {
  const acted = { bid: -1, kitty: -1, next: -1, blind: -1 };
  const timer = setInterval(() => {
    const s = client.state;
    if (!s) return;
    try {
      if (plan.onPhase) plan.onPhase(s);
      if (s.phase === 'blind' && s.you.blindDecision === 'pending' && acted.blind !== s.handNumber && plan.blind) {
        const m = plan.blind(s);
        if (m) { acted.blind = s.handNumber; client.send(m); }
      }
      if (s.phase === 'bidding' && s.bidTurn === s.you.seat && !s.you.bid && acted.bid !== s.handNumber) {
        acted.bid = s.handNumber;
        client.send(plan.bid ? plan.bid(s) : { type: 'bid', bidKind: 'num', bidValue: 3 });
      }
      if (s.phase === 'kitty' && s.kittyWinnerIdx === s.you.seat && acted.kitty !== s.handNumber) {
        acted.kitty = s.handNumber;
        client.send({ type: 'kittyDiscard', cardIds: s.you.hand.slice(0, 4).map(c => c.id) });
      }
      if (s.phase === 'playing' && s.currentTurn === s.you.seat && s.you.legal.length) {
        client.send({ type: 'playCard', cardId: plan.card ? plan.card(s) : s.you.legal[0] });
      }
      if (s.phase === 'handEnd' && s.isHost && acted.next !== s.handNumber) {
        acted.next = s.handNumber;
        setTimeout(() => client.send({ type: 'nextHand' }), 120);
      }
    } catch (e) { /* next tick retries */ }
  }, 80);
  return () => clearInterval(timer);
}

// Card steering for scripted hands: try to take the trick, or duck it.
function winCard(client) {
  const s = client.state;
  const plays = s.trick.map(t => ({ playerIdx: t.seat, card: t.card }));
  return BOTS.chooseCard('steady', s.you.hand, plays, s.settings, s.spadesBroken, s.you.seat, () => 0.5);
}
function duckCard(client) {
  const s = client.state;
  const cost = c => (G.isTrump(c, s.settings) ? 100 + G.trumpPower(c, s.settings) : c.rank);
  const legal = s.you.hand.filter(c => s.you.legal.includes(c.id)).sort((a, b) => cost(a) - cost(b));
  const plays = s.trick.map(t => ({ playerIdx: t.seat, card: t.card }));
  // Shed the highest card that still loses the trick right now: the high
  // cards are the ones that get forced into winning later. When every
  // card wins (a forced take, or when leading), shed the cheapest.
  for (let i = legal.length - 1; i >= 0; i--) {
    const trial = plays.concat([{ playerIdx: s.you.seat, card: legal[i] }]);
    if (G.trickWinner(trial, s.settings) !== trial.length - 1) return legal[i].id;
  }
  return legal[0].id;
}

async function main() {
  unitTests();

  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), BOT_DELAY_MIN_MS: '15', BOT_DELAY_MAX_MS: '45', TRICK_PAUSE_MS: '50' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));
  await new Promise(res => server.stdout.on('data', d => { if (String(d).includes('listening')) res(); }));
  console.log('\nserver up on port ' + PORT);

  const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  check('health endpoint answers', health.ok === true, health);
  const homeHtml = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
  check('home page loads and names the game', homeHtml.includes('2 and a Possible') && homeHtml.includes('How to Play'), homeHtml.length);
  check('home page carries the First Hand Bids Itself toggle and How to Play section', (homeHtml.match(/First Hand Bids Itself/g) || []).length >= 2 && homeHtml.includes('id="rule-firsthand"'), (homeHtml.match(/First Hand Bids Itself/g) || []).length);
  check('home page carries the Blind Bids toggle and the team bid wording', homeHtml.includes('id="rule-blind"') && homeHtml.includes('A blind bid is a team bid'), homeHtml.length);

  try {
    // ============ GAME A: 4 humans, Nil and Possible, one full hand ============
    console.log('\nGAME A - standard rules, scripted bids, one full hand');
    const A = new Client('Alpha'), B = new Client('Bravo'), C = new Client('Charlie'), D = new Client('Delta');
    for (const c of [A, B, C, D]) await c.connect();
    A.send({ type: 'create', name: 'Alpha' });
    const joinedA = await A.waitMsg(m => m.type === 'joined', 'host joined');
    const code = joinedA.code;
    check('room code is 4 letters', /^[A-Z]{4}$/.test(code), code);
    for (const c of [B, C, D]) { c.send({ type: 'join', code, name: c.name }); await c.waitMsg(m => m.type === 'joined', c.name + ' joined'); }
    await A.waitFor(s => s.phase === 'lobby' && s.players.length === 4, 'lobby of 4');
    check('lobby seats 4 players', A.state.players.length === 4);
    check('partners sit across: seats 0 and 2 share a team', A.state.players[0].team === A.state.players[2].team && A.state.players[1].team === A.state.players[3].team && A.state.players[0].team !== A.state.players[1].team);

    B.send({ type: 'playCard', cardId: 'S14' });
    await sleep(250);
    check('playing a card in the lobby is refused', B.errors.some(e => e.includes('No trick in play')), B.errors);

    const bidPlan = {
      Alpha: { type: 'bid', bidKind: 'nil' },
      Bravo: { type: 'bid', bidKind: 'possible' },
      Charlie: { type: 'bid', bidKind: 'num', bidValue: 4 },
      Delta: { type: 'bid', bidKind: 'num', bidValue: 3 },
    };
    const stops = [A, B, C, D].map(c => autoplay(c, { bid: () => bidPlan[c.name] }));
    A.send({ type: 'startGame' });
    await A.waitFor(s => s.phase === 'bidding', 'bidding opens');
    check('each player is dealt 13 cards', [A, B, C, D].every(c => c.state.you.hand.length === 13), [A, B, C, D].map(c => c.state.you.hand.length));
    const allIds = [A, B, C, D].flatMap(c => c.state.you.hand.map(x => x.id));
    check('the deal is 52 unique cards', allIds.length === 52 && new Set(allIds).size === 52);

    await A.waitFor(s => s.phase === 'handEnd' || s.phase === 'gameOver', 'hand A completes', 180000);
    for (const stop of stops) stop();
    const lh = A.state.lastHand;
    check('hand A played all 13 tricks', lh.tricks.reduce((a, b) => a + b, 0) === 13, lh.tricks);
    check('hand A recorded a Nil bid', lh.bids.includes('Nil'), lh.bids);
    check('hand A recorded a 2 and a Possible bid', lh.bids.includes('2 and a Possible'), lh.bids);
    let mathOk = true;
    for (const res of lh.results) {
      const bids = res.seats.map(seat => {
        const lbl = lh.bids[seat];
        if (lbl === 'Nil') return nil;
        if (lbl === '2 and a Possible') return possible;
        return num(parseInt(lbl, 10));
      });
      const expect = G.scoreTeam(bids, res.seats.map(seat => lh.tricks[seat]), 0);
      if (expect.total !== res.total || expect.teamBid !== res.teamBid) mathOk = false;
    }
    check('hand A server scoring matches the scoring function exactly', mathOk, lh.results.map(r => r.total));
    check('hand A standings match the hand result scores', JSON.stringify(A.state.scores) === JSON.stringify(lh.scores), A.state.scores);
    for (const c of [A, B, C, D]) c.close();

    // ============ GAME B: JJDD + Kitty, solo host plus bots, full game ============
    console.log('\nGAME B - JJDD and Kitty on, quick game to 250, bots fill the table');
    const H = new Client('Host');
    await H.connect();
    H.send({ type: 'create', name: 'Host' });
    const joinedH = await H.waitMsg(m => m.type === 'joined', 'host B joined');
    H.send({ type: 'setSettings', settings: { jjdd: true, kitty: true, targetScore: 250 } });
    await H.waitFor(s => s.settings.jjdd === true && s.settings.kitty === true && s.settings.targetScore === 250, 'house rules set');
    check('host can activate JJDD, Kitty, and the quick game', H.state.settings.jjdd && H.state.settings.kitty && H.state.settings.targetScore === 250, H.state.settings);
    H.send({ type: 'addBot' });
    await H.waitFor(s => s.players.length === 2 && s.players.some(p => p.isBot), 'one bot seated');
    check('host can seat a bot in the lobby', H.state.players.filter(p => p.isBot).length === 1);

    const seen = { kitty: false, kitty16: false, hands12: false, hands: new Set() };
    const stopH = autoplay(H, {
      bid: () => ({ type: 'bid', bidKind: 'num', bidValue: 3 }),
      onPhase: s => {
        if (s.phase === 'kitty') {
          seen.kitty = true;
          if (s.players.some(p => p.cardCount === 16)) seen.kitty16 = true;
        }
        if (s.phase === 'playing' && s.players.every(p => p.cardCount <= 12)) seen.hands12 = true;
        if (s.lastHand) seen.hands.add(s.lastHand.handNumber);
      },
    });
    H.send({ type: 'startGame' });
    await H.waitFor(s => s.phase === 'bidding' && s.players.length === 4, 'bots fill the table at start');
    check('start fills empty seats with bots (4 players, 3 bots)', H.state.players.length === 4 && H.state.players.filter(p => p.isBot).length === 3, H.state.players.map(p => p.isBot));
    check('kitty deal gives 12 cards each', H.state.you.hand.length === 12, H.state.you.hand.length);

    await H.waitFor(s => s.phase === 'gameOver', 'game B plays to a winner', 420000);
    stopH();
    // The kitty phase can be shorter than the autoplay sampling tick when a
    // bot works it, so also read it from the full broadcast history.
    for (const m of H.inbox) {
      if (m.type !== 'state') continue;
      if (m.phase === 'kitty') {
        seen.kitty = true;
        if (m.players.some(p => p.cardCount === 16)) seen.kitty16 = true;
      }
    }
    check('kitty phase happened', seen.kitty === true);
    check('kitty winner held 16 cards during the exchange', seen.kitty16 === true);
    check('hands settled to 12 cards for play', seen.hands12 === true);
    check('game B completed more than one hand', seen.hands.size >= 2, [...seen.hands]);
    check('game B kitty hands played 12 tricks', H.state.lastHand.tricks.reduce((a, b) => a + b, 0) === 12, H.state.lastHand.tricks);
    check('game B has a winning team', H.state.winnerTeam === 0 || H.state.winnerTeam === 1, H.state.winnerTeam);
    check('winning team reached the 250 target', H.state.scores[H.state.winnerTeam] >= 250 && H.state.scores[H.state.winnerTeam] > H.state.scores[1 - H.state.winnerTeam], H.state.scores);
    H.close();

    // ============ GAME C: rejoin ============
    console.log('\nGAME C - rejoin by token');
    const R1 = new Client('Reba'), R2 = new Client('Reggie');
    await R1.connect(); await R2.connect();
    R1.send({ type: 'create', name: 'Reba' });
    const joinedR = await R1.waitMsg(m => m.type === 'joined', 'host C joined');
    R2.send({ type: 'join', code: joinedR.code, name: 'Reggie' });
    const joinedR2 = await R2.waitMsg(m => m.type === 'joined', 'guest C joined');
    const token = joinedR2.token;
    R2.close();
    await sleep(300);
    const R2b = new Client('Reggie');
    await R2b.connect();
    R2b.send({ type: 'join', code: joinedR.code, name: 'Reggie', token });
    const rejoined = await R2b.waitMsg(m => m.type === 'joined', 'guest rejoined');
    check('rejoin with token reclaims the seat', rejoined.rejoined === true && rejoined.playerId === joinedR2.playerId, rejoined);
    await R1.waitFor(s => s.players.length === 2 && s.players.every(p => p.connected), 'room back to 2 connected');
    check('room still holds exactly the 2 original seats', R1.state.players.length === 2);
    R1.close(); R2b.close();

    // ============ GAME D: First Hand Bids Itself on, no kitty, hands 1 and 2 ============
    console.log('\nGAME D - First Hand Bids Itself on, hand 1 skips bidding, hand 2 bids');
    const S1 = new Client('Solo');
    await S1.connect();
    S1.send({ type: 'create', name: 'Solo' });
    await S1.waitMsg(m => m.type === 'joined', 'host D joined');
    await S1.waitFor(s => s.phase === 'lobby', 'game D lobby');
    check('First Hand Bids Itself defaults OFF in a new room', S1.state.settings.firstHandBidsItself === false, S1.state.settings);
    S1.send({ type: 'setSettings', settings: { firstHandBidsItself: true } });
    await S1.waitFor(s => s.settings.firstHandBidsItself === true, 'first hand rule set');
    check('toggle appears in settings once the host activates it', S1.state.settings.firstHandBidsItself === true, S1.state.settings);

    const seenD = { hand1Bidding: false, hand2Bidding: false, hand1Result: null };
    const stopD = autoplay(S1, {
      bid: () => ({ type: 'bid', bidKind: 'num', bidValue: 3 }),
      onPhase: s => {
        if (s.handNumber === 1 && s.phase === 'bidding') seenD.hand1Bidding = true;
        if (s.handNumber === 2 && s.phase === 'bidding') seenD.hand2Bidding = true;
        if (s.lastHand && s.lastHand.handNumber === 1) seenD.hand1Result = s.lastHand;
      },
    });
    S1.send({ type: 'startGame' });
    await S1.waitFor(s => s.phase === 'playing' && s.handNumber === 1, 'hand 1 goes straight to play', 30000);
    check('hand 1 opens in play, marked as a bids itself hand', S1.state.phase === 'playing' && S1.state.selfBidHand === true && S1.state.bidTurn === null, { phase: S1.state.phase, selfBidHand: S1.state.selfBidHand, bidTurn: S1.state.bidTurn });
    check('hand 1 shows no bids placed by anyone', S1.state.players.every(p => p.bid === null), S1.state.players.map(p => p.bid));

    await S1.waitFor(s => !!seenD.hand1Result, 'hand 1 scored', 180000);
    const lhD = seenD.hand1Result;
    check('hand 1 never entered a bidding phase', seenD.hand1Bidding === false);
    check('hand 1 result is flagged self bid with no Nil or Possible bids', lhD.selfBid === true && lhD.bids.every(b => b === 'Bids itself'), lhD.bids);
    check('hand 1 played all 13 tricks', lhD.tricks.reduce((a, b) => a + b, 0) === 13, lhD.tricks);
    check('hand 1: every team bid equals its books and scores exactly 10 per book, no set',
      lhD.results.every(res => res.teamBid === res.teamTricks && res.total === 10 * res.teamTricks && res.set === false && res.bagsEarned === 0), lhD.results);
    check('hand 1 scores on the board equal 10 per book per team',
      lhD.scores.every((v, i) => v === lhD.results[i].total), lhD.scores);

    await until(() => seenD.hand2Bidding === true, 'hand 2 bidding phase observed', 60000);
    check('hand 2 bids normally (a bidding phase runs on hand 2)', seenD.hand2Bidding === true);
    await S1.waitFor(s => s.lastHand && s.lastHand.handNumber === 2 && (s.phase === 'handEnd' || s.phase === 'gameOver'), 'hand 2 scored', 180000);
    stopD();
    check('hand 2 result is a normal bid hand, not self bid', S1.state.lastHand.selfBid === false && S1.state.lastHand.bids.every(b => b !== 'Bids itself'), S1.state.lastHand.bids);
    S1.close();

    // ============ GAME E: rule OFF leaves hand 1 bidding unchanged ============
    console.log('\nGAME E - First Hand Bids Itself off, hand 1 bids as usual');
    const O1 = new Client('Offie');
    await O1.connect();
    O1.send({ type: 'create', name: 'Offie' });
    await O1.waitMsg(m => m.type === 'joined', 'host E joined');
    const stopE = autoplay(O1, { bid: () => ({ type: 'bid', bidKind: 'num', bidValue: 3 }) });
    O1.send({ type: 'startGame' });
    await O1.waitFor(s => s.handNumber === 1 && (s.phase === 'bidding' || s.phase === 'playing'), 'game E hand 1 under way');
    check('rule OFF: hand 1 is not a self bid hand', O1.state.selfBidHand === false, O1.state.selfBidHand);
    // The autoplay host bids on sight, so catch the bidding phase through the bid record:
    await O1.waitFor(s => s.players.some(p => p.bid !== null) || s.phase === 'playing', 'a bid lands on hand 1 with the rule off');
    check('rule OFF: bids are placed on hand 1 as before', O1.state.players.some(p => p.bid !== null), O1.state.players.map(p => p.bid));
    stopE();
    O1.close();

    // ============ GAME F: First Hand Bids Itself + Kitty, dealer works hand 1 kitty ============
    console.log('\nGAME F - First Hand Bids Itself plus Kitty on, dealer kitty on hand 1');
    const K1 = new Client('Kit');
    await K1.connect();
    K1.send({ type: 'create', name: 'Kit' });
    await K1.waitMsg(m => m.type === 'joined', 'host F joined');
    K1.send({ type: 'setSettings', settings: { firstHandBidsItself: true, kitty: true } });
    await K1.waitFor(s => s.settings.firstHandBidsItself === true && s.settings.kitty === true, 'game F rules set');
    check('host can activate First Hand Bids Itself together with the Kitty', K1.state.settings.firstHandBidsItself && K1.state.settings.kitty, K1.state.settings);

    const seenF = { kittySeat: null, dealerSeat: null, dealerHand: null, selfBidKitty: null, hand1Result: null, hand2Bidding: false, hand1Bidding: false };
    const stopF = autoplay(K1, {
      bid: () => ({ type: 'bid', bidKind: 'num', bidValue: 3 }),
      onPhase: s => {
        if (s.handNumber === 1 && s.phase === 'bidding') seenF.hand1Bidding = true;
        if (s.handNumber === 1 && s.phase === 'kitty') {
          seenF.kittySeat = s.kittyWinnerIdx; seenF.dealerSeat = s.dealerIdx; seenF.selfBidKitty = s.selfBidHand;
          if (s.kittyWinnerIdx === s.you.seat) seenF.dealerHand = s.you.hand.length;
        }
        if (s.lastHand && s.lastHand.handNumber === 1) seenF.hand1Result = s.lastHand;
        if (s.handNumber === 2 && s.phase === 'bidding') seenF.hand2Bidding = true;
      },
    });
    K1.send({ type: 'startGame' });
    await K1.waitFor(s => seenF.kittySeat !== null || (s.handNumber === 1 && (s.phase === 'kitty' || s.phase === 'playing')), 'hand 1 opens with the kitty exchange', 30000);
    check('kitty game hand 1 goes to the kitty phase with no bidding first', seenF.kittySeat !== null && seenF.hand1Bidding === false && seenF.selfBidKitty === true, { kittySeat: seenF.kittySeat, selfBidKitty: seenF.selfBidKitty });
    check('hand 1 kitty sits with the dealer (seat 0 on hand 1)', seenF.kittySeat === seenF.dealerSeat && seenF.dealerSeat === 0, { kittySeat: seenF.kittySeat, dealerSeat: seenF.dealerSeat });
    check('dealer holds 16 cards for the exchange', seenF.dealerHand === 16, seenF.dealerHand);

    await K1.waitFor(s => !!seenF.hand1Result, 'kitty hand 1 scored', 180000);
    const lhF = seenF.hand1Result;
    check('kitty hand 1 completed as a self bid hand', lhF.selfBid === true && lhF.results.every(res => res.teamBid === res.teamTricks && res.total === 10 * res.teamTricks && res.set === false), lhF.results);
    check('kitty hand 1 played 12 tricks', lhF.tricks.reduce((a, b) => a + b, 0) === 12, lhF.tricks);
    await until(() => seenF.hand2Bidding === true, 'game F hand 2 bidding phase observed', 60000);
    check('game continues: hand 2 starts and bids normally', seenF.hand2Bidding === true, { handNumber: K1.state.handNumber, phase: K1.state.phase });
    stopF();
    K1.close();

    // ============ GAME G: Blind Bids, scripted eligible hand ============
    console.log('\nGAME G - Blind Bids on, build a 100 point gap, then a scripted blind hand');
    const GA = new Client('Alpha'), GB = new Client('Bravo'), GC = new Client('Charlie'), GD = new Client('Delta');
    for (const c of [GA, GB, GC, GD]) await c.connect();
    GA.send({ type: 'create', name: 'Alpha' });
    const joinedG = await GA.waitMsg(m => m.type === 'joined', 'host G joined');
    for (const c of [GB, GC, GD]) { c.send({ type: 'join', code: joinedG.code, name: c.name }); await c.waitMsg(m => m.type === 'joined', c.name + ' G joined'); }
    GA.send({ type: 'setSettings', settings: { blindBids: true } });
    await GA.waitFor(s => s.settings.blindBids === true, 'blind bids rule set');
    check('Blind Bids toggle appears in settings once the host activates it', GA.state.settings.blindBids === true, GA.state.settings);
    GA.send({ type: 'startGame' });
    await GA.waitFor(s => s.phase === 'bidding' && s.handNumber === 1, 'game G hand 1 bidding');
    check('level scores: no blind window and nobody is blind eligible', GA.state.blindEligible[0] === false && GA.state.blindEligible[1] === false, GA.state.blindEligible);
    GA.send({ type: 'blindDeclare', value: 7 });
    await sleep(300);
    check('a team down by less than 100 cannot declare blind', GA.errors.some(e => e.includes('Blind bids are only called')), GA.errors);

    // Build the gap: team 0 bids Nil and Nil (win-trying play busts Nil),
    // team 1 bids 1 and 1. Team 0 plunges until it trails by 100 or more
    // and the blind window opens. On the blind hand, team 0 plays to win
    // and team 1 ducks.
    const bidPlanG = { Alpha: { type: 'bid', bidKind: 'nil' }, Charlie: { type: 'bid', bidKind: 'nil' }, Bravo: { type: 'bid', bidKind: 'num', bidValue: 1 }, Delta: { type: 'bid', bidKind: 'num', bidValue: 1 } };
    const stopsG = [GA, GB, GC, GD].map(c => autoplay(c, {
      bid: () => bidPlanG[c.name],
      blind: () => null, // the blind hand is driven manually below
      card: () => {
        const s = c.state;
        if (s.teamBlind && s.teamBlind[0]) return s.you.team === 0 ? winCard(c) : duckCard(c);
        return winCard(c);
      },
    }));
    // A set blind hand drops the team further back, so the blind window
    // opens again on the next hand. Play blind attempts (steered: team 0
    // plays to win, team 1 ducks) until one is made, verifying the team
    // bid formula against an independent recomputation on every attempt.
    let madeBlind = false, blindAttempts = 0, lastBlindHand = 0, madeInfo = null;
    while (!madeBlind && blindAttempts < 4) {
      blindAttempts++;
      await GA.waitFor(s => s.phase === 'blind' && s.handNumber > lastBlindHand, 'blind window opens, attempt ' + blindAttempts, 420000);
      const blindHandNo = GA.state.handNumber;
      lastBlindHand = blindHandNo;
      const bagsBeforeG = GA.state.bags.slice();
      const scoresBeforeG = GA.state.scores.slice();
      if (blindAttempts === 1) {
        check('blind window opens only once a team trails by 100 or more', GA.state.blindEligible[0] === true && GA.state.blindEligible[1] === false && scoresBeforeG[1] - scoresBeforeG[0] >= 100, { eligible: GA.state.blindEligible, scores: scoresBeforeG });
        check('eligible players have not seen their cards yet', GA.state.you.hand.length === 0 && GA.state.you.blindDecision === 'pending' && GB.state.you.hand.length === 13, { alphaHand: GA.state.you.hand.length, bravoHand: GB.state.you.hand.length });
        GB.send({ type: 'blindDeclare', value: 7 });
        await sleep(300);
        check('a player on the leading team cannot declare blind', GB.errors.some(e => e.includes('Blind is not open')), GB.errors);
        GC.send({ type: 'blindLook' });
        await sleep(300);
        check('looking reveals the cards and spends the blind chance', GC.state.you.blindDecision === 'look' && GC.state.you.hand.length === 13, { decision: GC.state.you.blindDecision, hand: GC.state.you.hand.length });
        GC.send({ type: 'blindDeclare', value: 7 });
        await sleep(300);
        check('blind cannot be declared after viewing cards', GC.errors.some(e => e.includes('already looked')), GC.errors);
        GA.send({ type: 'blindDeclare', value: 5 });
        await sleep(250);
        GA.send({ type: 'blindDeclare', value: 11 });
        await sleep(250);
        check('blind bids are held to the 6 to 10 range', GA.errors.filter(e => e.includes('6 to 10')).length === 2, GA.errors);
      }
      GA.send({ type: 'blindDeclare', value: 6 });
      await GA.waitFor(s => !!(s.teamBlind && s.teamBlind[0] && s.teamBlind[0].value === 6), 'blind 6 stands for team 0');
      if (blindAttempts === 1) {
        check('the blind call stands as a team bid from the declarer', GA.state.players[0].bid === 'Blind 6' && GA.state.teamBlind[0].declarerSeat === 0, GA.state.teamBlind);
        check('the partner is covered and adds no bid of their own', GA.state.players[2].bid === 'Blind (team)', GA.state.players[2].bid);
        await GA.waitFor(s => s.phase === 'bidding', 'normal bidding follows the blind window');
        const charlieErrsBefore = GC.errors.length;
        GC.send({ type: 'bid', bidKind: 'num', bidValue: 3 });
        await sleep(400);
        check('partner cannot add a bid after their team declared blind', GC.state.players[2].bid === 'Blind (team)' && GC.errors.length > charlieErrsBefore, { bid: GC.state.players[2].bid, errors: GC.errors });
      }
      await GA.waitFor(s => s.lastHand && s.lastHand.handNumber === blindHandNo && (s.phase === 'handEnd' || s.phase === 'gameOver'), 'blind hand scored, attempt ' + blindAttempts, 420000);
      const lhG = GA.state.lastHand;
      const resG = lhG.results[0];
      const tricksG = lhG.tricks[0] + lhG.tricks[2];
      let expectedG;
      if (tricksG >= 6) {
        const bagsE = tricksG - 6;
        const pen = (Math.floor((bagsBeforeG[0] + bagsE) / 10) - Math.floor(bagsBeforeG[0] / 10)) * 100;
        expectedG = 120 + bagsE - pen;
      } else expectedG = -60;
      check('blind attempt ' + blindAttempts + ': the blind number is the team total in the result', resG.teamBid === 6 && resG.blindValue === 6, resG);
      check('blind attempt ' + blindAttempts + ': server score matches the independent team bid recomputation', resG.total === expectedG && resG.blindAdj === (tricksG >= 6 ? 60 : 0), { total: resG.total, expected: expectedG, tricks: tricksG });
      if (tricksG >= 6) { madeBlind = true; madeInfo = { tricks: tricksG, declarerTricks: lhG.tricks[0], total: resG.total }; }
    }
    for (const stop of stopsG) stop();
    check('a steered blind team made its Blind 6 (double pay verified on the made hand)', madeBlind, { attempts: blindAttempts, madeInfo });
    for (const c of [GA, GB, GC, GD]) c.close();

    // ============ GAME H: Blind Bids on, solo host plus bots, full game ============
    console.log('\nGAME H - Blind Bids on, quick game to 250, bots fill the table');
    const HB = new Client('HostB');
    await HB.connect();
    HB.send({ type: 'create', name: 'HostB' });
    await HB.waitMsg(m => m.type === 'joined', 'host H joined');
    HB.send({ type: 'setSettings', settings: { blindBids: true, targetScore: 250 } });
    await HB.waitFor(s => s.settings.blindBids === true && s.settings.targetScore === 250, 'game H rules set');
    check('host can activate Blind Bids with the quick game', HB.state.settings.blindBids && HB.state.settings.targetScore === 250, HB.state.settings);
    const stopHB = autoplay(HB, {
      bid: () => ({ type: 'bid', bidKind: 'num', bidValue: 3 }),
      blind: () => ({ type: 'blindLook' }),
    });
    HB.send({ type: 'startGame' });
    await HB.waitFor(s => s.phase === 'gameOver', 'game H plays to a winner', 420000);
    stopHB();
    const sawBlindPhase = HB.inbox.some(m => m.type === 'state' && (m.phase === 'blind' || (m.teamBlind && (m.teamBlind[0] || m.teamBlind[1]))));
    console.log('  INFO  blind window seen during game H: ' + sawBlindPhase);
    check('game H has a winning team', HB.state.winnerTeam === 0 || HB.state.winnerTeam === 1, HB.state.winnerTeam);
    check('game H winning team reached the 250 target', HB.state.scores[HB.state.winnerTeam] >= 250 && HB.state.scores[HB.state.winnerTeam] > HB.state.scores[1 - HB.state.winnerTeam], HB.state.scores);
    HB.close();
  } finally {
    server.kill();
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
