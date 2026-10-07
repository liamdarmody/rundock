'use strict';
// A development machine in miniature, for the Code-mode command classes.
//
// WHERE IT LIVES IS PART OF THE RULE BEING TESTED. In Code mode the system
// temp folders are development paths, where a recursive delete is disposable,
// and a folder inside any git working tree is judged by what git holds. A
// fixture built under os.tmpdir(), /tmp, or a checkout would therefore answer
// every "folder with no repository" row as disposable or as tracked, and the
// test would pass for the wrong reason. So the root is taken, in order, from
// RUNDOCK_TEST_OUTSIDE_TEMP_ROOT or /var/tmp, and refused when it sits under a
// temp folder or a git working tree. With neither available the suites that
// need it skip with that reason rather than run on a root that lies.
//
// The world, relative to the root:
//   home/                        the HOME the hook sees: .npm, .ssh, .gitconfig,
//                                .config/git/config, .claude, .codex, .aws, .kube,
//                                Library/Caches/pip, .cargo/registry, Documents,
//                                notes.txt, elsewhere/
//   home/Workspace/              the Rundock workspace (not a repository)
//   home/Projects/               the working folder
//   home/Projects/app            a repository: origin is a bare repository whose
//                                HEAD is main; current branch feat/x; branches
//                                main, feat/x, old-spike; ignored node_modules/,
//                                dist/, build/, .env, src/cache.pyc
//   home/Projects/other          a sibling repository
//   home/Projects/sketch         a folder with no repository, with a subfolder
//   remotes/app.git              the bare origin
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function real(p) { try { return fs.realpathSync.native(p); } catch (e) { return p; } }

function underGitTree(dir) {
  let cur = real(dir);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}
function underTemp(dir) {
  const r = real(dir);
  const temps = ['/tmp', '/private/tmp', os.tmpdir(), real(os.tmpdir())];
  return temps.some(t => r === t || r.startsWith(t + path.sep));
}

// The folder fixtures are made in, or { skip: '<why>' }. On a machine with no
// such folder the suites that need one skip, with the reason. Under CI they
// fail instead: a skipped suite reports green, and these suites carry the
// evidence the permission rules rest on.
const NO_ROOT = 'needs a writable folder outside every temp folder and git working tree (set RUNDOCK_TEST_OUTSIDE_TEMP_ROOT)';
function outsideTempRoot({ env = process.env, candidates } = {}) {
  const bases = (candidates || [env.RUNDOCK_TEST_OUTSIDE_TEMP_ROOT, '/var/tmp']).filter(Boolean);
  for (const base of bases) {
    try {
      fs.mkdirSync(base, { recursive: true });
      const dir = fs.mkdtempSync(path.join(base, `rundock-code-mode-p${process.pid}-`));
      if (underTemp(dir) || underGitTree(dir)) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      return { dir: real(dir) };
    } catch (e) { /* not writable here: try the next */ }
  }
  if (runningInCi(env)) throw new Error(`The Code-mode fixture ${NO_ROOT}. Under CI this fails rather than skips.`);
  return { skip: NO_ROOT };
}
function runningInCi(env) {
  const v = env.CI;
  return typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

function buildWorld(root) {
  const home = path.join(root, 'home');
  const ws = path.join(home, 'Workspace');
  const projects = path.join(home, 'Projects');
  const app = path.join(projects, 'app');
  const other = path.join(projects, 'other');
  const sketch = path.join(projects, 'sketch');
  const remotes = path.join(root, 'remotes');
  const bare = path.join(remotes, 'app.git');

  // Home, with every hidden folder a row names.
  write(path.join(home, '.npm/_cacache/index-v5/aa/entry'), 'cache\n');
  write(path.join(home, '.ssh/config'), 'Host example\n  User git\n');
  write(path.join(home, '.gitconfig'), '[user]\n\tname = Test User\n');
  write(path.join(home, '.config/git/config'), '[core]\n\tautocrlf = false\n');
  write(path.join(home, '.claude/CLAUDE.md'), '# global instructions\n');
  write(path.join(home, '.claude/settings.json'), '{}\n');
  write(path.join(home, '.claude/.credentials.json'), '{}\n');
  write(path.join(home, '.codex/AGENTS.md'), '# global instructions\n');
  write(path.join(home, '.codex/auth.json'), '{}\n');
  write(path.join(home, '.aws/credentials'), '[default]\n');
  fs.mkdirSync(path.join(home, '.kube'), { recursive: true });
  write(path.join(home, 'Library/Caches/pip/http/entry'), 'cache\n');
  write(path.join(home, '.cargo/registry/cache/entry'), 'cache\n');
  write(path.join(home, 'Documents/brief.md'), '# brief\n');
  write(path.join(home, 'notes.txt'), 'notes\n');
  write(path.join(home, 'elsewhere/x.txt'), 'x\n');

  // The workspace: enough of one for the hook, which reads only its state file.
  write(path.join(ws, '.rundock/state.json'), JSON.stringify({ workspaceMode: 'code', workingFolders: [] }) + '\n');
  write(path.join(ws, '.rundock/permissions.json'), '{}\n');
  write(path.join(ws, '.claude/settings.local.json'), '{}\n');
  fs.mkdirSync(path.join(ws, '.rundock/scratch/run-42'), { recursive: true });

  // The origin, then the repository.
  fs.mkdirSync(remotes, { recursive: true });
  git(remotes, 'init', '-q', '--bare', '-b', 'main', bare);
  fs.mkdirSync(app, { recursive: true });
  git(app, 'init', '-q', '-b', 'main');
  write(path.join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }, null, 2) + '\n');
  write(path.join(app, 'README.md'), '# app\n');
  write(path.join(app, 'notes.txt'), 'scratch notes\n');
  write(path.join(app, 'a.log'), 'a\n');
  write(path.join(app, 'b.log'), 'b\n');
  write(path.join(app, 'draft.md'), '# draft\n');
  write(path.join(app, 'src/app.js'), "module.exports = 1;\n");
  write(path.join(app, 'src/index.js'), "console.log('hello');\n");
  write(path.join(app, 'src/legacy/parser.js'), 'module.exports = {};\n');
  write(path.join(app, 'scripts/dev.sh'), '#!/bin/sh\nnpm run dev\n');
  write(path.join(app, 'bin/tool'), '#!/bin/sh\n');
  write(path.join(app, 'template/index.html'), '<p>t</p>\n');
  write(path.join(app, 'notes/.keep'), '');
  write(path.join(app, 'config/settings.json'), '{}\n');
  write(path.join(app, '.env.example'), 'API_KEY=\n');
  write(path.join(app, '.gitignore'), 'node_modules/\ndist/\nbuild/\n.next/\n.env\n*.pyc\n');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'Initial commit');
  git(app, 'remote', 'add', 'origin', bare);
  git(app, 'push', '-q', '-u', 'origin', 'main');
  git(app, 'remote', 'set-head', 'origin', 'main');
  git(app, 'branch', 'old-spike');
  git(app, 'switch', '-q', '-c', 'feat/x');
  write(path.join(app, 'src/login.js'), 'module.exports = () => true;\n');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'Start login');
  git(app, 'push', '-q', '-u', 'origin', 'feat/x');
  git(app, 'tag', 'v1.2.0');
  // Ignored and rebuildable; and one ignored file nobody can rebuild.
  write(path.join(app, 'node_modules/left-pad/index.js'), 'module.exports = s => s;\n');
  write(path.join(app, 'dist/bundle.js'), '// built\n');
  write(path.join(app, 'build/out.js'), '// built\n');
  write(path.join(app, '.next/cache.json'), '{}\n');
  write(path.join(app, 'src/cache.pyc'), 'x');
  write(path.join(app, '.env'), 'API_KEY=not-a-real-key\n');
  write(path.join(app, 'config/.env'), 'API_KEY=not-a-real-key\n');
  fs.mkdirSync(path.join(app, 'empty-dir'), { recursive: true });

  fs.mkdirSync(other, { recursive: true });
  git(other, 'init', '-q', '-b', 'main');
  write(path.join(other, 'README.md'), '# other\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'Initial commit');

  write(path.join(sketch, 'idea.md'), 'not in git\n');
  write(path.join(sketch, 'drafts/one.md'), 'not in git\n');

  return { root, home, ws, projects, app, other, sketch, remotes, bare };
}

// Repository states a row can ask for, applied before and undone after, so one
// fixture serves every row. Undo never touches ignored files.
const STATES = {
  clean: { apply() {}, undo() {} },
  'tracked-change': {
    apply(w) { fs.appendFileSync(path.join(w.app, 'src/app.js'), '// changed\n'); },
    undo(w) { git(w.app, 'checkout', '--', 'src/app.js'); },
  },
  'untracked-file': {
    apply(w) { write(path.join(w.app, 'src/new-parser.ts'), 'export {};\n'); },
    undo(w) { fs.rmSync(path.join(w.app, 'src/new-parser.ts'), { force: true }); },
  },
  'legacy-unsaved': {
    apply(w) {
      write(path.join(w.app, 'src/legacy/new-parser.ts'), 'export {};\n');
      fs.appendFileSync(path.join(w.app, 'src/legacy/parser.js'), '// changed\n');
    },
    undo(w) {
      fs.rmSync(path.join(w.app, 'src/legacy/new-parser.ts'), { force: true });
      git(w.app, 'checkout', '--', 'src/legacy/parser.js');
    },
  },
  'no-env': {
    apply(w) {
      for (const f of ['.env', 'config/.env']) fs.renameSync(path.join(w.app, f), path.join(w.root, f.replace('/', '-') + '.aside'));
    },
    undo(w) {
      for (const f of ['.env', 'config/.env']) fs.renameSync(path.join(w.root, f.replace('/', '-') + '.aside'), path.join(w.app, f));
    },
  },
  'on-main': {
    apply(w) { git(w.app, 'switch', '-q', 'main'); },
    undo(w) { git(w.app, 'switch', '-q', 'feat/x'); },
  },
  'has-stash': {
    apply(w) { fs.appendFileSync(path.join(w.app, 'README.md'), 'x\n'); git(w.app, 'stash', '-q'); },
    undo(w) { try { git(w.app, 'stash', 'drop', '-q'); } catch (e) { /* none */ } },
  },
};
function withState(world, state, fn) {
  const s = STATES[state || 'clean'];
  if (!s) throw new Error(`unknown fixture state ${state}`);
  s.apply(world);
  try { return fn(); } finally { s.undo(world); }
}
async function withStateAsync(world, state, fn) {
  const s = STATES[state || 'clean'];
  if (!s) throw new Error(`unknown fixture state ${state}`);
  s.apply(world);
  try { return await fn(); } finally { s.undo(world); }
}

// Where a row's command runs, by name.
function cwdFor(world, at) {
  switch (at || 'app') {
    case 'app': return world.app;
    case 'app/src': return path.join(world.app, 'src');
    case 'ws': return world.ws;
    case 'projects': return world.projects;
    case 'sketch': return world.sketch;
    case 'none': return undefined;
    default: throw new Error(`unknown cwd ${at}`);
  }
}

// Placeholders a row writes instead of fixture paths.
function expand(world, s) {
  return String(s)
    .replace(/<HOME>/g, world.home)
    .replace(/<WS>/g, world.ws)
    .replace(/<PROJECTS>/g, world.projects)
    .replace(/<APP>/g, world.app);
}

// ── The real hook, spawned the way the runtime spawns it ────────────────────

// A server standing in for Rundock's /api/permission-request: records what the
// hook asked, and answers allow so the hook exits.
async function startCaptureServer() {
  const posted = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { const d = JSON.parse(body); posted.set(d.session_id, d); } catch (e) { /* ignored */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: true, reason: 'harness' }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, posted, close: () => new Promise(r => server.close(r)) };
}

async function closedPort() {
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

function hookEnv(world, { port, codeMode = true, extraDirs, home } = {}) {
  const env = {
    ...process.env,
    RUNDOCK: '1',
    RUNDOCK_WORKSPACE: world.ws,
    RUNDOCK_PORT: String(port),
    RUNDOCK_EXTRA_DIRS: (extraDirs || [world.projects]).join(path.delimiter),
    RUNDOCK_CONVO_ID: 'code-mode-test',
    // The token the server starts an agent with for this conversation, which
    // the hook sends on both of its routes (lib/auth). Issued in this process,
    // which is where the routes under test run.
    RUNDOCK_HOOK_TOKEN: require('../../lib/auth/index.js').issueHookToken('code-mode-test'),
    HOME: home || world.home,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  if (codeMode) env.RUNDOCK_CODE_MODE = '1'; else delete env.RUNDOCK_CODE_MODE;
  delete env.NODE_V8_COVERAGE;
  return env;
}

function runHook(env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (e) { /* raw kept */ }
      const h = parsed && parsed.hookSpecificOutput;
      resolve({ raw: out, decision: h ? h.permissionDecision : 'pass-through', reason: h ? h.permissionDecisionReason : '' });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

let seq = 0;
// One call judged twice: once against a capture server (did the hook ask, and
// with what), once against a closed port (what happens when nobody can be
// asked). The class follows from those two observations alone.
async function judge(world, capture, deadPort, { tool, input, cwd, codeMode = true, extraDirs, home }) {
  const sid = `cm-${process.pid}-${++seq}`;
  const base = { session_id: sid, transcript_path: '', permission_mode: 'acceptEdits', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
  if (cwd !== undefined) base.cwd = cwd;
  const live = await runHook(hookEnv(world, { port: capture.port, codeMode, extraDirs, home }), base);
  const payload = capture.posted.get(sid) || null;
  const dead = await runHook(hookEnv(world, { port: deadPort, codeMode, extraDirs, home }), { ...base, session_id: sid + '-dead' });
  return { live, dead, payload, cls: classOf(live, dead, payload) };
}

const ASKS_ONCE_REFUSAL = /held for your approval and Rundock could not ask/;
function classOf(live, dead, payload) {
  if (!payload) {
    if (live.decision === 'allow') return 'runs';
    if (live.decision === 'deny') return 'refused';
    return 'pass-through';
  }
  if (dead.decision === 'deny') return ASKS_ONCE_REFUSAL.test(dead.reason) ? 'asks-once' : 'always-asks';
  return payload.boundary ? 'boundary' : 'card';
}

module.exports = {
  HOOK, GIT_ENV, git, write, real, outsideTempRoot, buildWorld, STATES, withState, withStateAsync, cwdFor, expand,
  startCaptureServer, closedPort, hookEnv, runHook, judge, classOf, ASKS_ONCE_REFUSAL,
};
