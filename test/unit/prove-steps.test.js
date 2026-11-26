'use strict';
// The prove workflow's test-user steps, each run whole as the workflow runs
// it, handed a `require` and a `process` made here. The `require` returns a
// fake file system and a fake spawnSync that stand in for the runner, sudo,
// the test user and /proc, and record every call, so each check a step makes
// can be shown to fail, naming its cause, without a real user being made.
const { describe, test } = require('node:test');
const assert = require('node:assert');
const realFs = require('node:fs');
const { spawnSync: realSpawnSync } = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path').posix;
const { readProve, runStep } = require('../helpers/prove-workflow.js');

const WORKFLOW = readProve().workflow;
const STEPS = ['prepare the test user', 'install', 'run the test', 'stop the test user', 'check the tree'];
// The step after them, which judges the evidence they leave.
const JUDGE = 'judge the result';
const { O_NOFOLLOW } = realFs.constants;

const RUNNER = { uid: 1000, home: '/fake/runner' };
const CHECKOUT = '/fake/runner/work/rundock/rundock';
const RUNNER_TEMP = '/fake/runner/work/_temp';
const EVIDENCE = `${RUNNER_TEMP}/prove-evidence`;
const COMMANDS = `${RUNNER_TEMP}/_runner_file_commands`;
const TEST_HOME = '/fake/users/prove-test';
const COPY = `${TEST_HOME}/checkout`;
const NODE_DIR = '/fake/toolcache/node/24.12.0/x64';
const NODE = `${NODE_DIR}/bin/node`;
const LIMIT = 64 * 1024 * 1024;
// Cron's spool, where it reads each user's crontab from the entry named after them.
const SPOOL = '/var/spool/cron/crontabs';
// The arguments after the directory with which GNU find lists the names in it,
// each ended by a 0x00 byte.
const FIND_NAMES = ['-mindepth', '1', '-maxdepth', '1', '-printf', '%f\\0'];
const FILE_KEYS = ['GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY'];
const TESTS = [{ i: 1, file: 'test/a.test.js', name: 'a works' }];
const ROWS = [{ i: 1, file: 'src/a.js', from: '1', to: '2', test: 1 }];

const SUMMARY = (n) => ['suites 0', `pass ${n.pass}`, `fail ${n.fail}`, 'cancelled 0', 'skipped 0', 'todo 0', 'duration_ms 41.5'];
const tap = (results, n) => ['TAP version 13', ...results, `1..${n.tests}`, `# tests ${n.tests}`, ...SUMMARY(n).map((s) => `# ${s}`), ''].join('\n');
const PASSED = (k = 1) => ['# Subtest: a works', `ok ${k} - a works`, '  ---', '  duration_ms: 1.2', "  type: 'test'", '  ...'];
const FAILED = ['# Subtest: a works', 'not ok 1 - a works', '  ---', '  duration_ms: 1.2', "  type: 'test'",
  "  failureType: 'testCodeFailure'", "  error: 'Expected values to be strictly equal'", "  code: 'ERR_ASSERTION'", '  ...'];
const PASS_TAP = tap(PASSED(), { tests: 1, pass: 1, fail: 0 });
const FAIL_TAP = tap(FAILED, { tests: 1, pass: 0, fail: 1 });
const TWO_TAP = tap([...PASSED(1), ...PASSED(2)], { tests: 2, pass: 2, fail: 0 });

class Exit {
  constructor(code) { this.code = code; }
}

const TYPE = { dir: 0o040000, file: 0o100000, link: 0o120000, fifo: 0o010000, socket: 0o140000 };

/**
 * A fake runner for one job. `cfg` changes what the fakes answer:
 * probe(op, target, sys) a probe's answer; extraEnv keys the test user's
 * environment gains; sudo true when the test user may run sudo; idU and idG
 * what id prints; user {uid, gid, home} the account useradd makes;
 * chmodSkip(argv) a root chmod that does nothing; immortal pids no kill
 * stops; onNpm(sys) and onRun(n, sys) what npm and each run do besides
 * their default; npm and run(n) their results; atq and setup(sys);
 * rootSpawn(call, sys) what a spawn as root answers, in place of the fakes;
 * unset {step: [keys]} the variables a step's environment lacks. Cron's spool
 * starts empty, and crontab answers as Ubuntu's does: it refuses a user
 * named in /etc/cron.deny, even to root, whatever the spool holds.
 */
function makeSystem(job, cfg = {}) {
  const calls = [];
  const nodes = new Map();
  const fds = new Map();
  const sys = {
    job, cfg, calls, nodes, out: [], err: [], step: null, runs: 0, user: null,
    procs: new Map([['1', 0], ['200', RUNNER.uid]]), immortal: new Set(cfg.immortal || []), nextPid: 300,
  };
  const norm = (p) => path.resolve(String(p));
  const fail = (code, syscall, p) => Object.assign(new Error(`${code}: ${syscall} '${p}'`), { code, syscall, path: String(p) });
  const put = (p, node) => { nodes.set(norm(p), { uid: 0, gid: 0, ...node }); return nodes.get(norm(p)); };
  const dir = (p, mode = 0o755, uid = 0) => put(p, { type: 'dir', mode, uid, gid: uid });
  const file = (p, data = '', mode = 0o644, uid = 0) => put(p, { type: 'file', mode, uid, gid: uid, data: Buffer.from(data) });
  const link = (p, target, uid = 0) => put(p, { type: 'link', mode: 0o777, uid, gid: uid, target: Buffer.from(target) });
  const children = (at) => [...nodes.keys()].filter((k) => k !== '/' && path.dirname(k) === at).map((k) => path.basename(k));
  const under = (at) => [...nodes.keys()].filter((k) => k === at || k.startsWith(`${at}/`));
  const follow = (p) => {
    let at = norm(p);
    for (let n = 0; n < 40; n++) {
      const node = nodes.get(at);
      if (!node || node.type !== 'link') return { at, node };
      at = path.resolve(path.dirname(at), node.target.toString());
    }
    throw fail('ELOOP', 'stat', p);
  };
  const parent = (p, syscall) => {
    const up = nodes.get(path.dirname(norm(p)));
    if (!up || up.type !== 'dir') throw fail('ENOENT', syscall, p);
  };
  const stat = (n) => ({
    mode: TYPE[n.type] | n.mode, uid: n.uid, gid: n.gid, size: n.data ? n.data.length : 0,
    isDirectory: () => n.type === 'dir', isFile: () => n.type === 'file', isSymbolicLink: () => n.type === 'link',
    isFIFO: () => n.type === 'fifo', isSocket: () => n.type === 'socket', isBlockDevice: () => false, isCharacterDevice: () => false,
  });
  const log = (fn, args) => calls.push({ step: sys.step, fn, args });
  const encodingOf = (opts) => (typeof opts === 'string' ? opts : opts && opts.encoding);

  const fs = {
    constants: realFs.constants,
    readdirSync(p, opts) {
      log('readdirSync', [p, opts]);
      const at = norm(p);
      const buffer = encodingOf(opts) === 'buffer';
      if (at === '/proc') {
        const pids = [...sys.procs.keys()].filter((pid) => cfg.hidePid1 !== true || pid !== '1');
        return buffer ? pids.map((pid) => Buffer.from(pid)) : pids;
      }
      const n = nodes.get(at);
      if (!n) throw fail('ENOENT', 'scandir', p);
      if (n.type !== 'dir') throw fail('ENOTDIR', 'scandir', p);
      if (n.noList) throw fail('EACCES', 'scandir', p);
      const names = children(at);
      return buffer ? [...names.map((name) => Buffer.from(name)), ...(n.extraRaw || [])] : names;
    },
    lstatSync(p) {
      log('lstatSync', [p]);
      const n = nodes.get(norm(p));
      if (!n) throw fail('ENOENT', 'lstat', p);
      return stat(n);
    },
    readlinkSync(p, opts) {
      log('readlinkSync', [p, opts]);
      const n = nodes.get(norm(p));
      if (!n) throw fail('ENOENT', 'readlink', p);
      if (n.type !== 'link') throw fail('EINVAL', 'readlink', p);
      return encodingOf(opts) === 'buffer' ? Buffer.from(n.target) : n.target.toString();
    },
    openSync(p, flags) {
      log('openSync', [p, flags]);
      const at = norm(p);
      let n = nodes.get(at);
      if (!n) throw fail('ENOENT', 'open', p);
      if (n.type === 'link') {
        if (flags & O_NOFOLLOW) throw fail('ELOOP', 'open', p);
        n = follow(at).node;
        if (!n) throw fail('ENOENT', 'open', p);
      }
      if (n.noRead) throw fail('EACCES', 'open', p);
      const fd = 100 + fds.size + calls.length;
      fds.set(fd, n);
      return fd;
    },
    fstatSync(fd) {
      log('fstatSync', [fd]);
      if (!fds.has(fd)) throw fail('EBADF', 'fstat', fd);
      return stat(fds.get(fd));
    },
    closeSync(fd) {
      log('closeSync', [fd]);
      if (!fds.delete(fd)) throw fail('EBADF', 'close', fd);
    },
    readFileSync(p, opts) {
      log('readFileSync', [p, opts]);
      const enc = encodingOf(opts);
      let data;
      const proc = typeof p === 'string' && /^\/proc\/(\d+)\/status$/.exec(p);
      if (typeof p === 'number') {
        if (!fds.has(p)) throw fail('EBADF', 'read', p);
        data = fds.get(p).data;
      } else if (proc) {
        if (!sys.procs.has(proc[1])) throw fail('ENOENT', 'open', p);
        const uid = sys.procs.get(proc[1]);
        data = Buffer.from(`Name:\tfake\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
      } else {
        const { node } = follow(p);
        if (!node) throw fail('ENOENT', 'open', p);
        if (node.type === 'dir') throw fail('EISDIR', 'read', p);
        if (node.noRead) throw fail('EACCES', 'open', p);
        data = node.data;
      }
      return enc ? data.toString(enc) : Buffer.from(data);
    },
    mkdirSync(p, opts) {
      log('mkdirSync', [p, opts]);
      if (nodes.has(norm(p))) throw fail('EEXIST', 'mkdir', p);
      parent(p, 'mkdir');
      const mode = typeof opts === 'number' ? opts : opts && opts.mode !== undefined ? opts.mode : 0o777;
      dir(p, mode & ~0o022, RUNNER.uid);
    },
    chmodSync(p, mode) {
      log('chmodSync', [p, mode]);
      const { node } = follow(p);
      if (!node) throw fail('ENOENT', 'chmod', p);
      node.mode = mode & 0o7777;
    },
    symlinkSync(target, p) {
      log('symlinkSync', [target, p]);
      if (nodes.has(norm(p))) throw fail('EEXIST', 'symlink', p);
      parent(p, 'symlink');
      link(p, target, RUNNER.uid);
    },
    copyFileSync(from, to, mode) {
      log('copyFileSync', [from, to, mode]);
      const { node } = follow(from);
      if (!node || node.type !== 'file') throw fail('ENOENT', 'copyfile', from);
      if (nodes.has(norm(to)) && mode & realFs.constants.COPYFILE_EXCL) throw fail('EEXIST', 'copyfile', to);
      parent(to, 'copyfile');
      file(to, node.data, node.mode, RUNNER.uid);
    },
    writeFileSync(p, data, opts) {
      log('writeFileSync', [p, Buffer.from(data), opts]);
      if (nodes.has(norm(p)) && opts && opts.flag === 'wx') throw fail('EEXIST', 'open', p);
      parent(p, 'open');
      file(p, data, 0o644, RUNNER.uid);
    },
    realpathSync(p) {
      log('realpathSync', [p]);
      const { at, node } = follow(p);
      if (!node) throw fail('ENOENT', 'realpath', p);
      return at;
    },
  };

  const result = (r) => ({ pid: 0, status: 0, signal: null, ...r, stdout: Buffer.from(r.stdout || ''), stderr: Buffer.from(r.stderr || '') });
  const exists = (p) => nodes.has(norm(p));
  const mortal = (uid) => { const pid = String(sys.nextPid++); sys.procs.set(pid, uid); return pid; };

  function asRootUser(argv, input) {
    const [tool, ...args] = argv;
    if (tool === '/usr/sbin/useradd') {
      const want = { uid: 1001, gid: 1001, home: TEST_HOME, ...cfg.user };
      sys.user = { name: args[args.length - 1], ...want };
      dir(want.home, 0o750, want.uid);
      return result({});
    }
    if (tool === '/usr/bin/tee' && args[0] === '-a') {
      const n = nodes.get(norm(args[1])) || file(args[1]);
      n.data = Buffer.concat([n.data, Buffer.from(input)]);
      return result({ stdout: input });
    }
    if (tool === '/usr/bin/chmod') {
      if (cfg.chmodSkip && cfg.chmodSkip(argv)) return result({});
      const recursive = args[0] === '-R';
      const [spec, target] = recursive ? args.slice(1) : args;
      for (const at of recursive ? under(norm(target)) : [follow(target).at]) {
        const n = nodes.get(at);
        if (!n) return result({ status: 1, stderr: `chmod: cannot access '${target}'` });
        if (n.type === 'link') continue;
        n.mode = /^[0-7]+$/.test(spec) ? parseInt(spec, 8) : n.mode & ~0o022;
      }
      return result({});
    }
    if (tool === '/usr/bin/install' && args[0] === '-d') {
      const [, , owner, , group, , mode, target] = args;
      const id = (name) => (name === sys.user.name ? sys.user.uid : Number(name));
      put(target, { type: 'dir', mode: parseInt(mode, 8), uid: id(owner), gid: id(group) });
      return result({});
    }
    if (tool === '/usr/bin/chown' && args[0] === '--no-dereference' && args[1] === '-R') {
      for (const at of under(norm(args[3]))) Object.assign(nodes.get(at), { uid: sys.user.uid, gid: sys.user.gid });
      return result({});
    }
    if (tool === '/usr/bin/crontab' && args[0] === '-l' && args[1] === '-u') {
      const deny = nodes.get('/etc/cron.deny');
      if (deny && deny.data.toString().split('\n').includes(args[2])) {
        return result({ status: 1, stderr: `The user ${args[2]} cannot use this program (crontab)\n` });
      }
      const entry = nodes.get(path.join(SPOOL, args[2]));
      return entry ? result({ stdout: entry.data }) : result({ status: 1, stderr: `no crontab for ${args[2]}\n` });
    }
    if (tool === '/usr/bin/find' && JSON.stringify(args.slice(1)) === JSON.stringify(FIND_NAMES)) {
      // Each entry's name, of any type, never what a symlink points to.
      const n = nodes.get(norm(args[0]));
      // GNU find names itself as it was run, and quotes the path as the C locale does.
      if (!n) return result({ status: 1, stderr: `/usr/bin/find: '${args[0]}': No such file or directory\n` });
      const names = n.type === 'dir' ? [...children(norm(args[0])).map((name) => Buffer.from(name)), ...(n.extraRaw || [])] : [];
      return result({ stdout: Buffer.concat(names.flatMap((name) => [name, Buffer.from([0])])) });
    }
    if (tool === '/usr/bin/atq') return result({ stdout: cfg.atq || '' });
    return result({ status: 1, stderr: `${tool} is not faked\n` });
  }

  function asTestUser(rest) {
    if (rest[0] !== 'prove-test' || rest[1] !== '--' || rest[2] !== '/usr/bin/env' || rest[3] !== '-i') {
      return result({ status: 1, stderr: 'sudo: a password is required\n' });
    }
    let k = 4;
    const env = {};
    for (; k < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[k]); k++) env[rest[k].split('=')[0]] = rest[k].slice(rest[k].indexOf('=') + 1);
    const argv = rest.slice(k);
    if (argv[0] === NODE && argv[1] === '-e' && argv[2].includes('const [op, target] = process.argv.slice(1);')) {
      const [op, target] = argv.slice(3);
      const answer = cfg.probe && cfg.probe(op, target, sys);
      return result({ stdout: answer || (exists(target) ? 'EACCES' : 'ENOENT') });
    }
    if (argv[0] === NODE && argv[1] === '-e' && argv[2].includes('Object.keys(process.env)')) {
      return result({ stdout: [...Object.keys(env), ...(cfg.extraEnv || [])].sort().join(' ') });
    }
    if (argv[0] === '/usr/bin/sudo') return result({ status: cfg.sudo ? 0 : 1, stderr: cfg.sudo ? '' : 'sudo: a password is required\n' });
    if (argv[0] === '/usr/bin/id') {
      const answer = argv[1] === '-u' ? cfg.idU || String(sys.user.uid) : cfg.idG || String(sys.user.gid);
      return result({ stdout: `${answer}\n` });
    }
    if (argv[0] === '/usr/bin/kill' && argv[1] === '-KILL' && argv[2] === '-1') {
      for (const [pid, uid] of sys.procs) if (uid === sys.user.uid && !sys.immortal.has(pid)) sys.procs.delete(pid);
      return result({});
    }
    if (argv[0] === 'npm' && argv[1] === 'ci') {
      // npm leaves a process behind that the kill must stop.
      mortal(sys.user.uid);
      for (const d of ['node_modules', 'node_modules/dep']) if (!exists(path.join(COPY, d))) dir(path.join(COPY, d), 0o755, sys.user.uid);
      file(path.join(COPY, 'node_modules/dep/index.js'), 'module.exports = 1;\n', 0o644, sys.user.uid);
      if (cfg.onNpm) cfg.onNpm(sys);
      return result(cfg.npm || { stdout: 'added 1 package\n' });
    }
    if (argv[0] === NODE && argv[1] === '--test') {
      const n = ++sys.runs;
      mortal(sys.user.uid);
      if (cfg.onRun) cfg.onRun(n, sys);
      const want = (cfg.run && cfg.run(n, sys)) || (job === 'green' ? { tap: PASS_TAP, status: 0 } : { tap: FAIL_TAP, status: 1 });
      return result({ ...want, stdout: want.tap, stderr: want.stderr || '' });
    }
    return result({ status: 127, stderr: `${argv[0]} is not faked\n` });
  }

  function spawnSync(cmd, args, opts = {}) {
    const call = { step: sys.step, fn: 'spawnSync', cmd, args: [...args], opts };
    calls.push(call);
    if (cmd === '/usr/bin/getent' && args[0] === 'passwd') {
      if (args[1] === String(RUNNER.uid)) return result({ stdout: `runner:x:1000:1000:,,,:${RUNNER.home}:/bin/bash\n` });
      if (sys.user && args[1] === sys.user.name) {
        const u = sys.user;
        return result({ stdout: `${u.name}:x:${u.uid}:${u.gid}::${u.home}:/usr/sbin/nologin\n` });
      }
      return result({ status: 2 });
    }
    if (cmd !== '/usr/bin/sudo' || args[0] !== '-n') return result({ status: 127, stderr: `${cmd} is not faked\n` });
    call.as = args[1] === '-u' ? 'test user' : 'root';
    if (call.as === 'test user') {
      call.argv = args.slice(2 + args.slice(2).findIndex((a) => !/^[A-Za-z_][A-Za-z0-9_]*=|^(prove-test|--|\/usr\/bin\/env|-i)$/.test(a)));
      const hook = cfg.spawn && cfg.spawn(call, sys);
      return hook || asTestUser(args.slice(2));
    }
    call.argv = args.slice(1);
    const hook = cfg.rootSpawn && cfg.rootSpawn(call, sys);
    return hook || asRootUser(args.slice(1), opts.input);
  }

  dir('/');
  for (const d of ['/fake', '/fake/users', '/usr', '/usr/bin', '/usr/sbin', '/bin', '/etc', '/var', '/var/run', '/var/lib',
    '/var/lib/systemd', '/var/lib/systemd/linger', '/var/spool', '/var/spool/cron', '/proc']) dir(d);
  dir(SPOOL, 0o1730);
  for (const f of ['/usr/bin/at', '/usr/bin/atq', '/usr/bin/crontab', '/usr/bin/find', '/usr/bin/id', '/usr/bin/kill', '/usr/bin/env']) file(f, '', 0o755);
  file('/usr/bin/sudo', '', 0o4755);
  put('/var/run/docker.sock', { type: 'socket', mode: 0o660 });
  for (const d of [RUNNER.home, '/fake/runner/work', RUNNER_TEMP, COMMANDS, '/fake/runner/work/rundock', CHECKOUT]) dir(d, 0o755, RUNNER.uid);
  for (const d of ['src', 'docs', 'scripts', 'test', '.git']) dir(path.join(CHECKOUT, d), 0o755, RUNNER.uid);
  file(path.join(CHECKOUT, 'package.json'), '{"name":"x"}\n', 0o644, RUNNER.uid);
  file(path.join(CHECKOUT, 'package-lock.json'), '{"lockfileVersion":3}\n', 0o644, RUNNER.uid);
  file(path.join(CHECKOUT, 'src/a.js'), 'module.exports = 1;\n', 0o644, RUNNER.uid);
  link(path.join(CHECKOUT, 'src/link.js'), 'a.js', RUNNER.uid);
  file(path.join(CHECKOUT, 'docs/x.md'), '# x\n', 0o644, RUNNER.uid);
  file(path.join(CHECKOUT, 'scripts/run.sh'), 'exit 0\n', 0o755, RUNNER.uid);
  file(path.join(CHECKOUT, 'test/a.test.js'), "require('node:test')('a works', () => {});\n", 0o644, RUNNER.uid);
  file(path.join(CHECKOUT, '.git/HEAD'), 'ref: refs/heads/main\n', 0o644, RUNNER.uid);
  // The runner image leaves its tool cache writable by everyone.
  for (const d of ['/fake/toolcache', '/fake/toolcache/node', '/fake/toolcache/node/24.12.0', NODE_DIR, `${NODE_DIR}/bin`, `${NODE_DIR}/lib`]) dir(d, 0o777, RUNNER.uid);
  file(NODE, '', 0o777, RUNNER.uid);
  link(`${NODE_DIR}/bin/npm`, '../lib/npm-cli.js', RUNNER.uid);
  file(`${NODE_DIR}/lib/npm-cli.js`, '', 0o777, RUNNER.uid);

  sys.fs = fs;
  sys.result = result;
  sys.dir = dir;
  sys.file = file;
  sys.link = link;
  sys.mortal = mortal;
  // A process no kill stops, kept as sys.left so a test can name it.
  sys.immortalProc = (uid) => { const pid = mortal(uid); sys.immortal.add(pid); sys.left = pid; return pid; };
  const modules = {
    'node:fs': fs,
    'node:child_process': { spawnSync, execFileSync: () => { throw new Error('execFileSync is not faked'); } },
    'node:path': path,
    'node:crypto': crypto,
  };
  sys.require = (name) => {
    if (!Object.prototype.hasOwnProperty.call(modules, name)) throw new Error(`the steps may not require ${name} here`);
    return modules[name];
  };
  if (cfg.setup) cfg.setup(sys);
  return sys;
}

// Each step's own environment, as the runner gives it: its own file-command
// files, made empty, beside the inputs.
function stepEnv(sys, k) {
  const env = { RUNNER_TEMP, SIDE: sys.job, ENTRY: '1', TESTS: JSON.stringify(TESTS), ROWS: JSON.stringify(ROWS) };
  for (const key of FILE_KEYS) {
    env[key] = `${COMMANDS}/${key.toLowerCase()}_${k}`;
    sys.file(env[key], '', 0o644, RUNNER.uid);
  }
  return env;
}

// The spawns that run crontab, as a program or as a word of a command line.
const crontabCalls = (calls) => calls.filter((c) => c.fn === 'spawnSync'
  && [c.cmd, ...c.args].some((a) => String(a).split(/\s+/).some((word) => /(^|\/)crontab$/.test(word))));

/**
 * Runs one step whole, returning its exit code, what it printed and its calls.
 * Stop the test user must never run crontab, whatever else it finds, so every
 * run of it checks its recorded calls for one.
 */
function step(sys, name) {
  sys.step = name;
  const from = { out: sys.out.length, err: sys.err.length, calls: sys.calls.length };
  const proc = {
    env: stepEnv(sys, [...STEPS, JUDGE].indexOf(name)), execPath: NODE, getuid: () => RUNNER.uid, cwd: () => CHECKOUT,
    stdout: { write: (s) => { sys.out.push(String(s)); return true; } },
    stderr: { write: (s) => { sys.err.push(String(s)); return true; } },
    exit: (code) => { throw new Exit(code); },
  };
  for (const key of (sys.cfg.unset || {})[name] || []) delete proc.env[key];
  let code = 0;
  try {
    runStep(sys.job, name, sys.require, proc, WORKFLOW);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  }
  const calls = sys.calls.slice(from.calls);
  if (name === 'stop the test user') {
    assert.deepStrictEqual(crontabCalls(calls).map((c) => [c.cmd, ...c.args]), [], 'stop the test user never runs crontab');
  }
  return { code, env: proc.env, out: sys.out.slice(from.out).join(''), err: sys.err.slice(from.err).join(''), calls };
}

/**
 * Runs the steps before `name`, each of which must pass, then `name`, which
 * must fail with `why`, or with what `why(sys)` gives once it has run.
 */
function failsAt(job, name, cfg, why) {
  const sys = makeSystem(job, cfg);
  for (const before of STEPS.slice(0, STEPS.indexOf(name))) {
    const r = step(sys, before);
    assert.strictEqual(r.code, 0, `${before} was to pass: ${r.err}`);
  }
  const r = step(sys, name);
  assert.strictEqual(r.err, `${name} failed: ${typeof why === 'function' ? why(sys) : why}\n`);
  assert.strictEqual(r.code, 1);
  return { sys, r };
}

const testUserSpawns = (calls) => calls.filter((c) => c.fn === 'spawnSync' && c.as === 'test user');
const isKill = (c) => c.as === 'test user' && c.argv.join(' ') === '/usr/bin/kill -KILL -1';
const isProbe = (c) => c.as === 'test user' && c.argv[0] === NODE && c.argv[1] === '-e' && c.argv[2].includes('const [op, target]');
const isTestRun = (c) => c.as === 'test user' && c.argv[0] === NODE && c.argv[1] === '--test';
const isNpm = (c) => c.fn === 'spawnSync' && [c.cmd, ...c.args].some((a) => /(^|\/)npm$/.test(a));
const pathArg = (c) => String(c.args[0]);

describe('the test-user steps, run whole on fake system calls', () => {
  for (const job of ['red', 'green', 'break']) {
    test(`a ${job} job's steps pass when the test user is refused everything and the runs agree`, () => {
      const sys = makeSystem(job);
      const results = STEPS.map((name) => [name, step(sys, name)]);
      for (const [name, r] of results) assert.strictEqual(r.code, 0, `${name}: ${r.err}`);
      assert.deepStrictEqual(results.map(([, r]) => r.out.split('\n').filter(Boolean).pop()), [
        'the test user is made, and each thing it tried was refused',
        'the test user installed, and nothing outside node_modules changed',
        'the test ran three times, and each run selected exactly one test',
        "the test user left nothing behind, and each run's exit status agrees with its TAP",
        'nothing outside test/ changed during the runs',
      ]);
      const want = job === 'green' ? PASS_TAP : FAIL_TAP;
      for (let n = 1; n <= 3; n++) {
        assert.strictEqual(sys.nodes.get(`${EVIDENCE}/run-${n}.tap`).data.toString(), want);
        assert.deepStrictEqual(JSON.parse(sys.nodes.get(`${EVIDENCE}/exit-${n}.json`).data), { status: job === 'green' ? 0 : 1, signal: null });
      }
    });
  }

  describe('the calls the fakes record', () => {
    const sys = makeSystem('red');
    const byStep = Object.fromEntries(STEPS.map((name) => [name, step(sys, name)]));
    const all = sys.calls;

    test('the test user is made with its own group and no other', () => {
      const made = all.filter((c) => c.fn === 'spawnSync' && c.as === 'root' && c.argv[0] === '/usr/sbin/useradd');
      assert.deepStrictEqual(made.map((c) => c.argv), [['/usr/sbin/useradd', '--user-group', '--create-home', '--shell', '/usr/sbin/nologin', 'prove-test']]);
      assert.ok(!made[0].argv.some((a) => /^(-G|--groups|-g|--gid)/.test(a)), 'no group is named');
    });

    test('the deny entries are written for cron and at', () => {
      assert.strictEqual(sys.nodes.get('/etc/cron.deny').data.toString(), 'prove-test\n');
      assert.strictEqual(sys.nodes.get('/etc/at.deny').data.toString(), 'prove-test\n');
    });

    test("the runner's home is closed to group and others, and the test user's home lets it read only the copy", () => {
      assert.ok(all.some((c) => c.fn === 'chmodSync' && c.args[0] === RUNNER.home));
      assert.strictEqual(sys.nodes.get(RUNNER.home).mode & 0o077, 0);
      assert.strictEqual(sys.nodes.get(TEST_HOME).mode, 0o711);
      assert.deepStrictEqual([sys.nodes.get(`${TEST_HOME}-scratch`).mode, sys.nodes.get(`${TEST_HOME}-scratch`).uid], [0o700, 1001]);
    });

    test("the evidence directory is the runner's, made 0700", () => {
      const made = all.filter((c) => c.fn === 'mkdirSync' && c.args[0] === EVIDENCE);
      assert.deepStrictEqual(made.map((c) => c.args[1]), [{ mode: 0o700 }]);
      const node = sys.nodes.get(EVIDENCE);
      assert.deepStrictEqual([node.type, node.mode, node.uid], ['dir', 0o700, RUNNER.uid]);
    });

    test("the Node installation and the directories above it lose group and other write", () => {
      for (const [at, node] of sys.nodes) {
        if ((at === NODE_DIR || at.startsWith(`${NODE_DIR}/`)) && node.type !== 'link') assert.strictEqual(node.mode & 0o022, 0, at);
      }
      for (const at of ['/fake/toolcache', '/fake/toolcache/node', '/fake/toolcache/node/24.12.0']) assert.strictEqual(sys.nodes.get(at).mode & 0o022, 0, at);
    });

    test('the copy holds every entry but .git, owned by the test user, a symlink copied as a symlink and its target never read', () => {
      const inCopy = [...sys.nodes.keys()].filter((k) => k.startsWith(`${COPY}/`) && !k.startsWith(`${COPY}/node_modules`)).map((k) => k.slice(COPY.length + 1)).sort();
      assert.deepStrictEqual(inCopy, ['docs', 'docs/x.md', 'package-lock.json', 'package.json', 'scripts', 'scripts/run.sh', 'src', 'src/a.js', 'src/link.js', 'test', 'test/a.test.js']);
      const linked = sys.nodes.get(`${COPY}/src/link.js`);
      assert.deepStrictEqual([linked.type, linked.target.toString(), linked.uid], ['link', 'a.js', 1001]);
      assert.strictEqual(sys.nodes.get(`${COPY}/scripts/run.sh`).mode, 0o755);
      assert.strictEqual(sys.nodes.get(`${COPY}/src/a.js`).mode, 0o644);
      const links = [`${CHECKOUT}/src/link.js`, `${COPY}/src/link.js`];
      const reads = all.filter((c) => ['openSync', 'readFileSync', 'copyFileSync', 'realpathSync'].includes(c.fn) && links.includes(pathArg(c)));
      assert.deepStrictEqual(reads, [], 'nothing is read through a symlink');
      assert.ok(all.some((c) => c.fn === 'symlinkSync' && Buffer.isBuffer(c.args[0]) && c.args[0].toString() === 'a.js' && c.args[1] === `${COPY}/src/link.js`));
      assert.ok(!all.some((c) => c.fn !== 'spawnSync' && pathArg(c).startsWith(`${CHECKOUT}/.git`)), '.git is never looked at');
    });

    test('no call touches a path under /tmp, /var/tmp or /dev/shm', () => {
      const strings = (x) => (typeof x === 'string' ? [x] : Buffer.isBuffer(x) ? [x.toString()] : x && typeof x === 'object'
        ? Object.values(x).flatMap(strings) : []);
      for (const c of all) {
        for (const s of strings({ args: c.args, cwd: c.opts && c.opts.cwd })) assert.ok(!/\/(tmp|var\/tmp|dev\/shm)(\/|$)/.test(s), `${c.fn} ${s}`);
      }
    });

    // The temporary directory every process of the test user is given.
    const tmpGiven = () => {
      const given = [...new Set(testUserSpawns(all).map((c) => c.args.find((a) => a.startsWith('TMPDIR='))))];
      assert.strictEqual(given.length, 1, given.join(', '));
      return given[0].slice('TMPDIR='.length);
    };
    const within = (a, b) => a === b || a.startsWith(`${b}/`);

    test("the test user's temporary directory is apart from the runner's home, either way", () => {
      const tmp = tmpGiven();
      assert.ok(!within(tmp, RUNNER.home) && !within(RUNNER.home, tmp), tmp);
    });

    test("the test user's temporary directory is apart from the evidence directory, either way", () => {
      const tmp = tmpGiven();
      assert.ok(!within(tmp, EVIDENCE) && !within(EVIDENCE, tmp), tmp);
    });

    test('npm ci --ignore-scripts starts once, only through the test-user function', () => {
      const npm = all.filter(isNpm);
      assert.strictEqual(npm.length, 1);
      assert.strictEqual(npm[0].as, 'test user');
      assert.deepStrictEqual(npm[0].argv, ['npm', 'ci', '--ignore-scripts']);
      assert.strictEqual(npm[0].opts.cwd, COPY);
    });

    test('every process of the test user starts with only its five variables, no input, and capped pipes', () => {
      const spawns = testUserSpawns(all);
      assert.ok(spawns.length > 20);
      for (const c of spawns) {
        assert.deepStrictEqual(c.args.slice(0, 11), ['-n', '-u', 'prove-test', '--', '/usr/bin/env', '-i', `PATH=${NODE_DIR}/bin:/usr/bin:/bin`,
          `HOME=${TEST_HOME}`, `TMPDIR=${TEST_HOME}-scratch`, 'LANG=C.UTF-8', 'CI=true']);
        assert.deepStrictEqual([c.opts.argv0, c.opts.stdio[0], c.opts.maxBuffer], ['sudo', 'ignore', LIMIT]);
      }
      for (const c of all.filter((x) => x.fn === 'spawnSync')) assert.strictEqual(c.opts.maxBuffer, LIMIT, c.cmd);
    });

    for (const [name, first] of [['install', isNpm], ['run the test', isTestRun]]) {
      test(`${name} checks every file-command file before the first command from the commits`, () => {
        const { calls, env } = byStep[name];
        const start = calls.findIndex(first);
        assert.ok(start > 0);
        const probes = calls.slice(0, start).filter(isProbe).map((c) => c.argv.slice(3).join(' '));
        for (const key of FILE_KEYS) {
          assert.ok(probes.includes(`append ${env[key]}`), `${key} append`);
          assert.ok(probes.includes(`create ${COMMANDS}`), `${key} create`);
        }
        assert.strictEqual(probes.length, 10);
      });
    }

    for (const [name, count] of [['install', 2], ['run the test', 4]]) {
      test(`${name} takes each of its ${count} snapshots only after a kill and a check that no process is left`, () => {
        const { calls } = byStep[name];
        const shots = calls.map((c, k) => [c, k]).filter(([c]) => c.fn === 'readdirSync' && c.args[0] === COPY).map(([, k]) => k);
        assert.strictEqual(shots.length, count);
        for (const at of shots) {
          const spawns = calls.slice(0, at).map((c, k) => [c, k]).filter(([c]) => c.fn === 'spawnSync');
          const [kill, k] = spawns[spawns.length - 1];
          assert.ok(isKill(kill), `the last process before the snapshot at call ${at} is a kill`);
          assert.ok(calls.slice(k, at).some((c) => c.fn === 'readdirSync' && c.args[0] === '/proc'), 'the processes are listed after the kill');
        }
      });
    }

    test('run the test passes no reporter destination and fences off what the test prints', () => {
      const { calls, out } = byStep['run the test'];
      const runs = calls.filter(isTestRun);
      assert.strictEqual(runs.length, 3);
      for (const c of runs) {
        assert.ok(!c.argv.some((a) => a.startsWith('--test-reporter-destination')));
        assert.strictEqual(c.opts.cwd, COPY);
      }
      const fence = /^::stop-commands::([0-9a-f]{32})$/m.exec(out);
      assert.ok(fence, 'a stop-commands line with a 32-digit token');
      const [before, inside] = out.split(fence[0]);
      assert.ok(!before.includes('TAP version'));
      assert.ok(inside.includes(`\n::${fence[1]}::\n`));
      assert.strictEqual(inside.split(`::${fence[1]}::`)[0].split('TAP version 13').length - 1, 3);
    });

    test('run the test keeps each snapshot in the evidence directory, test/ and .git left out', () => {
      for (let n = 0; n <= 3; n++) {
        const shot = new Map(JSON.parse(sys.nodes.get(`${EVIDENCE}/tree-${n}.json`).data));
        assert.ok(![...shot.keys()].some((k) => k === 'test' || k.startsWith('test/')));
        assert.strictEqual(shot.get('src/link.js'), 'link a.js');
        assert.strictEqual(shot.get('src'), 'dir');
        assert.strictEqual(shot.get('scripts/run.sh'), `x ${crypto.createHash('sha256').update('exit 0\n').digest('hex')}`);
        assert.ok(shot.has('node_modules/dep/index.js'));
      }
    });
  });

  describe('prepare the test user', () => {
    const PROBES = [
      ['connect', '/var/run/docker.sock'], ['list', RUNNER.home], ['list', EVIDENCE], ['create', EVIDENCE], ['write', NODE],
      ['create', `${NODE_DIR}/bin`], ['create', '/usr/bin'], ['create', '/bin'],
    ];
    for (const [op, target] of PROBES) {
      test(`fails when the test user's ${op} of ${target} is allowed`, () => {
        failsAt('red', 'prepare the test user', { probe: (o, t) => (o === op && t === target ? 'allowed' : null) },
          `the test user's ${op} of ${JSON.stringify(target)} gave "allowed", where it must be refused`);
      });
    }

    test('fails when a probe meets an error other than a refusal', () => {
      failsAt('red', 'prepare the test user', { probe: (o, t) => (t === RUNNER.home ? 'ENOENT' : null) },
        `the test user's list of ${JSON.stringify(RUNNER.home)} gave "ENOENT", where it must be refused`);
    });

    test('fails when the test user may run sudo', () => {
      failsAt('red', 'prepare the test user', { sudo: true }, 'the test user ran sudo -n true');
    });

    for (const [what, cfg, shown] of [['uid 0', { idU: '0' }, 'uid "0"'], ["the runner's uid", { idU: '1000' }, 'uid "1000"']]) {
      test(`fails when id shows the test user as ${what}`, () => {
        failsAt('red', 'prepare the test user', cfg, `id shows the test user as ${shown}`);
      });
    }

    test('fails when id shows the test user in a group besides its own', () => {
      failsAt('red', 'prepare the test user', { idG: '1001 27' },
        'id shows the test user in the groups "1001 27", where it must be in its own only');
    });

    test("fails when the test user's environment holds a sixth key", () => {
      failsAt('red', 'prepare the test user', { extraEnv: ['NODE_OPTIONS'] },
        'the test user\'s environment holds "CI HOME LANG NODE_OPTIONS PATH TMPDIR", where it must hold only CI HOME LANG PATH TMPDIR');
    });

    test('fails when a target is missing, so its refusal would prove nothing', () => {
      failsAt('red', 'prepare the test user', { setup: (sys) => sys.nodes.delete('/var/run/docker.sock') },
        '"/var/run/docker.sock" does not exist, so a refusal there would prove nothing');
    });

    test('fails when the Node installation keeps group or other write', () => {
      failsAt('red', 'prepare the test user', { chmodSkip: (argv) => argv[1] === '-R' },
        `${JSON.stringify(NODE_DIR)} in the Node installation can be written by group or others`);
    });

    test('fails when a directory above the Node installation stays open', () => {
      failsAt('red', 'prepare the test user', { chmodSkip: (argv) => argv[2] === '/fake/toolcache' },
        '"/fake/toolcache", above the Node installation, can be written by group or others');
    });

    test('leaves a sticky directory above the Node installation as it is', () => {
      const sys = makeSystem('red', { setup: (s) => { s.nodes.get('/fake/toolcache').mode = 0o1777; } });
      assert.strictEqual(step(sys, 'prepare the test user').code, 0);
      assert.strictEqual(sys.nodes.get('/fake/toolcache').mode, 0o1777);
    });

    test('fails when the test user owns an entry of the Node installation', () => {
      failsAt('red', 'prepare the test user', { setup: (sys) => { sys.nodes.get(`${NODE_DIR}/lib/npm-cli.js`).uid = 1001; } },
        `"${NODE_DIR}/lib/npm-cli.js" in the Node installation is owned by the test user`);
    });

    test("fails when the test user's home is inside the runner's", () => {
      failsAt('red', 'prepare the test user', { user: { home: `${RUNNER.home}/prove-test` } },
        `the test user's home "${RUNNER.home}/prove-test" is not apart from the runner's`);
    });

    test("fails when the test user has the runner's uid", () => {
      failsAt('red', 'prepare the test user', { user: { uid: 1000 } }, 'the test user has uid 1000 and gid 1001, which root or the runner has');
    });

    test('fails when the copy meets an entry that is not a directory, file or symlink', () => {
      failsAt('red', 'prepare the test user', { setup: (sys) => sys.nodes.set(`${CHECKOUT}/src/pipe`, { type: 'fifo', mode: 0o644, uid: 1000, gid: 1000 }) },
        '"src/pipe" is not a directory, regular file or symlink, which the copy refuses');
    });
  });

  describe('install', () => {
    for (const key of FILE_KEYS) {
      test(`fails, before npm starts, when the test user may append to ${key}`, () => {
        const file = `${COMMANDS}/${key.toLowerCase()}_1`;
        const { r } = failsAt('red', 'install', { probe: (o, t) => (o === 'append' && t === file ? 'allowed' : null) },
          `${key}: the test user's append of ${JSON.stringify(file)} gave "allowed", where it must be refused`);
        assert.ok(!r.calls.some(isNpm));
      });
    }

    test('fails, before npm starts, when the test user may create a file beside the file-command files', () => {
      const { r } = failsAt('red', 'install', { probe: (o, t, sys) => (sys.step === 'install' && o === 'create' && t === COMMANDS ? 'allowed' : null) },
        `GITHUB_ENV: the test user's create of ${JSON.stringify(COMMANDS)} gave "allowed", where it must be refused`);
      assert.ok(!r.calls.some(isNpm));
    });

    test('fails, before npm starts, when a file-command variable names no file', () => {
      const { r } = failsAt('red', 'install', { unset: { install: ['GITHUB_STATE'] } }, 'GITHUB_STATE names no file');
      assert.ok(!r.calls.some(isNpm));
    });

    test('fails when a process of the test user is running before npm starts', () => {
      const { r } = failsAt('red', 'install', { setup: (sys) => { sys.procs.set('299', 1001); sys.immortal.add('299'); } },
        'before npm, process 299 of the test user is still running after kill -KILL -1');
      assert.ok(!r.calls.some(isNpm));
    });

    test('fails when npm leaves a process the kill cannot stop', () => {
      failsAt('red', 'install', { onNpm: (sys) => sys.immortalProc(1001) },
        (sys) => `after npm, process ${sys.left} of the test user is still running after kill -KILL -1`);
    });

    test('fails when npm writes more than a pipe may carry', () => {
      failsAt('red', 'install', { npm: { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync /usr/bin/sudo ENOBUFS'), { code: 'ENOBUFS' }) } },
        `npm wrote more than the ${LIMIT} bytes a pipe may carry`);
    });

    test('fails when npm exits with a status other than 0, or by a signal', () => {
      failsAt('red', 'install', { npm: { status: 1 } }, 'npm ci --ignore-scripts ended with exit status 1');
      failsAt('red', 'install', { npm: { status: null, signal: 'SIGKILL' } }, 'npm ci --ignore-scripts ended with SIGKILL');
    });

    for (const [what, change, why] of [
      ['a file added', (sys) => sys.file(`${COPY}/src/b.js`, '2;\n', 0o644, 1001), '"src/b.js" was added'],
      ['a file changed', (sys) => { sys.nodes.get(`${COPY}/package-lock.json`).data = Buffer.from('{}\n'); }, '"package-lock.json" was changed'],
      ['a test file changed', (sys) => { sys.nodes.get(`${COPY}/test/a.test.js`).data = Buffer.from('1;\n'); }, '"test/a.test.js" was changed'],
      ['a node_modules below the top level', (sys) => sys.dir(`${COPY}/src/node_modules`, 0o755, 1001), '"src/node_modules" was added'],
      ['a symlink retargeted', (sys) => { sys.nodes.get(`${COPY}/src/link.js`).target = Buffer.from('b.js'); }, '"src/link.js" was changed'],
      ['a file removed', (sys) => sys.nodes.delete(`${COPY}/docs/x.md`), '"docs/x.md" was removed'],
    ]) {
      test(`fails, naming it, when npm leaves ${what} outside node_modules`, () => {
        failsAt('red', 'install', { onNpm: change }, `outside node_modules, ${why}`);
      });
    }
  });

  describe('run the test', () => {
    test('fails, before any run, when the test user may append to a file-command file', () => {
      const { r } = failsAt('red', 'run the test', { probe: (o, t, sys) => (sys.step === 'run the test' && t.endsWith('github_path_2') ? 'allowed' : null) },
        `GITHUB_PATH: the test user's append of "${COMMANDS}/github_path_2" gave "allowed", where it must be refused`);
      assert.ok(!r.calls.some(isTestRun));
    });

    test('fails, before the first snapshot, when a process of the test user is left', () => {
      const { sys, r } = failsAt('red', 'run the test', { spawn: (c, s) => {
        if (s.step === 'run the test' && isProbe(c) && !s.left) s.immortalProc(1001);
        return null;
      } }, (s) => `before the first run, process ${s.left} of the test user is still running after kill -KILL -1`);
      assert.ok(!r.calls.some(isTestRun));
      assert.ok(!sys.nodes.has(`${EVIDENCE}/tree-0.json`));
    });

    for (const n of [1, 2, 3]) {
      test(`fails, before its snapshot, when run ${n} leaves a process the kill cannot stop`, () => {
        const { sys } = failsAt('red', 'run the test', { onRun: (k, s) => { if (k === n) s.immortalProc(1001); } },
          (s) => `after run ${n}, process ${s.left} of the test user is still running after kill -KILL -1`);
        assert.ok(!sys.nodes.has(`${EVIDENCE}/tree-${n}.json`));
      });
    }

    test('fails when a run writes more than a pipe may carry', () => {
      failsAt('red', 'run the test', { run: (n) => (n === 2 ? { error: Object.assign(new Error('spawnSync /usr/bin/sudo ENOBUFS'), { code: 'ENOBUFS' }), status: null, signal: 'SIGTERM' } : null) },
        `run 2: ${NODE} wrote more than the ${LIMIT} bytes a pipe may carry`);
    });

    test('fails when the name selects two tests', () => {
      failsAt('red', 'run the test', { run: () => ({ tap: TWO_TAP, status: 0 }) }, 'run 1: the name selected 2 tests, where it must select exactly one');
    });

    for (const [what, change, why] of [
      ['a FIFO', (sys) => sys.nodes.set(`${COPY}/src/pipe`, { type: 'fifo', mode: 0o644, uid: 1001, gid: 1001 }), '"src/pipe" is a FIFO, which a snapshot refuses'],
      ['a socket', (sys) => sys.nodes.set(`${COPY}/src/sock`, { type: 'socket', mode: 0o644, uid: 1001, gid: 1001 }), '"src/sock" is a socket, which a snapshot refuses'],
      ['a name holding byte 0xFF', (sys) => { sys.nodes.get(`${COPY}/src`).extraRaw = [Buffer.from([0xff, 0x2e, 0x6a, 0x73])]; }, '"src/\\xFF.js" has a name that is not well-formed UTF-8'],
      ['an unreadable file', (sys) => { sys.nodes.get(`${COPY}/src/a.js`).noRead = true; }, '"src/a.js" cannot be read (EACCES)'],
      ['an unreadable directory', (sys) => { sys.nodes.get(`${COPY}/docs`).noList = true; }, '"docs" cannot be read (EACCES)'],
    ]) {
      test(`fails its snapshot, naming it, when a run leaves ${what}`, () => {
        failsAt('red', 'run the test', { onRun: (n, sys) => { if (n === 2) change(sys); } }, why);
      });
    }

    test('lets a run change test/', () => {
      const sys = makeSystem('red', { onRun: (n, s) => {
        s.nodes.get(`${COPY}/test/a.test.js`).data = Buffer.from(`${n};\n`);
        s.file(`${COPY}/test/made-${n}.js`, 'x', 0o644, 1001);
      } });
      for (const name of STEPS) assert.strictEqual(step(sys, name).code, 0, name);
    });
  });

  describe('check the tree', () => {
    for (const [n, what, change, why] of [
      [1, 'a symlink retargeted', (sys) => { sys.nodes.get(`${COPY}/src/link.js`).target = Buffer.from('b.js'); }, '"src/link.js" was changed'],
      [2, 'a directory added', (sys) => sys.dir(`${COPY}/src/new`, 0o755, 1001), '"src/new" was added'],
      [3, 'a directory removed', (sys) => { sys.nodes.delete(`${COPY}/docs/x.md`); sys.nodes.delete(`${COPY}/docs`); }, '"docs" was removed'],
      [2, 'a file changed', (sys) => { sys.nodes.get(`${COPY}/src/a.js`).data = Buffer.from('module.exports = 2;\n'); }, '"src/a.js" was changed'],
      [1, 'an executable bit set', (sys) => { sys.nodes.get(`${COPY}/src/a.js`).mode = 0o755; }, '"src/a.js" was changed'],
      [1, 'a file added in node_modules', (sys) => sys.file(`${COPY}/node_modules/dep/cache`, 'x', 0o644, 1001), '"node_modules/dep/cache" was added'],
    ]) {
      test(`fails, naming it, when run ${n} leaves ${what}`, () => {
        failsAt('red', 'check the tree', { onRun: (k, sys) => { if (k === n) change(sys); } }, `during run ${n}, ${why}`);
      });
    }
  });

  describe('stop the test user', () => {
    test('fails when a process of the test user is left', () => {
      failsAt('red', 'stop the test user', { spawn: (c, s) => {
        if (s.step === 'stop the test user' && isKill(c) && !s.left) s.immortalProc(1001);
        return null;
      } }, (s) => `process ${s.left} of the test user is still running after kill -KILL -1`);
    });

    // The crontab check lists cron's spool as root and never runs crontab,
    // whose deny list refuses the test user even to root. Each run of the
    // step, in these cases and every other, checks that it ran no crontab.
    const STOP = 'stop the test user';
    const SPOOL_ERROR = (cause, stderr) => `cron's spool "${SPOOL}" cannot be listed as root (${cause}): ${JSON.stringify(stderr)}`;
    const HAS_CRONTAB = `the test user has a crontab, "${SPOOL}/prove-test"`;
    const listings = (calls) => calls.filter((c) => c.as === 'root' && c.argv[0] === '/usr/bin/find').map((c) => c.argv);
    // Answers the spool listing with `answer(sys)` in place of the fake find.
    const listing = (answer) => ({ rootSpawn: (c, s) => (s.step === STOP && c.argv[0] === '/usr/bin/find' ? answer(s) : null) });
    // Runs the steps before stop the test user, each of which must pass, then
    // stop the test user, which must pass too.
    function stops(job, cfg) {
      const sys = makeSystem(job, cfg);
      for (const before of STEPS.slice(0, STEPS.indexOf(STOP))) assert.strictEqual(step(sys, before).code, 0, before);
      const r = step(sys, STOP);
      assert.strictEqual(r.code, 0, r.err);
      assert.strictEqual(r.out, "the test user left nothing behind, and each run's exit status agrees with its TAP\n");
      return { sys, r };
    }
    const failsStop = (cfg, why) => failsAt('red', STOP, cfg, why).r;

    test("the fake crontab refuses the test user once it is in cron.deny, as Ubuntu's does, whatever the spool holds", () => {
      const sys = makeSystem('red');
      assert.strictEqual(step(sys, 'prepare the test user').code, 0);
      const crontab = () => sys.require('node:child_process').spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/crontab', '-l', '-u', 'prove-test'], {});
      const refused = (r) => [r.status, String(r.stderr)];
      assert.deepStrictEqual(refused(crontab()), [1, 'The user prove-test cannot use this program (crontab)\n']);
      sys.file(`${SPOOL}/prove-test`, '* * * * * /bin/true\n', 0o600, 1001);
      assert.deepStrictEqual(refused(crontab()), [1, 'The user prove-test cannot use this program (crontab)\n']);
    });

    for (const job of ['red', 'green', 'break']) {
      test(`passes in a ${job} job when nothing is left behind, listing the spool as root and never running crontab`, () => {
        const { r } = stops(job);
        assert.deepStrictEqual(listings(r.calls), [['/usr/bin/find', SPOOL, ...FIND_NAMES]]);
      });
    }

    test("fails, naming it, when the spool holds a regular file named the test user's name", () => {
      failsStop({ setup: (sys) => sys.file(`${SPOOL}/prove-test`, '* * * * * /bin/true\n', 0o600, 1001) }, HAS_CRONTAB);
    });

    for (const [what, add] of [
      ['a directory', (sys) => sys.dir(`${SPOOL}/prove-test`, 0o700, 1001)],
      ['a dangling symlink', (sys) => sys.link(`${SPOOL}/prove-test`, '/fake/nowhere', 1001)],
    ]) {
      test(`fails, naming it, when the spool holds ${what} named the test user's name`, () => {
        failsStop({ setup: add }, HAS_CRONTAB);
      });
    }

    test('passes when the spool holds entries for other users only, root, prove-test2 and xprove-test among them', () => {
      stops('red', { setup: (sys) => {
        for (const name of ['root', 'prove-test2', 'xprove-test', 'prove-tes', 'Prove-test']) sys.file(`${SPOOL}/${name}`, '', 0o600);
      } });
    });

    // Each name is read whole, up to the 0x00 find ends it with, so a newline
    // in a name never splits it. Neither name is exactly the test user's, and
    // cron reads a user's crontab only from the entry named exactly after
    // them, so neither is the test user's crontab: passing is safe.
    test("passes when entries' names hold a newline beside the test user's name, since no name is exactly the test user's", () => {
      stops('red', { setup: (sys) => {
        for (const name of ['x\nprove-test', 'prove-test\nx']) sys.file(`${SPOOL}/${name}`, '* * * * * /bin/true\n', 0o600);
      } });
    });

    test("fails, naming it, when the test user's entry sits beside names that hold a newline or bytes that are not UTF-8", () => {
      failsStop({ setup: (sys) => {
        for (const name of ['x\nprove-test', 'prove-test\nx', 'prove-test', '\nprove-test\n']) sys.file(`${SPOOL}/${name}`, '', 0o600);
        sys.nodes.get(SPOOL).extraRaw = [Buffer.from([0x70, 0xff, 0x0a])];
      } }, HAS_CRONTAB);
    });

    test('fails, naming why, when the listing holds a name it cannot read whole', () => {
      for (const [stdout, shown] of [['root\0prove-te', '"root\\u0000prove-te"'], ['root\0\0', '"root\\u0000\\u0000"']]) {
        failsStop(listing((s) => s.result({ stdout })), `cron's spool "${SPOOL}" lists a name that cannot be read: ${shown}`);
      }
    });

    test('fails, naming the directory, when the spool is missing', () => {
      failsStop({ setup: (sys) => sys.nodes.delete(SPOOL) }, SPOOL_ERROR('exit status 1', `/usr/bin/find: '${SPOOL}': No such file or directory`));
    });

    test('fails, naming the status and the stderr, when the listing exits nonzero', () => {
      failsStop(listing((s) => s.result({ status: 1, stdout: 'root\0', stderr: `find: '${SPOOL}/root': Input/output error\n` })),
        SPOOL_ERROR('exit status 1', `find: '${SPOOL}/root': Input/output error`));
    });

    test('fails, naming the spawn error, when the listing cannot be started', () => {
      const error = Object.assign(new Error('spawnSync /usr/bin/sudo ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawnSync /usr/bin/sudo', path: '/usr/bin/sudo' });
      failsStop(listing(() => ({ error, pid: 0, status: null, signal: null, output: null, stdout: undefined, stderr: undefined })), SPOOL_ERROR('spawn error ENOENT', ''));
    });

    test('fails, naming the signal, when the listing is ended by a signal', () => {
      failsStop(listing((s) => s.result({ status: null, signal: 'SIGKILL', stdout: 'root\0prove-' })), SPOOL_ERROR('signal SIGKILL', ''));
    });

    test('lists no spool when crontab is not installed, as before', () => {
      const { r } = stops('red', { setup: (sys) => sys.nodes.delete('/usr/bin/crontab') });
      assert.deepStrictEqual(listings(r.calls), []);
    });

    test('fails when the test user has an at job', () => {
      failsAt('red', 'stop the test user', { atq: '1\tSun Nov 22 10:00:00 2026 a root\n7\tSun Nov 22 10:00:00 2026 a prove-test\n' },
        'the test user has an at job: "7\\tSun Nov 22 10:00:00 2026 a prove-test"');
    });

    test('fails when the test user has a linger file', () => {
      failsAt('red', 'stop the test user', { onRun: (n, sys) => sys.file('/var/lib/systemd/linger/prove-test') },
        'the test user has a linger file, "/var/lib/systemd/linger/prove-test"');
    });

    for (const [job, run, why] of [
      ['green', (n) => (n === 1 ? { tap: PASS_TAP, status: 1 } : null), 'run 1 is passed in its TAP, but exited with status 1, not 0'],
      ['green', (n) => (n === 3 ? { tap: PASS_TAP, status: null, signal: 'SIGTERM' } : null), 'run 3 was ended by SIGTERM'],
      ['red', (n) => (n === 2 ? { tap: FAIL_TAP, status: 0 } : null), 'run 2 is assertion failed in its TAP, but exited with status 0, not 1'],
      ['red', (n) => (n === 1 ? { tap: FAIL_TAP, status: 2 } : null), 'run 1 is assertion failed in its TAP, but exited with status 2, not 1'],
      ['break', (n) => (n === 1 ? { tap: FAIL_TAP, status: null, signal: 'SIGKILL' } : null), 'run 1 was ended by SIGKILL'],
    ]) {
      test(`fails in a ${job} job when ${why}`, () => {
        failsAt(job, 'stop the test user', { run }, why);
      });
    }
  });
});

describe('judge the result, run whole on the evidence the steps before it leave', () => {
  const WANT = { red: 'assertion failed', green: 'passed', break: 'assertion failed' };

  // Runs the steps before it, each of which must pass, then `between(sys)`,
  // then judge the result. The step prints through console rather than its
  // process, so its lines are taken by standing in for console.log and
  // console.error while it runs.
  function judge(job, cfg = {}, between = () => {}) {
    const sys = makeSystem(job, cfg);
    for (const name of STEPS) {
      const r = step(sys, name);
      assert.strictEqual(r.code, 0, `${name} was to pass: ${r.err}`);
    }
    between(sys);
    const said = { out: [], err: [] };
    const { log, error } = console;
    console.log = (...a) => { said.out.push(a.join(' ')); };
    console.error = (...a) => { said.err.push(a.join(' ')); };
    let r;
    try {
      r = step(sys, JUDGE);
    } finally {
      console.log = log;
      console.error = error;
    }
    return { code: r.code, out: said.out.join('\n'), err: said.err.join('\n') };
  }

  for (const job of ['red', 'green', 'break']) {
    test(`passes a ${job} job whose three runs are each ${WANT[job]}`, () => {
      const r = judge(job);
      assert.strictEqual(r.err, '');
      assert.strictEqual(r.code, 0);
      assert.deepStrictEqual(r.out.split('\n').slice(-4), [
        `run 1: ${WANT[job]}`, `run 2: ${WANT[job]}`, `run 3: ${WANT[job]}`, `every run is ${WANT[job]}, as a ${job} job needs`,
      ]);
    });
  }

  for (const job of ['red', 'break']) {
    test(`fails a ${job} job whose runs pass`, () => {
      const r = judge(job, { run: () => ({ tap: PASS_TAP, status: 0 }) });
      assert.strictEqual(r.err, `judge the result failed: run 1: passed, where a ${job} job needs every run to be assertion failed`);
      assert.strictEqual(r.code, 1);
    });
  }

  test('fails a green job whose runs fail on an assertion', () => {
    const r = judge('green', { run: () => ({ tap: FAIL_TAP, status: 1 }) });
    assert.strictEqual(r.err, 'judge the result failed: run 1: assertion failed, where a green job needs every run to be passed');
    assert.strictEqual(r.code, 1);
  });

  for (const [job, n, result, got] of [
    ['red', 3, { tap: PASS_TAP, status: 0 }, 'passed'],
    ['green', 2, { tap: FAIL_TAP, status: 1 }, 'assertion failed'],
  ]) {
    test(`fails a ${job} job when run ${n} alone is ${got}`, () => {
      const r = judge(job, { run: (k) => (k === n ? result : null) });
      assert.strictEqual(r.err, `judge the result failed: run ${n}: ${got}, where a ${job} job needs every run to be ${WANT[job]}`);
      assert.strictEqual(r.code, 1);
    });
  }

  for (const job of ['red', 'green', 'break']) {
    test(`fails a ${job} job when the TAP of run 3 is missing`, () => {
      const r = judge(job, {}, (sys) => sys.nodes.delete(`${EVIDENCE}/run-3.tap`));
      assert.strictEqual(r.err, `judge the result failed: run 3: unparseable, where a ${job} job needs every run to be ${WANT[job]}`);
      assert.strictEqual(r.code, 1);
    });
  }
});

// The fake find beside GNU find itself, so the listings stop the test user is
// tested on are the ones the real tool gives. Each tree is made for real in a
// directory this test makes and removes, never in cron's spool, and the same
// way in the fake file system, and both are listed with the arguments the
// step passes, taken from a run of it. GNU find is /usr/bin/find on Linux,
// where CI runs the suite, and there a find that is missing or is not GNU
// find fails these tests rather than skipping them.
describe('the fake find, beside GNU find', () => {
  const GNU_FIND = '/usr/bin/find';
  const SKIP = process.platform === 'linux' ? false
    : `the fake find is compared with GNU find, which is ${GNU_FIND} on Linux only, and this is ${process.platform}`;
  // In the C locale find quotes a path in its messages with ' marks, and in
  // a UTF-8 one with curly marks. The step passes a message on whatever its
  // wording, and the fake answers as the C locale does.
  const LOCALE = { LC_ALL: 'C' };
  // Each tree: what it is, what stands at the directory's path, and the
  // entries in it, each a type and a name. A name given as bytes is not UTF-8.
  const TREES = [
    ['an empty directory', 'dir', []],
    ['a directory holding a regular file named prove-test', 'dir', [['file', 'prove-test']]],
    ['a directory holding a directory named prove-test, with a file in it', 'dir', [['dir', 'prove-test'], ['file', 'prove-test/crontab']]],
    ['a directory holding a dangling symlink named prove-test', 'dir', [['link', 'prove-test']]],
    ['a directory holding root, prove-test2 and xprove-test', 'dir', [['file', 'root'], ['file', 'prove-test2'], ['file', 'xprove-test']]],
    ['a directory holding names with a newline beside prove-test', 'dir', [['file', 'x\nprove-test'], ['file', 'prove-test\nx']]],
    ['a directory holding prove-test beside names with a newline or bytes that are not UTF-8', 'dir',
      [['file', 'prove-test'], ['file', '\nprove-test\n'], ['file', Buffer.from([0x70, 0xff, 0x0a])]]],
    ['a regular file in place of the directory', 'file', []],
    ['a missing directory', 'missing', []],
  ];

  // The arguments after the directory that stop the test user lists cron's
  // spool with, from a run of the step, so a change to them is compared too.
  let stepArgs = null;
  function findArgs() {
    if (stepArgs) return stepArgs;
    const sys = makeSystem('red');
    for (const name of STEPS.slice(0, STEPS.indexOf('stop the test user'))) assert.strictEqual(step(sys, name).code, 0, name);
    const finds = step(sys, 'stop the test user').calls.filter((c) => c.as === 'root' && c.argv[0] === '/usr/bin/find');
    assert.strictEqual(finds.length, 1, 'stop the test user lists the spool once, with find');
    assert.strictEqual(finds[0].argv[1], SPOOL);
    stepArgs = finds[0].argv.slice(2);
    return stepArgs;
  }

  function assertGnuFind() {
    const r = realSpawnSync(GNU_FIND, ['--version'], { env: LOCALE, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(!r.error, `${GNU_FIND} cannot be run: ${r.error && r.error.message}`);
    assert.match(String(r.stdout), /^find \(GNU findutils\) /, `${GNU_FIND} is not GNU find: ${JSON.stringify(String(r.stdout) + String(r.stderr))}`);
  }

  const named = (at, name) => Buffer.concat([Buffer.from(`${at}/`), Buffer.from(name)]);
  function makeReal(spool, top, entries) {
    if (top === 'file') realFs.writeFileSync(spool, '');
    if (top !== 'dir') return;
    realFs.mkdirSync(spool);
    for (const [type, name] of entries) {
      if (type === 'dir') realFs.mkdirSync(named(spool, name));
      if (type === 'file') realFs.writeFileSync(named(spool, name), '');
      if (type === 'link') realFs.symlinkSync(`${spool}-nowhere`, named(spool, name));
    }
  }
  function makeFake(top, entries) {
    const sys = makeSystem('red');
    sys.nodes.delete(SPOOL);
    if (top === 'file') sys.file(SPOOL, '');
    if (top !== 'dir') return sys;
    const spool = sys.dir(SPOOL, 0o1730);
    for (const [type, name] of entries) {
      if (Buffer.isBuffer(name)) spool.extraRaw = [...(spool.extraRaw || []), name];
      else if (type === 'dir') sys.dir(`${SPOOL}/${name}`);
      else if (type === 'file') sys.file(`${SPOOL}/${name}`, '');
      else sys.link(`${SPOOL}/${name}`, `${SPOOL}-nowhere`);
    }
    return sys;
  }

  // What a listing answers: how it ended, its stderr with the directory's path
  // written as cron's spool, and its stdout as the records each 0x00 ends,
  // then whatever follows the last 0x00. find lists a directory in the order
  // the file system reads it, which no one chooses, so the records are sorted:
  // every byte is compared, but not their order.
  function answer(r, spool) {
    const stdout = Buffer.from(r.stdout || '');
    const records = [];
    let from = 0;
    for (let k = 0; k < stdout.length; k++) {
      if (stdout[k] === 0) {
        records.push(stdout.subarray(from, k + 1).toString('latin1'));
        from = k + 1;
      }
    }
    return {
      error: r.error ? r.error.code : null, status: r.status, signal: r.signal,
      records: records.sort(), rest: stdout.subarray(from).toString('latin1'),
      stderr: String(r.stderr || '').split(spool).join(SPOOL),
    };
  }

  for (const [what, top, entries] of TREES) {
    test(`answers as GNU find does for ${what}`, { skip: SKIP }, () => {
      assertGnuFind();
      const args = findArgs();
      const tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'prove-find-'));
      try {
        const spool = `${tmp}/crontabs`;
        makeReal(spool, top, entries);
        const real = realSpawnSync(GNU_FIND, [spool, ...args], { cwd: tmp, env: LOCALE, stdio: ['ignore', 'pipe', 'pipe'] });
        const fake = makeFake(top, entries).require('node:child_process').spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/find', SPOOL, ...args], {});
        assert.deepStrictEqual(answer(fake, SPOOL), answer(real, spool));
      } finally {
        realFs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
