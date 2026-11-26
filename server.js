'use strict';
// 2 and a Possible: game server.
// All game state lives server side. Each client only ever receives its
// own hand; opponents' cards are never sent, only counts.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game');
const BOTS = require('./bots');

const PORT = parseInt(process.env.PORT || '3001', 10);
const BOT_DELAY_MIN_MS = parseInt(process.env.BOT_DELAY_MIN_MS || '900', 10);
const BOT_DELAY_MAX_MS = parseInt(process.env.BOT_DELAY_MAX_MS || '2200', 10);
const TRICK_PAUSE_MS = parseInt(process.env.TRICK_PAUSE_MS || '1100', 10);

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const rooms = new Map();

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function newId() { return crypto.randomBytes(8).toString('hex'); }
function newToken() { return crypto.randomBytes(16).toString('hex'); }

function defaultSettings() {
  return {
    targetScore: 500,  // 500 | 250 (House Rule: quick game)
    jjdd: false,       // House Rule: Joker Joker Deuce Deuce
    kitty: false,      // House Rule: play with the kitty
    firstHandBidsItself: false, // House Rule: no bidding on hand 1, the hand scores what it takes
    blindBids: false,  // House Rule: a team down 100 or more may call a blind team bid before seeing cards
    format: 'partners' // Partners is the v1 format (seats 0+2 vs 1+3)
  };
}

function makePlayer(name) {
  return {
    id: newId(), token: newToken(),
    name: String(name || 'Player').slice(0, 20),
    ws: null, connected: false, isBot: false, personality: null,
    hand: [], bid: null, tricks: 0, _botTimer: null, _botFor: null,
    blindDecision: 'none', // none | pending | blind | look | covered
  };
}
function makeBot(room) {
  const used = new Set(room.players.map(p => p.name));
  let name = BOTS.BOT_NAMES.find(n => !used.has(n));
  if (!name) name = `Bot Cousin ${room.players.filter(p => p.isBot).length + 1}`;
  const botCount = room.players.filter(p => p.isBot).length;
  const bot = makePlayer(name);
  bot.isBot = true;
  bot.personality = BOTS.PERSONALITY_ORDER[botCount % BOTS.PERSONALITY_ORDER.length];
  bot.connected = true;
  return bot;
}
function makeRoom(host) {
  const room = {
    code: newCode(), hostId: host.id, players: [host],
    phase: 'lobby', settings: defaultSettings(),
    dealerIdx: 0, handNumber: 0,
    scores: [0, 0], bags: [0, 0],
    bids: [null, null, null, null],
    blindEligible: [false, false], teamBlind: [null, null],
    bidTurn: null, currentTurn: null, leaderIdx: null,
    trick: [], tricksWon: [0, 0, 0, 0], spadesBroken: false,
    kitty: [], kittyCards: [], kittyWinnerIdx: null,
    lastHand: null, lastTrick: null, winnerTeam: null,
    trickTimer: null, createdAt: Date.now(), emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}
function teamOf(seat) { return seat % 2; }
// True while the First Hand Bids Itself rule is running this room: the
// setting is on and the current (or just scored) hand is hand 1.
function isSelfBidHand(room) { return !!(room.settings.firstHandBidsItself && room.handNumber === 1); }
function effectiveHost(room) {
  const host = room.players.find(p => p.id === room.hostId);
  if (host && host.connected) return host;
  return room.players.find(p => p.connected && !p.isBot) || room.players.find(p => p.connected) || host;
}
function isHost(room, player) { const h = effectiveHost(room); return h && h.id === player.id; }

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---------- state ----------
function stateFor(room, me) {
  const mySeat = room.players.indexOf(me);
  const host = effectiveHost(room);
  // During the blind window, a player who still owes a blind call has not
  // seen their cards: the server sends an empty hand, only the count in
  // the players list. The moment they look or call blind, cards come out.
  const cardsHidden = room.phase === 'blind' && me.blindDecision === 'pending';
  return {
    type: 'state',
    code: room.code,
    phase: room.phase,
    settings: room.settings,
    isHost: isHost(room, me),
    blindEligible: room.blindEligible,
    teamBlind: room.teamBlind,
    you: {
      id: me.id, name: me.name, seat: mySeat,
      team: mySeat >= 0 ? teamOf(mySeat) : null,
      blindDecision: me.blindDecision,
      hand: cardsHidden ? [] : G.sortHand(me.hand, room.settings),
      bid: me.bid, tricks: me.tricks,
      isBot: !!me.isBot,
      legal: room.phase === 'playing' && room.currentTurn === mySeat
        ? G.legalCards(me.hand, room.trick, room.settings, room.spadesBroken).map(c => c.id) : [],
      kittyCards: room.phase === 'kitty' && room.kittyWinnerIdx === mySeat ? (room.kittyCards || []) : [],
    },
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name, seat: i, team: teamOf(i),
      connected: p.connected, isBot: !!p.isBot,
      personality: p.isBot ? BOTS.PERSONALITIES[p.personality].label : null,
      isHost: host && p.id === host.id,
      cardCount: p.hand.length,
      bid: p.bid ? G.bidLabel(p.bid) : null,
      blindDecision: p.blindDecision,
      tricks: p.tricks,
    })),
    dealerIdx: room.dealerIdx,
    handNumber: room.handNumber,
    selfBidHand: isSelfBidHand(room),
    scores: room.scores, bags: room.bags,
    bidTurn: room.bidTurn, currentTurn: room.currentTurn, leaderIdx: room.leaderIdx,
    trick: room.trick.map(t => ({ seat: t.playerIdx, name: room.players[t.playerIdx].name, card: t.card })),
    lastTrick: room.lastTrick,
    tricksWon: room.tricksWon,
    spadesBroken: room.spadesBroken,
    kittyWinnerIdx: room.kittyWinnerIdx,
    kittyCount: (room.kittyCards || []).length,
    lastHand: room.lastHand,
    winnerTeam: room.winnerTeam,
    standings: [0, 1].map(t => ({ team: t, score: room.scores[t], bags: room.bags[t], players: [room.players[t], room.players[t + 2]].filter(Boolean).map(p => p.name) })),
  };
}
function send(player, obj) { if (player.ws && player.ws.readyState === 1) player.ws.send(JSON.stringify(obj)); }
function fail(player, message) { send(player, { type: 'error', message }); }
function broadcast(room) { for (const p of room.players) if (p.connected) send(p, stateFor(room, p)); driveBots(room); }

// ---------- bots ----------
function botDelay() { return BOT_DELAY_MIN_MS + Math.floor(Math.random() * Math.max(1, BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS)); }
function scheduleBot(room, bot, tag, act) {
  if (bot._botTimer && bot._botFor !== tag) { clearTimeout(bot._botTimer); bot._botTimer = null; bot._botFor = null; }
  if (bot._botTimer) return;
  bot._botFor = tag;
  bot._botTimer = setTimeout(() => {
    bot._botTimer = null; bot._botFor = null;
    if (!rooms.has(room.code) || !room.players.includes(bot)) return;
    try { act(); } catch (e) { console.error('bot action error', e); }
  }, botDelay());
  if (bot._botTimer.unref) bot._botTimer.unref();
}
function driveBots(room) {
  for (const bot of room.players.filter(p => p.isBot)) {
    const seat = room.players.indexOf(bot);
    if (room.phase === 'blind' && bot.blindDecision === 'pending') {
      scheduleBot(room, bot, `blind:${room.handNumber}:${seat}`, () => {
        if (room.phase !== 'blind' || bot.blindDecision !== 'pending') return;
        const v = BOTS.chooseBlind(bot.personality, bot.hand, room.settings);
        handleMessage(room, bot, v ? { type: 'blindDeclare', value: v } : { type: 'blindLook' });
      });
    }
    if (room.phase === 'bidding' && room.bidTurn === seat && !bot.bid) {
      scheduleBot(room, bot, `bid:${room.handNumber}:${seat}`, () => {
        if (room.phase !== 'bidding' || room.bidTurn !== seat || bot.bid) return;
        handleMessage(room, bot, { type: 'bid', ...bidMsg(BOTS.chooseBid(bot.personality, bot.hand, room.settings)) });
      });
    }
    if (room.phase === 'kitty' && room.kittyWinnerIdx === seat) {
      scheduleBot(room, bot, `kitty:${room.handNumber}:${seat}`, () => {
        if (room.phase !== 'kitty' || room.kittyWinnerIdx !== seat) return;
        const discards = BOTS.chooseKittyDiscards(bot.personality, bot.hand, room.settings, G.kittySizeFor(room.settings));
        handleMessage(room, bot, { type: 'kittyDiscard', cardIds: discards });
      });
    }
    if (room.phase === 'playing' && room.currentTurn === seat) {
      scheduleBot(room, bot, `play:${room.handNumber}:${room.tricksWon.reduce((a, b) => a + b, 0)}:${room.trick.length}:${seat}`, () => {
        if (room.phase !== 'playing' || room.currentTurn !== seat) return;
        const id = BOTS.chooseCard(bot.personality, bot.hand, room.trick, room.settings, room.spadesBroken, seat);
        handleMessage(room, bot, { type: 'playCard', cardId: id });
      });
    }
  }
}
function bidMsg(bid) {
  if (bid.kind === 'nil') return { bidKind: 'nil' };
  if (bid.kind === 'possible') return { bidKind: 'possible' };
  return { bidKind: 'num', bidValue: bid.value };
}

// ---------- hand flow ----------
function startGame(room) {
  room.scores = [0, 0]; room.bags = [0, 0];
  room.handNumber = 0; room.dealerIdx = 0; room.winnerTeam = null; room.lastHand = null;
  startHand(room);
}
function startHand(room) {
  room.handNumber += 1;
  if (room.handNumber > 1) room.dealerIdx = (room.dealerIdx + 1) % 4;
  const s = room.settings;
  const deck = shuffle(G.buildDeck(s));
  const hs = G.handSizeFor(s);
  room.players.forEach((p, i) => {
    p.hand = deck.slice(i * hs, (i + 1) * hs);
    p.bid = null; p.tricks = 0; p.blindDecision = 'none';
  });
  room.teamBlind = [null, null];
  room.blindEligible = [false, false];
  room.kitty = s.kitty ? deck.slice(4 * hs, 4 * hs + G.kittySizeFor(s)) : [];
  room.kittyCards = room.kitty.slice();
  room.bids = [null, null, null, null];
  room.tricksWon = [0, 0, 0, 0];
  room.trick = []; room.lastTrick = null;
  room.spadesBroken = false;
  room.kittyWinnerIdx = null;
  room.currentTurn = null; room.leaderIdx = null;
  if (isSelfBidHand(room)) {
    // First Hand Bids Itself: no bidding round at all on hand 1. No Nil,
    // no signature bid. With the Kitty on there is no high bidder, so the
    // dealer does the kitty exchange on this hand.
    room.bidTurn = null;
    if (s.kitty) {
      room.kittyWinnerIdx = room.dealerIdx;
      const dealer = room.players[room.dealerIdx];
      dealer.hand = dealer.hand.concat(room.kitty);
      room.phase = 'kitty';
      broadcast(room);
      return;
    }
    beginPlay(room);
    return;
  }
  if (s.blindBids) {
    // Blind Bids window: a team trailing by 100 or more at the start of
    // the hand may call a blind team bid before seeing any cards. Never
    // on a First Hand Bids Itself hand (that hand has no bidding at all;
    // the self bid branch above already returned).
    for (let t = 0; t < 2; t++) {
      if (room.scores[t] + 100 <= room.scores[1 - t]) room.blindEligible[t] = true;
    }
    if (room.blindEligible[0] || room.blindEligible[1]) {
      room.players.forEach((p, i) => { if (room.blindEligible[teamOf(i)]) p.blindDecision = 'pending'; });
      room.phase = 'blind';
      room.bidTurn = null;
      broadcast(room);
      return;
    }
  }
  room.phase = 'bidding';
  room.bidTurn = (room.dealerIdx + 1) % 4;
  broadcast(room);
}
// The blind window closes when every player who owed a call has made one
// (declared, looked, or been covered by their partner's declaration).
// Returns true when it closed the window.
function checkBlindDone(room) {
  if (room.phase !== 'blind') return false;
  if (room.players.some(p => p.blindDecision === 'pending')) return false;
  if (room.players.every(p => p.bid)) { finishBidding(room); return true; }
  room.phase = 'bidding';
  let next = (room.dealerIdx + 1) % 4;
  while (room.players[next].bid) next = (next + 1) % 4;
  room.bidTurn = next;
  broadcast(room);
  return true;
}
function finishBidding(room) {
  // Highest individual bidder takes the kitty. Ties go to the earliest bidder.
  if (room.settings.kitty) {
    let bestSeat = 0, bestVal = -1, bestOrder = 99;
    room.players.forEach((p, i) => {
      const v = G.bidValue(p.bid);
      const order = (i - room.bidTurn + 4) % 4;
      if (v > bestVal || (v === bestVal && order < bestOrder)) { bestVal = v; bestSeat = i; bestOrder = order; }
    });
    room.kittyWinnerIdx = bestSeat;
    const winner = room.players[bestSeat];
    winner.hand = winner.hand.concat(room.kitty);
    room.phase = 'kitty';
    broadcast(room);
    return;
  }
  beginPlay(room);
}
function beginPlay(room) {
  room.kitty = [];
  room.kittyCards = [];
  room.phase = 'playing';
  room.leaderIdx = (room.dealerIdx + 1) % 4;
  room.currentTurn = room.leaderIdx;
  broadcast(room);
}
function completeTrick(room) {
  const winIdx = G.trickWinner(room.trick, room.settings);
  const winSeat = room.trick[winIdx].playerIdx;
  room.players[winSeat].tricks += 1;
  room.tricksWon[winSeat] += 1;
  // A trump played on a non trump lead breaks spades.
  const ledSuit = G.effectiveSuit(room.trick[0].card, room.settings);
  if (ledSuit !== 'S' && room.trick.some(t => G.isTrump(t.card, room.settings))) room.spadesBroken = true;
  if (room.trick.some(t => G.isTrump(t.card, room.settings)) && ledSuit === 'S') room.spadesBroken = true;
  room.lastTrick = {
    plays: room.trick.map(t => ({ seat: t.playerIdx, name: room.players[t.playerIdx].name, card: t.card })),
    winnerSeat: winSeat, winnerName: room.players[winSeat].name,
  };
  room.trick = [];
  room.leaderIdx = winSeat;
  room.currentTurn = null;
  broadcast(room);
  room.trickTimer = setTimeout(() => {
    room.trickTimer = null;
    if (!rooms.has(room.code)) return;
    if (room.players.every(p => p.hand.length === 0)) return scoreHand(room);
    room.currentTurn = winSeat;
    room.phase = 'playing';
    broadcast(room);
  }, TRICK_PAUSE_MS);
  if (room.trickTimer.unref) room.trickTimer.unref();
}
function scoreHand(room) {
  const selfBid = isSelfBidHand(room);
  const results = [];
  for (let team = 0; team < 2; team++) {
    const seats = [team, team + 2];
    const r = selfBid
      ? G.scoreSelfBidTeam(seats.map(s => room.players[s].tricks), room.bags[team])
      : G.scoreTeam(seats.map(s => room.players[s].bid), seats.map(s => room.players[s].tricks), room.bags[team]);
    room.scores[team] += r.total;
    room.bags[team] = r.bagsAfter % 10;
    results.push({ team, seats, ...r, scoreAfter: room.scores[team] });
  }
  room.lastHand = {
    handNumber: room.handNumber,
    selfBid,
    bids: selfBid ? room.players.map(() => 'Bids itself') : room.players.map(p => G.bidLabel(p.bid)),
    tricks: room.players.map(p => p.tricks),
    results,
    scores: room.scores.slice(),
  };
  const target = room.settings.targetScore;
  const [s0, s1] = room.scores;
  let winner = null;
  if ((s0 >= target || s1 >= target) && s0 !== s1) winner = s0 > s1 ? 0 : 1;
  if (winner !== null) {
    room.winnerTeam = winner;
    room.phase = 'gameOver';
  } else {
    room.phase = 'handEnd';
  }
  broadcast(room);
}

// ---------- messages ----------
function handleMessage(room, player, msg) {
  const seat = room.players.indexOf(player);
  switch (msg.type) {
    case 'setSettings': {
      if (!isHost(room, player) || room.phase !== 'lobby') return fail(player, 'Only the host can change House Rules in the lobby.');
      const s = msg.settings || {};
      if ([500, 250].includes(s.targetScore)) room.settings.targetScore = s.targetScore;
      if (typeof s.jjdd === 'boolean') room.settings.jjdd = s.jjdd;
      if (typeof s.kitty === 'boolean') room.settings.kitty = s.kitty;
      if (typeof s.firstHandBidsItself === 'boolean') room.settings.firstHandBidsItself = s.firstHandBidsItself;
      if (typeof s.blindBids === 'boolean') room.settings.blindBids = s.blindBids;
      broadcast(room);
      break;
    }
    case 'addBot': {
      if (!isHost(room, player)) return fail(player, 'Only the host can seat a bot.');
      if (room.phase !== 'lobby') return fail(player, 'Bots take their seats in the lobby.');
      if (room.players.length >= 4) return fail(player, 'The table is full. Four seats, that is everybody.');
      room.players.push(makeBot(room));
      broadcast(room);
      break;
    }
    case 'removeBot': {
      if (!isHost(room, player)) return fail(player, 'Only the host can unseat a bot.');
      if (room.phase !== 'lobby') return fail(player, 'Bots leave from the lobby, not mid-game.');
      const idx = room.players.findIndex(p => p.id === msg.playerId && p.isBot);
      if (idx < 0) return fail(player, 'That seat is not a bot.');
      const [bot] = room.players.splice(idx, 1);
      if (bot._botTimer) clearTimeout(bot._botTimer);
      broadcast(room);
      break;
    }
    case 'startGame': {
      if (!isHost(room, player)) return fail(player, 'Only the host can start the game.');
      if (room.phase !== 'lobby' && room.phase !== 'gameOver') return fail(player, 'Game already running.');
      while (room.players.length < 4) room.players.push(makeBot(room)); // bots fill empty seats
      startGame(room);
      break;
    }
    case 'blindDeclare': {
      if (room.phase !== 'blind') return fail(player, 'Blind bids are only called before anyone looks at their cards.');
      if (player.blindDecision === 'look') return fail(player, 'You already looked at your cards. Blind is off the table for you this hand.');
      if (player.blindDecision !== 'pending') return fail(player, 'Blind is not open to you on this hand.');
      const team = teamOf(seat);
      if (room.teamBlind[team]) return fail(player, 'Your team already has a blind bid this hand.');
      const v = msg.value | 0;
      if (v < 6 || v > 10) return fail(player, 'Blind bids run from 6 to 10 books.');
      // A blind bid is a TEAM bid: this number is the team's whole target.
      // The declarer becomes the team's bidder of record, and the partner
      // is covered: they place no bid of their own this hand.
      room.teamBlind[team] = { value: v, declarerSeat: seat };
      player.bid = { kind: 'blind', value: v };
      room.bids[seat] = player.bid;
      player.blindDecision = 'blind';
      const mateSeat = (seat + 2) % 4;
      const mate = room.players[mateSeat];
      mate.bid = { kind: 'blindCovered' };
      room.bids[mateSeat] = mate.bid;
      if (mate.blindDecision === 'pending') mate.blindDecision = 'covered';
      if (!checkBlindDone(room)) broadcast(room);
      break;
    }
    case 'blindLook': {
      if (room.phase !== 'blind') return fail(player, 'There is no blind call to make right now.');
      if (player.blindDecision !== 'pending') return fail(player, 'You already made your blind call for this hand.');
      player.blindDecision = 'look';
      if (!checkBlindDone(room)) broadcast(room);
      break;
    }
    case 'bid': {
      if (room.phase !== 'bidding') return fail(player, 'Bidding is not open right now.');
      if (room.bidTurn !== seat) return fail(player, 'Not your bid yet.');
      if (player.bid) return fail(player, 'You already bid this hand.');
      const bid = G.parseBid(msg);
      if (!bid) return fail(player, 'Bid 1 to 13, Nil, or 2 and a Possible.');
      if (bid.kind === 'num' && bid.value > player.hand.length) return fail(player, 'You cannot bid more books than you hold cards.');
      player.bid = bid;
      room.bids[seat] = bid;
      // Advance to the next player who has not bid; four bids end the phase.
      if (room.players.every(p => p.bid)) { finishBidding(room); break; }
      let next = seat;
      do { next = (next + 1) % 4; } while (room.players[next].bid);
      room.bidTurn = next;
      broadcast(room);
      break;
    }
    case 'kittyDiscard': {
      if (room.phase !== 'kitty') return fail(player, 'No kitty exchange right now.');
      if (room.kittyWinnerIdx !== seat) return fail(player, 'The kitty is not yours to work on this hand.');
      const need = G.kittySizeFor(room.settings);
      const ids = Array.isArray(msg.cardIds) ? msg.cardIds : [];
      if (ids.length !== need || new Set(ids).size !== need) return fail(player, `Pick exactly ${need} cards to put back.`);
      const picked = ids.map(id => player.hand.find(c => c.id === id));
      if (picked.some(c => !c)) return fail(player, 'One of those cards is not in your hand.');
      player.hand = player.hand.filter(c => !ids.includes(c.id));
      room.kitty = [];
      beginPlay(room);
      break;
    }
    case 'playCard': {
      if (room.phase !== 'playing') return fail(player, 'No trick in play right now.');
      if (room.currentTurn !== seat) return fail(player, 'Not your turn.');
      const card = player.hand.find(c => c.id === msg.cardId);
      if (!card) return fail(player, 'That card is not in your hand.');
      const legal = G.legalCards(player.hand, room.trick, room.settings, room.spadesBroken);
      if (!legal.some(c => c.id === card.id)) {
        const led = room.trick.length ? G.effectiveSuit(room.trick[0].card, room.settings) : null;
        return fail(player, led ? 'You have to follow suit if you can.' : 'Spades are not broken yet. You cannot lead them.');
      }
      player.hand = player.hand.filter(c => c.id !== card.id);
      if (room.trick.length === 0 && G.isTrump(card, room.settings)) room.spadesBroken = true;
      room.trick.push({ playerIdx: seat, card });
      if (room.trick.length === 4) { completeTrick(room); break; }
      room.currentTurn = (seat + 1) % 4;
      broadcast(room);
      break;
    }
    case 'nextHand': {
      if (!isHost(room, player)) return fail(player, 'Only the host can deal the next hand.');
      if (room.phase !== 'handEnd') return fail(player, 'This hand is not scored yet.');
      room.dealerIdx = room.dealerIdx; // startHand advances it
      startHand(room);
      break;
    }
    case 'playAgain': {
      if (!isHost(room, player)) return fail(player, 'Only the host can restart.');
      if (room.phase !== 'gameOver') return fail(player, 'The game is not over yet.');
      for (const p of room.players) { p.hand = []; p.bid = null; p.tricks = 0; p.blindDecision = 'none'; }
      room.teamBlind = [null, null]; room.blindEligible = [false, false];
      room.winnerTeam = null; room.lastHand = null; room.phase = 'lobby';
      broadcast(room);
      break;
    }
    default:
      fail(player, 'Unknown message.');
  }
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('client missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let room = null, player = null;
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (msg.type === 'create') {
        player = makePlayer(msg.name);
        room = makeRoom(player);
        player.ws = ws; player.connected = true;
        send(player, { type: 'joined', code: room.code, playerId: player.id, token: player.token, isHost: true });
        broadcast(room);
        return;
      }
      if (msg.type === 'join') {
        const target = rooms.get(String(msg.code || '').toUpperCase());
        if (!target) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found. Check the code.' })); return; }
        room = target;
        let seatPlayer = null;
        if (msg.token) seatPlayer = room.players.find(p => p.token === msg.token);
        if (!seatPlayer && msg.name) seatPlayer = room.players.find(p => !p.connected && !p.isBot && p.name.toLowerCase() === String(msg.name).toLowerCase());
        if (seatPlayer) {
          player = seatPlayer;
          player.ws = ws; player.connected = true;
          send(player, { type: 'joined', code: room.code, playerId: player.id, token: player.token, isHost: isHost(room, player), rejoined: true });
          broadcast(room);
          return;
        }
        if (room.phase !== 'lobby') { ws.send(JSON.stringify({ type: 'error', message: 'That game already started. Rejoin with the same name to reclaim your seat.' })); return; }
        if (room.players.length >= 4) { ws.send(JSON.stringify({ type: 'error', message: 'That room is full (4 players).' })); return; }
        player = makePlayer(msg.name);
        player.ws = ws; player.connected = true;
        room.players.push(player);
        send(player, { type: 'joined', code: room.code, playerId: player.id, token: player.token, isHost: false });
        broadcast(room);
        return;
      }
      if (!room || !player) { ws.send(JSON.stringify({ type: 'error', message: 'Join a room first.' })); return; }
      handleMessage(room, player, msg);
    } catch (e) {
      console.error('message error', e);
      if (player) fail(player, 'Something went wrong with that move.');
    }
  });
  ws.on('close', () => {
    if (room && player) {
      player.connected = false; player.ws = null;
      if (!room.players.some(p => !p.isBot && p.connected)) room.emptySince = Date.now();
      broadcast(room);
    }
  });
});

setInterval(() => { for (const client of wss.clients) { try { client.ping(); } catch {} } }, 30000);
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > 30 * 60 * 1000) {
      if (room.trickTimer) clearTimeout(room.trickTimer);
      rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, () => { console.log(`2 and a Possible server listening on port ${PORT}`); });
