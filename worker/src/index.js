/* chess rooms: Cloudflare Worker + Durable Objects.

   Every other game in the arcade proves itself after the fact: the client
   submits a seed and a move tape and a Worker replays it. That does not work
   for two people playing at once, because there is no single tape and nobody
   to trust with it. So this Worker is a referee instead of an auditor. One
   Durable Object per room owns the position, and a move only happens if the
   object agrees it is legal. A client here cannot cheat by lying, only by
   asking; the object decides.

   The position itself is never stored past the life of the room: when a room
   goes quiet an alarm wipes it. What does outlive a room is the Elo, written
   into the shared arcade database from the result this object watched happen,
   which is the only reason a rating here is worth anything. */
"use strict";

const ALLOWED_ORIGINS = [
  "https://maybaah.github.io",
  "http://localhost:8619",
  "http://127.0.0.1:8619",
];

const PROTOCOL = 1;
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;
const IDLE_MS = 60 * 60 * 1000;
const MAX_FRAME = 1024;

/* ── the rules ────────────────────────────────────────────────────────────
   This block is duplicated character for character in the game's game.js.
   The server owns the board, but the page has to reach the same verdict to
   draw legal squares, and drift shows up as a move the page offers and the
   referee then refuses. Change one copy, change the other. */

var FILES = "abcdefgh";
var BACK_RANK = "rnbqkbnr";

var KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
var KING_D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
var DIAG_D = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
var ORTHO_D = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/* index 0 is a8 and index 63 is h1, so a rank is a row and the array reads
   the way the board is drawn */
function fileOf(i) { return i & 7; }
function rankOf(i) { return i >> 3; }
function at(f, r) { return f < 0 || f > 7 || r < 0 || r > 7 ? -1 : r * 8 + f; }
function colorOf(p) { return !p ? null : p === p.toUpperCase() ? "w" : "b"; }
function other(c) { return c === "w" ? "b" : "w"; }
function squareName(i) { return FILES[fileOf(i)] + (8 - rankOf(i)); }

function startPosition() {
  var b = new Array(64).fill(null);
  for (var f = 0; f < 8; f++) {
    b[at(f, 0)] = BACK_RANK[f];
    b[at(f, 1)] = "p";
    b[at(f, 6)] = "P";
    b[at(f, 7)] = BACK_RANK[f].toUpperCase();
  }
  return { board: b, turn: "w", castling: "KQkq", ep: null, half: 0, full: 1 };
}

function kingSquare(board, color) {
  var k = color === "w" ? "K" : "k";
  for (var i = 0; i < 64; i++) if (board[i] === k) return i;
  return -1;
}

function ray(board, f, r, dirs, by, kinds) {
  for (var i = 0; i < dirs.length; i++) {
    var ff = f, rr = r;
    for (;;) {
      ff += dirs[i][0];
      rr += dirs[i][1];
      var s = at(ff, rr);
      if (s < 0) break;
      var p = board[s];
      if (!p) continue;
      if (colorOf(p) === by && kinds.indexOf(p.toLowerCase()) !== -1) return true;
      break;
    }
  }
  return false;
}

function attacked(board, idx, by) {
  var f = fileOf(idx), r = rankOf(idx), i, s;

  /* a pawn of `by` attacking this square stands one rank behind it, which is
     the opposite direction to the one it moves in */
  var pawnRank = by === "w" ? r + 1 : r - 1;
  var pawn = by === "w" ? "P" : "p";
  for (i = -1; i <= 1; i += 2) {
    s = at(f + i, pawnRank);
    if (s >= 0 && board[s] === pawn) return true;
  }
  for (i = 0; i < KNIGHT_D.length; i++) {
    s = at(f + KNIGHT_D[i][0], r + KNIGHT_D[i][1]);
    if (s >= 0 && board[s] === (by === "w" ? "N" : "n")) return true;
  }
  for (i = 0; i < KING_D.length; i++) {
    s = at(f + KING_D[i][0], r + KING_D[i][1]);
    if (s >= 0 && board[s] === (by === "w" ? "K" : "k")) return true;
  }
  return ray(board, f, r, DIAG_D, by, "bq") || ray(board, f, r, ORTHO_D, by, "rq");
}

function inCheck(pos, color) {
  var k = kingSquare(pos.board, color);
  return k >= 0 && attacked(pos.board, k, other(color));
}

function addPawnMove(out, from, to, promoting) {
  if (!promoting) {
    out.push({ from: from, to: to, promo: null, flag: "" });
    return;
  }
  var kinds = ["q", "r", "b", "n"];
  for (var i = 0; i < kinds.length; i++) out.push({ from: from, to: to, promo: kinds[i], flag: "p" });
}

function pawnMoves(pos, i, color, out) {
  var b = pos.board, f = fileOf(i), r = rankOf(i);
  var dir = color === "w" ? -1 : 1;
  var home = color === "w" ? 6 : 1;
  var last = color === "w" ? 0 : 7;

  var one = at(f, r + dir);
  if (one >= 0 && !b[one]) {
    addPawnMove(out, i, one, rankOf(one) === last);
    var two = at(f, r + dir * 2);
    if (r === home && two >= 0 && !b[two]) out.push({ from: i, to: two, promo: null, flag: "d" });
  }
  for (var side = -1; side <= 1; side += 2) {
    var c = at(f + side, r + dir);
    if (c < 0) continue;
    if (b[c]) {
      if (colorOf(b[c]) !== color) addPawnMove(out, i, c, rankOf(c) === last);
    } else if (pos.ep === c) {
      out.push({ from: i, to: c, promo: null, flag: "e" });
    }
  }
}

function stepMoves(board, i, color, dirs, out) {
  var f = fileOf(i), r = rankOf(i);
  for (var d = 0; d < dirs.length; d++) {
    var s = at(f + dirs[d][0], r + dirs[d][1]);
    if (s >= 0 && colorOf(board[s]) !== color) out.push({ from: i, to: s, promo: null, flag: "" });
  }
}

function slideMoves(board, i, color, dirs, out) {
  var f = fileOf(i), r = rankOf(i);
  for (var d = 0; d < dirs.length; d++) {
    var ff = f, rr = r;
    for (;;) {
      ff += dirs[d][0];
      rr += dirs[d][1];
      var s = at(ff, rr);
      if (s < 0) break;
      if (!board[s]) { out.push({ from: i, to: s, promo: null, flag: "" }); continue; }
      if (colorOf(board[s]) !== color) out.push({ from: i, to: s, promo: null, flag: "" });
      break;
    }
  }
}

/* Castling is the one move with rules about squares the king does not land
   on: it may not start in check, cross an attacked square or finish on one,
   and the rook has to still be sitting where the rights say it is. */
function castleMoves(pos, color, out) {
  var b = pos.board;
  var home = color === "w" ? 60 : 4;
  var king = color === "w" ? "K" : "k";
  var rook = color === "w" ? "R" : "r";
  var rights = color === "w" ? ["K", "Q"] : ["k", "q"];
  var them = other(color);

  if (b[home] !== king || attacked(b, home, them)) return;

  if (pos.castling.indexOf(rights[0]) !== -1 &&
      !b[home + 1] && !b[home + 2] && b[home + 3] === rook &&
      !attacked(b, home + 1, them) && !attacked(b, home + 2, them)) {
    out.push({ from: home, to: home + 2, promo: null, flag: "c" });
  }
  if (pos.castling.indexOf(rights[1]) !== -1 &&
      !b[home - 1] && !b[home - 2] && !b[home - 3] && b[home - 4] === rook &&
      !attacked(b, home - 1, them) && !attacked(b, home - 2, them)) {
    out.push({ from: home, to: home - 2, promo: null, flag: "c" });
  }
}

function pseudoMoves(pos, color) {
  var b = pos.board, out = [];
  for (var i = 0; i < 64; i++) {
    var p = b[i];
    if (!p || colorOf(p) !== color) continue;
    var kind = p.toLowerCase();
    if (kind === "p") pawnMoves(pos, i, color, out);
    else if (kind === "n") stepMoves(b, i, color, KNIGHT_D, out);
    else if (kind === "k") stepMoves(b, i, color, KING_D, out);
    else {
      if (kind === "b" || kind === "q") slideMoves(b, i, color, DIAG_D, out);
      if (kind === "r" || kind === "q") slideMoves(b, i, color, ORTHO_D, out);
    }
  }
  castleMoves(pos, color, out);
  return out;
}

function applyMove(pos, mv) {
  var b = pos.board.slice();
  var p = b[mv.from];
  var color = colorOf(p);
  var kind = p.toLowerCase();
  var captured = b[mv.to];

  b[mv.to] = mv.promo ? (color === "w" ? mv.promo.toUpperCase() : mv.promo) : p;
  b[mv.from] = null;

  if (mv.flag === "e") {
    b[mv.to + (color === "w" ? 8 : -8)] = null;
    captured = color === "w" ? "p" : "P";
  }
  if (mv.flag === "c") {
    var kingSide = mv.to > mv.from;
    b[kingSide ? mv.to - 1 : mv.to + 1] = b[kingSide ? mv.from + 3 : mv.from - 4];
    b[kingSide ? mv.from + 3 : mv.from - 4] = null;
  }

  var rights = pos.castling;
  if (kind === "k") rights = rights.replace(color === "w" ? /[KQ]/g : /[kq]/g, "");
  /* a rook that moves or is captured takes its own right with it, whichever
     end of the move its square happens to be */
  [mv.from, mv.to].forEach(function (s) {
    if (s === 63) rights = rights.replace("K", "");
    if (s === 56) rights = rights.replace("Q", "");
    if (s === 7) rights = rights.replace("k", "");
    if (s === 0) rights = rights.replace("q", "");
  });

  return {
    board: b,
    turn: other(color),
    castling: rights || "-",
    ep: mv.flag === "d" ? (mv.from + mv.to) / 2 : null,
    half: kind === "p" || captured ? 0 : pos.half + 1,
    full: pos.full + (color === "b" ? 1 : 0)
  };
}

function legalMoves(pos) {
  var all = pseudoMoves(pos, pos.turn), out = [];
  for (var i = 0; i < all.length; i++) {
    var next = applyMove(pos, all[i]);
    var k = kingSquare(next.board, pos.turn);
    if (k < 0 || !attacked(next.board, k, other(pos.turn))) out.push(all[i]);
  }
  return out;
}

function findMove(pos, from, to, promo) {
  var moves = legalMoves(pos);
  for (var i = 0; i < moves.length; i++) {
    if (moves[i].from === from && moves[i].to === to && (moves[i].promo || null) === (promo || null)) {
      return moves[i];
    }
  }
  return null;
}

/* An en passant square only makes two positions different if somebody can
   actually take it, so repetition counts it only when a pawn is standing
   ready. Without that, a pointless double push would reset the count. */
function epCapturable(pos) {
  var f = fileOf(pos.ep), r = rankOf(pos.ep);
  var behind = pos.turn === "w" ? 1 : -1;
  var pawn = pos.turn === "w" ? "P" : "p";
  for (var s = -1; s <= 1; s += 2) {
    var i = at(f + s, r + behind);
    if (i >= 0 && pos.board[i] === pawn) return true;
  }
  return false;
}

function positionKey(pos) {
  var ep = pos.ep !== null && epCapturable(pos) ? pos.ep : "-";
  var squares = "";
  for (var i = 0; i < 64; i++) squares += pos.board[i] || ".";
  return squares + " " + pos.turn + " " + pos.castling + " " + ep;
}

/* Dead positions: nothing either side can do amounts to mate. Rooks, queens
   and pawns are always enough, so anything holding one is still a game. */
function insufficient(board) {
  var minors = [];
  for (var i = 0; i < 64; i++) {
    var p = board[i];
    if (!p) continue;
    var kind = p.toLowerCase();
    if (kind === "p" || kind === "r" || kind === "q") return false;
    if (kind !== "k") {
      minors.push({ color: colorOf(p), kind: kind, dark: (fileOf(i) + rankOf(i)) % 2 === 1 });
    }
  }
  if (minors.length <= 1) return true;
  return minors.length === 2 &&
    minors[0].kind === "b" && minors[1].kind === "b" &&
    minors[0].color !== minors[1].color && minors[0].dark === minors[1].dark;
}

function terminal(pos, keys) {
  if (!legalMoves(pos).length) {
    return inCheck(pos, pos.turn)
      ? { result: other(pos.turn), reason: "checkmate" }
      : { result: "draw", reason: "stalemate" };
  }
  if (insufficient(pos.board)) return { result: "draw", reason: "material" };
  if (pos.half >= 100) return { result: "draw", reason: "fifty" };
  if (keys) {
    var key = positionKey(pos), seen = 0;
    for (var i = 0; i < keys.length; i++) if (keys[i] === key) seen++;
    if (seen >= 3) return { result: "draw", reason: "repetition" };
  }
  return null;
}

/* Standard algebraic notation, disambiguated only as far as it has to be:
   by file if that is enough, then by rank, then by the whole square. */
function san(pos, mv) {
  var p = pos.board[mv.from];
  var kind = p.toLowerCase();
  var text;

  if (mv.flag === "c") {
    text = mv.to > mv.from ? "O-O" : "O-O-O";
  } else if (kind === "p") {
    var pawnTakes = !!pos.board[mv.to] || mv.flag === "e";
    text = (pawnTakes ? FILES[fileOf(mv.from)] + "x" : "") + squareName(mv.to);
    if (mv.promo) text += "=" + mv.promo.toUpperCase();
  } else {
    var rivals = legalMoves(pos).filter(function (m) {
      return m.to === mv.to && m.from !== mv.from && pos.board[m.from] === p;
    });
    var hint = "";
    if (rivals.length) {
      var sameFile = rivals.some(function (m) { return fileOf(m.from) === fileOf(mv.from); });
      var sameRank = rivals.some(function (m) { return rankOf(m.from) === rankOf(mv.from); });
      hint = !sameFile ? FILES[fileOf(mv.from)]
           : !sameRank ? String(8 - rankOf(mv.from))
           : squareName(mv.from);
    }
    text = kind.toUpperCase() + hint + (pos.board[mv.to] ? "x" : "") + squareName(mv.to);
  }

  var next = applyMove(pos, mv);
  if (inCheck(next, next.turn)) text += legalMoves(next).length ? "+" : "#";
  return text;
}

/* ── end of the shared rules ── */

/* ── ratings ──────────────────────────────────────────────────────────────
   The Elo is computed here, from the result this object watched happen, and
   that is the only reason a number on the ladder means anything. A client is
   never asked what it scored; it is told.

   Rows live in the shared arcade database, in the same scores table as every
   other board, keyed (game, board, player). Boards there sort ascending, so a
   rating is stored negated and the real value kept in the detail JSON. */

const ELO_START = 1200;
const ELO_FLOOR = 100;
const RATED_BOARD = "elo";

/* A resignation costs nothing to hand over, so two cooperating browsers could
   trade them all day. A game that ends by agreement or resignation has to be
   long enough to have been a game; a mate is always rated, since the fastest
   legal one is four plies. */
const MIN_RATED_PLIES = 10;
const PAIR_LIMIT_PER_DAY = 3;

function kFactor(elo, games) {
  if (games < 10) return 40;          // provisional: find the right level fast
  if (elo >= 2100) return 16;         // settled: move slowly
  return 24;
}

function expectedScore(mine, theirs) {
  return 1 / (1 + Math.pow(10, (theirs - mine) / 400));
}

function utcDayKey() {
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function freshRating() {
  return { elo: ELO_START, games: 0, wins: 0, draws: 0, losses: 0, peak: ELO_START };
}

/* created on demand so a deploy needs no migration step of its own */
async function ensureSchema(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS chess_pair (
       pair TEXT NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (pair, day))`
  ).run();
}

async function readRating(db, player) {
  const row = await db.prepare(
    `SELECT score, detail FROM scores WHERE game = 'chess' AND board = ?1 AND player = ?2`
  ).bind(RATED_BOARD, player).first();
  if (!row) return freshRating();

  let d = {};
  try { d = JSON.parse(row.detail) || {}; } catch { /* fall back to the score column */ }
  const elo = typeof d.elo === "number" ? d.elo : -row.score;
  return {
    elo,
    games: d.games || 0,
    wins: d.wins || 0,
    draws: d.draws || 0,
    losses: d.losses || 0,
    peak: d.peak || elo,
  };
}

/* No `WHERE excluded.score < scores.score` guard here, unlike the best-run
   boards: a rating has to be able to fall. */
async function writeRating(db, player, name, r) {
  await db.prepare(
    `INSERT INTO scores (game, board, player, name, score, detail, created_at)
     VALUES ('chess', ?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(game, board, player) DO UPDATE SET
       name = excluded.name, score = excluded.score,
       detail = excluded.detail, created_at = excluded.created_at`
  ).bind(RATED_BOARD, player, name, -r.elo, JSON.stringify(r), Date.now()).run();
}

async function pairPlays(db, a, b) {
  const pair = [a, b].sort().join("|");
  const day = utcDayKey();
  const row = await db.prepare(
    `SELECT n FROM chess_pair WHERE pair = ?1 AND day = ?2`
  ).bind(pair, day).first();
  return { pair, day, n: row ? row.n : 0 };
}

async function bumpPair(db, pair, day) {
  await db.prepare(
    `INSERT INTO chess_pair (pair, day, n) VALUES (?1, ?2, 1)
     ON CONFLICT(pair, day) DO UPDATE SET n = n + 1`
  ).bind(pair, day).run();
}

async function rateMatch(db, m) {
  const white = m.players[0];
  const black = m.players[1];
  if (!white || !black || white.id === black.id) return null;

  const byMate = m.reason !== "resign" && m.reason !== "agreement";
  if (!byMate && m.history.length < MIN_RATED_PLIES) {
    return { rated: false, note: "too short to be rated" };
  }

  await ensureSchema(db);
  const before = [await readRating(db, white.id), await readRating(db, black.id)];
  const { pair, day, n } = await pairPlays(db, white.id, black.id);
  const capped = n >= PAIR_LIMIT_PER_DAY;

  const scored = m.result === "draw" ? 0.5 : m.result === "w" ? 1 : 0;
  const seats = [
    { seat: white, was: before[0], other: before[1], got: scored },
    { seat: black, was: before[1], other: before[0], got: 1 - scored },
  ];

  /* both sides are graded against the rating the other one walked in with,
     never a half-updated one */
  const after = seats.map((s) => {
    const k = capped ? 0 : kFactor(s.was.elo, s.was.games);
    const elo = Math.max(ELO_FLOOR,
      Math.round(s.was.elo + k * (s.got - expectedScore(s.was.elo, s.other.elo))));
    return {
      elo,
      games: s.was.games + 1,
      wins: s.was.wins + (s.got === 1 ? 1 : 0),
      draws: s.was.draws + (s.got === 0.5 ? 1 : 0),
      losses: s.was.losses + (s.got === 0 ? 1 : 0),
      peak: Math.max(s.was.peak, elo),
    };
  });

  await writeRating(db, white.id, white.name, after[0]);
  await writeRating(db, black.id, black.name, after[1]);
  await bumpPair(db, pair, day);

  return {
    rated: true,
    ratings: after,
    deltas: [after[0].elo - before[0].elo, after[1].elo - before[1].elo],
    note: capped ? "already played three rated games today, rating held" : null,
  };
}

function freshMatch(players, ratings) {
  const pos = startPosition();
  return {
    pos,
    players: players || [null, null],   // seat 0 is white, seat 1 is black
    ratings: ratings || [null, null],
    deltas: null,
    note: null,
    status: "waiting",
    result: null,
    reason: null,
    history: [],
    keys: [positionKey(pos)],
    last: null,
    draw: null,
    rematch: [],
  };
}

export class Match {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.match = null;
  }

  async load() {
    if (!this.match) {
      this.match = (await this.state.storage.get("match")) || freshMatch();
    }
    return this.match;
  }

  async save() {
    await this.state.storage.put("match", this.match);
    await this.state.storage.setAlarm(Date.now() + IDLE_MS);
  }

  /* an abandoned room forgets itself, so a four-character code is never held
     hostage by a game nobody came back to */
  async alarm() {
    if (this.state.getWebSockets().length === 0) {
      await this.state.storage.deleteAll();
      this.match = null;
    } else {
      await this.state.storage.setAlarm(Date.now() + IDLE_MS);
    }
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  seatOf(playerId) {
    const m = this.match;
    if (m.players[0] && m.players[0].id === playerId) return 0;
    if (m.players[1] && m.players[1].id === playerId) return 1;
    return -1;
  }

  /* `you` is per socket, so state goes out one at a time rather than broadcast
     as a single frame.

     `closing` is the socket a close handler is running for. It is still in
     getWebSockets() at that point and is dropped only once the handler
     returns, so without excluding it the survivor is told their opponent is
     still there. */
  push(closing) {
    const m = this.match;
    const live = this.state.getWebSockets().filter((s) => s !== closing);
    const online = new Set();
    for (const ws of live) {
      const att = ws.deserializeAttachment();
      if (att && att.id) online.add(att.id);
    }
    const shared = {
      type: "state",
      v: PROTOCOL,
      board: m.pos.board,
      turn: m.pos.turn,
      castling: m.pos.castling,
      ep: m.pos.ep,
      half: m.pos.half,
      full: m.pos.full,
      status: m.status,
      result: m.result,
      reason: m.reason,
      history: m.history,
      last: m.last,
      draw: m.draw,
      ratings: m.ratings,
      deltas: m.deltas,
      note: m.note,
      players: m.players.map((p, i) => p
        ? { name: p.name, color: i === 0 ? "w" : "b", here: online.has(p.id) }
        : null),
      rematch: m.rematch.length,
    };
    for (const ws of live) {
      const att = ws.deserializeAttachment() || {};
      const seat = att.id ? this.seatOf(att.id) : -1;
      try {
        ws.send(JSON.stringify(Object.assign({ you: seat < 0 ? null : (seat === 0 ? "w" : "b") }, shared)));
      } catch { /* socket already gone; webSocketClose will tidy up */ }
    }
  }

  fail(ws, reason) {
    try { ws.send(JSON.stringify({ type: "error", reason })); } catch {}
  }

  /* the match is the thing that matters, so a database that is down or slow
     must not be able to take the game down with it */
  async finish(m) {
    m.draw = null;
    try {
      const out = await rateMatch(this.env.DB, m);
      if (out && out.rated) {
        m.ratings = out.ratings;
        m.deltas = out.deltas;
        m.note = out.note;
      } else if (out) {
        m.note = out.note;
      }
    } catch {
      m.note = "the ladder is unreachable, this game was not rated";
    }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_FRAME) return this.fail(ws, "bad frame");
    let msg;
    try { msg = JSON.parse(raw); } catch { return this.fail(ws, "bad frame"); }
    if (!msg || typeof msg !== "object") return this.fail(ws, "bad frame");

    const m = await this.load();

    if (msg.type === "join") return this.onJoin(ws, msg, m);

    const att = ws.deserializeAttachment();
    if (!att || !att.id) return this.fail(ws, "join first");

    if (msg.type === "move") return this.onMove(ws, msg, m, att.id);
    if (msg.type === "resign") return this.onResign(ws, m, att.id);
    if (msg.type === "draw") return this.onDraw(ws, m, att.id);
    if (msg.type === "rematch") return this.onRematch(ws, m, att.id);
    return this.fail(ws, "unknown message");
  }

  async onJoin(ws, msg, m) {
    const id = typeof msg.player === "string" ? msg.player.slice(0, 64) : "";
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) return this.fail(ws, "bad player id");
    const name = String(msg.name || "").replace(/[^ -~]/g, "").trim().slice(0, 16) || "player";

    let seat = this.seatOf(id);
    if (seat < 0) {
      /* Rooms are addressed by name, so every code names a room whether or not
         anyone made one. Without this a typo would quietly seat you alone in
         WXYZ and look identical to waiting for your friend. */
      if (msg.intent === "join" && !m.players[0] && !m.players[1]) {
        return this.fail(ws, "no room with that code");
      }
      // a refresh must reclaim its own seat, not eat the one left for a friend
      seat = m.players[0] ? (m.players[1] ? -1 : 1) : 0;
      if (seat < 0) return this.fail(ws, "this room is full");
      m.players[seat] = { id, name };
      try {
        m.ratings[seat] = await readRating(this.env.DB, id);
      } catch {
        m.ratings[seat] = freshRating();
      }
    } else {
      m.players[seat].name = name;
    }

    ws.serializeAttachment({ id });
    if (m.players[0] && m.players[1] && m.status === "waiting") m.status = "live";
    await this.save();
    this.push();
  }

  async onMove(ws, msg, m, id) {
    const seat = this.seatOf(id);
    if (seat < 0) return this.fail(ws, "you are not seated");
    if (m.status !== "live") {
      return this.fail(ws, m.status === "waiting" ? "waiting for an opponent" : "this match is over");
    }
    const color = seat === 0 ? "w" : "b";
    if (m.pos.turn !== color) return this.fail(ws, "not your turn");

    const { from, to } = msg;
    if (!Number.isInteger(from) || from < 0 || from > 63) return this.fail(ws, "no such square");
    if (!Number.isInteger(to) || to < 0 || to > 63) return this.fail(ws, "no such square");
    const promo = msg.promo == null ? null : String(msg.promo);
    if (promo !== null && ["q", "r", "b", "n"].indexOf(promo) === -1) {
      return this.fail(ws, "a pawn promotes to a queen, rook, bishop or knight");
    }

    /* the whole defence in one line: the move has to be in the list this
       object generates from the position it holds, or it does not happen */
    const mv = findMove(m.pos, from, to, promo);
    if (!mv) return this.fail(ws, "that move is not legal");

    m.history.push(san(m.pos, mv));
    m.pos = applyMove(m.pos, mv);
    m.keys.push(positionKey(m.pos));
    m.last = { from, to };
    m.draw = null;

    const done = terminal(m.pos, m.keys);
    if (done) {
      m.status = "over";
      m.result = done.result;
      m.reason = done.reason;
      await this.finish(m);
    }
    await this.save();
    this.push();
  }

  async onResign(ws, m, id) {
    const seat = this.seatOf(id);
    if (seat < 0) return this.fail(ws, "you are not seated");
    if (m.status !== "live") return this.fail(ws, "there is nothing to resign");
    m.status = "over";
    m.result = seat === 0 ? "b" : "w";
    m.reason = "resign";
    await this.finish(m);
    await this.save();
    this.push();
  }

  /* one message does both halves: the first press offers, the second accepts
     the offer already standing from the other side */
  async onDraw(ws, m, id) {
    const seat = this.seatOf(id);
    if (seat < 0) return this.fail(ws, "you are not seated");
    if (m.status !== "live") return this.fail(ws, "the game is not running");
    const color = seat === 0 ? "w" : "b";

    if (m.draw && m.draw !== color) {
      m.status = "over";
      m.result = "draw";
      m.reason = "agreement";
      await this.finish(m);
    } else {
      m.draw = color;
    }
    await this.save();
    this.push();
  }

  /* both seats have to ask, and the colours swap, so a rematch is not a
     permanent first-move advantage. The ratings follow their players across
     the swap. */
  async onRematch(ws, m, id) {
    if (m.status !== "over") return this.fail(ws, "the match is still going");
    if (this.seatOf(id) < 0) return this.fail(ws, "you are not seated");
    if (m.rematch.indexOf(id) === -1) m.rematch.push(id);

    if (m.rematch.length >= 2) {
      Object.assign(
        m,
        freshMatch([m.players[1], m.players[0]], [m.ratings[1], m.ratings[0]]),
        { status: "live" }
      );
    }
    await this.save();
    this.push();
  }

  async webSocketClose(ws) {
    await this.load();
    this.push(ws);
  }

  async webSocketError(ws) {
    await this.load();
    this.push(ws);
  }
}

function allowed(origin) {
  return ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(origin) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": allowed(origin) ? origin : ALLOWED_ORIGINS[0],
    "Cache-Control": "no-store",
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin") || "";

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, v: PROTOCOL }), { headers: corsHeaders(origin) });
    }

    /* one player's own standing, for the panel on the page outside any room */
    if (url.pathname === "/rating") {
      const player = url.searchParams.get("player") || "";
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(player)) {
        return new Response(JSON.stringify({ error: "bad player id" }), { status: 400, headers: corsHeaders(origin) });
      }
      try {
        const r = await readRating(env.DB, player);
        return new Response(JSON.stringify(r), { headers: corsHeaders(origin) });
      } catch {
        return new Response(JSON.stringify({ error: "the ladder is unreachable" }), { status: 503, headers: corsHeaders(origin) });
      }
    }

    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{1,8})$/);
    if (!m) return new Response("not found", { status: 404 });

    const code = m[1].toUpperCase();
    if (!CODE_RE.test(code)) return new Response("bad room code", { status: 400 });

    /* A WebSocket handshake never gets a CORS preflight, so the browser will
       not stop a page on another origin from opening one. This check is the
       only gate there is. */
    if (!allowed(origin)) return new Response("forbidden origin", { status: 403 });
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    return env.MATCH.get(env.MATCH.idFromName(code)).fetch(req);
  },
};
