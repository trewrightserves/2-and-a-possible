# 2 and a Possible - Online Spades

The second game in the We All Gone Eat game suite. Spades the way the table
talks it: four players, partners across the table, played on any phone
browser with a 4-letter room code. No installs, no accounts, no app store.
Short a player or three? Bots fill the empty seats, so one person can run a
full table solo.

The name is the bid every Spades player knows: "I got 2, and a possible."
Here it is a real bid you can call. See the signature bid below.

## Run it locally

```bash
cd app
npm install   # one dependency: ws (already vendored in this folder)
npm start     # serves on http://localhost:3001
```

Open `http://localhost:3001` in a browser. One player creates a room and
shares the 4-letter code; everyone else joins with the code. Starting the
game fills any empty seats with bots.

Optional environment variables:

| Variable           | Default | Purpose                                  |
|--------------------|---------|------------------------------------------|
| `PORT`             | `3001`  | Port the server listens on.              |
| `BOT_DELAY_MIN_MS` | `900`   | Fastest a bot acts (bid, kitty, play).   |
| `BOT_DELAY_MAX_MS` | `2200`  | Slowest a bot acts, the human pause.     |
| `TRICK_PAUSE_MS`   | `1100`  | Pause to read a finished trick.          |

## How a hand flows

1. **Lobby** - host creates the room, everyone joins by code, host sets the
   House Rules below and starts. Bots fill any seats still empty.
2. **Deal** - 13 cards each (12 each plus a kitty when the Kitty rule is on).
   Dealer rotates every hand.
3. **Bidding** - each player bids once, starting left of the dealer: a
   number from 1 up to the cards in hand, Nil, or the signature bid. The
   team bid is the two partners' bids added together. Exception: with the
   First Hand Bids Itself rule on, hand 1 has no bidding round at all.
   With Blind Bids on, a blind window comes before bidding on any hand
   where a team trails by 100 or more: see House Rule 5.
4. **Kitty exchange** (Kitty rule only) - the highest individual bidder
   picks up the kitty, then puts 4 cards back. Ties go to the earliest
   bidder. Exception: with First Hand Bids Itself also on, hand 1 has no
   high bidder, so the dealer does the exchange on that hand.
5. **Play** - the player left of the dealer leads the first trick. Follow
   suit if you can. Spades are trump and cannot be led until broken, unless
   a hand is all spades. Trick winner leads the next trick.
6. **Score** - the hand breakdown shows every team's math: bid, books, base
   points, sandbags, Nil and Possible results. Host deals the next hand.
7. **Win** - first team to the target score wins. If both teams cross the
   target on the same hand, the higher score wins; a dead tie plays another
   hand.

Dropped connections are safe: rejoin with the same name and the room code
(the phone remembers your seat token) and your seat, hand, and score are
restored.

## Scoring (exact, as implemented)

- **Make the team bid:** 10 points per bid book, plus 1 point per
  overtrick. Overtricks are **sandbags**.
- **Sandbags:** every 10 cumulative sandbags cost the team **100 points**,
  charged on the hand where the tenth bag lands.
- **Miss the team bid (set):** minus 10 points per bid book. No sandbags
  are earned on a set hand.
- **Nil:** plus 100 if the Nil bidder takes no tricks, minus 100 if they
  take even one. A Nil bidder's tricks still count toward the team total
  for the partner's bid. Both partners may bid Nil; each is judged on its
  own.
- **Target:** 500 points standard. The Quick Game House Rule plays to 250.

## The signature bid: 2 and a Possible

Any player, on their bid turn, may bid **2 and a Possible** instead of a
number. Exact scoring, as implemented:

- It counts as **2** toward the team bid.
- The bidder personally takes **3 or more** books: the team earns a
  **20 point bonus**.
- The bidder takes **exactly 2**: the bid is made. No bonus, no penalty.
- The bidder takes **0 or 1**: the guarantee missed, **minus 20 points**.
  That alone does not set the team; the set is still decided by team books
  against the team bid, as usual.
- It works with every House Rule below, including JJDD and the Kitty (in a
  Kitty hand it still counts as 2, judged on the bidder's own books).

## House Rules (host toggles in the lobby, all OFF by default)

1. **Joker Joker Deuce Deuce** - the trump order at the top becomes:
   Big Joker, Little Joker, 2 of Spades, 2 of Diamonds, then Ace of
   Spades on down. Both jokers are added and the 2 of Hearts and the 2 of
   Clubs are removed, so the deck stays at 52 cards. Both deuces count as
   spades for following suit: the 2 of Diamonds must follow a spade lead,
   and it does not count as a diamond when diamonds are led.
2. **The Kitty** - each player is dealt 12 cards and 4 cards go face down
   as the kitty. After bidding, the highest individual bidder picks up the
   kitty (ties go to the earliest bidder), looks at all 16 cards, and puts
   any 4 back face down. The discards are out of the hand and score
   nothing. The hand plays 12 tricks.
3. **Quick Game** - play to 250 instead of 500.
4. **First Hand Bids Itself** - hand 1 has no bidding round at all: no
   number bids, no Nil, and no signature bid. The hand plays out and each
   team's bid for that hand is set after the fact to the number of books
   the team actually took. Exact scoring for hand 1: 10 points per book
   taken, and that is all. Nobody can be set, no overtricks exist (the bid
   equals the books), no sandbags are earned on hand 1 so the team's
   cumulative sandbag count does not move and no sandbag penalty can land
   on that hand, and there are no Nil or Possible adjustments. From hand 2
   onward bidding is completely normal. If the Kitty is also on, hand 1
   has no highest bidder, so the dealer picks up the kitty and puts any 4
   back on that hand; hands 2 and later use the high bidder as usual. The
   target score is unchanged.
5. **Blind Bids** - **a blind bid is a team bid.** At the start of a hand,
   if a team trails the other team by 100 points or more (score difference
   of 100 or more, using the current game scores), the hand opens with a
   blind window: the trailing team's cards are dealt face down and are
   not sent to those players yet. Each player on the trailing team either
   calls a blind bid or looks at their cards. Looking ends that player's
   blind chance for the hand; a player who has looked cannot call blind.
   A blind bid is 6, 7, 8, 9, or 10, and that number is the team's whole
   bid for the hand, the combined books the team must take. The declaring
   player's partner places no bid of their own (their bid is recorded as
   covered by the blind), and only one blind bid can stand per team per
   hand: the first declaration locks it. The other team bids normally,
   unless it is also trailing by 100 or more, which cannot happen for
   both teams at once. Exact scoring: if the team makes its blind team
   bid, the blind books pay double, 20 points per book of the blind bid,
   plus 1 point per overtrick, with sandbag accounting exactly as usual
   (a made Blind 7 on the number scores 140; a made Blind 7 with 2
   overtricks scores 142 and earns 2 sandbags). If the team misses, the
   set penalty is the normal rate, minus 10 points per book of the team
   bid; the set penalty is not doubled. There is no Blind Nil in this
   implementation. Blind bids cannot be called on a First Hand Bids
   Itself hand, because that hand has no bidding at all. With the Kitty
   on, the blind declarer is their team's bidder of record: the blind
   value counts in the high bid comparison, and if the declarer is the
   highest bidder at the table they do the kitty exchange, seeing the
   kitty when they pick it up.

**Format:** v1 plays **Partners** format only (seats 1 and 3 vs seats 2
and 4). A Cutthroat (every player for themselves) format is not in v1 and
there is no toggle for it; it is a candidate for a later version.

## Bots

The host can seat bots from the lobby, and starting a game auto fills any
remaining seats. Bots bid from their own hand strength, play legal cards
only, work the kitty by shedding their lowest plain cards, and never see
another player's hand. Under First Hand Bids Itself, bots simply do not
bid on hand 1 (nobody does) and play the hand normally; a bot dealing
hand 1 with the Kitty on works the kitty like any dealer. Under Blind
Bids, a bot on an eligible trailing team follows one fixed rule: it
declares Blind 6, the floor, when its dealt hand rates at 5 or more
expected books (4.5 for Bold Talker), and otherwise looks at its cards
and bids normally. Personalities: **Steady Eddie** bids what the hand
shows, **Bold Talker** bids up, **Quiet Storm** plays low and keeps the
Ace late, **Wild Card** swings on bids and sometimes burns a bigger card
than the trick needs. Hosting never falls to a bot, and a room closes on
schedule once the last human leaves.

## Files

```
server.js          Game server: HTTP + WebSocket, rooms, phases, scoring calls
game.js            Pure logic: deck, trump ranking, tricks, legal plays, scoring
bots.js            Bot bidding, card play, and kitty choices
public/index.html  The entire phone client (no build step, no CDN)
test/e2e-test.js   Unit checks plus scripted WebSocket games
test/last-run.log  Latest test output (120 checks)
```

## Test

```bash
npm test   # unit checks, then scripted games against a spawned server
```

The suite covers: deck shape with and without JJDD, the full JJDD trump
ranking, trick winners, follow suit (including the 2 of Diamonds counting
as a spade), the spades lead rule, exact scoring (make, set, sandbags and
the 10 bag penalty, Nil made and busted, double Nil, and all three
Possible outcomes), bot judgment, a scripted 4 human hand with a Nil bid
and a Possible bid where the server score is recomputed independently and
matched, a JJDD plus Kitty quick game with bots played all the way to a
winner at 250, the kitty exchange (16 cards in hand, 12 tricks played),
and seat rejoin by token. First Hand Bids Itself coverage: the toggle in
settings, hand 1 skipping bidding and scoring exactly 10 points per book
with no set possible, hand 2 bidding normally, the rule off leaving hand
1 unchanged, and a First Hand plus Kitty bot game where the dealer works
the hand 1 kitty. Blind Bids coverage: the toggle in settings, no blind
window at level scores or under a 100 point gap, the window opening for
the trailing team with cards still unseen, the leading team barred, no
blind after looking, the 6 to 10 range enforced, the partner covered and
unable to add a bid, a scripted blind hand whose score is recomputed
independently from the team bid formula (double pay on a made blind, the
normal set rate on a miss, both checked in the scoring unit tests), and a
full bot game with Blind Bids on played to a winner. Latest verified
result: **120 passed, 0 failed**, in two consecutive runs.

## Deploy notes (not deployed)

Same shape as We All Gone Eat: a single Node process serving the client
and the WebSocket traffic on one `PORT`, rooms in memory. It fits Render,
Railway, or Fly style hosts at a single instance. Deployment is a separate
decision; v1 ships locally only.
