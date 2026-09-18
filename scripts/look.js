'use strict';
// Serve the branch in this worktree so a person can look at it NOW.
//
// WHY THIS EXISTS. Measured across 0.13.3: the elapsed time from a fix
// existing to the owner being able to see it was 40 to 60 minutes for most of
// a day, and about 90 seconds for the last third. Same machine, same people,
// same work. The only difference was that the last third served the branch on
// a port and looked at it, and the rest waited for a gate, CI and a merge
// first.
//
// THE GATE IS NOT THE PROBLEM AND IS NOT SLIMMED BY THIS. It is a merge gate,
// its evidence is worth its twenty minutes, and every step it runs is one CI
// also runs. What was wrong was the ORDER: looking was not possible until the
// gate finished, so the gate's duration sat on the path between a defect being
// fixed and the person who reported it seeing the fix. Nothing about the gate
// changes here. It stops being a precondition by looking becoming cheap enough
// that nothing queues behind it. Run it detached, or let CI own it, while the
// person is already looking.
//
// THE PORT IS THE WHOLE TRICK, and it is smaller than it sounds. `npm run dev`
// takes PORT or 3000 and `server.listen` throws EADDRINUSE on the second
// worktree, which is the ordinary case: a branch is worth looking at precisely
// when there is something to compare it against. A person who has to find and
// free a port before they can look will wait for the merge instead, which is
// the behaviour this file exists to remove.

const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FIRST_PORT = 3000;
// Enough room for every worktree someone realistically has open at once, and
// bounded rather than infinite so a machine with no free port says so instead
// of hanging.
const PORT_SCAN = 40;

/** Free means nothing is listening AND we could bind it ourselves. Probing by
 * connect alone reports a port free when something holds it without accepting,
 * which is the state a half-dead server from a previous run leaves behind. */
function free(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

// `from` is injectable only so this can be tested against ports the test owns.
// Scanning from a hard-coded 3000 would make the suite depend on whatever the
// developer happens to have running, which is a test that passes or fails for
// reasons unrelated to the code it names.
async function pickPort(requested, from = FIRST_PORT) {
  if (requested) {
    if (await free(requested)) return requested;
    // Named explicitly and not available: say so rather than quietly serving
    // somewhere else. A person who asked for 3000 is comparing that branch
    // against something, and being moved to 3001 without being told is how you
    // spend twenty minutes looking at the build you were trying to replace.
    // 0.13.3 shipped a tag two days behind main for the same class of reason:
    // every check was green and nobody was looking at the artefact.
    throw new Error(`port ${requested} is in use. Leave --port off to take the next free one.`);
  }
  for (let p = from; p < from + PORT_SCAN; p += 1) {
    if (await free(p)) return p;
  }
  throw new Error(`no free port between ${from} and ${from + PORT_SCAN}.`);
}

function branchName() {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim()
      || execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    // Not a checkout, or no git. Worth serving anyway: the branch is a label
    // on the output, not a precondition for looking at the product.
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const port = await pickPort(Number(at('--port')) || null);
  const workspace = at('--workspace') || process.env.WORKSPACE || null;
  const branch = branchName();

  // PRINTED BEFORE THE SERVER STARTS, not after it is ready. The URL is the
  // only thing the reader wants and the server's own boot output is long
  // enough to push it off a short terminal.
  console.log('');
  console.log(`  Look at it:  http://localhost:${port}`);
  if (branch) console.log(`  Branch:      ${branch}`);
  console.log(`  Workspace:   ${workspace || '(the server default)'}`);
  console.log('');
  console.log('  This is not gated and does not need to be. Run the gate and CI');
  console.log('  alongside, not in front: npm run precommit:detached');
  console.log('');

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port), ...(workspace ? { WORKSPACE: workspace } : {}) },
  });
  child.on('exit', (code) => process.exit(code == null ? 1 : code));
}

// GUARDED, so requiring this file to test the port logic does not boot a
// server. `test/unit/no-live-server-in-tests.test.js` exists because a test
// that quietly arms the real product is how fixture state reached a real
// Recent workspaces list, and an unguarded main() here would be the same
// mistake in a new place.
if (require.main === module) {
  main().catch((err) => {
    console.error(`look: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { free, pickPort, FIRST_PORT, PORT_SCAN };
