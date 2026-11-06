'use strict';
// Stub login shells and stub `claude` copies, in temp folders, for the tests
// of how Rundock finds Claude Code (lib/runtime/claude-lookup.js). No test
// runs a real shell or a real Claude Code.
//
// A STUB SHELL records each run (its arguments, whether its stdin was closed,
// its working folder and its whole environment), prints startup noise, then
// runs the command it was given the way a shell would, by a small evaluator
// that knows only `printf` with single-quoted or bare words, `printenv PATH` and
// `echo $PATH`; anything else is an unknown command, exit 127, as a shell
// says. What it does is read from `plan.json` beside it on every run, so a
// test can change it between runs:
//   loginPath  the PATH its startup files built (printenv PATH prints it),
//              or 'given': startup files that never touch PATH, so it
//              prints back the PATH it was started with
//   before     what the startup files print before the command runs
//   after      what is printed after it, as a logout file would
//   fail       'crash' (killed by a signal after its noise), 'stall' (never
//              answers), 'cut' (the first marker and part of the PATH, then
//              it ends), 'nonzero' (the whole answer, then exit 1), 'silent'
//              (noise and no answer)
//   style      'fish': `echo $PATH` prints the folders space-separated, as
//              fish does, and it greets as fish does; printenv still prints
//              the exported PATH colon-separated
const fs = require('node:fs');
const path = require('node:path');

function shellSource() {
  return `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8'));
const args = process.argv.slice(2);
let stdin = 'open';
try { stdin = fs.fstatSync(0).isCharacterDevice() ? 'closed' : 'open'; } catch (e) { stdin = 'closed'; }
fs.appendFileSync(path.join(__dirname, 'runs.jsonl'), JSON.stringify({ args, stdin, cwd: process.cwd(), env: process.env }) + '\\n');
const out = (s) => fs.writeSync(1, s);
if (plan.style === 'fish') out('Welcome to fish, the friendly interactive shell\\n');
out(plan.before || '');
if (plan.fail === 'crash') process.kill(process.pid, 'SIGKILL');
if (plan.fail === 'stall') { setInterval(() => {}, 1000); return; }
if (plan.fail === 'silent') process.exit(0);
if (plan.fail === 'cut') { out('_RUNDOCK_LOGIN_PATH_BEGIN_\\n' + String(plan.loginPath).slice(0, 8)); process.exit(0); }
const loginPath = plan.loginPath === 'given' ? process.env.PATH : plan.loginPath;
const command = args[args.indexOf('-c') + 1] || '';
const words = (s) => s.split(/\\s+/).filter(Boolean).map((w) => w.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1'));
for (const statement of command.split(';').map((s) => s.trim()).filter(Boolean)) {
  const [name, ...rest] = words(statement);
  if (name === 'printf') {
    let i = 0;
    out(rest[0].replace(/%s/g, () => rest[1 + i++] || '').replace(/\\\\n/g, '\\n'));
  } else if (name === 'printenv' && rest[0] === 'PATH') {
    out(loginPath + '\\n');
  } else if (name === 'echo' && rest[0] === '$PATH') {
    out((plan.style === 'fish' ? loginPath.split(':').join(' ') : loginPath) + '\\n');
  } else {
    process.stderr.write(name + ': command not found\\n');
    process.exit(127);
  }
}
out(plan.after || '');
process.exit(plan.fail === 'nonzero' ? 1 : 0);
`;
}

// A stub shell in its own temp folder (inside `parent`), named `name`.
function makeLoginShell(parent, plan, name = 'zsh') {
  const dir = fs.mkdtempSync(path.join(parent, 'shell-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, shellSource());
  fs.chmodSync(file, 0o755);
  const shell = {
    dir, file,
    plan: (next) => fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(next)),
    runs: () => {
      const log = path.join(dir, 'runs.jsonl');
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
  shell.plan(plan);
  return shell;
}

// A stub `claude` in `dir` (made if it is not there). What it answers to
// --version is read from `said` beside it on every run, so a copy can be
// updated in place: CRASH exits 3 having printed nothing, STALL never
// answers. Every run is logged with its arguments, so a version probe can be
// told from a chat it was handed. `name` stands in a Windows copy, such as
// claude.exe or an npm claude.cmd, as a script this machine can run.
function makeClaude(dir, said, name = 'claude') {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'runs.jsonl'), JSON.stringify({ args }) + '\\n');
if (args[0] === '--version') {
  const said = fs.readFileSync(path.join(__dirname, 'said'), 'utf8');
  if (said === 'STALL') setTimeout(() => {}, 20000);
  else if (said === 'CRASH') process.exit(3);
  else { process.stdout.write(said + '\\n'); process.exit(0); }
} else {
  setTimeout(() => process.exit(0), 50);
}
`);
  fs.chmodSync(bin, 0o755);
  const copy = {
    dir, bin,
    say: (next) => fs.writeFileSync(path.join(dir, 'said'), next),
    runs: () => {
      const log = path.join(dir, 'runs.jsonl');
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
  copy.say(said);
  copy.probes = () => copy.runs().filter((r) => r.args[0] === '--version');
  copy.chats = () => copy.runs().filter((r) => r.args[0] !== '--version');
  return copy;
}

const CURRENT = '2.1.318 (Claude Code)';
const OLD = '2.0.58 (Claude Code)';

module.exports = { makeLoginShell, makeClaude, CURRENT, OLD };
