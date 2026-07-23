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

- **Pass and play** runs entirely in the page. No request leaves the browser.
  The board turns to face whoever is to move.
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

## No leaderboard, on purpose

A match needs two people, so there is no run to replay and no scalar that two
cooperating browsers could not manufacture between them. The Worker therefore
has no D1 binding and writes nothing: room state lives only as long as the room.

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

## Deploying

Pages deploys on push. The Worker does not:

```bash
cd worker && npx wrangler deploy
```
