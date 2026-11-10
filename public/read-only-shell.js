'use strict';
// Whether a shell command, taken as a whole, only reads.
//
// ONE DEFINITION, TWO GRADERS. Two layers of the permission path ask this
// question about the same text: the PreToolUse hook (scripts/permission-hook.js)
// asks it to re-grade a crossing under the runtime's own home, and the client
// risk grader (public/permissions.js) asks it to decide whether a command
// auto-approves or raises a card. They were written apart and answered
// differently, and the reader paid for the disagreement: a command the hook
// read as harmless was carded anyway, because the grader kept a narrower list
// of its own. Neither list is here twice now. This module is the definition,
// the hook requires it, and the browser reads it as a global.
//
// UMD, the same pattern as markers.js and permissions.js, because it has to
// load both ways: `require`d by node (the hook, the tests) and loaded as a
// plain script in the browser, where it must be listed in index.html BEFORE
// permissions.js, which reads it off the root object.
//
// FAIL SAFE, in every direction at once:
// - EVERY segment of a compound command must qualify. One leading word this
//   module does not name fails the whole line, so `ls x && rm -rf x` is not a
//   read.
// - Any write-shaped redirection (`>`, `>>`) or a `tee` anywhere disqualifies
//   the whole command: which stream a redirection targets is not decidable
//   from text alone, and `echo` is only harmless without one.
// - A command not built entirely from what this module names is never a read,
//   whatever it is.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockReadOnlyShell = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // ── The vocabulary, and what this change is allowed to add to it ────────
  //
  // This module is consumed by the BOUNDARY layer as well as by the card
  // grader, so a word added here can exempt a crossing under the runtime's own
  // home, not merely skip a card. Growing the vocabulary and sharing it are
  // separate judgements, and bundling them makes it impossible to tell which
  // one moved a verdict. So this change shares, and adds exactly one word.

  // MEASURED, AND UNCHANGED. Exactly the list the permission hook already
  // carried before these registries were shared. Nothing is added here.
  var READ_ONLY_SHELL_COMMANDS = [
    'ls', 'cat', 'head', 'tail', 'find', 'grep', 'rg', 'wc', 'file', 'stat',
    'realpath', 'basename', 'dirname', 'echo', 'pwd', 'tree', 'du',
    // Byte dumps, added so an agent inspecting a permission file with them is
    // not carded as changing it. Neither has any option that writes a file.
    // `xxd` is left out: `xxd -r IN OUT` writes OUT with no redirection.
    'od', 'hexdump',
  ];

  // THE ONE ADDITION. A line is judged segment by segment and fails as a whole
  // if any segment does not qualify, so a leading directory change disqualified
  // commands that went on to do nothing at all. `cd` reaches no file, so there
  // is nothing for it to write.
  //
  // The card grader also recognized `diff`, `printenv`, `pushd`, `popd`,
  // `true`, `uniq`, `which` and `whoami`, and none of them is on this list.
  // `uniq INPUT OUTPUT` writes a file with no redirection character anywhere
  // on the line, so shared into the boundary layer it would grade a write into
  // a persistence surface as a read and exempt it from its crossing. The
  // others cannot write, and each one restored to the grader's auto-allow set
  // is a widening judged on its own evidence.
  //
  // SORT AND DATE READ ONLY IN THE FORMS THAT READ. The grader recognized
  // both, and neither is on this list either, because this list frees a word
  // whatever its options. Each is judged by its options instead: a read when
  // every option on the line is on its own list of reading options
  // (SORT_OPTIONS and DATE_OPTIONS below), and any other option asks. The
  // rest of their forms ask because they do more than read: `sort -o FILE`
  // writes FILE with no redirection on the line, `sort -T DIR` puts its
  // temporary files where it is told, `sort --compress-program=PROG` runs
  // PROG, and `date -s`, `date --set`, a time operand (one not starting with
  // `+`) and `date -f` without `-j` set the system clock.
  var NO_TARGET_COMMANDS = ['cd'];

  // Keywords a REAL COMMAND follows. Stripped, then the rest is judged on its
  // own merits, so nothing rides in behind one. `if` and `elif` and `while` and
  // `until` each take a command as their condition; `do`, `then` and `else`
  // introduce a body. Getting this list wrong in the other direction (treating
  // one of these as reaching no file) would exempt whatever follows it, which
  // is why they are not in the list below.
  var KEYWORD_PREFIXES = ['do', 'then', 'else', 'if', 'elif', 'while', 'until', '{', '}', '!'];

  // Keywords whose remainder is NOT a command: a variable and a word list, or a
  // pattern. They reach no file themselves. Any path among those words is still
  // scanned for boundary crossings by the caller; this function only answers
  // whether the segment WRITES.
  var NON_COMMAND_KEYWORDS = ['for', 'case', 'select', 'esac', 'done', 'fi'];

  // `env` IS DELIBERATELY ABSENT, though it prints the environment and looks
  // like a read. It also runs whatever follows its assignments, so
  // `env FOO=1 rm notes.md` is a removal wearing a read's leading word, and a
  // registry consulted by the boundary layer cannot afford to carry that.
  //
  // `node` and `python` are absent for the same reason and one more: `node -e`
  // and `python -c` are arbitrary code execution rather than reads, so a
  // fs.rmSync payload, or a fetch that sends a file somewhere, would run with
  // no card at all. They ask, exactly as `node script.js` already does.

  // THE REGISTRY FOR THE OTHER SHELL, because Windows is one of the two
  // platforms this product builds for, its agents do not write `ls`, and it
  // has no sandbox under the card. It is read by isReadOnlyPowerShellCommand
  // below, the one reading of PowerShell, which the card grader and the hook
  // both call.
  //
  // A POWERSHELL READ IS A COMMAND WHOSE EVERY PART STARTS WITH A NAME ON THIS
  // LIST. Every part: the command is split at `;`, `|`, `&&`, `||` and each new
  // line, and one part that is not a read makes the whole command not a read.
  //
  // NAMED, NOT MATCHED BY VERB. `Get-*` is read-shaped by PowerShell's own
  // convention, and nothing holds a cmdlet to it: `Get-Clipboard` and
  // `Get-Credential` hand an agent what it should not see unasked, and a cmdlet
  // written tomorrow can take any name. This list frees a crossing into the
  // runtime's own home as well as skipping a card, so it names cmdlets one at a
  // time, each one that writes, sends and runs nothing when given plain words,
  // and it stays short. Aliases are named one by one too: `sc`, `ac` and `ni`
  // write, and are not here. Compared case-insensitively because PowerShell
  // is; the list above is not, because its shells are not.
  //
  // ANYTHING NOT READ ALL THE WAY CARDS. A name on this list makes a read only
  // when the reading has followed every way the text can run something else
  // and found none. A command in brackets, a script block, a redirection to a
  // file or an escape it cannot see past makes the command not a read,
  // whatever names are in it, so a listed cmdlet handed a block or a
  // calculated property cards too.
  //
  // Bash reads these names as well, with its own rules, as it always has
  // (`dir`, `type`). A PowerShell command is never read by the Bash rules.
  var READ_ONLY_POWERSHELL_COMMANDS = [
    'get-childitem', 'gci', 'dir', 'ls', 'get-content', 'gc', 'cat', 'type',
    'get-item', 'gi', 'get-location', 'gl', 'pwd', 'test-path', 'resolve-path',
    'split-path', 'select-string', 'sls', 'measure-object', 'select-object',
    'sort-object', 'format-table', 'format-list', 'out-string', 'write-output',
    'write-host', 'echo', 'get-date', 'where-object',
  ];
  // FOR THE POWERSHELL READING ONLY. These joined the list above when
  // PowerShell got a reading of its own, and Bash reads that list too. Bash's
  // answer was not to move with PowerShell's, so Bash reads the list as it
  // stood before and these two are not reads there, as they were not.
  var POWERSHELL_ONLY_READS = ['get-date', 'where-object'];

  // NO NAME OF ANY PARTICULAR TOOL LIVES HERE, and a package runner is not a
  // read whatever follows it.
  //
  // A runner (`npx` and its kin) resolves a package and RUNS it, fetching it
  // when it is not already present. Whether the program then reads or writes
  // files is a second question; executing it is the first, and answering that
  // with "no card" is a thing this product has never done. It was briefly done
  // here for one reported command, keyed on that tool's name and subcommand,
  // which also put knowledge of a third party's semantics inside the
  // permission rules: a claim that rots silently the moment that tool adds a
  // writing option, and one that frees the command somebody reported while the
  // next person's equally harmless command still asks.
  //
  // Inferring the answer from the subcommand's wording was considered and is
  // worse. The MCP read verbs elsewhere work because those names come from a
  // structured namespace a server declares; `npx <package> <word>` is
  // unconstrained, and a package can be published whose `list` deletes.

  // A redirection that cannot create or modify a file: output thrown away at
  // /dev/null, or a file descriptor duplicated onto another (`2>&1`). Stripped
  // before anything below looks at the command, for two reasons. It writes
  // nothing, so it must not change what a command is graded as. And the
  // segmenter splits on `&`, which cuts `2>&1` into `2>` and a bare `1` that
  // leads no command this module names, so an ordinary listing graded as a
  // write: measured on a real session, on the build that had already taught
  // the boundary classifier this exact rule and not the grader beside it.
  //
  // EXHAUSTIVE BY INTENT. Only these two shapes are exempt, because only these
  // two provably reach no path. Every other target is a real file.
  //
  // A DESCRIPTOR NUMBER IS THE REDIRECT'S ONLY WHEN IT STARTS A WORD, as bash
  // reads it: `-t2>&1` is the word `-t2` and then `>&1`. Taken as the
  // redirect's, the `2` was stripped with it, `-t` took the next word, and
  // `sort -t2>&1 -o out in` read as a sort with no `-o`. With no number the
  // redirect is stripped wherever it stands, because `>` ends the word before
  // it in bash: `x>/dev/null` is `x`, and a discard.
  var DISCARDING_REDIRECT_RE = /(?:(?<![^ \t\n])\d+)?>>?\s*(?:\/dev\/null|&\s*\d+)/g;

  // ── Where the shell's quotes really are ─────────────────────────────────
  //
  // EVERY READING HERE FINDS A QUOTE BY PAIRING QUOTE CHARACTERS, and the
  // hook's readings do the same. The shell has quote characters that open
  // nothing as well, and each one, paired with a later quote, hid every
  // command after it inside a quote the shell never opened:
  //   - a comment runs from a `#` that starts a word to the end of its line,
  //     and a quote in it is text (`ls # it's`);
  //   - inside `$'…'` a backslash takes the next character with it, a quote
  //     included, so `$'\''` is one quoted word, a lone `'`;
  //   - in a here-document's body every quote is text, as is everything else
  //     but a substitution in a body whose delimiter is not quoted;
  //   - a quote after a backslash outside single quotes is text;
  //   - inside a substitution held in double quotes, `"$(echo "x")"`, quotes
  //     start afresh, and a reading that pairs them ran the strings together.
  //
  // shellView gives the line back with each of those characters made a space,
  // one character for one, so every offset into the line still holds. A
  // double-quoted string that holds a command is opened up as well: its own
  // quotes, and the quote and grouping characters in its text, are made
  // spaces, so the command inside is read where it runs. Each reading reads
  // this view as well as the line itself and keeps everything either finds,
  // so nothing the line's own reading found stops being found.
  //
  // `ok` IS FALSE WHEN THE LINE CANNOT BE READ TO ITS END THIS WAY, or when
  // the shells an agent's command runs in (bash 3.2, which macOS ships, a
  // later bash, and zsh, which macOS starts with) read its quotes differently:
  // a quote, substitution or here-document never closed; a single quote
  // inside `${…}` within double quotes; a `case` inside `$( )`; a substitution
  // holding a here-document or a comment that bash 3.2 ends at another `)`;
  // or nesting deeper than this reading follows. Such a line is not a read,
  // and in Code mode it asks.
  //
  // `parens` is whether a `(` or `)` stands outside every quote and outside
  // every substitution's own. Each runs a command behind a leading word that
  // reads: zsh runs `cmd` for `ls *(e:'cmd':)`, `ls x(+cmd)` and `cat =(cmd)`,
  // and `case x in x) cmd;; esac` runs `cmd` in either shell. A line holding
  // one is not a read. `wordParen` is whether such a `(` is inside a word
  // rather than starting one (a subshell), other than an array's `name=(`:
  // the zsh forms above, which the Code-mode verdict, reading bash's grammar,
  // does not model, so there they ask.
  //
  // A FAILURE INSIDE THIS READING IS AN ANSWER: the line as given and `ok`
  // false. A test forces one through this seam.
  var shellViewSeam = { beforeReading: function () {} };
  var VIEW_DEPTH_LIMIT = 32;
  // The characters that give text a structure: quotes, an escape, a
  // substitution, a group, a here-document.
  var STRUCTURE_CHARS = '\'"`\\$(){}<';
  // The text characters of a double-quoted string that is opened up.
  var OPENED_CHARS = '\'\\(){}<#';
  function shellView(command) {
    var text = String(command);
    try {
      shellViewSeam.beforeReading(text);
      var seen = viewOf(text, 0);
      return { text: seen.chars.join(''), ok: seen.ok, parens: seen.parens, wordParen: seen.wordParen };
    } catch (failed) {
      return { text: text, ok: false, parens: false, wordParen: false };
    }
  }
  function viewOf(text, depth) {
    var v = text.split('');
    var n = text.length;
    var st = { ok: true, parens: false, wordParen: false, pending: [], command: false, marks: 0 };
    if (depth > VIEW_DEPTH_LIMIT) return { chars: v, ok: false, parens: false, wordParen: false, command: false };
    var blank = function (k) { if (v[k] !== '\n') v[k] = ' '; };
    var blankStructure = function (from, to) {
      for (var k = from; k < to; k++) if (STRUCTURE_CHARS.indexOf(text[k]) >= 0) blank(k);
    };
    var escapedQuote = function (c) { return c === '\'' || c === '"' || c === '`'; };

    // Commands from `p` to `limit`. In a substitution (`inParen`) they end at
    // the `)` that closes it, whose index is returned.
    function script(p, limit, inParen, level) {
      if (depth + level > VIEW_DEPTH_LIMIT) { st.ok = false; return limit; }
      var wordStart = true;
      var wordFrom = p;
      var groups = 0;
      while (p < limit) {
        var c = text[p];
        if (wordStart) wordFrom = p;
        if (c === '\\') {
          if (p + 1 >= limit) return limit;
          if (escapedQuote(text[p + 1])) blank(p + 1);
          if (text[p + 1] !== '\n') wordStart = false;
          p += 2;
          continue;
        }
        if (c === '\'') { p = single(p, limit); wordStart = false; continue; }
        if (c === '"') { p = double(p, limit, level); wordStart = false; continue; }
        if (c === '`') { p = backtick(p, limit, level, false); wordStart = false; continue; }
        if (c === '$') { p = dollar(p, limit, level, false); wordStart = false; continue; }
        if (c === '#' && wordStart) { p = comment(p, limit); continue; }
        if (c === '\n') { p = bodies(p, limit, level); wordStart = true; continue; }
        if ((c === '<' || c === '>') && text[p + 1] === '(') { p = substitution(p + 1, limit, level); wordStart = false; continue; }
        if (c === '<' && text[p + 1] === '<') {
          p = text[p + 2] === '<' ? p + 3 : marker(p, limit);
          wordStart = false;
          continue;
        }
        if (c === '(') {
          st.parens = true;
          if (!wordStart && !/^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(text.slice(wordFrom, p))) st.wordParen = true;
          groups++;
          p++;
          wordStart = true;
          continue;
        }
        if (c === ')') {
          if (inParen && groups === 0) return p;
          st.parens = true;
          if (groups > 0) groups--;
          p++;
          wordStart = true;
          continue;
        }
        if (c === ' ' || c === '\t' || c === ';' || c === '&' || c === '|') { p++; wordStart = true; continue; }
        // A case pattern's `)` ends a substitution early in bash 3.2 and not
        // in a later bash or zsh.
        if (inParen && wordStart && /^case[ \t\n;&|()<>]/.test(text.slice(p, p + 5))) st.ok = false;
        wordStart = false;
        p++;
      }
      if (inParen) st.ok = false;
      return limit;
    }
    function single(p, limit) {
      var j = text.indexOf('\'', p + 1);
      if (j < 0 || j >= limit) { st.ok = false; return limit; }
      return j + 1;
    }
    function double(p, limit, level) {
      var start = p;
      var held = st.command;
      st.command = false;
      var plain = [];
      p++;
      while (p < limit && text[p] !== '"') {
        var c = text[p];
        if (c === '\\') {
          if (p + 1 < limit && '$`"\\\n'.indexOf(text[p + 1]) >= 0) {
            if (escapedQuote(text[p + 1])) blank(p + 1);
            plain.push(p);
            p += 2;
            continue;
          }
          plain.push(p);
          p++;
          continue;
        }
        if (c === '$') { p = dollar(p, limit, level, true); continue; }
        if (c === '`') { p = backtick(p, limit, level, true); continue; }
        plain.push(p);
        p++;
      }
      var holds = st.command;
      st.command = held || holds;
      if (p >= limit) { st.ok = false; return limit; }
      if (holds) {
        blank(start);
        blank(p);
        for (var k = 0; k < plain.length; k++) if (OPENED_CHARS.indexOf(text[plain[k]]) >= 0) blank(plain[k]);
      }
      return p + 1;
    }
    function dollar(p, limit, level, inDouble) {
      if (p + 1 >= limit) return p + 1;
      var e = text[p + 1];
      if (e === '(') return text[p + 2] === '(' ? arithmetic(p, limit, level) : substitution(p + 1, limit, level);
      if (e === '{') return parameter(p, limit, level, inDouble);
      if (e === '\'' && !inDouble) return ansi(p, limit);
      return p + 1;
    }
    function ansi(p, limit) {
      p += 2;
      while (p < limit) {
        if (text[p] === '\\') { if (text[p + 1] === '\'') blank(p + 1); p += 2; continue; }
        if (text[p] === '\'') return p + 1;
        p++;
      }
      st.ok = false;
      return limit;
    }
    // `$(`, `<(` or `>(`, from its `(`.
    function substitution(q, limit, level) {
      st.command = true;
      var marks = st.marks;
      var end = script(q + 1, limit, true, level + 1);
      if (end >= limit) { st.ok = false; return limit; }
      if (st.marks !== marks) {
        var old = bash32Close(q, limit);
        if (old >= 0 && old !== end) st.ok = false;
      }
      return end + 1;
    }
    function arithmetic(p, limit, level) {
      var q = p + 3;
      var groups = 0;
      while (q < limit) {
        var c = text[q];
        if (c === '\\') { if (escapedQuote(text[q + 1])) blank(q + 1); q += 2; continue; }
        if (c === '\'') { q = single(q, limit); continue; }
        if (c === '"') { q = double(q, limit, level + 1); continue; }
        if (c === '`') { q = backtick(q, limit, level + 1, false); continue; }
        if (c === '$') { q = dollar(q, limit, level + 1, false); continue; }
        if (c === '(') { groups++; q++; continue; }
        if (c === ')') {
          if (groups > 0) { groups--; q++; continue; }
          if (text[q + 1] === ')') return q + 2;
          // `$((` closed by a lone `)`: a subshell inside `$( )`, read no
          // further.
          st.ok = false;
          return q + 1;
        }
        q++;
      }
      st.ok = false;
      return limit;
    }
    function parameter(p, limit, level, inDouble) {
      var q = p + 2;
      var braces = 1;
      while (q < limit) {
        var c = text[q];
        if (c === '\\') { if (escapedQuote(text[q + 1])) blank(q + 1); q += 2; continue; }
        if (c === '\'') {
          // Bash 3.2 takes it as a quote here, a later bash and zsh as text.
          if (inDouble) { st.ok = false; q++; continue; }
          q = single(q, limit);
          continue;
        }
        if (c === '"') { q = double(q, limit, level + 1); continue; }
        if (c === '`') { q = backtick(q, limit, level + 1, inDouble); continue; }
        if (c === '$') { q = dollar(q, limit, level + 1, inDouble); continue; }
        if (c === '{') braces++;
        else if (c === '}' && --braces === 0) return q + 1;
        q++;
      }
      st.ok = false;
      return limit;
    }
    // A backtick's command is the text up to the next backtick not escaped,
    // with `\\`, `` \` ``, `\$` (and `\"` inside double quotes) made the
    // character after the backslash, then read as commands of its own.
    function backtick(p, limit, level, inDouble) {
      st.command = true;
      var q = p + 1;
      var inner = '';
      var at = [];
      var unescape = inDouble ? '\\`$"' : '\\`$';
      while (q < limit && text[q] !== '`') {
        if (text[q] === '\\' && q + 1 < limit && unescape.indexOf(text[q + 1]) >= 0) {
          if (escapedQuote(text[q + 1])) blank(q + 1);
          inner += text[q + 1];
          at.push(q + 1);
          q += 2;
          continue;
        }
        if (text[q] === '\\' && q + 1 < limit) { inner += text.slice(q, q + 2); at.push(q, q + 1); q += 2; continue; }
        inner += text[q];
        at.push(q);
        q++;
      }
      if (q >= limit) { st.ok = false; return limit; }
      var seen = viewOf(inner, depth + level + 1);
      for (var k = 0; k < inner.length; k++) if (seen.chars[k] !== inner[k]) blank(at[k]);
      if (!seen.ok) st.ok = false;
      if (seen.parens) st.parens = true;
      if (seen.wordParen) st.wordParen = true;
      return q + 1;
    }
    function comment(p, limit) {
      st.marks++;
      var q = p;
      while (q < limit && text[q] !== '\n') q++;
      blankStructure(p, q);
      return q;
    }
    // `<<` or `<<-`, then its delimiter word, from the first `<`.
    function marker(p, limit) {
      st.marks++;
      var q = p + 2;
      var tabs = false;
      if (text[q] === '-') { tabs = true; q++; }
      while (q < limit && (text[q] === ' ' || text[q] === '\t')) q++;
      var start = q;
      var delim = '';
      var quoted = false;
      while (q < limit) {
        var c = text[q];
        if (c === ' ' || c === '\t' || c === '\n' || ';&|<>()'.indexOf(c) >= 0) break;
        if (c === '\\') { quoted = true; if (q + 1 < limit) delim += text[q + 1]; q += 2; continue; }
        if (c === '\'' || c === '"') {
          var j = text.indexOf(c, q + 1);
          if (j < 0 || j >= limit) { st.ok = false; return limit; }
          quoted = true;
          delim += text.slice(q + 1, j);
          q = j + 1;
          continue;
        }
        delim += c;
        q++;
      }
      if (q === start) { st.ok = false; return q; }
      st.pending.push({ delim: delim, tabs: tabs, expands: !quoted });
      return q;
    }
    // At a line break: the bodies of the here-documents its line opened, each
    // up to the line that is its delimiter. Returns where reading resumes.
    function bodies(p, limit, level) {
      p++;
      while (st.pending.length) {
        var m = st.pending.shift();
        var from = p;
        var closed = false;
        while (p < limit) {
          var eol = text.indexOf('\n', p);
          if (eol < 0 || eol > limit) eol = limit;
          var line = text.slice(p, eol);
          if ((m.tabs ? line.replace(/^\t+/, '') : line) === m.delim) {
            body(from, p, m.expands, level);
            p = Math.min(eol + 1, limit);
            closed = true;
            break;
          }
          p = eol + 1;
        }
        if (!closed) {
          body(from, limit, m.expands, level);
          st.ok = false;
          st.pending = [];
          return limit;
        }
      }
      return p;
    }
    function body(from, to, expands, level) {
      if (!expands) { blankStructure(from, to); return; }
      var q = from;
      while (q < to) {
        var c = text[q];
        if (c === '\\') {
          if (q + 1 < to && '$`\\\n'.indexOf(text[q + 1]) >= 0) { if (text[q + 1] === '`') blank(q + 1); q += 2; continue; }
          blank(q);
          q++;
          continue;
        }
        if (c === '$') { q = dollar(q, to, level, true); continue; }
        if (c === '`') { q = backtick(q, to, level, true); continue; }
        if (STRUCTURE_CHARS.indexOf(c) >= 0) blank(q);
        q++;
      }
    }
    // Where bash 3.2 ends the substitution whose `(` is at `q`: it pairs
    // quotes and parentheses and skips a comment, and knows nothing of a
    // here-document. -1 when it cannot end it, which is an error there.
    function bash32Close(q, limit) {
      var groups = 1;
      var p = q + 1;
      var wordStart = true;
      while (p < limit) {
        var c = text[p];
        if (c === '\\') { p += 2; wordStart = false; continue; }
        if (c === '\'') {
          var j = text.indexOf('\'', p + 1);
          if (j < 0 || j >= limit) return -1;
          p = j + 1;
          wordStart = false;
          continue;
        }
        if (c === '"') { p = bash32Double(p, limit); if (p < 0) return -1; wordStart = false; continue; }
        if (c === '`') { p = bash32Backtick(p, limit); if (p < 0) return -1; wordStart = false; continue; }
        if (c === '$' && text[p + 1] === '\'') {
          p += 2;
          while (p < limit && text[p] !== '\'') p += text[p] === '\\' ? 2 : 1;
          if (p >= limit) return -1;
          p++;
          wordStart = false;
          continue;
        }
        if (c === '#' && wordStart) { while (p < limit && text[p] !== '\n') p++; continue; }
        if (c === '(') groups++;
        else if (c === ')' && --groups === 0) return p;
        wordStart = ' \t\n;&|()'.indexOf(c) >= 0;
        p++;
      }
      return -1;
    }
    function bash32Double(p, limit) {
      p++;
      while (p < limit && text[p] !== '"') {
        if (text[p] === '\\') { p += 2; continue; }
        if (text[p] === '$' && text[p + 1] === '(') { var j = bash32Close(p + 1, limit); if (j < 0) return -1; p = j + 1; continue; }
        if (text[p] === '`') { p = bash32Backtick(p, limit); if (p < 0) return -1; continue; }
        p++;
      }
      return p < limit ? p + 1 : -1;
    }
    function bash32Backtick(p, limit) {
      p++;
      while (p < limit && text[p] !== '`') p += text[p] === '\\' ? 2 : 1;
      return p < limit ? p + 1 : -1;
    }

    script(0, n, false, 0);
    if (st.pending.length) st.ok = false;
    return { chars: v, ok: st.ok, parens: st.parens, wordParen: st.wordParen, command: st.command };
  }

  // SPLIT ON OPERATORS, BUT NOT ON TEXT THAT LOOKS LIKE ONE. A regular
  // expression is full of shell operator characters, and quoting is what tells
  // them apart: `grep -oE '"(app|window_title)": ...' f | head` runs two
  // commands, not four. A plain split cut the pattern in half, left a fragment
  // leading no command this module names, and carded a read: measured on a
  // real session.
  //
  // A LONE `&` JOINS TWO COMMANDS TOO. It backgrounds what precedes it and
  // runs what follows, so `ls x & rm -rf x` is two commands exactly as
  // `ls x && rm -rf x` is. `&&` is consumed first, so any `&` reaching the
  // single-character test is the lone form; a trailing one yields an empty
  // segment, which carries nothing to disqualify and leaves a backgrounded
  // read a read.
  //
  // Newlines separate too, because a shell runs each line, so a read-only
  // first line must not shield a destructive one below it. Quote state is
  // carried across them for the same reason it is carried anywhere else.
  //
  // Order does not matter to the caller: every segment must qualify for the
  // command to be a read, so which one is examined first changes nothing.
  //
  // A BACKSLASH OUTSIDE SINGLE QUOTES TAKES THE NEXT CHARACTER WITH IT, as in
  // bash, so `\"` and `\'` open no quote, and inside double quotes `\"` ends
  // none. Taken as a quote, an escaped one hid every line after it inside a
  // quote bash never opened, and the commands on those lines were never
  // judged. Inside single quotes a backslash is text, as it is in bash.
  //
  // AN ESCAPED SEPARATOR STILL ENDS A SEGMENT HERE, though bash takes `\;` as
  // text and a backslash before a new line as the line going on. Splitting
  // where bash does not only ever asks more: each piece must read on its own,
  // and the piece the backslash ends is not read where options are judged,
  // because shellWords leaves a trailing backslash unread.
  //
  // `asWritten` (true) splits the line as it is written instead, every quote
  // taken as written and a backslash as text, which is how every line was
  // split before. Every reading here asks both splits (shellSplits): a line
  // reads only when it reads in each, and a check that looks for a segment
  // that writes or destroys looks in each.
  function shellSegments(command, asWritten) {
    var shellReading = asWritten !== true;
    var segments = [];
    var cur = '';
    var quote = null;
    var str = String(command);
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (shellReading && ch === '\\' && quote !== "'" && i + 1 < str.length && (quote || ';|&\n\r'.indexOf(str[i + 1]) < 0)) {
        cur += ch + str[++i];
        continue;
      }
      if (quote) {
        cur += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
      if ((ch === '&' && str[i + 1] === '&') || (ch === '|' && str[i + 1] === '|')) {
        segments.push(cur); cur = ''; i++; continue;
      }
      if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') {
        segments.push(cur); cur = ''; continue;
      }
      cur += ch;
    }
    segments.push(cur);
    return segments.map(function (seg) { return seg.trim(); });
  }
  // The segments of every split, the shell's first: as the shell splits the
  // line, as it splits the line's view (shellView, above), and as the line is
  // written. The first and last differ only after a backslash before a quote
  // or a separator, and the view only where the line holds a quote character
  // that opens nothing, so most lines are split once.
  function shellSplits(command) {
    var str = String(command);
    var segments = shellSegments(str);
    var view = shellView(str).text;
    if (view !== str) segments = segments.concat(shellSegments(view));
    return /\\['";|&\n\r]/.test(str) ? segments.concat(shellSegments(str, true)) : segments;
  }

  // The command name without the directory it was reached through, so
  // `/usr/bin/ls` and `ls` are one name.
  function bareWord(word) {
    return word.indexOf('/') >= 0 ? word.slice(word.lastIndexOf('/') + 1) : word;
  }

  // ── find is judged by an ALLOWLIST, and everything else fails closed ─────
  //
  // NAMING THE FLAGS THAT HURT DOES NOT WORK, and this is the second attempt.
  // The first named `-exec`, `-execdir`, `-ok` and `-delete`, and missed
  // `-fprint`, `-fprint0`, `-fprintf` and `-fls`, each of which writes the
  // search results to a path with no redirection character on the line. The
  // list of ways `find` can write is not knowable from memory, and it differs
  // by implementation: the BSD `find` on this machine has no `-fprintf` at all
  // while GNU's does, so a denylist written against one manual is wrong on the
  // other platform this product ships to.
  //
  // So the question is inverted. These are the flags that keep `find` a read,
  // and ANY other word beginning with `-` makes it not one, whether it is an
  // action nobody here thought of, a flag a future version adds, or a typo.
  // An unknown flag draws a card, which is the safe direction and the whole
  // point of the shape.
  //
  // EACH FLAG IS JUDGED AS THE SHELL HANDS IT TO find, never as it is written:
  // `'-fprintf'`, `\-fprintf` and `-fpr'int'f` are all the `-fprintf` find is
  // given (see optionsOnlyRead below). A line whose words the text alone does
  // not show is not a read, so it asks.
  //
  // ARITY IS WHAT MAKES THIS SOUND. `find /tmp -type f -mtime -1` is an
  // ordinary read whose operand begins with `-`, so a flag's operand has to be
  // consumed rather than judged, exactly as `find` itself consumes it. Where a
  // flag's arity is ambiguous it is recorded as taking NONE: `-depth` is
  // documented both ways, and reading it as taking one would let
  // `find . -depth -delete` swallow the removal as an operand. Taking none
  // leaves the next word to be judged, which is the safe direction again.
  var FIND_READ_FLAGS_NO_OPERAND = [
    '-depth', '-d', '-follow', '-xdev', '-mount', '-noleaf', '-empty',
    '-print', '-print0', '-ls', '-prune', '-quit', '-nouser', '-nogroup',
    '-readable', '-writable', '-executable', '-true', '-false', '-daystart',
    '-ignore_readdir_race', '-noignore_readdir_race', '-warn', '-nowarn',
    '-not', '-a', '-and', '-o', '-or', '-H', '-L', '-P',
  ];
  // Each of these always takes exactly one operand, so the operand is consumed
  // unjudged. A word is only ever listed here when it cannot appear alone: get
  // that wrong in this direction and a flag would be swallowed as an operand.
  var FIND_READ_FLAGS_ONE_OPERAND = [
    '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename',
    '-lname', '-ilname', '-regex', '-iregex', '-regextype', '-type', '-xtype',
    '-maxdepth', '-mindepth', '-mtime', '-atime', '-ctime', '-mmin', '-amin',
    '-cmin', '-size', '-user', '-group', '-uid', '-gid', '-perm', '-links',
    '-inum', '-used', '-fstype', '-samefile', '-context', '-printf', '-flags',
  ];
  // -newer, and the -newerXY family (-newermt, -newerct and the rest), all of
  // which take one operand.
  var FIND_NEWER_FAMILY = /^-newer[a-z]{0,2}$/i;

  // A word that does not begin with `-`, once the shell has taken its quotes
  // and backslashes away, is a path, a pattern, a number or one of find's
  // grouping tokens, and none of those is a flag to judge.
  function findOnlyReads(words) {
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w.charAt(0) !== '-') continue;
      if (FIND_READ_FLAGS_NO_OPERAND.indexOf(w) >= 0) continue;
      if (FIND_READ_FLAGS_ONE_OPERAND.indexOf(w) >= 0 || FIND_NEWER_FAMILY.test(w)) { i++; continue; }
      return false;
    }
    return true;
  }

  // ── sort and date are judged the way find is, by the options that read ──
  //
  // Both are everyday reads, and both have forms that are not. `sort -o FILE`
  // writes FILE with no redirection on the line, `-T DIR` writes temporary
  // files where it is told, and `--compress-program=PROG` runs PROG. `date`
  // sets the system clock when given `-s`, `--set` or a time operand, and the
  // BSD `date -f FMT TIME` sets it too unless `-j` says not to. So each has a
  // list of the options that keep it a read, with how many operands each
  // takes, and ANY OTHER OPTION makes the segment not a read: one these lists
  // never heard of, one a later version adds, a typo.
  //
  // CHECKED AGAINST TWO MANUALS, because the same text runs under either:
  // this Mac's (the FreeBSD sort, "2.3-Apple", and the FreeBSD date), and GNU
  // coreutils', which Linux and Git Bash on Windows run. Each entry says which
  // manual it comes from. An option one of them does not have is refused
  // there before anything runs, so it only has to read in the other.
  //
  // OPTIONS ARE READ AS getopt READS THEM, because that is what decides what
  // runs. A short bundle is taken letter by letter, and a letter that takes an
  // operand takes the rest of the bundle, or the next word when the bundle
  // ends with it: `-rno out` is `-r -n -o out`, and `-k2,2n` is `-k` given
  // `2,2n`. Every word is judged wherever it stands, because GNU's getopt
  // still reads an option after a file. `--` ends the options in both, and is
  // on neither list, so it asks. A long option that takes a value reads only
  // with the value joined by `=`; given as the next word it asks, which costs
  // a card and claims nothing about which word getopt would hand it.
  var SORT_OPTIONS = {
    // No operand, in both manuals: -b -c -C -d -f -g -h -i -M -m -n -R -r -s
    // -u -V -z. Never `o` (writes a file) or `T` (writes where it is told).
    letters: 'bcCdfghiMmnRrsuVz',
    // One operand, in both manuals: -k KEY, -t SEPARATOR, -S SIZE.
    operandLetters: 'ktS',
    // An operand only when joined to the letter: none.
    joinedLetters: '',
    // Both manuals. GNU's `--stable` and `--check=diagnose-first`, and both
    // manuals' --files0-from, --random-source, --batch-size and --parallel,
    // read too and are left off to keep the list short: they ask.
    long: ['--check', '--check=silent', '--check=quiet', '--merge', '--unique',
      '--ignore-leading-blanks', '--dictionary-order', '--ignore-case',
      '--general-numeric-sort', '--human-numeric-sort', '--ignore-nonprinting',
      '--month-sort', '--numeric-sort', '--random-sort', '--reverse',
      '--version-sort', '--zero-terminated', '--debug'],
    // Both manuals, the value joined by `=`.
    longValue: ['--sort=', '--key=', '--field-separator=', '--buffer-size='],
  };
  var DATE_OPTIONS = {
    // No operand: -u and -R (both manuals; GNU's -R is --rfc-email), and -j,
    // this Mac's "do not try to set the date", which GNU's date refuses.
    letters: 'uRj',
    // One operand: -r FILE or SECONDS (both), -z ZONE and -v ADJUST (this
    // Mac's), -d STRING (GNU's) and -f (both: this Mac's input format, which
    // reads only with -j, below, and GNU's file of dates).
    //
    // Before macOS 12.3, this Mac's `date -d N` set the kernel's
    // daylight-saving flag through settimeofday, which only the superuser may
    // call; an agent runs as the person, and `sudo` is graded irreversible
    // before this is asked. Every later release, and GNU, read `-d` as a date
    // to show.
    operandLetters: 'rzvdf',
    // An operand only when joined to the letter: -I[FMT] (both). `-I seconds`
    // hands `seconds` to date as a time to set, so -I never takes the next word.
    joinedLetters: 'I',
    // GNU's long forms. This Mac's date has none, and refuses every one.
    long: ['--utc', '--universal', '--iso-8601', '--rfc-email', '--debug'],
    longValue: ['--date=', '--iso-8601=', '--rfc-3339=', '--reference='],
  };

  // The options and operands of one command in the order getopt meets them,
  // or null when an option is not on the command's lists. A lone `-` is
  // standard input, an operand.
  function optionsAndOperands(words, spec) {
    var seen = [];
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w.charAt(0) !== '-' || w === '-') { seen.push({ operand: w }); continue; }
      if (w.charAt(1) === '-') {
        var joined = spec.longValue.some(function (prefix) { return w.indexOf(prefix) === 0; });
        if (spec.long.indexOf(w) >= 0 || joined) { seen.push({ option: w }); continue; }
        return null;
      }
      for (var j = 1; j < w.length; j++) {
        var letter = w.charAt(j);
        if (spec.letters.indexOf(letter) >= 0) { seen.push({ option: letter }); continue; }
        if (spec.joinedLetters.indexOf(letter) >= 0) { seen.push({ option: letter }); break; }
        if (spec.operandLetters.indexOf(letter) >= 0) {
          seen.push({ option: letter });
          if (j === w.length - 1) i++;
          break;
        }
        return null;
      }
    }
    return seen;
  }

  // WHETHER date SETS NOTHING. An operand starting with `+` is a format to
  // show the date in; any other operand is a time to set. `-f` names the
  // format of a time to set. Either one is a read only after `-j`, and only a
  // `-j` met before the first operand counts: this Mac's getopt stops at the
  // first operand, so in `date 0101 -j` the `-j` is an operand and 0101 is
  // set. GNU's date refuses `-j` outright, so a line holding one sets nothing
  // there either.
  function dateOnlyReads(seen) {
    var noSet = false;
    for (var i = 0; i < seen.length && !('operand' in seen[i]); i++) {
      if (seen[i].option === 'j') noSet = true;
    }
    var sets = false;
    for (var k = 0; k < seen.length; k++) {
      if (seen[k].option === 'f') sets = true;
      if ('operand' in seen[k] && seen[k].operand.charAt(0) !== '+') sets = true;
    }
    return noSet || !sets;
  }

  // THE WORDS THE PROGRAM IS HANDED, read from the text as the shell reads
  // them, or null when the text holds anything whose result the text alone
  // does not show. Every command whose options are judged is judged on these
  // words (optionsOnlyRead below), never on the text as it is written. Only a
  // space or a tab ends a word, as in bash. Quotes and backslashes are taken
  // away, so `'-o'`, `"-o"`, `\-o` and `-'o'` are all the `-o` the program is
  // given. Not followed at all: a `$` or a backtick
  // (unquoted or inside double quotes), `$'…'`, a glob, a brace, a bracket, a
  // redirection, a quote left open, a backslash with nothing after it, a
  // control character, and text longer than this reading follows. Each can
  // hand the program a word the text does not show, `-o` among them, so the
  // segment is not a read, and it asks.
  //
  // `asWrittenToo` (true for find, rg, tree and file, whose words are judged
  // as written as well, below) makes the only two exceptions to the plain set,
  // each for text those four always read: a wildcard that cannot start with a
  // dash (globCannotStartWithDash), and a `!` that is a word of its own, which
  // bash and zsh hand over as the text `!` after the command's name (find's
  // negation, `find . ! -name x`). A `!` beside other text still fails closed.
  var OPTIONS_READ_LIMIT = 8192;
  // Unquoted, only these are plain text in bash and in zsh alike.
  var PLAIN_WORD_CHAR = /^(?:[A-Za-z0-9_.\/:,=+%@~-]|[\p{L}\p{M}\p{N}])$/u;
  function shellWords(text, asWrittenToo) {
    var lenient = asWrittenToo === true;
    // UNREADABLE is the PowerShell reading's test, below: a control character,
    // a replacement character, or half a surrogate pair.
    if (text.length > OPTIONS_READ_LIMIT || UNREADABLE.test(text)) return null;
    var words = [];
    var word = '';
    var inWord = false;
    var first = '';
    var quote = '';
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quote === "'") { if (c === "'") quote = ''; else word += c; continue; }
      if (quote === '"') {
        if (c === '"') { quote = ''; continue; }
        if (c === '$' || c === '`') return null;
        if (c === '\\' && i + 1 < text.length && '$`"\\'.indexOf(text[i + 1]) >= 0) { word += text[++i]; continue; }
        word += c;
        continue;
      }
      if (c === ' ' || c === '\t') { if (inWord) words.push(word); word = ''; inWord = false; continue; }
      if (!inWord) first = c;
      inWord = true;
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '\\') {
        if (i + 1 >= text.length) return null;
        word += text[++i];
        continue;
      }
      // A `!` standing alone as a word, find's negation, is plain text to bash
      // and zsh anywhere after the command's own name.
      if (lenient && c === '!' && !word && /^[ \t]?$/.test(text.charAt(i + 1))) { word += c; continue; }
      if (lenient && GLOB_CHAR.test(c) && globCannotStartWithDash(first)) { word += c; continue; }
      if (!PLAIN_WORD_CHAR.test(c)) return null;
      word += c;
    }
    if (quote) return null;
    if (inWord) words.push(word);
    return words;
  }

  // A WILDCARD THAT CANNOT START WITH A DASH. The shell swaps an unquoted word
  // holding `*`, `?` or `[` for the names of the files it matches, and a name
  // can begin with `-`, so `rg x *` may hand rg `--pre` if a file is named
  // that. A word whose first character, as written, is a plain character
  // other than `-` keeps that character in every name it expands to (`src/*.js`
  // is `src/` and more, `./*` is `./` and more), so none of them is an option.
  // Any other first character asks: a wildcard itself (`*.md`, `?pre*`), a
  // bracket (`[-]*`), a quote or a backslash. One rule for find, rg, tree and
  // file; a `$`, a backtick or an open quote anywhere still asks.
  var GLOB_CHAR = /^[*?[\]]$/;
  function globCannotStartWithDash(first) {
    return first !== '-' && PLAIN_WORD_CHAR.test(first);
  }

  // A FAILURE INSIDE THIS READING IS AN ANSWER, as it is in the PowerShell
  // reading: not a read, so the command cards. A test forces one through this
  // seam; what it returns is ignored, so all it can do is fail.
  var optionReadingSeam = { beforeReading: function () {} };

  // A BLANK BASH DOES NOT SPLIT ON. JavaScript's `\s` takes a form feed, a
  // vertical tab, a carriage return and the Unicode spaces (U+00A0, U+2000 to
  // U+200A, U+3000 and the rest) for a space, and bash takes none of them for
  // one. Split by `\s`, `sort -t<form feed> -o out in` reads as `-t -o out in`,
  // `-t` given `-o`, while sort is handed `-t` with the form feed and then
  // `-o out`, and writes `out`. So one anywhere in the segment, quoted or not,
  // means it is not a read.
  var NOT_A_WORD_BREAK = /[^\S \t]/;

  // The text after the first `count` words, words ending at a space or a tab.
  function textAfterWords(text, count) {
    var i = 0;
    var blank = function (c) { return c === ' ' || c === '\t'; };
    while (i < text.length && blank(text[i])) i++;
    for (var k = 0; k < count; k++) {
      while (i < text.length && !blank(text[i])) i++;
      while (i < text.length && blank(text[i])) i++;
    }
    return text.slice(i);
  }

  // READ BOTH WAYS. find, rg, tree and file were judged on their words as
  // written, split at blanks with quotes and backslashes left in, and they
  // still are, as well as on the words the shell hands them: a segment reads
  // only when both readings say it reads. The shell's reading finds an option
  // the text hides (`'-o'`, `\-o`); the written one keeps asking wherever it
  // always asked, at option-like text inside a quoted operand (`find . -name
  // 'a -delete'`, `rg "x --pre" .`) or an option split across quotes where
  // its list does not hold the pieces (`find . -na'me' x`). So no segment of
  // these reads that did not read before.
  var AS_WRITTEN_TOO = ['find', 'rg', 'tree', 'file'];
  function wordsAsWritten(text, skip) {
    return String(text).split(/\s+/).filter(Boolean).slice(skip);
  }

  // One command whose options are judged (OPTION_RULES below), judged from the
  // segment's own text, never from words split some other way: the words the
  // shell hands the program after the first `skip` (any keyword before the
  // command, and the command), then the command's own rule over them. A
  // segment whose words the text alone does not show is not a read.
  function optionsOnlyRead(command, segment, skip) {
    try {
      optionReadingSeam.beforeReading(command);
      var text = String(segment);
      if (NOT_A_WORD_BREAK.test(text)) return false;
      var asWrittenToo = AS_WRITTEN_TOO.indexOf(command) >= 0;
      var words = shellWords(textAfterWords(text, skip), asWrittenToo);
      if (!words) return false;
      if (OPTION_RULES[command](words) !== true) return false;
      return !asWrittenToo || OPTION_RULES[command](wordsAsWritten(text, skip)) === true;
    } catch (failed) {
      return false;
    }
  }

  // `rg --pre <command>` runs an arbitrary preprocessor over every file it
  // searches. Named rather than inverted because ripgrep's surface is small
  // and stable, and because only this one flag executes anything.
  var EXECUTING_FLAGS = { rg: { letters: '', long: ['--pre'] } };

  // Two listed programs also WRITE a file they are given, with no redirect on
  // the line: `tree -o FILE` sends its listing there (alone or in a bundle such
  // as `-ao`), and `file -C` compiles a magic file. Either makes the segment
  // not a read. Named for the same reason as the flag above: each program has
  // exactly one such option.
  var WRITING_FLAGS = { tree: { letters: 'o', long: [] }, file: { letters: 'C', long: ['--compile'] } };

  // WHETHER A WORD IS ONE OF THESE OPTIONS, judged as the shell hands the word
  // over (shellWords), so a quoted or escaped option is the option. A short
  // one counts alone, with a value joined (`-oFILE`) or anywhere in a bundle
  // of letters (`-ao`). A long one counts alone, with a value joined
  // (`--pre=sh`), cut short as getopt_long takes any unique start of a name
  // (`file --comp` compiles), or followed by more than a letter or a digit
  // (`--pre-glob`, which asks as it always has).
  function namesOption(w, spec) {
    if (w.charAt(0) !== '-') return false;
    if (w.charAt(1) === '-') {
      var name = w.split('=')[0];
      return name.length > 2 && spec.long.some(function (o) {
        return o.indexOf(name) === 0 || (name.indexOf(o) === 0 && !/\w/.test(name.charAt(o.length)));
      });
    }
    for (var j = 1; j < w.length && /[A-Za-z]/.test(w.charAt(j)); j++) {
      if (spec.letters.indexOf(w.charAt(j)) >= 0) return true;
    }
    return false;
  }
  // Every word is judged wherever it stands, an operand's place included, as
  // the raw text was: the program may read an option after a file.
  function namesNoOption(spec) {
    return function (words) {
      return !words.some(function (w) { return namesOption(w, spec); });
    };
  }

  // EVERY COMMAND WHOSE OPTIONS ARE JUDGED, and the rule it is judged by,
  // given the words the shell hands it. `find`, `sort` and `date` read only
  // with options from their lists; `rg`, `tree` and `file` read unless an
  // option that runs or writes is among their words.
  var OPTION_RULES = {
    find: findOnlyReads,
    sort: function (words) { return optionsAndOperands(words, SORT_OPTIONS) !== null; },
    date: function (words) {
      var seen = optionsAndOperands(words, DATE_OPTIONS);
      return seen !== null && dateOnlyReads(seen);
    },
    rg: namesNoOption(EXECUTING_FLAGS.rg),
    tree: namesNoOption(WRITING_FLAGS.tree),
    file: namesNoOption(WRITING_FLAGS.file),
  };
  function judgesOptions(command) {
    return Object.prototype.hasOwnProperty.call(OPTION_RULES, command);
  }

  // Whether one segment's leading command only reads. An empty segment (a
  // trailing separator) carries nothing to disqualify it.
  //
  // After a package runner ONLY the pair registry answers. A runner fetches
  // and executes whatever package it is pointed at, and a package that happens
  // to share a name with a read-only builtin is not that builtin, so `npx cat`
  // is not `cat`.
  function segmentReads(segment) {
    var words = String(segment).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    // SHELL KEYWORDS ARE NOT COMMANDS, and the two kinds are not interchangeable.
    //
    // The segmenter splits on `;` and `&&`, so a loop arrives as `for f in a b`,
    // `do cat "$f"`, `done`. None of those first words is a command name, so
    // every loop graded as a write, however harmless its body. Reported from the
    // field twice: an agent surveying a workspace loops over its agent and skill
    // files, and a loop that only `cat`s them was carded as wanting to CHANGE
    // the file it was reading.
    //
    // The distinction below is the whole safety of this. A PREFIX keyword is
    // followed by a real command, so it is stripped and what follows is judged:
    // `do cat "$f"` reads, `do rm -rf x` does not, and `then rm y` must never
    // qualify just because `then` is harmless. A keyword whose remainder is NOT
    // a command (`for f in ...`, `case $x in`) reaches no file itself, so the
    // segment qualifies; any path in its word list is still scanned for
    // crossings by the caller, which is a separate question from this one.
    var stripped = 0;
    while (words.length && KEYWORD_PREFIXES.indexOf(bareWord(words[0])) >= 0) { words.shift(); stripped++; }
    // `done`, `fi`, `esac`, or a bare `do`: nothing left to reach a file with.
    if (!words.length) return stripped > 0;
    var first = bareWord(words[0]);
    if (NON_COMMAND_KEYWORDS.indexOf(first) >= 0) return true;
    if (judgesOptions(first)) return optionsOnlyRead(first, segment, stripped + 1);
    if (POWERSHELL_ONLY_READS.indexOf(first.toLowerCase()) >= 0) return false;
    if (READ_ONLY_SHELL_COMMANDS.indexOf(first) >= 0) return true;
    if (NO_TARGET_COMMANDS.indexOf(first) >= 0) return true;
    if (READ_ONLY_POWERSHELL_COMMANDS.indexOf(first.toLowerCase()) >= 0) return true;
    return false;
  }

  // Structure this module cannot see into. `$(...)`, a backtick, and process
  // substitution all run an inner command the segmenter never examines, so
  // `cd $(rm -rf ~/.claude/agents/x)` reads as a bare `cd` and the removal
  // rides in unseen.
  //
  // THIS BELONGS IN THE SHARED DEFINITION, not beside one caller. The card
  // grader had this test and the hook never did, so the same text was read as
  // hiding nothing by the layer that exempts a crossing under the runtime's
  // own home and as hiding something by the layer that only draws a card. One
  // definition of a read has to carry the reason a read cannot be trusted.
  var HIDES_SUBCOMMAND = /\$\(|`|<\(|>\(/;

  // Whether a segment runs a command whose options are judged, past any
  // keyword before it. The hook asks this of each segment it reads for what
  // writes an answer file, so it judges those from the segment's own text too.
  function leadsJudgedOptions(segment) {
    var words = String(segment).split(/\s+/).filter(Boolean);
    while (words.length && KEYWORD_PREFIXES.indexOf(bareWord(words[0])) >= 0) words.shift();
    return words.length > 0 && judgesOptions(bareWord(words[0]));
  }

  // A CARRIAGE RETURN ENDS A SEGMENT HERE AND ENDS NOTHING IN BASH, which
  // takes it as part of a word. So the words after one would be judged as a
  // command of their own: `sort -t<CR>cat -o out in` is one sort, handed `-t`
  // and then `-o out`, and it writes `out`, and `rg -e <CR>cat --pre sh x` is
  // one rg, handed `--pre sh`. Whether the text holds one and a command whose
  // options are judged: such a line is not a read, here and wherever else the
  // hook reads its segments one by one.
  function carriageReturnSplitsJudgedOptions(text) {
    var str = String(text);
    return str.indexOf('\r') >= 0 && shellSplits(str).some(leadsJudgedOptions);
  }

  // Only text is read. Anything else is not a command this can judge, so it
  // is not a read, and turning it into text first could throw.
  function isReadOnlyShellCommand(command) {
    if (typeof command !== 'string') return false;
    var str = String(command).replace(DISCARDING_REDIRECT_RE, ' ');
    if (/>>?|\btee\b/.test(str)) return false;
    if (HIDES_SUBCOMMAND.test(str)) return false;
    // A line whose quotes the shells read differently, or one this reading
    // cannot follow to its end, is not a read; nor is one holding a `(` or a
    // `)` outside its quotes (shellView, above).
    var view = shellView(str);
    if (!view.ok || view.parens) return false;
    if (carriageReturnSplitsJudgedOptions(str)) return false;
    // SPLIT AS WRITTEN TOO, with each quote taken as written and a backslash
    // as text, as every line was split before, as well as the way the shell
    // splits it. The two differ only after a backslash before a quote or a
    // separator: as written, an escaped quote opens a quote, and inside double
    // quotes `\"` closes one. A line reads only when every piece of both splits
    // reads, so `grep "a\"; rm x" f`, split as written at its `;`, asks as it
    // always has.
    var segments = shellSplits(str);
    return segments.length > 0 && segments.every(segmentReads);
  }

  // ── PowerShell's own reading ──────────────────────────────────────────
  // What makes a PowerShell read is set out beside its list, above. This
  // reading notices each way PowerShell text can run a second command, and
  // stops there: it never tries to judge what a construct would run.

  // The longest command this reading follows. Longer text is not read at all.
  var POWERSHELL_READ_LIMIT = 8192;
  // Text that cannot be read with confidence: a control character other than
  // a tab or a line break, a replacement character, or half a surrogate pair.
  var UNREADABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f�]|[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;
  // Outside plain ASCII only letters, marks and digits are plain text.
  // PowerShell takes some other characters as a quote, a dash or a space (a
  // curly quote closes a string), and this reading would not see them as one.
  var NOT_PLAIN = /[^\u0000-\u007f\p{L}\p{M}\p{N}]/u;
  // A redirection that writes no file: output thrown away at `$null`, or one
  // stream sent into another (`2>&1`).
  var POWERSHELL_DISCARD = /^&[1-6]|^[ \t]*\$null(?![^\s;|&])/i;

  // The name each part of the command starts with. Null when the text holds
  // something this reading does not follow, and a throw when the text cannot
  // be read to its end at all.
  function powerShellPartNames(command) {
    var text = String(command);
    if (text.length > POWERSHELL_READ_LIMIT) throw new Error('longer than this reading follows');
    if (UNREADABLE.test(text)) throw new Error('a character this reading cannot read');
    var plain = !NOT_PLAIN.test(text);
    var names = [];
    var words = [];
    var word = '';
    var quote = '';
    var open = [];
    var endWord = function () { if (word) words.push(word); word = ''; };
    var endPart = function () { endWord(); if (words.length) names.push(words[0]); words = []; };
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      // An escape: what follows a backtick is not what it looks like.
      if (c === '`') {
        if (i === text.length - 1) throw new Error('a backtick with nothing after it');
        plain = false; word += c + text[++i]; continue;
      }
      if (quote === "'") { word += c; if (c === "'") quote = ''; continue; }
      if (quote === '"') {
        word += c;
        if (c === '"') quote = '';
        else if (c === '$' && text[i + 1] === '(') plain = false;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; word += c; continue; }
      if (c === '(') { open.push(')'); plain = false; word += c; continue; }
      if (c === '{') { open.push('}'); plain = false; word += c; continue; }
      if (c === ')' || c === '}') {
        if (open.pop() !== c) throw new Error('a bracket closed that was never opened');
        word += c; continue;
      }
      // A here-string, an array or hash literal, or splatting.
      if (c === '@') { plain = false; word += c; continue; }
      // A comment, whose quotes are not quotes.
      if (c === '#') { plain = false; word += c; continue; }
      // The stop-parsing token, after which quotes are not quotes either.
      if (c === '-' && text.substr(i, 3) === '--%') { plain = false; word += c; continue; }
      if (c === '>') {
        endWord();
        if (text[i + 1] === '>') i++;
        var discard = POWERSHELL_DISCARD.exec(text.slice(i + 1));
        if (discard) i += discard[0].length;
        else plain = false;
        continue;
      }
      // `&&` joins two parts. A lone `&` calls what follows or runs it in the
      // background.
      if (c === '&') {
        if (text[i + 1] === '&') { i++; endPart(); continue; }
        plain = false; word += c; continue;
      }
      if (c === '|') { if (text[i + 1] === '|') i++; endPart(); continue; }
      if (c === ';' || c === '\n' || c === '\r') { endPart(); continue; }
      if (c === ' ' || c === '\t') { endWord(); continue; }
      word += c;
    }
    if (quote) throw new Error('a quote left open');
    if (open.length) throw new Error('a bracket left open');
    endPart();
    return plain ? names : null;
  }

  // A FAILURE INSIDE THE READING IS AN ANSWER: not a read, so the command
  // cards and nothing is allowed on its behalf. A test forces one through
  // this seam. What it returns is ignored, so all it can do is fail.
  var powerShellReadingSeam = { beforeReading: function () {} };

  function isReadOnlyPowerShellCommand(command) {
    try {
      powerShellReadingSeam.beforeReading(command);
      var names = powerShellPartNames(command);
      if (!names || !names.length) return false;
      for (var i = 0; i < names.length; i++) {
        if (READ_ONLY_POWERSHELL_COMMANDS.indexOf(names[i].toLowerCase()) < 0) return false;
      }
      return true;
    } catch (unreadable) {
      return false;
    }
  }

  // ── The other end of the same question ────────────────────────────────
  // A command that destroys, escalates, or fetches-and-executes. This lived
  // only in the card grader, where its single job was to colour a card red.
  //
  // WHY IT HAD TO MOVE. Code mode auto-approves anything that is not outside
  // the workspace and not an answer file, and that branch never consulted this
  // test, because this test was in the browser and the branch is in the hook.
  // So `rm -rf <anywhere inside>` was approved in Code mode with no card drawn
  // and no record of a decision, while the same text in Notes mode drew a
  // card the grader had painted high-risk. The grader was describing a card
  // that the decider had already chosen not to raise.
  //
  // It is the shared definition for exactly the reason the read-only test above
  // is: two places answering one question about the same text is how they come
  // to disagree, and the reader pays for the disagreement.
  //
  // ERRING TOWARD ASKING IS CORRECT HERE. Naive splitting can over-flag an
  // operator inside a quoted string; the cost of that is one card, and the cost
  // of the other direction is an unasked question about an irreversible act.
  var DESTRUCTIVE_LEADING = /^(rm|sudo|chmod|chown|kill|mkfs|dd)/;
  function isDestructiveShellCommand(command) {
    var raw = String(command == null ? '' : command).trim();
    // A redirection that discards output writes nothing, so it must not make a
    // command read as destructive.
    var cmd = raw.replace(DISCARDING_REDIRECT_RE, ' ').trim();
    if (!cmd) return false;
    if (/--force|--hard|-rf\b/.test(cmd)) return true;
    if (/git\s+(push|reset|clean|checkout\s+\.)/.test(cmd)) return true;
    if (/\b(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh|dash)\b/.test(cmd)) return true;
    // `find` reads until it runs something or deletes: -exec/-execdir/-ok spawn
    // an arbitrary command per match and -delete removes files, so a bare find
    // leading segment must not shield these.
    if (/\bfind\b[\s\S]*-(exec(dir)?|delete|ok(dir)?)\b/.test(cmd)) return true;
    // macOS's launch services: these change what every program started from
    // now on inherits, Rundock included, or start one under launchd, so they
    // are graded like an irreversible act, wherever they sit in the line.
    if (/\blaunchctl\s+(setenv|unsetenv|load|bootstrap|submit|config)\b/i.test(cmd)) return true;
    // Both splits, so a segment that leads with a delete in either is one.
    var segments = shellSplits(cmd);
    for (var i = 0; i < segments.length; i++) {
      if (DESTRUCTIVE_LEADING.test(segments[i].trim())) return true;
      if (launchctlUnspelled(segments[i])) return true;
    }
    return false;
  }
  // launchctl leading a segment with no subcommand (it reads them from
  // standard input, so `echo setenv X 1 | launchctl` changes what it likes)
  // or with one only the shell fills in (`launchctl $SUB X 1`, a quoted or
  // substituted word): what it would change is not on the line.
  function launchctlUnspelled(segment) {
    var words = String(segment).trim().split(/\s+/).filter(Boolean);
    if (!words.length || bareWord(words[0]) !== 'launchctl') return false;
    return words.length === 1 || /^["'$`\\]/.test(words[1]);
  }

  // A COPY OF EVERY OPTION THIS MODULE JUDGES BY NAME, for the test that asks
  // each one the same question in every spelling the shell reads as it. A
  // copy, so a test can read the lists and cannot change them.
  function namedOptions() {
    return JSON.parse(JSON.stringify({
      find: {
        noOperand: FIND_READ_FLAGS_NO_OPERAND, oneOperand: FIND_READ_FLAGS_ONE_OPERAND,
        newerFamily: { source: FIND_NEWER_FAMILY.source, flags: FIND_NEWER_FAMILY.flags },
      },
      sort: SORT_OPTIONS, date: DATE_OPTIONS, rg: EXECUTING_FLAGS.rg, tree: WRITING_FLAGS.tree, file: WRITING_FLAGS.file,
    }));
  }

  // Only what a caller actually uses. The registries stay private: exporting
  // them invites a second place to reason about membership, which is the
  // shape this module exists to remove, so a test that reads the named
  // options gets a copy (namedOptions). The seams are exported for the tests
  // that force a failure inside the PowerShell reading and inside the reading
  // of options, and the word reader for the test that asks it about text the
  // line's own checks already refuse. The carriage-return rule, and which
  // segments have their options judged, are exported for the hook, which
  // reads a command's segments one by one for what they write, so that it
  // asks the same rules rather than keeping copies.
  return {
    DISCARDING_REDIRECT_RE, shellSegments, shellSplits, shellView, isReadOnlyShellCommand, isReadOnlyPowerShellCommand,
    isDestructiveShellCommand, powerShellReadingSeam, optionReadingSeam, shellViewSeam, carriageReturnSplitsJudgedOptions,
    leadsJudgedOptions, shellWords, namedOptions,
  };
}));
