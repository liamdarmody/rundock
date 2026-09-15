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
  ];

  // THE ONE ADDITION. A line is judged segment by segment and fails as a whole
  // if any segment does not qualify, so a leading directory change disqualified
  // commands that went on to do nothing at all. `cd` reaches no file, so there
  // is nothing for it to write.
  //
  // The card grader also recognised `date`, `diff`, `printenv`, `pushd`,
  // `popd`, `sort`, `true`, `uniq`, `which` and `whoami`, and those are NOT
  // carried across. Two of them are why: `sort -o FILE` and
  // `uniq INPUT OUTPUT` write a file with no redirection character anywhere on
  // the line, so shared into the boundary layer unqualified they would have
  // graded a write into a persistence surface as a read and exempted it from
  // its crossing. The rest cannot write, and are still left out, because
  // restoring them to the grader's auto-allow set is a widening that should be
  // judged on its own evidence rather than ride in on a change about sharing.
  var NO_TARGET_COMMANDS = ['cd'];

  // `env` IS DELIBERATELY ABSENT, though it prints the environment and looks
  // like a read. It also runs whatever follows its assignments, so
  // `env FOO=1 rm notes.md` is a removal wearing a read's leading word, and a
  // registry consulted by the boundary layer cannot afford to carry that.
  //
  // `node` and `python` are absent for the same reason and one more: `node -e`
  // and `python -c` are arbitrary code execution rather than reads, so a
  // fs.rmSync payload, or a fetch that sends a file somewhere, would run with
  // no card at all. They ask, exactly as `node script.js` already does.

  // THE SAME REGISTRY FOR THE OTHER SHELL, because Windows is one of the two
  // platforms this product builds for and its agents do not write `ls`.
  //
  // Enumerated rather than matched by verb. `Get-*` is read-shaped by
  // PowerShell's own convention, and this registry frees a crossing into the
  // runtime's own home, so it names the cmdlets actually seen rather than
  // trusting a naming convention to hold for every cmdlet anyone ever writes.
  // Compared case-insensitively because PowerShell is; the list above is not,
  // because its shells are not.
  var READ_ONLY_POWERSHELL_COMMANDS = [
    'get-childitem', 'gci', 'dir', 'ls', 'get-content', 'gc', 'cat', 'type',
    'get-item', 'gi', 'get-location', 'gl', 'pwd', 'test-path', 'resolve-path',
    'split-path', 'select-string', 'sls', 'measure-object', 'select-object',
    'sort-object', 'format-table', 'format-list', 'out-string', 'write-output',
    'write-host', 'echo',
  ];

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
  var DISCARDING_REDIRECT_RE = /\d*>>?\s*(?:\/dev\/null|&\s*\d+)/g;

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
  function shellSegments(command) {
    var segments = [];
    var cur = '';
    var quote = null;
    var str = String(command);
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
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

  // A word that does not begin with `-` is a path, a pattern, a number or one
  // of find's grouping tokens, and none of those is a flag to judge.
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

  // `rg --pre <command>` runs an arbitrary preprocessor over every file it
  // searches. Named rather than inverted because ripgrep's surface is small
  // and stable, and because only this one flag executes anything.
  var EXECUTING_FLAGS = { rg: /(^|\s)--pre\b/ };

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
    var first = bareWord(words[0]);
    if (first === 'find') return findOnlyReads(words.slice(1));
    if (Object.prototype.hasOwnProperty.call(EXECUTING_FLAGS, first)
      && EXECUTING_FLAGS[first].test(segment)) return false;
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

  function isReadOnlyShellCommand(command) {
    var str = String(command).replace(DISCARDING_REDIRECT_RE, ' ');
    if (/>>?|\btee\b/.test(str)) return false;
    if (HIDES_SUBCOMMAND.test(str)) return false;
    var segments = shellSegments(str);
    return segments.length > 0 && segments.every(segmentReads);
  }

  // Only what a caller actually uses. The registries stay private: exporting
  // them invites a second place to reason about membership, which is the
  // shape this module exists to remove.
  return { DISCARDING_REDIRECT_RE, shellSegments, isReadOnlyShellCommand };
}));
