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
   team bid is the two partners' bids added together.
4. **Kitty exchange** (Kitty rule only) - the highest individual bidder
   picks up the kitty, then puts 4 cards back. Ties go to the earliest
   bidder.
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

**Format:** v1 plays **Partners** format only (seats 1 and 3 vs seats 2
and 4). A Cutthroat (every player for themselves) format is not in v1 and
there is no toggle for it; it is a candidate for a later version.

## Bots

The host can seat bots from the lobby, and starting a game auto fills any
remaining seats. Bots bid from their own hand strength, play legal cards
only, work the kitty by shedding their lowest plain cards, and never see
another player's hand. Personalities: **Steady Eddie** bids what the hand
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
test/last-run.log  Latest test output (66 checks)
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
and seat rejoin by token. Latest verified result: **66 passed, 0 failed**,
in two consecutive runs.

## Deploy notes (not deployed)

Same shape as We All Gone Eat: a single Node process serving the client
and the WebSocket traffic on one `PORT`, rooms in memory. It fits Render,
Railway, or Fly style hosts at a single instance. Deployment is a separate
decision; v1 ships locally only.
