'use strict';
// A QUOTE CHARACTER THAT OPENS NOTHING IN BASH HIDES NO COMMAND.
//
// Every reading of a line pairs quote characters to find its quotes. Bash has
// quote characters that open nothing: one in a comment, one escaped inside
// `$'…'`, one in a here-document's body, and the quotes inside a substitution
// held in double quotes, which start afresh. Paired with a later quote, each
// hid the commands after it, and a line that copies over the runtime's
// settings read as a listing. shellView (public/read-only-shell.js) is the
// line with each of them made a space, and every reading reads it as well as
// the line. These tests hold the shared definition and the card grader to it;
// test/unit/shell-view-hook.test.js holds the real hook, in both modes.
//
// Each line here was run through bash 3.2 and zsh 5.9 with a harmless `echo`
// in place of the copy, and each shell ran the command these tests say runs.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const S = require('../../public/read-only-shell.js');
const P = require('../../public/permissions.js');

const T = '~/.claude/settings.json';
const risk = (command) => P.classifyRisk('Bash', { command });
const show = (cmd) => JSON.stringify(cmd.length > 90 ? cmd.slice(0, 90) + '...' : cmd);
function assertAsks(cmd) {
  assert.strictEqual(S.isReadOnlyShellCommand(cmd), false, `not a read: ${show(cmd)}`);
  assert.notStrictEqual(risk(cmd), 'low', `and it asks: ${show(cmd)}`);
}
function assertReads(cmd) {
  assert.strictEqual(S.isReadOnlyShellCommand(cmd), true, `a read: ${show(cmd)}`);
  assert.strictEqual(risk(cmd), 'low', `and it runs with no card: ${show(cmd)}`);
}

// Each hidden line, as bash runs it: a listing, then the copy, and the plain
// line it is the same as.
const HIDDEN = [
  ['an escaped quote inside $\'…\'', `ls $'\\''; cp x ${T}`],
  ['an escaped quote inside $\'…\', on lines of their own', `ls $'\\''\ncp x ${T}\nls $'\\''`],
  ['a quote in a comment', `ls # it's\ncp x ${T}\nls # '`],
  ['a quote in a here-document\'s body', `cat <<EOF\n'\nEOF\ncp x ${T}\necho "'"`],
  ['a quote in a quoted here-document\'s body', `cat <<'EOF'\nit's\nEOF\ncp x ${T}\necho "'"`],
  ['quotes inside a substitution in double quotes', `echo "$(echo "'")"\ncp x ${T}\necho "$(echo "'")"`],
  ['quotes inside a backtick in double quotes', `echo "\`echo "'"\`"\ncp x ${T}\necho "\`echo "'"\`"`],
];

describe('the view is the line with each quote that opens nothing made a space', () => {
  test('one character for one, so every offset into the line holds', () => {
    for (const [, line] of HIDDEN) assert.strictEqual(S.shellView(line).text.length, line.length, show(line));
  });

  test('each quote character that opens nothing, and only those', () => {
    const cases = [
      ["ls $'\\''; cp x y", "ls $'\\ '; cp x y"],
      ["ls # it's\ncp x y", 'ls # it s\ncp x y'],
      ['ls # $(x) `y` {z} <<EOF\ncp x y', 'ls #   x   y   z    EOF\ncp x y'],
      ["cat <<EOF\nit's $(echo \"a\") (b)\nEOF\nls", 'cat <<EOF\nit s $(echo "a")  b \nEOF\nls'],
      ["cat <<'EOF'\nit's $(echo \"a\")\nEOF\nls", "cat <<'EOF'\nit s   echo  a  \nEOF\nls"],
      ['ls \\"; cp x y', 'ls \\ ; cp x y'],
      ['echo "$(echo "a b")" it', 'echo  $(echo "a b")  it'],
      ['echo "it\'s $(date)"', 'echo  it s $(date) '],
    ];
    for (const [line, view] of cases) {
      assert.strictEqual(S.shellView(line).text, view, show(line));
      assert.strictEqual(S.shellView(line).ok, true, show(line));
    }
  });

  test('a line with none of them is its own view', () => {
    for (const line of ['ls -la', "grep -rn \"it's\" notes", "rg -n 'TODO' notes", "echo $'a\\tb'", 'echo "$HOME"',
      "find . -name '*.md' -type f", "echo 'it''s'", 'cat notes/todo.md', "git log --format='%h %s'", 'echo "${x:-"a b"}"']) {
      assert.strictEqual(S.shellView(line).text, line, show(line));
      assert.strictEqual(S.shellView(line).ok, true, show(line));
    }
  });

  test('a # inside a word, after a redirection or escaped starts no comment, as in bash', () => {
    for (const line of ["echo a#b it's\ncp x y\necho '", "echo $# it's\ncp x y\necho '", "echo ${#x} it's\ncp x y\necho '",
      "echo $((16#ff)) it's\ncp x y\necho '", "echo \\# it's\ncp x y\necho '", "cat <#x it's\ncp x y\necho '",
      "{# it's\ncp x y\necho '", "echo A\\\n#x it's\ncp x y\necho '"]) {
      assert.strictEqual(S.shellView(line).text, line, `no comment, so its quote is a quote: ${show(line)}`);
    }
  });

  test('a # after a blank, a line break or an operator starts one, as in bash and zsh', () => {
    for (const lead of ['ls ', 'ls\t', 'ls;', 'ls&&', 'false||', 'ls&', 'ls|', '(', '(ls)', 'x=1 ', 'ls \\\n']) {
      const line = `${lead}# it's\ncp x y`;
      assert.ok(!S.shellView(line).text.includes("'"), `a comment: ${show(line)}`);
    }
  });
});

describe('a line whose quote opened nothing reads as bash runs it', () => {
  test('each hidden copy over the settings is not a read, and asks', () => {
    for (const [name, line] of HIDDEN) {
      assert.strictEqual(S.isReadOnlyShellCommand(line), false, `${name}: ${show(line)}`);
      assert.notStrictEqual(risk(line), 'low', `${name} asks: ${show(line)}`);
    }
  });

  test('a removal hidden behind $\'…\' is not a read and is graded high, as the plain one is', () => {
    const hidden = "echo $'\\''; rm -rf notes; echo $'\\''";
    assertAsks(hidden);
    assert.strictEqual(risk(hidden), 'high');
    assert.strictEqual(risk('rm -rf notes'), 'high');
  });

  test('a removal hidden behind quotes inside a substitution is graded high', () => {
    const hidden = 'echo "$(echo "\'")"\nrm notes/todo.md\necho "$(echo "\'")"';
    assert.strictEqual(risk(hidden), 'high', show(hidden));
    assert.strictEqual(S.isDestructiveShellCommand(hidden), true);
  });

  test('a removal hidden behind a comment\'s quote is graded high', () => {
    const hidden = "ls # it's\nrm notes/todo.md\nls # '";
    assert.strictEqual(risk(hidden), 'high', show(hidden));
  });
});

describe('where the shells read a quote differently, or the reading cannot finish, the line is not a read', () => {
  test('a quote, $\'…\', substitution or here-document never closed', () => {
    for (const line of ["ls 'x", 'ls "x', "ls $'x", 'ls $(x', 'ls `x', 'ls ${x', 'cat <<EOF\nbody', "ls $'\\'"]) {
      assert.strictEqual(S.shellView(line).ok, false, show(line));
      assertAsks(line);
    }
  });

  test('a single quote inside ${…} within double quotes: bash 3.2 takes it as a quote, zsh as text', () => {
    for (const line of [`echo "\${x:-'}"\ncp x ${T}\necho "'}"`, `echo "\${x:-'a'}"`]) {
      assert.strictEqual(S.shellView(line).ok, false, show(line));
      assertAsks(line);
    }
  });

  test('substitutions nested deeper than the reading follows', () => {
    const nested = (n) => 'echo ' + '$('.repeat(n) + 'ls' + ')'.repeat(n);
    assert.strictEqual(S.shellView(nested(8)).ok, true, 'eight deep is followed');
    assert.strictEqual(S.shellView(nested(40)).ok, false, 'forty deep is not');
    assert.strictEqual(S.shellView(nested(20000)).ok, false, 'and twenty thousand deep is an answer, not a crash');
    assert.strictEqual(S.shellView(nested(8)).wordParen, false, 'what it follows holds no ( inside a word');
    for (const n of [40, 20000]) assert.strictEqual(S.shellView(nested(n)).wordParen, true, `what it never read may hold one: ${n} deep`);
    const ticked = (n) => 'echo ' + '$('.repeat(n) + '`ls`' + ')'.repeat(n);
    assert.strictEqual(S.shellView(ticked(31)).wordParen, false, 'a backtick it follows holds none');
    assert.strictEqual(S.shellView(ticked(32)).wordParen, true, 'one it never read may hold one');
  });

  test('a case inside $( ), whose pattern\'s ) bash 3.2 takes as its end', () => {
    assert.strictEqual(S.shellView('echo "$(case x in x) echo y;; esac)"').ok, false);
  });

  test('a here-document in $( ) that bash 3.2 ends at a ) in its body', () => {
    const line = "echo \"$(cat <<'EOF'\n)$(cp x ~/.claude/settings.json)\nEOF\n)\"";
    assert.strictEqual(S.shellView(line).ok, false, show(line));
    // The common shape, a message whose quote bash 3.2 cannot close, is read.
    for (const ok of ["git commit -m \"$(cat <<'EOF'\nFix the reader, it's quoted\nEOF\n)\"",
      "git commit -m \"$(cat <<'EOF'\nFix the reader (both readings)\nEOF\n)\""]) {
      assert.strictEqual(S.shellView(ok).ok, true, show(ok));
    }
  });
});

describe('a ( or ) outside every quote runs a command behind a leading word that reads', () => {
  test('zsh\'s glob qualifiers and =( ), and a case pattern, are not reads', () => {
    for (const line of [`ls *(e:'cp a ${T}':)`, 'ls x(+f)', `cat =(cp a ${T})`, `case x in x) cp a ${T};; esac`,
      `case x in (x) cp a ${T};; esac`, `case y in \\') cp a ${T};; esac`]) {
      assert.strictEqual(S.shellView(line).parens, true, show(line));
      assertAsks(line);
    }
  });

  test('only a ( inside a word is one the Code-mode verdict does not model', () => {
    for (const line of [`ls *(e:'x':)`, 'ls x(+f)', 'cat =(ls)', 'ls !(*.md)']) assert.strictEqual(S.shellView(line).wordParen, true, show(line));
    for (const line of ['(cd x && ls)', 'files=(a b c)', 'a+=(d)', 'echo $(ls)', 'cat <(ls)', 'echo $((1+2))', 'ls \\(x\\)', "grep -c '(' x"]) {
      assert.strictEqual(S.shellView(line).wordParen, false, show(line));
    }
  });

  test('an escaped or quoted parenthesis is text, as it was', () => {
    for (const line of ['ls \\(x\\)', 'find . \\( -name a -o -name b \\)', "grep -c '(' x", 'echo "("']) assertReads(line);
  });
});

describe('the most common reads beside these lines still read', () => {
  test('comments, apostrophes in quotes, $\'…\' with an escape, and plain searches', () => {
    for (const line of ["grep -rn \"it's\" notes", 'ls # list the notes', "rg -n 'TODO' notes", "echo $'a\\tb'",
      "cat notes/todo.md # it's done", 'ls -la # what is here', "grep -n \"don't\" README.md", "echo 'it''s'",
      'rg -n "#[0-9]+" CHANGELOG.md', "find . -name '*.md'"]) {
      assertReads(line);
    }
  });
});

describe('a failure inside the view is an answer', () => {
  test('the line as given, not readable and marked, so nothing reads and the risk is not low', () => {
    const seam = S.shellViewSeam.beforeReading;
    S.shellViewSeam.beforeReading = () => { throw new Error('forced failure'); };
    try {
      assert.deepStrictEqual(S.shellView("ls # it's"), { text: "ls # it's", ok: false, parens: false, wordParen: true });
      for (const line of ['ls', 'cat notes/todo.md', "rg -n 'TODO' notes"]) assertAsks(line);
    } finally {
      S.shellViewSeam.beforeReading = seam;
    }
    assertReads('ls');
  });
});
