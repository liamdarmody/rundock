'use strict';
// EVERY WRITE TO A CHILD'S STDIN, AND WHERE THAT STDIN WAS GIVEN ITS HANDLER.
//
// A write to a child that has stopped fails asynchronously with EPIPE, and
// with no `error` listener on the stream that ends the server. Each child's
// stdin is given its handler once, where the child is started
// (lib/runtime/child-stdin.js), so no write site carries one of its own. That
// is only safe while every write goes to a child started on one of those
// paths, which is what this holds to the source.
//
// The exact inventory, read from every file the app loads. Each write is
// listed by its file, the function it is in and what it writes to, with where
// that child came from:
//   - `started here`: a variable this function set from spawnClaude;
//   - `an entry's process`: the process of a conversation entry, and every
//     entry is given its process from spawnClaude (checked below, for every
//     entry the app makes);
//   - `the app-server`: the Codex app-server, whose process is set in one
//     place, from the spawn that is guarded.
// Then the start paths themselves: spawnClaude and the app-server's spawn give
// the stdin its handler straight after the spawn, and nothing else does.
// A write added, moved or removed fails here until it is listed with its case.
//
// Bookkeeping only, read from the source and cheap on purpose: what a failed
// write does is driven in test/unit/child-stdin.test.js,
// test/unit/codex-appserver-stdin.test.js and
// test/integration/stopped-child-write.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// ── The inventory ──

const STARTED_HERE = 'started here';
const ENTRY = "an entry's process";
const APP_SERVER = 'the app-server';

const WRITES = [
  { at: 'server.js | message chat | existing.process.stdin.write', from: ENTRY, what: "a follow-up to the conversation's live process" },
  { at: 'server.js | message chat | proc.stdin.write #1', from: STARTED_HERE, what: 'the first message to a process started for it (interactive)' },
  { at: 'server.js | message chat | proc.stdin.write #2', from: STARTED_HERE, what: 'the message to a process started for it (legacy, one per message)' },
  { at: 'lib/delegation/engine.js | wireProcessHandlers | blockedEntry.process.stdin.write', from: ENTRY, what: 'the notice to a caller resumed after Rundock blocked its handoff' },
  { at: 'lib/delegation/engine.js | startWithoutSession | proc.stdin.write #1', from: STARTED_HERE, what: 'the prompt to an agent started fresh, its session gone' },
  { at: 'lib/delegation/engine.js | startWithoutSession | proc.stdin.write #2', from: STARTED_HERE, what: 'the messages carried over to that agent' },
  { at: 'lib/delegation/engine.js | handleScopeReturn | proc.stdin.write', from: STARTED_HERE, what: "the handback to the orchestrator started for a specialist's return" },
  { at: 'lib/delegation/engine.js | handleDelegation | delegateProc.stdin.write', from: STARTED_HERE, what: 'the brief to the agent delegated to' },
  { at: 'lib/delegation/engine.js | handleDelegation | orchestratorEntry.process.stdin.write', from: ENTRY, what: 'the result of an intercepted Agent call, to the orchestrator that made it' },
  { at: 'lib/delegation/engine.js | handleDelegation | resumeProc.stdin.write #1', from: STARTED_HERE, what: 'the resume prompt to the parent after its delegate finished' },
  { at: 'lib/delegation/engine.js | handleDelegation | resumeProc.stdin.write #2', from: STARTED_HERE, what: 'the completion prompt to that parent' },
  { at: 'lib/delegation/engine.js | handleDelegation | resumeProc.stdin.write #3', from: STARTED_HERE, what: 'the plain prompt to that parent' },
  { at: 'lib/delegation/engine.js | handleDelegation | orig.process.stdin.write', from: ENTRY, what: "the specialist's return, to the orchestrator still running" },
  { at: 'codex-appserver.js | _writeLine | proc.stdin.write', from: APP_SERVER, what: 'every request and notification to the Codex app-server' },
];

// Where a child's stdin is given its handler: straight after the spawn that
// starts it, in the one function each kind of child is started through.
const GUARDED_STARTS = [
  { file: 'lib/runtime/claude.js', fn: 'spawnClaude', spawn: 'spawn(resolveClaudeBin()', starts: 'every Claude agent process' },
  { file: 'codex-appserver.js', fn: '_spawn', spawn: 'spawn(this._binPath', starts: 'the Codex app-server' },
];

// Where a stand-in for a process that was never started is handed back in
// place of one, and guarded the same way, straight after it is made: a
// caller writes to it as to any process it was handed.
const GUARDED_STAND_INS = [
  { file: 'lib/runtime/claude.js', fn: 'spawnClaude', made: 'unstarted(refusal)', name: 'standIn', stands: 'a Claude Code below the version floor' },
];

// The two places that replace a stdin's write: the handler itself, and the
// answer-file guard, which wraps the write the handler has already wrapped.
const WRITE_WRAPPERS = ['lib/runtime/child-stdin.js | guardChildStdin', 'lib/runtime/claude-turn-guard.js | watchClaudeTurns'];

// ── Reading the source ──

// Every file the app loads, as the spawn inventory reads it
// (test/unit/unattended-spawn-paths.test.js).
function appFiles() {
  const out = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.add(p);
    }
  };
  for (const f of ['server.js', 'search.js', 'codex.js', 'codex-appserver.js', 'permission-routing.js']) out.add(path.join(ROOT, f));
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'electron'));
  const queue = [...out];
  while (queue.length) {
    const f = queue.shift();
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
      let r = path.resolve(path.dirname(f), m[1]);
      if (!r.endsWith('.js')) r += '.js';
      if (!fs.existsSync(r) || out.has(r) || !rel(r).startsWith('scripts/')) continue;
      out.add(r);
      queue.push(r);
    }
  }
  return [...out].sort();
}

// THE SOURCE AS THE SCANS READ IT, as two views of every line, each the same
// length as the line it came from, so a position or a line number in either
// means the same place in the file: `kept`, with every comment blanked; and
// `code`, with every string's, template's and regular expression's text
// blanked as well. The patterns run over `code`, so neither a comment nor
// text inside a string can be taken for a write or hide one; the function a
// line is in is read from `kept`, because the message handler is named by a
// string ('chat').
//
// Read by one pass over the characters, which knows where each comment,
// string, template and regular expression starts and ends, rather than by
// cutting each line at its first `//`: a line cut that way loses everything
// after a URL in a string. A `/` starts a regular expression where an operand
// is expected, and divides where one has just ended.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
function sourceViews(text) {
  const kept = text.split('');
  const code = text.split('');
  const n = text.length;
  const blankBoth = (k) => { if (text[k] !== '\n') { kept[k] = ' '; code[k] = ' '; } };
  const blankText = (k) => { if (text[k] !== '\n') code[k] = ' '; };
  const placeholders = []; // the brace depth each open `${` returns to
  let depth = 0;
  let last = ''; // the last token: '' at the start, 'w:<word>', 'v' for a value, or the punctuator
  let i = 0;
  const regexMayStart = () => (last === '' ? true
    : last.startsWith('w:') ? REGEX_AFTER_WORD.has(last.slice(2))
      : last !== 'v' && last !== ')' && last !== ']');
  // Template text from `i`, to its closing backtick or its next placeholder.
  const template = () => {
    while (i < n) {
      const c = text[i];
      if (c === '\\') { blankText(i); blankText(i + 1); i += 2; continue; }
      if (c === '`') { i++; last = 'v'; return; }
      if (c === '$' && text[i + 1] === '{') { i += 2; placeholders.push(depth); depth++; last = '{'; return; }
      blankText(i); i++;
    }
  };
  if (text.startsWith('#!')) while (i < n && text[i] !== '\n') blankBoth(i++);
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') blankBoth(i++);
    } else if (c === '/' && d === '*') {
      blankBoth(i); blankBoth(i + 1); i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) blankBoth(i++);
      if (i < n) { blankBoth(i); blankBoth(i + 1); i += 2; }
    } else if (c === "'" || c === '"') {
      i++;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\') { blankText(i); i++; }
        blankText(i); i++;
      }
      i++; last = 'v';
    } else if (c === '`') {
      i++; template();
    } else if (c === '/' && regexMayStart()) {
      i++;
      let inClass = false;
      while (i < n && text[i] !== '\n') {
        const r = text[i];
        if (r === '\\') { blankText(i); i++; blankText(i); i++; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        blankText(i); i++;
      }
      i++;
      while (i < n && /[A-Za-z]/.test(text[i])) i++;
      last = 'v';
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(text[j])) j++;
      last = `w:${text.slice(i, j)}`;
      i = j;
    } else if (/[0-9]/.test(c)) {
      while (i < n && /[\w.]/.test(text[i])) i++;
      last = 'v';
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === '{') {
      depth++; last = '{'; i++;
    } else if (c === '}') {
      depth--; i++;
      if (placeholders.length && depth === placeholders[placeholders.length - 1]) { placeholders.pop(); template(); } else last = '}';
    } else {
      last = c; i++;
    }
  }
  return { kept: kept.join('').split('\n'), code: code.join('').split('\n') };
}
const viewsByFile = new Map();
function viewsOf(file) {
  if (!viewsByFile.has(file)) viewsByFile.set(file, sourceViews(fs.readFileSync(file, 'utf8')));
  return viewsByFile.get(file);
}

// The function a line is in, and the line it starts on: the message handler
// in server.js, a top-level function, or a class method.
function contextOf(lines, i) {
  for (let j = i; j >= 0; j--) {
    const l = lines[j];
    let m;
    if ((m = l.match(/^\s+if \(msg\.type === '(\w+)'\)/))) return { name: `message ${m[1]}`, start: j };
    if ((m = l.match(/^(?:async\s+)?function\s+(\w+)\s*\(/))) return { name: m[1], start: j };
    if ((m = l.match(/^ {2}(?:async\s+)?(?!(?:if|for|while|switch|catch)\b)(\w+)\s*\([^)]*\)\s*\{\s*$/))) return { name: m[1], start: j };
  }
  return { name: '(top level)', start: 0 };
}

// What a variable was set to: its nearest declaration above `i` in the same
// function, read to the statement's end.
function initializerOf(lines, start, i, name) {
  const decl = new RegExp(`^\\s*(?:const|let)\\s+${name}\\s*=`);
  for (let j = i; j >= start; j--) {
    if (!decl.test(lines[j])) continue;
    const text = lines.slice(j).join('\n');
    const from = text.indexOf('=') + 1;
    let depth = 0;
    for (let k = from; k < text.length; k++) {
      const c = text[k];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ';' && depth === 0) return text.slice(from, k).trim();
    }
    return text.slice(from).trim();
  }
  return null;
}

// Sites matching `pattern` in the app's files, each keyed `file | function |
// <the match's first group>`, the same key twice in one function told apart
// by its order there.
// `lines` on each site is the `code` view.
function sitesIn({ kept, code }, pattern, name) {
  const sites = [];
  code.forEach((line, i) => {
    for (const m of line.matchAll(pattern)) {
      const ctx = contextOf(kept, i);
      sites.push({ base: `${name} | ${ctx.name} | ${m[1]}`, match: m, lines: code, line: i, start: ctx.start, file: name, fn: ctx.name });
    }
  });
  return sites;
}
function sitesOf(pattern) {
  const sites = [];
  for (const file of appFiles()) sites.push(...sitesIn(viewsOf(file), pattern, rel(file)));
  const count = new Map();
  for (const s of sites) count.set(s.base, (count.get(s.base) || 0) + 1);
  const seen = new Map();
  for (const s of sites) {
    const n = (seen.get(s.base) || 0) + 1;
    seen.set(s.base, n);
    s.at = count.get(s.base) > 1 ? `${s.base} #${n}` : s.base;
  }
  return sites;
}

// A write to a child's stdin: anything's `.stdin.write(` but Rundock's own
// process.stdin.
const WRITE = /(?<![\w$.])((?!process\.stdin)[\w$]+(?:\.[\w$]+)*?\.stdin\.write)\s*\(/g;
const writes = () => sitesOf(WRITE);

// Every conversation entry is given its process in one of two ways.
const ENTRY_PROCESS = /(?<![\w$])(process\s*:\s*([\w$]+)|[\w$]+\.process\s*=\s*([\w$]+))(?![\w$])/g;

describe('every write to a child\'s stdin goes to a child whose stdin was given its handler at start', () => {
  test('every write is in the inventory, and nothing listed has gone', () => {
    const found = writes().map((s) => s.at);
    const listed = WRITES.map((w) => w.at);
    const unlisted = found.filter((at) => !listed.includes(at));
    const gone = listed.filter((at) => !found.includes(at));
    assert.deepStrictEqual({ unlisted, gone }, { unlisted: [], gone: [] },
      'every write to a child\'s stdin is listed: add a new one with where its child came from, and remove one that has gone');
    assert.strictEqual(new Set(listed).size, listed.length, 'each is listed once');
    // A pattern that stopped matching would find nothing and pass the lines
    // above; the scan is held to the inventory's exact size.
    assert.strictEqual(found.length, listed.length);
    assert.strictEqual(found.length, 14);
  });

  test('a write to a child started here writes to what spawnClaude returned', () => {
    for (const s of writes().filter((w) => WRITES.find((e) => e.at === w.at).from === STARTED_HERE)) {
      const name = s.match[1].replace(/\.stdin\.write$/, '');
      const init = initializerOf(s.lines, s.start, s.line, name);
      assert.ok(init, `${s.at} (line ${s.line + 1}): ${name} is declared in its function`);
      assert.match(init, /(?<![\w$.])spawnClaude\(/, `${s.at}: ${name} is set from spawnClaude, which guards its stdin`);
    }
  });

  test('every conversation entry the app makes is given its process from spawnClaude', () => {
    for (const s of writes().filter((w) => WRITES.find((e) => e.at === w.at).from === ENTRY)) {
      assert.match(s.match[1], /^[\w$]+\.process\.stdin\.write$/, `${s.at} writes to an entry's process`);
    }
    const sets = sitesOf(ENTRY_PROCESS);
    for (const s of sets) {
      const value = s.match[2] || s.match[3];
      const init = initializerOf(s.lines, s.start, s.line, value);
      assert.ok(init, `${s.file}:${s.line + 1} gives an entry ${value}, which is declared in its function`);
      assert.match(init, /(?<![\w$.])spawnClaude\(/, `${s.file}:${s.line + 1}: ${value} is set from spawnClaude`);
    }
    // Seven places make or restart an entry; a pattern gone blind would find none.
    assert.strictEqual(sets.length, 7, `entries given a process: ${sets.map((s) => `${s.file}:${s.line + 1}`).join(', ')}`);
  });

  test('the app-server is written to only through the process its guarded spawn set', () => {
    const [site] = writes().filter((w) => WRITES.find((e) => e.at === w.at).from === APP_SERVER);
    assert.strictEqual(initializerOf(site.lines, site.start, site.line, 'proc'), 'this._proc', 'the writer reads the current process');
    const src = viewsOf(path.join(ROOT, 'codex-appserver.js')).code.join('\n');
    const sets = [...src.matchAll(/this\._proc\s*=(?!=)\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepStrictEqual(sets.sort(), ['null', 'null', 'proc'],
      'and that process is set only by the spawn, and otherwise only cleared (in the constructor and on exit)');
  });

  test('each start path gives the stdin its handler straight after the spawn, and nothing else does', () => {
    for (const g of GUARDED_STARTS) {
      const { kept, code: lines } = viewsOf(path.join(ROOT, g.file));
      const spawnAt = lines.findIndex((l) => l.includes(`const proc = ${g.spawn}`));
      assert.ok(spawnAt >= 0, `${g.file} ${g.fn} starts ${g.starts} with ${g.spawn}`);
      assert.strictEqual(contextOf(kept, spawnAt).name, g.fn, `in ${g.fn}`);
      let guardAt = -1;
      for (let j = spawnAt + 1; j < lines.length && contextOf(kept, j).name === g.fn; j++) {
        const c = lines[j];
        if (/(?<![\w$.])guardChildStdin\(proc\b/.test(c)) { guardAt = j; break; }
        assert.ok(!/\bproc\.stdin\.write\(|\breturn proc\b|this\._proc\s*=(?!=)\s*null/.test(c),
          `${g.fn} writes to or hands on its process before guarding it (line ${j + 1})`);
      }
      assert.ok(guardAt > spawnAt, `${g.fn} calls guardChildStdin(proc) after its spawn`);
    }
    for (const g of GUARDED_STAND_INS) {
      const { kept, code: lines } = viewsOf(path.join(ROOT, g.file));
      const madeAt = lines.findIndex((l) => l.includes(`const ${g.name} = ${g.made}`));
      assert.ok(madeAt >= 0, `${g.file} ${g.fn} makes the stand-in for ${g.stands} with ${g.made}`);
      assert.strictEqual(contextOf(kept, madeAt).name, g.fn, `in ${g.fn}`);
      let guardAt = -1;
      for (let j = madeAt + 1; j < lines.length && contextOf(kept, j).name === g.fn; j++) {
        const c = lines[j];
        if (new RegExp(`(?<![\\w$.])guardChildStdin\\(${g.name}\\b`).test(c)) { guardAt = j; break; }
        assert.ok(!new RegExp(`\\b${g.name}\\.stdin\\.write\\(|\\breturn\\b`).test(c),
          `${g.fn} writes to or hands on its stand-in before guarding it (line ${j + 1})`);
      }
      assert.ok(guardAt > madeAt, `${g.fn} calls guardChildStdin(${g.name}) straight after making it`);
    }
    const calls = sitesOf(/(?<![\w$.])(guardChildStdin)\s*\(/g).filter((s) => !/function\s+$/.test(s.lines[s.line].slice(0, s.match.index)));
    assert.deepStrictEqual(calls.map((s) => `${s.file} | ${s.fn}`).sort(),
      [...GUARDED_STARTS, ...GUARDED_STAND_INS].map((g) => `${g.file} | ${g.fn}`).sort(),
      'guardChildStdin is called in the start paths, and for the stand-ins, and nowhere else');
  });

  test('only the handler and the answer-file guard replace a stdin\'s write', () => {
    const wrappers = sitesOf(/(?<![\w$])((?:[\w$]+\.)*stdin\.write)\s*=(?!=)/g).map((s) => `${s.file} | ${s.fn}`);
    assert.deepStrictEqual(wrappers.sort(), [...WRITE_WRAPPERS].sort());
  });
});

describe('the scans, on specimens', () => {
  test('the scan keeps its place through every file the app loads: both views of each still compile', () => {
    // Blanking only text inside comments, strings, templates and regular
    // expressions leaves a file that still compiles. A pass that lost its
    // place (a regular expression read as a division, a string never closed)
    // would blank code or keep text, and the file would not.
    const vm = require('node:vm');
    const files = appFiles();
    assert.ok(files.length > 50, `sanity: the app's files were read (${files.length})`);
    for (const file of files) {
      const { kept, code } = viewsOf(file);
      for (const [name, view] of [['kept', kept], ['code', code]]) {
        assert.doesNotThrow(() => vm.compileFunction(view.join('\n'), ['require', 'module', 'exports', '__filename', '__dirname']),
          `${rel(file)}: the ${name} view no longer compiles, so the scan lost its place in it`);
      }
    }
  });

  // Each specimen is scanned exactly as an app file is, through sourceViews
  // and sitesIn, so what the scan cannot see is shown here, by name.
  const found = (text) => sitesIn(sourceViews(text), WRITE, 'specimen').map((s) => `${s.line + 1}:${s.match[1]}`);

  test('a write after a string holding // is found: a URL is not a comment', () => {
    assert.deepStrictEqual(found("const url = 'https://x'; child.stdin.write('x');"), ['1:child.stdin.write']);
    assert.deepStrictEqual(found('const url = "https://x"; child.stdin.write(\'x\');'), ['1:child.stdin.write']);
    assert.deepStrictEqual(found('const url = `https://${host}/`; child.stdin.write(\'x\');'), ['1:child.stdin.write']);
  });

  test('a write in a comment, of either kind, or in a string, is not a write', () => {
    assert.deepStrictEqual(found("// child.stdin.write('x');"), []);
    assert.deepStrictEqual(found("go(); // then child.stdin.write('x');"), []);
    assert.deepStrictEqual(found("/* child.stdin.write('x'); */ go();"), []);
    assert.deepStrictEqual(found("log('child.stdin.write(x)'); log(\"proc.stdin.write(y)\");"), []);
    assert.deepStrictEqual(found('log(`proc.stdin.write(x) at ${when}`);'), []);
  });

  test('a block comment that spans lines hides what is inside it, and nothing after it', () => {
    const text = ["go(); /* a comment", "   child.stdin.write('inside');", "   ends here */ proc.stdin.write('after');", "next.stdin.write('x');"].join('\n');
    assert.deepStrictEqual(found(text), ['3:proc.stdin.write', '4:next.stdin.write'], 'and the line numbers are the file\'s');
  });

  test('code inside a template\'s placeholder is code, and a // in a regular expression is not a comment', () => {
    assert.deepStrictEqual(found('const s = `sent ${child.stdin.write(x)}`;'), ['1:child.stdin.write']);
    assert.deepStrictEqual(found("const re = /\\/\\//; proc.stdin.write('x');"), ['1:proc.stdin.write']);
    assert.deepStrictEqual(found("const re = /'/; proc.stdin.write('x'); const q = '/';"), ['1:proc.stdin.write']);
    assert.deepStrictEqual(found("const half = a / 2; proc.stdin.write('x'); const third = b / 3;"), ['1:proc.stdin.write']);
  });

  test('the write pattern finds a child\'s write, through an entry or not, and never process.stdin', () => {
    const hit = (s) => [...s.matchAll(WRITE)].map((m) => m[1]);
    assert.deepStrictEqual(hit("proc.stdin.write('x');"), ['proc.stdin.write']);
    assert.deepStrictEqual(hit("orig.process.stdin.write('x');"), ['orig.process.stdin.write']);
    assert.deepStrictEqual(hit("if (a) delegateProc.stdin.write ('x');"), ['delegateProc.stdin.write']);
    assert.deepStrictEqual(hit("process.stdin.write('x'); proc.stdin.writable;"), []);
  });

  test('the entry pattern finds both ways an entry is given its process', () => {
    const hit = (s) => [...s.matchAll(ENTRY_PROCESS)].map((m) => m[2] || m[3]);
    assert.deepStrictEqual(hit('const e = { process: proc, buffer: "" };'), ['proc']);
    assert.deepStrictEqual(hit('entry.process = proc;'), ['proc']);
    assert.deepStrictEqual(hit('{ process: delegateProc || undefined }'), ['delegateProc']);
    assert.deepStrictEqual(hit('if (entry.process === proc) {}'), []);
  });
});
