/* Chess for Maybaah's Arcade.

   Two modes that share one rulebook and one renderer.

   Pass and play is entirely local. Nothing leaves the page, because both
   players are sitting in front of it and there is nothing to protect them
   from except each other.

   vs Friend is refereed. The server owns the position and is the only thing
   allowed to change it; this page asks for a move and draws whatever comes
   back. It still knows the whole rulebook, but only so it can show legal
   squares before you commit. It never decides that a move happened. */
(function () {
  "use strict";

  var API = "https://chess-match.maybeez.workers.dev";
  var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";  // no I, O, 0, 1
  var CODE_RE = /^[A-HJ-NP-Z2-9]{4}$/;

  /* ── the rules ────────────────────────────────────────────────────────────
     This block is duplicated character for character in worker/src/index.js.
     The server owns the board, but this page has to reach the same verdict to
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
  var GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
  var NAMES = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
  var VALUE = { q: 9, r: 5, b: 3, n: 3, p: 1 };
  var WHY = {
    checkmate: "checkmate", stalemate: "stalemate", fifty: "fifty move rule",
    repetition: "threefold repetition", material: "not enough material to mate",
    resign: "resignation", agreement: "agreement"
  };

  /* ── state ── */
  var mode = "local";
  var pos = startPosition();
  var keys = [positionKey(pos)];
  var moveList = [];
  var status = "live";
  var result = null;
  var reason = null;
  var last = null;
  var myColor = "w";
  var seats = [null, null];
  var ratings = [null, null];
  var deltas = null;
  var drawOffer = null;
  var flipped = false;
  var autoTurn = false;
  var orientation = null;
  var selected = -1;
  var pendingPromo = null;
  var focusIdx = 60;
  var bannerOff = false;

  var ws = null, roomCode = null, roomIntent = "join", wantOpen = false, retry = 0, retryTimer = null;

  var boardEl = document.getElementById("board");
  var piecesEl = document.getElementById("pieces");
  var stackEl = document.getElementById("stack");
  var statusEl = document.getElementById("status");
  var promoEl = document.getElementById("promo");
  var overEl = document.getElementById("over");
  var squares = [];

  for (var i = 0; i < 64; i++) {
    var b = document.createElement("button");
    b.className = "sq";
    b.type = "button";
    b.tabIndex = -1;
    b.setAttribute("role", "gridcell");
    boardEl.appendChild(b);
    squares.push(b);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function viewColor() {
    if (mode === "friend") return myColor || "w";
    /* Turning the board to face the mover is the right thing when two people
       share one phone and the wrong thing otherwise: it mirrors all 32 squares
       every move, so nothing on the board can animate meaningfully. Off unless
       asked for. */
    return autoTurn ? pos.turn : "w";
  }

  function bottomColor() {
    return flipped ? other(viewColor()) : viewColor();
  }

  /* board index to on-screen cell, and back */
  function toView(idx) { return bottomColor() === "w" ? idx : 63 - idx; }
  function fromView(v) { return bottomColor() === "w" ? v : 63 - v; }

  function canMove() {
    if (status !== "live" || pendingPromo) return false;
    return mode === "local" || pos.turn === myColor;
  }

  var moveCache = null, moveCacheKey = "";
  /* legalMoves walks the whole position, and one render asks about it per
     square, so the list is memoised against the position it came from */
  function myMoves() {
    if (!canMove()) return [];
    var k = positionKey(pos) + status;
    if (moveCacheKey !== k) {
      moveCache = legalMoves(pos);
      moveCacheKey = k;
    }
    return moveCache;
  }

  function targets(from) {
    return myMoves().filter(function (m) { return m.from === from; });
  }

  /* ── the pieces layer ─────────────────────────────────────────────────────
     Squares are backdrop and hit target; pieces are their own absolutely
     positioned elements that survive between renders. That is the whole reason
     a piece can slide to where it is going instead of blinking out of one
     square and into another. */
  var live = [];

  function transformFor(idx) {
    var v = toView(idx);
    return "translate(" + (v % 8) * 100 + "%," + Math.floor(v / 8) * 100 + "%)";
  }

  function paint(p) {
    var t = transformFor(p.idx);
    p.el.style.setProperty("--at", t);
    p.el.style.transform = t;
  }

  function glyph(p) {
    p.el.className = "pc " + colorOf(p.piece) + (p.fresh ? " born" : "");
    p.el.innerHTML = "<span>" + GLYPH[p.piece.toLowerCase()] + "</span>";
  }

  function spawn(idx, piece) {
    var p = { el: document.createElement("div"), idx: idx, piece: piece, fresh: true };
    glyph(p);
    paint(p);                     // positioned before it lands, so it fades in place
    piecesEl.appendChild(p.el);
    p.fresh = false;
    /* the class has to come back off, or a piece that merely arrived once keeps
       the arrival animation queued against every later style change */
    setTimeout(function () { p.el.classList.remove("born"); }, 200);
    return p;
  }

  function kill(p) {
    p.el.classList.add("dying");
    var el = p.el;
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }

  function syncPieces(next, mv) {
    var byIdx = new Map();
    live.forEach(function (p) { byIdx.set(p.idx, p); });

    /* a move relocates its element rather than destroying it, and castling
       relocates two */
    if (mv) {
      var relocations = [[mv.from, mv.to]];
      var mover = byIdx.get(mv.from);
      if (mover && mover.piece.toLowerCase() === "k" &&
          Math.abs(fileOf(mv.to) - fileOf(mv.from)) === 2) {
        relocations.push(mv.to > mv.from
          ? [mv.from + 3, mv.to - 1]
          : [mv.from - 4, mv.to + 1]);
      }
      var moving = [];
      relocations.forEach(function (r) {
        var p = byIdx.get(r[0]);
        if (p) { byIdx.delete(r[0]); moving.push([p, r[1]]); }
      });
      moving.forEach(function (m) {
        var victim = byIdx.get(m[1]);
        if (victim) { byIdx.delete(m[1]); kill(victim); }
        m[0].idx = m[1];
      });
      moving.forEach(function (m) { byIdx.set(m[1], m[0]); });
    }

    var keep = [];
    for (var i = 0; i < 64; i++) {
      var want = next[i];
      var have = byIdx.get(i);
      if (!have || !want) continue;
      if (have.piece !== want) {
        if (colorOf(have.piece) !== colorOf(want)) continue;   // not the same piece at all
        have.piece = want;                                     // a pawn that promoted
        glyph(have);
      }
      keep.push(have);
      byIdx.delete(i);
    }
    byIdx.forEach(kill);

    var held = new Set(keep.map(function (p) { return p.idx; }));
    for (var j = 0; j < 64; j++) {
      if (next[j] && !held.has(j)) keep.push(spawn(j, next[j]));
    }

    live = keep;
    live.forEach(paint);
  }

  function pieceAt(idx) {
    for (var i = 0; i < live.length; i++) if (live[i].idx === idx) return live[i];
    return null;
  }

  /* ── rendering ── */
  function render() {
    var moves = myMoves();
    var dests = selected >= 0 ? moves.filter(function (m) { return m.from === selected; }) : [];
    var checkAt = status === "live" ? (inCheck(pos, pos.turn) ? kingSquare(pos.board, pos.turn) : -1) : -1;
    var white = bottomColor() === "w";

    for (var v = 0; v < 64; v++) {
      var idx = fromView(v);
      var el = squares[v];
      var piece = pos.board[idx];
      var cls = "sq" + ((fileOf(idx) + rankOf(idx)) % 2 === 0 ? " light" : "");

      if (last && (idx === last.from || idx === last.to)) cls += " last";
      if (idx === selected) cls += " sel";
      if (idx === checkAt) cls += " check";

      var dest = null;
      for (var d = 0; d < dests.length; d++) if (dests[d].to === idx) dest = dests[d];
      var pickable = false;
      for (var m = 0; m < moves.length; m++) if (moves[m].from === idx) { pickable = true; break; }
      if (dest || pickable) cls += " playable";

      el.className = cls;
      el.dataset.idx = String(idx);
      el.disabled = !dest && !pickable;

      var marker = el.firstChild;
      if (dest) {
        var wantTake = !!piece || dest.flag === "e";
        var wantCls = "marker" + (wantTake ? " take" : "");
        if (!marker) { el.innerHTML = "<span class='marker'><i></i></span>"; marker = el.firstChild; }
        if (marker.className !== wantCls) marker.className = wantCls;
      } else if (marker) {
        el.innerHTML = "";
      }

      el.setAttribute("aria-label", squareName(idx) +
        (piece ? ", " + (colorOf(piece) === "w" ? "white " : "black ") + NAMES[piece.toLowerCase()] : ", empty") +
        (dest ? ", can move here" : ""));

      if (rankOf(idx) === (white ? 7 : 0)) el.dataset.file = FILES[fileOf(idx)];
      else delete el.dataset.file;
      if (fileOf(idx) === (white ? 0 : 7)) el.dataset.rank = String(8 - rankOf(idx));
      else delete el.dataset.rank;
    }

    /* A change of orientation moves every piece at once, which is a redraw
       rather than a move, so it happens with the transitions switched off. */
    var facing = bottomColor();
    if (orientation !== null && orientation !== facing) {
      stackEl.classList.add("flipping");
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { stackEl.classList.remove("flipping"); });
      });
    }
    orientation = facing;

    syncPieces(pos.board, render.mv || null);
    render.mv = null;

    squares.forEach(function (el) { el.tabIndex = -1; });
    squares[toView(focusIdx)].tabIndex = 0;

    renderPlates();
    renderMoves();
    renderBanner();
    renderRating();
    statusEl.textContent = statusText();
    statusEl.className = "statusline" + (drawOffer && drawOffer !== myColor && mode === "friend" ? " warn" : "");

    var running = mode === "friend" && status === "live";
    document.getElementById("btn-draw").hidden = !running;
    document.getElementById("btn-resign").hidden = !running;
    document.getElementById("btn-draw").textContent =
      drawOffer && drawOffer !== myColor ? "Accept draw" : "Offer draw";
  }

  /* captured pieces derived from the position, so a page that joins a match
     already in progress shows the same strips as the page that started it */
  function taken(color) {
    var start = { q: 1, r: 2, b: 2, n: 2, p: 8 };
    var alive = { q: 0, r: 0, b: 0, n: 0, p: 0 };
    for (var i = 0; i < 64; i++) {
      var p = pos.board[i];
      if (p && colorOf(p) === color && p.toLowerCase() !== "k") alive[p.toLowerCase()]++;
    }
    var lost = "", points = 0;
    ["q", "r", "b", "n", "p"].forEach(function (k) {
      var n = Math.max(0, start[k] - alive[k]);
      for (var j = 0; j < n; j++) lost += GLYPH[k];
      points += n * VALUE[k];
    });
    return { glyphs: lost, points: points };
  }

  function renderPlates() {
    var bottom = bottomColor(), top = other(bottom);
    [["plate-bottom", "taken-bottom", bottom], ["plate-top", "taken-top", top]].forEach(function (row) {
      var el = document.getElementById(row[0]);
      var color = row[2];
      var seatNo = color === "w" ? 0 : 1;
      var seat = seats[seatNo];
      var label = color === "w" ? "White" : "Black";
      var online = mode === "friend";
      var who = online ? (seat ? esc(seat.name) : "waiting") : label;

      el.className = "side-plate" +
        (online && seat && seat.here ? " here" : "") +
        (online && myColor === color ? " mine" : "") +
        (status === "live" && pos.turn === color ? " turn" : "");

      var bits = '<span class="dot"></span><b>' + who + "</b>";
      if (online) {
        bits += ' <span class="edge">' + label.toLowerCase() + (seat && !seat.here ? " · away" : "") + "</span>";
        var r = ratings[seatNo];
        if (r) bits += ' <span class="elo">' + r.elo + "</span>";
        if (deltas && deltas[seatNo] !== null && deltas[seatNo] !== undefined) {
          var dv = deltas[seatNo];
          bits += ' <span class="delta ' + (dv > 0 ? "up" : dv < 0 ? "down" : "") + '">' +
            (dv > 0 ? "+" : "") + dv + "</span>";
        }
      }
      el.querySelector(".who").innerHTML = bits;

      var mine = taken(other(color));
      var theirs = taken(color);
      var lead = mine.points - theirs.points;
      el.querySelector(".taken").textContent = mine.glyphs + (lead > 0 ? "  +" + lead : "");
    });
  }

  function renderMoves() {
    var el = document.getElementById("moves");
    if (!moveList.length) {
      el.innerHTML = '<span class="none">no moves yet</span>';
      renderMoves.shown = 0;
      return;
    }
    var rows = "";
    for (var i = 0; i < moveList.length; i += 2) {
      var freshA = i === moveList.length - 1 && moveList.length > (renderMoves.shown || 0);
      var freshB = i + 1 === moveList.length - 1 && moveList.length > (renderMoves.shown || 0);
      rows += '<div class="ply"><span class="n">' + (i / 2 + 1) + ".</span>" +
        '<span class="san' + (freshA ? " fresh" : "") + '">' + esc(moveList[i]) + "</span>" +
        '<span class="san' + (freshB ? " fresh" : "") + '">' +
        (moveList[i + 1] ? esc(moveList[i + 1]) : "") + "</span></div>";
    }
    el.innerHTML = rows;
    renderMoves.shown = moveList.length;
    el.scrollTop = el.scrollHeight;
  }

  function renderRating() {
    var elo = document.getElementById("my-elo");
    var rec = document.getElementById("my-record");
    var mine = mode === "friend" && myColor ? ratings[myColor === "w" ? 0 : 1] : null;
    var r = mine || renderRating.solo;
    if (!r) {
      elo.textContent = "—";
      rec.textContent = "unrated";
      return;
    }
    elo.textContent = r.elo;
    rec.textContent = r.games
      ? r.games + (r.games === 1 ? " game · " : " games · ") + r.wins + "W " + r.draws + "D " + r.losses + "L"
      : "provisional";
  }

  function renderBanner() {
    if (status !== "over" || bannerOff) { overEl.hidden = true; return; }
    var title, why = WHY[reason] || "";
    if (result === "draw") title = "Draw";
    else if (mode === "local") title = (result === "w" ? "White" : "Black") + " wins";
    else title = result === myColor ? "You win" : "You lose";

    document.getElementById("over-title").textContent = title;
    document.getElementById("over-why").textContent = "by " + why;

    var box = document.getElementById("over-rating");
    var seatNo = myColor === "w" ? 0 : 1;
    if (mode === "friend" && deltas && ratings[seatNo]) {
      var d = deltas[seatNo];
      box.innerHTML = "rating " + ratings[seatNo].elo + " " +
        '<b class="' + (d > 0 ? "up" : d < 0 ? "down" : "") + '">' + (d > 0 ? "+" : "") + d + "</b>";
      box.hidden = false;
    } else if (mode === "friend") {
      box.textContent = "not rated";
      box.hidden = false;
    } else {
      box.hidden = true;
    }
    overEl.hidden = false;
  }

  function statusText() {
    if (mode === "friend" && !roomCode) return "create a room or join one with a code";
    if (status === "waiting") return "waiting for someone to join · share the link";

    if (status === "over") {
      var how = WHY[reason] || "over";
      if (result === "draw") return "draw · " + how;
      var winner = result === "w" ? "white" : "black";
      if (mode === "local") return winner + " wins · " + how;
      return (result === myColor ? "you win · " : "they win · ") + how;
    }

    var check = inCheck(pos, pos.turn) ? " · check" : "";
    if (mode === "friend" && drawOffer) {
      if (drawOffer === myColor) return "draw offered, waiting for an answer" + check;
      return "they offered a draw · accept it or play on" + check;
    }
    if (mode === "local") return (pos.turn === "w" ? "white" : "black") + " to move" + check;
    return (pos.turn === myColor
      ? "your turn, you are " + (myColor === "w" ? "white" : "black")
      : "their turn") + check;
  }

  /* ── local game ── */
  function resetLocal() {
    pos = startPosition();
    keys = [positionKey(pos)];
    moveList = [];
    status = "live";
    result = null;
    reason = null;
    last = null;
    drawOffer = null;
    deltas = null;
    selected = -1;
    flipped = false;
    bannerOff = false;
    focusIdx = 60;
    hidePromo();
    render();
  }

  function playLocal(mv) {
    moveList.push(san(pos, mv));
    pos = applyMove(pos, mv);
    keys.push(positionKey(pos));
    last = { from: mv.from, to: mv.to };
    render.mv = last;
    selected = -1;
    /* only when the board is meant to turn: otherwise a manual flip is a
       deliberate choice to sit on the other side, and should survive a move */
    if (autoTurn) flipped = false;

    var done = terminal(pos, keys);
    if (done) {
      status = "over";
      result = done.result;
      reason = done.reason;
      bannerOff = false;
    }
    render();
  }

  /* ── moving ── */
  function tryMove(from, to) {
    var options = targets(from).filter(function (m) { return m.to === to; });
    if (!options.length) return false;
    if (options[0].promo) {
      pendingPromo = { from: from, to: to };
      showPromo();
      return true;
    }
    commit(from, to, null);
    return true;
  }

  function commit(from, to, promo) {
    if (mode === "local") {
      var mv = findMove(pos, from, to, promo);
      if (mv) playLocal(mv);
      return;
    }
    selected = -1;
    render();
    send({ type: "move", from: from, to: to, promo: promo });
  }

  function selectSquare(idx) {
    var movable = myMoves().some(function (m) { return m.from === idx; });
    selected = movable && idx !== selected ? idx : -1;
    render();
  }

  function refuse(idx) {
    var p = pieceAt(idx);
    if (!p) return;
    p.el.classList.remove("nudge");
    void p.el.offsetWidth;
    p.el.classList.add("nudge");
    setTimeout(function () { p.el.classList.remove("nudge"); }, 240);
  }

  /* ── pointer input: one path for tap-to-move and for dragging ── */
  var grab = null;

  function squareFromPoint(x, y) {
    var r = boardEl.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return -1;
    var cell = r.width / 8;
    var vx = Math.min(7, Math.max(0, Math.floor((x - r.left) / cell)));
    var vy = Math.min(7, Math.max(0, Math.floor((y - r.top) / cell)));
    return fromView(vy * 8 + vx);
  }

  boardEl.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (pendingPromo || status !== "live") return;
    var idx = squareFromPoint(e.clientX, e.clientY);
    if (idx < 0) return;

    var mine = myMoves().some(function (m) { return m.from === idx; });
    var isTarget = selected >= 0 && targets(selected).some(function (m) { return m.to === idx; });

    if (!mine && !isTarget) {
      if (pos.board[idx] && canMove()) refuse(idx);
      if (selected >= 0) { selected = -1; render(); }
      return;
    }

    if (mine) {
      grab = { from: idx, x: e.clientX, y: e.clientY, dragging: false, wasSelected: selected === idx };
      if (selected !== idx) { selected = idx; render(); }
      try { boardEl.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    } else {
      grab = { from: selected, to: idx, tapTarget: true };
    }
  });

  boardEl.addEventListener("pointermove", function (e) {
    if (!grab || grab.tapTarget) return;
    var dx = e.clientX - grab.x, dy = e.clientY - grab.y;
    if (!grab.dragging && dx * dx + dy * dy < 30) return;

    if (!grab.dragging) {
      grab.dragging = true;
      grab.piece = pieceAt(grab.from);
      if (grab.piece) grab.piece.el.classList.add("lifted");
    }
    if (!grab.piece) return;
    var r = boardEl.getBoundingClientRect();
    var cell = r.width / 8;
    grab.piece.el.style.transform =
      "translate(" + (e.clientX - r.left - cell / 2) + "px," + (e.clientY - r.top - cell / 2) + "px)";
  });

  function endGrab(e) {
    if (!grab) return;
    var g = grab;
    grab = null;

    if (g.tapTarget) {
      if (!tryMove(g.from, g.to)) { selected = -1; render(); }
      return;
    }

    try { boardEl.releasePointerCapture(e.pointerId); } catch (err) {}

    if (!g.dragging) {
      /* a tap, not a drag: keep it selected unless it already was, in which
         case the tap means put it down again */
      if (g.wasSelected) { selected = -1; render(); }
      return;
    }

    if (g.piece) g.piece.el.classList.remove("lifted");
    var to = squareFromPoint(e.clientX, e.clientY);
    if (to < 0 || to === g.from || !tryMove(g.from, to)) {
      if (to >= 0 && to !== g.from) refuse(g.from);
      selected = -1;
      render();
      if (g.piece) paint(g.piece);
    }
  }

  boardEl.addEventListener("pointerup", endGrab);
  boardEl.addEventListener("pointercancel", function (e) {
    if (grab && grab.piece) grab.piece.el.classList.remove("lifted");
    var g = grab;
    grab = null;
    if (g && g.piece) paint(g.piece);
    selected = -1;
    render();
  });

  /* keyboard: the board is one tab stop, arrows walk it, Enter acts */
  boardEl.addEventListener("keydown", function (e) {
    var v = toView(focusIdx);
    var vx = v % 8, vy = Math.floor(v / 8);
    var moved = true;
    if (e.key === "ArrowLeft") vx = Math.max(0, vx - 1);
    else if (e.key === "ArrowRight") vx = Math.min(7, vx + 1);
    else if (e.key === "ArrowUp") vy = Math.max(0, vy - 1);
    else if (e.key === "ArrowDown") vy = Math.min(7, vy + 1);
    else moved = false;

    if (moved) {
      e.preventDefault();
      focusIdx = fromView(vy * 8 + vx);
      squares.forEach(function (el) { el.tabIndex = -1; });
      var target = squares[toView(focusIdx)];
      target.tabIndex = 0;
      target.focus();
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (selected >= 0 && tryMove(selected, focusIdx)) return;
      selectSquare(focusIdx);
    }
  });

  boardEl.addEventListener("focusin", function (e) {
    var idx = e.target.dataset && e.target.dataset.idx;
    if (idx !== undefined) focusIdx = Number(idx);
  });

  /* ── promotion ── */
  function showPromo() {
    var color = mode === "local" ? pos.turn : myColor;
    promoEl.innerHTML = "";
    ["q", "r", "b", "n"].forEach(function (k) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = '<span class="pc ' + color + '">' + GLYPH[k] + "</span>";
      btn.setAttribute("aria-label", "promote to " + NAMES[k]);
      btn.addEventListener("click", function () {
        var p = pendingPromo;
        hidePromo();
        if (p) commit(p.from, p.to, k);
      });
      promoEl.appendChild(btn);
    });
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cancel";
    cancel.textContent = "×";
    cancel.setAttribute("aria-label", "cancel promotion");
    cancel.addEventListener("click", function () { hidePromo(); selected = -1; render(); });
    promoEl.appendChild(cancel);
    promoEl.hidden = false;
    promoEl.querySelector("button").focus();
  }

  function hidePromo() {
    pendingPromo = null;
    promoEl.hidden = true;
    promoEl.innerHTML = "";
  }

  /* ── online game ── */
  function randomCode() {
    var out = "";
    var buf = new Uint32Array(4);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(buf);
    for (var i = 0; i < 4; i++) {
      var n = buf[i] || Math.floor(Math.random() * 4294967296);
      out += CODE_ALPHABET[n % CODE_ALPHABET.length];
    }
    return out;
  }

  function connect(code, intent) {
    disconnect();
    roomCode = code;
    roomIntent = intent || "join";
    wantOpen = true;
    location.hash = code;
    showShare(code);
    openSocket();
  }

  function openSocket() {
    if (!wantOpen || !roomCode) return;
    statusEl.textContent = retry ? "reconnecting…" : "connecting…";
    ws = new WebSocket(API.replace(/^http/, "ws") + "/room/" + roomCode);

    ws.onopen = function () {
      retry = 0;
      ws.send(JSON.stringify({
        type: "join",
        intent: roomIntent,
        player: Arcade.playerId(),
        name: Arcade.getPlayer()
      }));
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === "error") { statusEl.textContent = msg.reason; return; }
      if (msg.type !== "state") return;

      var wasOver = status === "over";
      var moveCount = moveList.length;

      pos = {
        board: msg.board, turn: msg.turn, castling: msg.castling,
        ep: msg.ep, half: msg.half, full: msg.full
      };
      status = msg.status;
      result = msg.result;
      reason = msg.reason;
      moveList = msg.history;
      last = msg.last;
      myColor = msg.you;
      seats = msg.players;
      ratings = msg.ratings || [null, null];
      deltas = msg.deltas || null;
      drawOffer = msg.draw;
      selected = -1;
      /* only animate when this frame carries a move we had not seen, so a
         reconnect that replays the position does not slide every piece */
      render.mv = moveList.length === moveCount + 1 ? last : null;
      if (status === "live") bannerOff = false;
      if (!wasOver && status === "over") bannerOff = false;
      hidePromo();
      render();
    };

    /* The socket is the only way to reach the referee, so a drop has to be
       retried rather than silently ending the match. Backs off so a room that
       is genuinely gone stops being hammered. */
    ws.onclose = function () {
      ws = null;
      if (!wantOpen) return;
      retry = Math.min(retry + 1, 5);
      statusEl.textContent = "connection lost, retrying…";
      retryTimer = setTimeout(openSocket, retry * 1000);
    };

    ws.onerror = function () { statusEl.textContent = "could not reach the room"; };
  }

  function disconnect() {
    wantOpen = false;
    clearTimeout(retryTimer);
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    else statusEl.textContent = "not connected";
  }

  function showShare(code) {
    document.getElementById("share-link").textContent =
      location.origin + location.pathname + "#" + code;
    document.getElementById("share").hidden = false;
    document.getElementById("join-code").value = code;
  }

  function leaveRoom() {
    disconnect();
    roomCode = null;
    seats = [null, null];
    ratings = [null, null];
    deltas = null;
    /* `history` is the move list in this file, so the browser's own is spelled out */
    if (location.hash) window.history.replaceState(null, "", location.pathname);
    document.getElementById("share").hidden = true;
    document.getElementById("join-code").value = "";
    idleBoard();
  }

  function idleBoard() {
    pos = startPosition();
    keys = [positionKey(pos)];
    moveList = [];
    status = "idle";
    result = null;
    reason = null;
    last = null;
    drawOffer = null;
    deltas = null;
    myColor = "w";
    selected = -1;
    bannerOff = true;
    hidePromo();
    render();
  }

  /* ── my rating, for the panel outside any room ── */
  function loadMyRating() {
    if (!window.fetch) return;
    fetch(API + "/rating?player=" + encodeURIComponent(Arcade.playerId()))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && typeof d.elo === "number") { renderRating.solo = d; renderRating(); }
      })
      .catch(function () {});
  }

  /* ── modes ── */
  function setMode(next) {
    if (mode === next) return;
    mode = next;
    document.querySelectorAll("[data-mode]").forEach(function (p) {
      p.setAttribute("aria-pressed", String(p.dataset.mode === mode));
    });
    document.getElementById("panel-local").hidden = mode !== "local";
    document.getElementById("panel-friend").hidden = mode !== "friend";
    flipped = false;

    if (mode === "local") {
      leaveRoom();
      resetLocal();
    } else {
      idleBoard();
      var fromHash = (location.hash || "").slice(1).toUpperCase();
      if (CODE_RE.test(fromHash)) connect(fromHash);
    }
  }

  function flip() {
    flipped = !flipped;
    render();
  }

  /* ── wiring ── */
  document.getElementById("modes").addEventListener("click", function (e) {
    var m = e.target.getAttribute("data-mode");
    if (m) setMode(m);
  });

  document.getElementById("btn-create").addEventListener("click", function () {
    connect(randomCode(), "create");
  });

  document.getElementById("btn-join").addEventListener("click", function () {
    var code = document.getElementById("join-code").value.trim().toUpperCase();
    if (!CODE_RE.test(code)) {
      statusEl.textContent = "a room code is four letters or digits";
      return;
    }
    connect(code);
  });

  document.getElementById("join-code").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("btn-join").click();
  });

  document.getElementById("btn-copy").addEventListener("click", function () {
    var link = document.getElementById("share-link").textContent;
    var btn = document.getElementById("btn-copy");
    var done = function () {
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = "Copy link"; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () {});
    }
  });

  document.getElementById("btn-leave").addEventListener("click", leaveRoom);
  document.getElementById("btn-flip").addEventListener("click", flip);

  document.getElementById("panel-local").addEventListener("click", function (e) {
    var v = e.target.getAttribute("data-turn");
    if (!v) return;
    autoTurn = v === "on";
    flipped = false;
    document.querySelectorAll("[data-turn]").forEach(function (p) {
      p.setAttribute("aria-pressed", String((p.dataset.turn === "on") === autoTurn));
    });
    render();
  });

  function again() {
    if (mode === "local") resetLocal();
    else if (roomCode) { send({ type: "rematch" }); bannerOff = true; render(); }
  }

  document.getElementById("btn-again").addEventListener("click", again);
  document.getElementById("over-again").addEventListener("click", again);
  document.getElementById("over-close").addEventListener("click", function () {
    bannerOff = true;
    render();
  });

  document.getElementById("btn-draw").addEventListener("click", function () {
    send({ type: "draw" });
  });

  document.getElementById("btn-resign").addEventListener("click", function () {
    if (window.confirm("Resign this game?")) send({ type: "resign" });
  });

  document.addEventListener("keydown", function (e) {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.key === "Escape") {
      if (pendingPromo) { hidePromo(); selected = -1; render(); return; }
      if (!overEl.hidden) { bannerOff = true; render(); return; }
      selected = -1;
      render();
    } else if (e.key === "f" || e.key === "F") {
      flip();
    }
  });

  window.addEventListener("hashchange", function () {
    var code = (location.hash || "").slice(1).toUpperCase();
    if (mode === "friend" && CODE_RE.test(code) && code !== roomCode) connect(code);
  });

  window.addEventListener("beforeunload", disconnect);
  window.addEventListener("resize", function () { live.forEach(paint); });

  /* a link with a room code in it should land straight in that room */
  var initial = (location.hash || "").slice(1).toUpperCase();
  if (CODE_RE.test(initial)) setMode("friend");
  else render();

  loadMyRating();

  if (window.Arcade && Arcade.mountBoard && Arcade.boards && Arcade.boards.chess) {
    Arcade.mountBoard(document.getElementById("board-widget"), {
      game: "chess", title: "Elo ladder", limit: 10, selfLink: false
    });
  }

  /* exposed for the staging checks */
  window.__chess = {
    state: function () {
      return {
        mode: mode, pos: pos, status: status, result: result, reason: reason,
        history: moveList, you: myColor, room: roomCode, seats: seats,
        ratings: ratings, deltas: deltas, draw: drawOffer, last: last,
        selected: selected, connected: !!ws && ws.readyState === 1
      };
    },
    play: function (from, to, promo) { commit(from, to, promo || null); },
    raw: function (msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
    legal: function () { return legalMoves(pos); },
    pieceCount: function () { return live.length; },
    san: san,
    apply: applyMove,
    start: startPosition,
    terminal: terminal,
    key: positionKey,
    connect: connect,
    setMode: setMode
  };
})();
