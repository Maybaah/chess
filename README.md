# Chess

Chess for the [maybaah.github.io](https://maybaah.github.io/) arcade. Share a
room link and play a friend in real time, or pass one device back and forth.
Vanilla JS, no build step, no dependencies.

**Play:** https://maybaah.github.io/chess/

## How it fits together

This repo deploys as a project page under the root site's domain. It loads the
shared design system and arcade client (`/assets/site.css`, `/assets/arcade.js`)
from [Maybaah/Maybaah.github.io](https://github.com/Maybaah/Maybaah.github.io),
so it must be served under that domain to look right.

Like tic tac toe, and unlike everything else in the arcade, it ships a referee
rather than an auditor. Every other game proves itself after the fact: the
client submits a seed and a move tape, and a Worker replays the run and computes
the score. Two people playing at once produce no single tape and nobody to trust
with it.

- **Pass and play** runs entirely in the page. No request leaves the browser,
  and nothing is rated. The board can turn to face whoever is to move, for two
  people sharing a phone; it is off by default, because mirroring all 32 squares
  every move means nothing on the board can animate meaningfully.
- **vs Friend** is refereed by `worker/`, one Durable Object per room. The
  object owns the position. It decides whose turn it is and which moves are
  legal; the client only draws what it is sent and asks for moves. A tampered
  page can ask to move a pinned knight, castle out of check or move twice, and
  simply be told no.

## The rulebook is written twice

`game.js` and `worker/src/index.js` hold the same rules engine, character for
character between the `── the rules ──` markers, indentation aside: the client's
copy sits inside an IIFE. The server is the only thing that decides whether a
move happened, but the page has to reach the same verdict to show legal squares
before you commit, and drift shows up as a move the page offers and the referee
then refuses.

It is a complete rulebook, not a convenient subset: castling with all four of
its conditions, en passant, underpromotion, checkmate, stalemate, threefold
repetition, the fifty move rule and dead positions. Move generation is checked
against the published perft counts for the five standard test positions, to
depth 4 and 5.

## The Elo ladder

A finished 1v1 game moves both players. The rating is computed by the Worker
from the result it refereed, never sent by a client, and lands in the shared
`arcade` database in the same `scores` table as every other board. Boards there
sort ascending, so the rating is stored negated with the real number in the
`detail` JSON. It has no daily twin, because a rating is a running standing
rather than a personal best: there is only one current number per player.

Everyone starts at 1200. K is 40 for the first ten games, then 24, then 16 above
2100. The floor is 100.

A match needs two people, which is exactly what makes a ladder farmable, so
three gates stand in the way:

- both seats must be different players, and one id cannot hold both
- a game that ends by resignation or agreement inside ten plies is not rated,
  since handing over a resignation costs nothing. A mate is always rated, the
  fastest legal one being four plies
- the same two people move each other for three games a day. After that the
  games still finish and still count as played, but the ratings hold, and both
  pages say so

The position itself is still never stored past the life of the room. The Elo is
the only thing that outlives it.

## Rooms

A room code is four characters from an alphabet with no `O`, `0`, `I` or `1`, so
a code read aloud or copied by hand lands in the right place. Creating a room
puts the code in the URL fragment; the link is the invite. There is no queue and
no lobby list.

The cases that break a naive room are handled server-side:

- a third socket is refused rather than silently watching
- rejoining with the same player id reclaims that seat instead of taking the
  one being kept for a friend
- a code nobody created is refused when you meant to join, so a typo does not
  look like waiting
- a disconnect marks the seat away and tells the other player
- a rematch needs both seats to ask, and swaps the colours
- an idle room is wiped by an alarm, so codes are not held hostage

Identity is the shared `Arcade.playerId()` and `Arcade.getPlayer()` from the
site repo, which is what makes a refresh keep your seat.

## Playing

Drag a piece, or tap it and tap where it goes. Arrow keys walk the board and
Enter picks up and puts down, so the whole game is playable from the keyboard.
`f` flips the board. Escape clears a selection or dismisses the result banner.

## Deploying

Pages deploys on push. The Worker does not:

```bash
cd worker && npx wrangler deploy
```

The `chess_pair` table the daily cap uses is created on demand, so a deploy
needs no migration step of its own.
