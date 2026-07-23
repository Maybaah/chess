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

  /* ── state ── */
  var mode = "local";
  var pos = startPosition();
  var keys = [positionKey(pos)];
  var history = [];
  var status = "live";
  var result = null;
  var reason = null;
  var last = null;
  var myColor = "w";
  var seats = [null, null];
  var drawOffer = null;
  var flipped = false;
  var selected = -1;
  var pendingPromo = null;

  var ws = null, roomCode = null, roomIntent = "join", wantOpen = false, retry = 0, retryTimer = null;

  var boardEl = document.getElementById("board");
  var statusEl = document.getElementById("status");
  var promoEl = document.getElementById("promo");
  var squares = [];

  for (var i = 0; i < 64; i++) {
    var b = document.createElement("button");
    b.className = "sq";
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
    return pos.turn;
  }

  function bottomColor() {
    return flipped ? other(viewColor()) : viewColor();
  }

  /* my own turn in a room, either side's turn on one device */
  function canMove() {
    if (status !== "live") return false;
    return mode === "local" || pos.turn === myColor;
  }

  /* a piece with nowhere to go is not worth selecting, so the whole legal list
     is generated once per render and both the pickable pieces and the dots
     read off it */
  function myMoves() {
    return canMove() ? legalMoves(pos) : [];
  }

  function movable(idx) {
    return myMoves().some(function (m) { return m.from === idx; });
  }

  function targets(from) {
    return myMoves().filter(function (m) { return m.from === from; });
  }

  function render() {
    var white = bottomColor() === "w";
    var moves = myMoves();
    var dests = selected >= 0 ? moves.filter(function (m) { return m.from === selected; }) : [];
    var checkSquare = status === "live" && inCheck(pos, pos.turn) ? kingSquare(pos.board, pos.turn) : -1;

    for (var v = 0; v < 64; v++) {
      var idx = white ? v : 63 - v;
      var el = squares[v];
      var p = pos.board[idx];
      var cls = "sq" + ((fileOf(idx) + rankOf(idx)) % 2 === 0 ? " light" : "");

      if (last && (idx === last.from || idx === last.to)) cls += " last";
      if (idx === selected) cls += " sel";
      if (idx === checkSquare) cls += " check";
      if (last && idx === last.to) cls += " moved";

      var dest = dests.filter(function (m) { return m.to === idx; })[0];
      var pickable = moves.some(function (m) { return m.from === idx; });
      if (dest) cls += p || dest.flag === "e" ? " dest take" : " dest";
      if (dest || pickable) cls += " playable";

      el.className = cls;
      el.disabled = !dest && !pickable;
      el.dataset.idx = String(idx);
      el.innerHTML = p ? '<span class="pc ' + colorOf(p) + '">' + GLYPH[p.toLowerCase()] + "</span>" : "";
      el.setAttribute("aria-label", squareName(idx) +
        (p ? ", " + (colorOf(p) === "w" ? "white " : "black ") + NAMES[p.toLowerCase()] : ", empty"));

      if (rankOf(idx) === (white ? 7 : 0)) el.dataset.file = FILES[fileOf(idx)];
      else delete el.dataset.file;
      if (fileOf(idx) === (white ? 0 : 7)) el.dataset.rank = String(8 - rankOf(idx));
      else delete el.dataset.rank;
    }

    renderPlates();
    renderMoves();
    statusEl.textContent = statusText();
    document.getElementById("btn-draw").hidden = mode !== "friend" || status !== "live";
    document.getElementById("btn-resign").hidden = mode !== "friend" || status !== "live";
    document.getElementById("btn-draw").textContent =
      drawOffer && drawOffer !== myColor ? "Accept draw" : "Offer draw";
  }

  /* The two strips outside the board: who is sitting there, and what they have
     taken. The captured list is derived from the position rather than tracked,
     so a page that joins a match in progress shows the same thing. */
  function taken(color) {
    var startCount = { q: 1, r: 2, b: 2, n: 2, p: 8 };
    var live = { q: 0, r: 0, b: 0, n: 0, p: 0 };
    for (var i = 0; i < 64; i++) {
      var p = pos.board[i];
      if (p && colorOf(p) === color && p.toLowerCase() !== "k") live[p.toLowerCase()]++;
    }
    var lost = "", points = 0;
    ["q", "r", "b", "n", "p"].forEach(function (k) {
      var n = Math.max(0, startCount[k] - live[k]);
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
      var seat = seats[color === "w" ? 0 : 1];
      var label = color === "w" ? "White" : "Black";
      var who = mode === "friend"
        ? (seat ? esc(seat.name) + (seat.here ? "" : " (away)") : "waiting")
        : label;

      el.className = "side-plate" +
        (mode === "friend" && seat && seat.here ? " here" : "") +
        (mode === "friend" && myColor === color ? " mine" : "") +
        (status === "live" && pos.turn === color ? " turn" : "");
      el.querySelector(".who").innerHTML = '<span class="dot"></span><b>' + who + "</b>" +
        (mode === "friend" ? ' <span class="edge">' + label.toLowerCase() + "</span>" : "");

      var t = taken(other(color));   // what this side has captured
      var them = taken(color);
      var lead = t.points - them.points;
      el.querySelector(".taken").textContent = t.glyphs + (lead > 0 ? " +" + lead : "");
    });
  }

  function renderMoves() {
    var el = document.getElementById("moves");
    if (!history.length) {
      el.innerHTML = '<span class="none">no moves yet</span>';
      return;
    }
    var rows = "";
    for (var i = 0; i < history.length; i += 2) {
      rows += '<div class="ply"><span class="n">' + (i / 2 + 1) + '.</span>' +
        '<span class="san">' + esc(history[i]) + "</span>" +
        '<span class="san">' + (history[i + 1] ? esc(history[i + 1]) : "") + "</span></div>";
    }
    el.innerHTML = rows;
    el.scrollTop = el.scrollHeight;
  }

  function sideName(color) {
    if (mode === "local") return color === "w" ? "white" : "black";
    return color === myColor ? "you" : "they";
  }

  function statusText() {
    if (mode === "friend" && !roomCode) return "create a room or join one with a code";
    if (status === "waiting") return "waiting for someone to join · share the link";

    if (status === "over") {
      var how = {
        checkmate: "checkmate", stalemate: "stalemate", fifty: "fifty move rule",
        repetition: "threefold repetition", material: "not enough material to mate",
        resign: "resignation", agreement: "agreement"
      }[reason] || "over";
      if (result === "draw") return "draw · " + how;
      var winner = result === "w" ? "white" : "black";
      if (mode === "local") return winner + " wins · " + how;
      return (result === myColor ? "you win · " : "they win · ") + how;
    }

    var check = inCheck(pos, pos.turn) ? " · check" : "";
    if (drawOffer && mode === "friend") {
      if (drawOffer === myColor) return "draw offered, waiting for an answer" + check;
      return "they offered a draw · accept or play on" + check;
    }
    if (mode === "local") return (pos.turn === "w" ? "white" : "black") + " to move" + check;
    return (pos.turn === myColor ? "your turn, you are " + (myColor === "w" ? "white" : "black") : "their turn") + check;
  }

  /* ── local game ── */
  function resetLocal() {
    pos = startPosition();
    keys = [positionKey(pos)];
    history = [];
    status = "live";
    result = null;
    reason = null;
    last = null;
    drawOffer = null;
    selected = -1;
    flipped = false;
    hidePromo();
    render();
  }

  function playLocal(mv) {
    history.push(san(pos, mv));
    pos = applyMove(pos, mv);
    keys.push(positionKey(pos));
    last = { from: mv.from, to: mv.to };
    selected = -1;
    /* the board faces whoever is to move, so a flip is a look at the position
       from the other side rather than a setting that outlives the move */
    flipped = false;

    var done = terminal(pos, keys);
    if (done) {
      status = "over";
      result = done.result;
      reason = done.reason;
    }
    render();
  }

  /* ── the board ── */
  function pick(idx) {
    if (pendingPromo) return;

    if (selected >= 0) {
      var options = targets(selected).filter(function (m) { return m.to === idx; });
      if (options.length) {
        if (options[0].promo) {
          pendingPromo = { from: selected, to: idx };
          showPromo();
          return;
        }
        commit(selected, idx, null);
        return;
      }
    }
    selected = movable(idx) && idx !== selected ? idx : -1;
    render();
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

  function showPromo() {
    var color = pos.turn;
    promoEl.innerHTML = "";
    ["q", "r", "b", "n"].forEach(function (k) {
      var btn = document.createElement("button");
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
    cancel.textContent = "×";
    cancel.style.fontSize = "22px";
    cancel.setAttribute("aria-label", "cancel promotion");
    cancel.addEventListener("click", function () { hidePromo(); render(); });
    promoEl.appendChild(cancel);
    promoEl.hidden = false;
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

      pos = {
        board: msg.board, turn: msg.turn, castling: msg.castling,
        ep: msg.ep, half: msg.half, full: msg.full
      };
      status = msg.status;
      result = msg.result;
      reason = msg.reason;
      history = msg.history;
      last = msg.last;
      myColor = msg.you;
      seats = msg.players;
      drawOffer = msg.draw;
      selected = -1;
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
    /* `history` here is the move list, so the browser's own has to be named */
    if (location.hash) window.history.replaceState(null, "", location.pathname);
    document.getElementById("share").hidden = true;
    document.getElementById("join-code").value = "";
    idleBoard();
  }

  function idleBoard() {
    pos = startPosition();
    keys = [positionKey(pos)];
    history = [];
    status = "idle";
    result = null;
    reason = null;
    last = null;
    drawOffer = null;
    myColor = "w";
    selected = -1;
    hidePromo();
    render();
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

  /* ── input ── */
  boardEl.addEventListener("click", function (e) {
    var t = e.target.closest(".sq");
    if (!t || t.disabled) return;
    pick(Number(t.dataset.idx));
  });

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

  document.getElementById("btn-flip").addEventListener("click", function () {
    flipped = !flipped;
    render();
  });

  document.getElementById("btn-again").addEventListener("click", function () {
    if (mode === "local") resetLocal();
    else if (roomCode) send({ type: "rematch" });
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
      hidePromo();
      selected = -1;
      render();
    } else if (e.key === "f" || e.key === "F") {
      flipped = !flipped;
      render();
    }
  });

  window.addEventListener("hashchange", function () {
    var code = (location.hash || "").slice(1).toUpperCase();
    if (mode === "friend" && CODE_RE.test(code) && code !== roomCode) connect(code);
  });

  window.addEventListener("beforeunload", disconnect);

  /* a link with a room code in it should land straight in that room */
  var initial = (location.hash || "").slice(1).toUpperCase();
  if (CODE_RE.test(initial)) setMode("friend");
  else render();

  /* exposed for the staging checks */
  window.__chess = {
    state: function () {
      return {
        mode: mode, pos: pos, status: status, result: result, reason: reason,
        history: history, you: myColor, room: roomCode, seats: seats,
        draw: drawOffer, last: last, connected: !!ws && ws.readyState === 1
      };
    },
    play: function (from, to, promo) { commit(from, to, promo || null); },
    raw: function (msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
    legal: function () { return legalMoves(pos); },
    san: san,
    apply: applyMove,
    start: startPosition,
    terminal: terminal,
    key: positionKey,
    connect: connect,
    setMode: setMode
  };
})();
