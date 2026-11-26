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
// plan: { bidFor(name, state) -> msg, onPhase(state) optional }
function autoplay(client, plan) {
  const acted = { bid: -1, kitty: -1, next: -1 };
  const timer = setInterval(() => {
    const s = client.state;
    if (!s) return;
    try {
      if (plan.onPhase) plan.onPhase(s);
      if (s.phase === 'bidding' && s.bidTurn === s.you.seat && !s.you.bid && acted.bid !== s.handNumber) {
        acted.bid = s.handNumber;
        client.send(plan.bid ? plan.bid(s) : { type: 'bid', bidKind: 'num', bidValue: 3 });
      }
      if (s.phase === 'kitty' && s.kittyWinnerIdx === s.you.seat && acted.kitty !== s.handNumber) {
        acted.kitty = s.handNumber;
        client.send({ type: 'kittyDiscard', cardIds: s.you.hand.slice(0, 4).map(c => c.id) });
      }
      if (s.phase === 'playing' && s.currentTurn === s.you.seat && s.you.legal.length) {
        client.send({ type: 'playCard', cardId: s.you.legal[0] });
      }
      if (s.phase === 'handEnd' && s.isHost && acted.next !== s.handNumber) {
        acted.next = s.handNumber;
        setTimeout(() => client.send({ type: 'nextHand' }), 120);
      }
    } catch (e) { /* next tick retries */ }
  }, 80);
  return () => clearInterval(timer);
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
  } finally {
    server.kill();
  }

  console.log(`\n==== RESULT: ${passed} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
