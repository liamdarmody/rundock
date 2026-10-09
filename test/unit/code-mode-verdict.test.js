'use strict';
// The Code-mode command reader, in process: the verdict for every shell row of
// the command table against a real fixture repository, both states of every
// conditional row, the reading rules (segments, wrappers, inner commands,
// unknown targets, case folding), and the Windows spellings through the
// Windows path flavour.
//
// THE INTERFACE THESE TESTS FIX, since the module is written after them:
//
//   const { codeModeVerdict } = require('scripts/code-mode-verdict.js');
//   codeModeVerdict({
//     toolName,        // 'Bash' | 'PowerShell'
//     command,         // the command text
//     cwd,             // where it runs (the hook input's cwd); undefined if unknown
//     workspaceRoot,
//     extraDirs,       // the working folders
//     home,            // defaulted seam: os.homedir()
//     platform,        // defaulted seam: process.platform (path flavour, case folding)
//     env,             // defaulted seam: process.env ($env:TEMP and friends)
//     context,         // defaulted seam: the filesystem and git facts, for a
//                      // Windows-shaped world on a host that has none:
//                      //   exists(p), gitTop(p), gitStatus(top, specs, { env }) ->
//                      //   { ok, tracked, untracked, ignoredEnv } (relative paths),
//                      //   currentBranch(top), defaultBranches(top, remote) -> [names],
//                      //   isTag(top, name), canonical(p)
//   }) -> { verdict: 'runs' | 'asks-once' | 'always-asks',
//           rule?,     // asks-once: the standing-allow key, e.g. Bash:git-push:default-branch
//           reason?,   // always-asks: the reason id the card's sentence is chosen by
//           files?,    // unsaved work: up to three names, relative to the repository top
//           more? }    // unsaved work: how many more
//
// The fixture lives outside every temp folder and git working tree (see the
// helper), because both are part of the rule.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fx = require('../helpers/code-mode-fixture.js');
const { ROWS, spellingsOf } = require('../fixtures/code-mode/command-table.js');

const MODULE = '../../scripts/code-mode-verdict.js';
function codeModeVerdict(opts) {
  return require(MODULE).codeModeVerdict(opts);
}

const root = fx.outsideTempRoot();
const SKIP = root.skip || false;
let world;
before(() => { if (!SKIP) world = fx.buildWorld(root.dir); });
after(() => { if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true }); });

function verdictFor(command, { at = 'app', toolName = 'Bash', platform, extraDirs } = {}) {
  return codeModeVerdict({
    toolName, command: fx.expand(world, command), cwd: fx.cwdFor(world, at),
    workspaceRoot: world.ws, extraDirs: extraDirs || [world.projects], home: world.home,
    ...(platform ? { platform } : {}),
  });
}

// The rows the verdict decides on its own: every shell command whose class is
// about what it does rather than where it reaches.
const VERDICT_SECTIONS = new Set(['Git', 'Deleting', 'Packages', 'Processes', 'Permissions', 'Network', 'Disks', 'Scripts']);
const VERDICT_EXTRA_ROWS = new Set(['R4', 'R5', 'O4', 'O6', 'O7']);

describe('the table\'s totals are computed from the rows, not typed', () => {
  test('100 rows: Runs 58, Asks once 4, Always asks 34, Boundary 3, Refused 1', () => {
    const counts = {};
    for (const r of ROWS) counts[r.cls] = (counts[r.cls] || 0) + 1;
    assert.strictEqual(ROWS.length, 100);
    assert.deepStrictEqual(counts, { runs: 58, 'asks-once': 4, 'always-asks': 34, boundary: 3, refused: 1 });
    assert.strictEqual(new Set(ROWS.map(r => r.id)).size, 100, 'every row id once');
  });
});

describe('every shell row, in process, against a real repository', { skip: SKIP }, () => {
  for (const row of ROWS) {
    if (!VERDICT_SECTIONS.has(row.section) && !VERDICT_EXTRA_ROWS.has(row.id)) continue;
    const title = `${row.id} (${row.section})${row.edge ? `, asserted edge: ${row.edge}` : ''}`;
    describe(title, () => {
      for (const sp of spellingsOf(row)) {
        if (sp.win || sp.command === undefined) continue;
        const name = `${sp.command}${sp.tool === 'PowerShell' ? ' (PowerShell)' : ''}${sp.state !== 'clean' ? ` [${sp.state}]` : ''}${sp.note ? `, ${sp.note}` : ''} is ${sp.cls}`;
        test(name, () => {
          const v = fx.withState(world, sp.state, () => verdictFor(sp.command, { at: sp.at, toolName: sp.tool }));
          assert.strictEqual(v.verdict, sp.cls, `${sp.command}: ${JSON.stringify(v)}`);
          if (sp.cls === 'asks-once') assert.ok(typeof v.rule === 'string' && v.rule && !/^(Bash|PowerShell):[\w.-]+$/.test(v.rule),
            'a rule key of its own, never a bare binary key');
          if (sp.cls === 'always-asks') assert.ok(typeof v.reason === 'string' && v.reason, 'with a reason id');
        });
      }
    });
  }
});

describe('the reasons and rule keys the cards are worded from', { skip: SKIP }, () => {
  test('unsaved work names up to three files, relative to the repository, and counts the rest', () => {
    const extra = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(n => path.join(world.app, 'src/legacy', n));
    for (const f of extra) fx.write(f, 'x\n');
    try {
      const v = verdictFor('rm -rf src/legacy');
      assert.strictEqual(v.verdict, 'always-asks');
      assert.strictEqual(v.reason, 'unsaved-work');
      assert.strictEqual(v.files.length, 3);
      for (const f of v.files) assert.ok(f.startsWith('src/legacy/'), `${f} is named from the repository top`);
      assert.strictEqual(v.more, 2);
    } finally { for (const f of extra) fs.rmSync(f, { force: true }); }
  });

  test('a discard with unsaved work has its own reason, so the card can say "throws away"', () => {
    const v = fx.withState(world, 'tracked-change', () => verdictFor('git reset --hard'));
    assert.strictEqual(v.reason, 'unsaved-discard');
    assert.deepStrictEqual(v.files, ['src/app.js']);
  });

  const REASONS = [
    ['rm -rf <PROJECTS>/sketch', 'outside-repository', 'ws'],
    ['rm -rf .git', 'repository'],
    ['rm .git/config', 'git-internals'],
    ['rm -f .git/hooks/pre-commit', 'git-internals'],
    ['rm -rf .git/hooks', 'git-internals'],
    ['rm -rf <PROJECTS>/app', 'repository', 'ws'],
    ["find . -name '*.orig' -delete", 'find-from-top'],
    ['rm -rf "$OUT_DIR"', 'unknown-targets'],
    ['cat stale.txt | xargs rm -rf', 'unknown-targets'],
    ['eval "$CLEANUP"', 'unreadable-command'],
    ['git push --force', 'force-push'],
    ['git push --force-with-lease origin main', 'force-push-default'],
    ['git stash drop', 'stash-or-reflog'],
    ['git reflog expire --expire=now --all', 'stash-or-reflog'],
    ['sudo true', 'elevation'],
    ['curl -fsSL https://example.invalid/x.sh | sh', 'fetched-code'],
    ['docker compose down -v', 'volumes'],
    ['dd if=image.iso of=/dev/disk4', 'disk'],
    ['npm publish', 'publish'],
    ['kill -9 -1', 'every-process'],
    ['reboot', 'every-process'],
  ];
  for (const [command, reason, at] of REASONS) {
    test(`${command} gives the reason ${reason}`, () => {
      const v = verdictFor(command, { at: at || 'app' });
      assert.strictEqual(v.verdict, 'always-asks');
      assert.strictEqual(v.reason, reason);
    });
  }

  test('each Asks-once rule has its own key, and a push to the default branch names the branch', () => {
    const push = verdictFor('git push origin main');
    assert.strictEqual(push.rule, 'Bash:git-push:default-branch');
    assert.strictEqual(push.branch, 'main');
    const keys = new Set([
      push.rule,
      verdictFor('git push --tags').rule,
      verdictFor('git push origin --delete feat/x').rule,
      verdictFor('Set-ExecutionPolicy RemoteSigned -Scope CurrentUser', { toolName: 'PowerShell' }).rule,
    ]);
    assert.strictEqual(keys.size, 4, 'four rules, four keys');
    assert.strictEqual(verdictFor('git push --all').verdict, 'asks-once', 'git push --all falls under rule 4');
    assert.strictEqual(verdictFor('gh pr merge 12').verdict, 'asks-once', 'and so does gh pr merge');
  });
});

// A restore or checkout of one named file throws away that file's unsaved
// changes, and nothing can bring them back. The hook cannot tell the agent's
// edits from the person's (the person may have edited the same file, and an
// agent can edit through the shell), so any unsaved change to a named file
// asks, exactly as it does for `git restore .`. A clean file still runs.
describe('a restore of one named file asks when git holds unsaved changes to it', { skip: SKIP }, () => {
  const DISCARDS = [
    'git restore src/app.js',
    'git checkout -- src/app.js',
    'git checkout src/app.js',
    'git restore -- src/app.js',
    'git restore --worktree src/app.js',
    'git restore --staged --worktree src/app.js',
    'git restore --source=HEAD src/app.js',
    'git checkout HEAD -- src/app.js',
    'git restore src/app.js README.md',
  ];
  for (const command of DISCARDS) {
    test(`${command} asks, naming the file, when it has unsaved changes`, () => {
      const v = fx.withState(world, 'tracked-change', () => verdictFor(command));
      assert.strictEqual(v.verdict, 'always-asks', `${command}: ${JSON.stringify(v)}`);
      assert.strictEqual(v.reason, 'unsaved-discard');
      assert.deepStrictEqual(v.files, ['src/app.js']);
    });
    test(`${command} runs when the file has nothing unsaved`, () => {
      assert.strictEqual(verdictFor(command).verdict, 'runs');
    });
  }

  test('the file is found from a subfolder and named from the repository top', () => {
    const v = fx.withState(world, 'tracked-change', () => verdictFor('git restore app.js', { at: 'app/src' }));
    assert.strictEqual(v.verdict, 'always-asks');
    assert.deepStrictEqual(v.files, ['src/app.js']);
  });

  test('git restore . still asks, and still runs with nothing unsaved', () => {
    assert.strictEqual(fx.withState(world, 'tracked-change', () => verdictFor('git restore .')).verdict, 'always-asks');
    assert.strictEqual(verdictFor('git restore .').verdict, 'runs');
  });

  test('what loses nothing still runs while another file has unsaved changes', () => {
    for (const command of [
      'git restore README.md',
      'git checkout -- README.md',
      'git restore --staged src/app.js',
      'git restore -S src/app.js',
      'git checkout -b feat/new',
      'git checkout main',
      'git restore src/new-parser.ts',
    ]) {
      const v = fx.withState(world, 'tracked-change', () => verdictFor(command));
      assert.strictEqual(v.verdict, 'runs', `${command}: ${JSON.stringify(v)}`);
    }
    const untracked = fx.withState(world, 'untracked-file', () => verdictFor('git checkout -- src/new-parser.ts'));
    assert.strictEqual(untracked.verdict, 'runs', 'a file git has never seen is not touched by a checkout');
  });
});

// Deleting one named file follows the same line as a folder: what git can
// bring back runs, and what it cannot asks. A tracked file with nothing
// unsaved runs; unsaved changes, a file git has never saved, an ignored .env
// file, or a file outside any repository asks. Disposable paths (Rundock's
// scratch folder, the temp folders, the package caches) still run.
describe('a delete of one named file asks when git cannot bring it back', { skip: SKIP }, () => {
  const SPELLINGS = [
    ['rm', 'Bash'], ['rm -f', 'Bash'], ['rm --', 'Bash'], ['unlink', 'Bash'],
    ['Remove-Item', 'PowerShell'], ['Remove-Item -Force -Path', 'PowerShell'], ['del', 'PowerShell'],
  ];
  for (const [verb, toolName] of SPELLINGS) {
    const tag = `${verb}${toolName === 'PowerShell' ? ' (PowerShell)' : ''}`;
    test(`${tag} of a tracked file with nothing unsaved runs`, () => {
      assert.strictEqual(verdictFor(`${verb} src/app.js`, { toolName }).verdict, 'runs');
    });
    test(`${tag} of a tracked file with unsaved changes asks, naming it`, () => {
      const v = fx.withState(world, 'tracked-change', () => verdictFor(`${verb} src/app.js`, { toolName }));
      assert.strictEqual(v.verdict, 'always-asks', JSON.stringify(v));
      assert.strictEqual(v.reason, 'unsaved-work');
      assert.deepStrictEqual(v.files, ['src/app.js']);
    });
    test(`${tag} of a file git has never saved asks, naming it`, () => {
      const v = fx.withState(world, 'untracked-file', () => verdictFor(`${verb} src/new-parser.ts`, { toolName }));
      assert.strictEqual(v.verdict, 'always-asks', JSON.stringify(v));
      assert.strictEqual(v.reason, 'unsaved-work');
      assert.deepStrictEqual(v.files, ['src/new-parser.ts']);
    });
    test(`${tag} of a file outside any repository asks, naming it`, () => {
      const v = verdictFor(`${verb} ${path.join(world.sketch, 'idea.md')}`, { toolName, at: 'ws' });
      assert.strictEqual(v.verdict, 'always-asks', JSON.stringify(v));
      assert.strictEqual(v.reason, 'outside-repository');
      assert.deepStrictEqual(v.files, ['idea.md']);
    });
  }

  test('the file is found from a subfolder and named from the repository top', () => {
    const v = fx.withState(world, 'tracked-change', () => verdictFor('rm app.js', { at: 'app/src' }));
    assert.strictEqual(v.reason, 'unsaved-work');
    assert.deepStrictEqual(v.files, ['src/app.js']);
  });

  test('several named files ask when one of them is unsaved, naming only that one', () => {
    const changed = fx.withState(world, 'tracked-change', () => verdictFor('rm README.md src/app.js src/index.js'));
    assert.strictEqual(changed.reason, 'unsaved-work');
    assert.deepStrictEqual(changed.files, ['src/app.js']);
    const fresh = fx.withState(world, 'untracked-file', () => verdictFor('rm -f README.md src/new-parser.ts'));
    assert.strictEqual(fresh.reason, 'unsaved-work');
    assert.deepStrictEqual(fresh.files, ['src/new-parser.ts']);
    const ps = fx.withState(world, 'untracked-file', () => verdictFor('Remove-Item README.md, src/new-parser.ts', { toolName: 'PowerShell' }));
    assert.deepStrictEqual(ps.files, ['src/new-parser.ts']);
    assert.strictEqual(verdictFor('rm README.md src/app.js src/index.js').verdict, 'runs', 'all clean, all restorable');
  });

  test('several files outside any repository are named together, and a mix with a clean repository file still asks', () => {
    const v = verdictFor(`rm ${path.join(world.sketch, 'idea.md')} ${path.join(world.sketch, 'drafts/one.md')}`, { at: 'ws' });
    assert.strictEqual(v.reason, 'outside-repository');
    assert.deepStrictEqual(v.files, ['idea.md', 'one.md']);
    const mixed = verdictFor(`rm src/app.js ${path.join(world.sketch, 'idea.md')}`);
    assert.strictEqual(mixed.reason, 'outside-repository');
    assert.deepStrictEqual(mixed.files, ['idea.md']);
  });

  test('ignored files follow the bulk rule: an ignored .env asks, other ignored files run', () => {
    for (const command of ['rm .env', 'rm config/.env', 'unlink .env']) {
      const v = verdictFor(command);
      assert.strictEqual(v.reason, 'unsaved-work', `${command}: ${JSON.stringify(v)}`);
    }
    assert.deepStrictEqual(verdictFor('rm config/.env').files, ['config/.env']);
    for (const command of ['rm dist/bundle.js', 'rm build/out.js', 'rm src/cache.pyc', 'rm node_modules/left-pad/index.js']) {
      assert.strictEqual(verdictFor(command).verdict, 'runs', command);
    }
  });

  test('disposable paths still run: the scratch folder, the temp folders and the package caches', () => {
    const scratch = path.join(world.ws, '.rundock/scratch/run-42/out.log');
    const temp = path.join(require('node:os').tmpdir(), `rundock-verdict-${process.pid}.log`);
    fx.write(scratch, 'x\n');
    fx.write(temp, 'x\n');
    try {
      for (const command of [`rm ${scratch}`, `rm ${temp}`, 'rm ~/.npm/_cacache/index-v5/aa/entry']) {
        const v = verdictFor(command, { at: 'ws' });
        assert.strictEqual(v.verdict, 'runs', `${command}: ${JSON.stringify(v)}`);
      }
    } finally { fs.rmSync(scratch, { force: true }); fs.rmSync(temp, { force: true }); }
  });

  test('a file inside .git keeps its own reason, and a file that is not there deletes nothing', () => {
    assert.strictEqual(verdictFor('rm .git/config').reason, 'git-internals');
    assert.strictEqual(verdictFor('unlink .git/HEAD').reason, 'git-internals');
    assert.strictEqual(verdictFor('rm -f src/missing.js').verdict, 'runs');
    assert.strictEqual(verdictFor(`rm ${path.join(world.sketch, 'missing.md')}`, { at: 'ws' }).verdict, 'runs');
  });
});

describe('how a line is read', { skip: SKIP }, () => {
  test('the strictest segment decides the line', () => {
    assert.strictEqual(verdictFor(`ls && rm -rf ${world.sketch}`).verdict, 'always-asks');
    assert.strictEqual(verdictFor(`rm -rf dist; rm -rf ${world.sketch}`).verdict, 'always-asks');
    assert.strictEqual(verdictFor('npm test | tee out.txt & git status').verdict, 'runs');
  });

  test('wrappers are removed before the verb is read', () => {
    const S = world.sketch;
    for (const c of [`/bin/rm -rf ${S}`, `\\rm -rf ${S}`, `command rm -rf ${S}`, `builtin rm -rf ${S}`, `exec rm -rf ${S}`,
      `nohup rm -rf ${S}`, `time rm -rf ${S}`, `nice rm -rf ${S}`, `timeout 5 rm -rf ${S}`, `env X=1 rm -rf ${S}`, `X=1 rm -rf ${S}`]) {
      assert.strictEqual(verdictFor(c).verdict, 'always-asks', c);
    }
    for (const c of [`git -C ${world.app} push --force`, 'git -c core.pager=cat push --force']) {
      assert.strictEqual(verdictFor(c).verdict, 'always-asks', c);
    }
    assert.strictEqual(verdictFor('/bin/rm -rf dist').verdict, 'runs', 'and a wrapped delete of rebuildable output still runs');
  });

  test('elevation is never a wrapper: sudo of a harmless command still asks', () => {
    for (const c of ['sudo ls', 'doas ls', 'sudo -u nobody git status']) assert.strictEqual(verdictFor(c).verdict, 'always-asks', c);
  });

  test('commands carried inside another command are judged as commands', () => {
    assert.strictEqual(verdictFor(`bash -c 'rm -rf ${world.sketch}'`).verdict, 'always-asks');
    assert.strictEqual(verdictFor(`zsh -c "rm -rf ${world.sketch}"`).verdict, 'always-asks');
    assert.strictEqual(verdictFor("sh -c 'rm -rf dist'").verdict, 'runs');
    assert.strictEqual(verdictFor(`find ${world.sketch} -exec rm -rf {} +`).verdict, 'always-asks');
    assert.strictEqual(verdictFor('find src -name "*.pyc" -exec rm {} +').verdict, 'runs');
    assert.strictEqual(verdictFor(`echo ${world.sketch} | xargs rm -rf`).verdict, 'always-asks', 'the targets come from a pipe');
  });

  test('an inner command that is not a literal, eval and Invoke-Expression cannot be read, so they ask', () => {
    for (const c of ['sh -c "$CMD"', 'bash -c "$(cat script)"', 'eval "$X"']) assert.strictEqual(verdictFor(c).verdict, 'always-asks', c);
    for (const c of ['Invoke-Expression $cmd', 'iex $cmd', 'pwsh -Command $cmd']) {
      assert.strictEqual(verdictFor(c, { toolName: 'PowerShell' }).verdict, 'always-asks', c);
    }
  });

  test('a target that does not exist deletes nothing, so it does not make a delete ask', () => {
    assert.strictEqual(verdictFor('rm -rf no-such-folder', { at: 'sketch' }).verdict, 'runs');
  });

  test('with no working directory known, a relative bulk delete asks', () => {
    assert.strictEqual(verdictFor('rm -rf dist', { at: 'none' }).verdict, 'always-asks');
  });

  test('command names fold case on macOS and Windows hosts, and not on Linux', () => {
    const S = world.sketch;
    assert.strictEqual(verdictFor(`RM -RF ${S}`, { platform: 'darwin' }).verdict, 'always-asks', 'judged as rm -rf on macOS');
    assert.strictEqual(verdictFor('RM -RF dist', { platform: 'darwin' }).verdict, 'runs', 'and as rm -rf of rebuildable output');
    assert.strictEqual(verdictFor(`RM -RF ${S}`, { platform: 'linux' }).verdict, 'runs', 'on Linux RM is not rm, so it is an unknown verb and runs as today');
    assert.strictEqual(verdictFor(`remove-item -recurse ${S}`, { toolName: 'PowerShell', platform: 'darwin' }).verdict, 'always-asks');
  });

  test('a named working folder does not make an irreversible delete run', () => {
    assert.strictEqual(verdictFor(`rm -rf ${world.sketch}`, { extraDirs: [world.projects, world.sketch] }).verdict, 'always-asks');
  });

  test('Rundock\'s own scratch folder is disposable by design', () => {
    assert.strictEqual(verdictFor('rm -rf .rundock/scratch/*', { at: 'ws' }).verdict, 'runs');
  });
});

// ── Words only known when the line runs ─────────────────────────────────────
// A verb held in a variable or produced by a substitution cannot be read, so
// the line asks, as eval does. A substitution anywhere runs a command of its
// own, including inside an assignment, so that command is judged like any
// other. An expanding argument asks only where the verdict depends on it;
// everyday expansion elsewhere keeps running.
describe('a word only known when the line runs', { skip: SKIP }, () => {
  const unreadable = (c, o) => {
    const v = verdictFor(c, o);
    assert.deepStrictEqual(v, { verdict: 'always-asks', reason: 'unreadable-command' }, c);
  };

  test('a verb held in a variable, or produced by a substitution, cannot be read', () => {
    const S = world.sketch;
    for (const c of [
      'x=sudo; $x ls', '$(echo sudo) ls', '`echo sudo` ls', 'g=git; $g push --force origin main',
      `x=rm; $x -rf ${S}`, `$(echo rm) -rf ${S}`, `\`echo rm\` -rf ${S}`, `"$RM" -rf ${S}`, '${X} status',
      'env $X ls', 'command $X', `nohup $X -rf ${S}`, `echo ${S} | xargs $X -rf`, `find ${S} -exec $X {} +`,
    ]) unreadable(c);
    unreadable('$x Remove-Item -Recurse dist', { toolName: 'PowerShell' });
  });

  test('a known program named through an expanding folder is still read as that program', () => {
    assert.strictEqual(verdictFor(`$TOOLS/rm -rf ${world.sketch}`).reason, 'outside-repository');
    assert.strictEqual(verdictFor('"$HOME/.local/bin/prettier" --write src').verdict, 'runs');
  });

  test('a substitution runs its own command, which is judged like any other', () => {
    const S = world.sketch;
    for (const c of [
      `FOO=$(rm -rf ${S}) git status`, `echo "$(rm -rf ${S})"`, `echo \`rm -rf ${S}\``, `echo $(echo $(rm -rf ${S}))`,
      `diff <(rm -rf ${S}) README.md`, `X="$(rm -rf ${S})"`, `export X=$(rm -rf ${S})`,
    ]) assert.strictEqual(verdictFor(c).reason, 'outside-repository', c);
    assert.strictEqual(verdictFor('echo "$(sudo ls)"').reason, 'elevation');
    for (const c of ['echo $(git rev-parse HEAD)', 'VERSION=$(node -p "require(\'./package.json\').version") npm run build',
      'git commit -m "$(cat <<\'EOF\'\nFix the parser (it didn\'t handle "quotes")\n\nrm -rf / is not a command here :)\nEOF\n)"',
      'echo "total: $((1 + 2))"', 'echo \'$(rm -rf /)\' "\\$(rm -rf /)"',
      `git commit -m "$(cat <<'EOF'\nrm -rf ${S} is text in a message\nEOF\n)"`, `cat > notes.md <<'EOF'\nrm -rf ${S}\nEOF`]) {
      assert.strictEqual(verdictFor(c).verdict, 'runs', c);
    }
    assert.strictEqual(verdictFor(`bash <<'EOF'\nrm -rf ${S}\nEOF`).reason, 'outside-repository', 'a shell reading a here-document runs it');
    assert.strictEqual(verdictFor(`cat <<EOF\n$(rm -rf ${S})\nEOF`).reason, 'outside-repository', 'an unquoted here-document still runs its substitutions');
  });

  test('a substitution that cannot be followed to its end cannot be read', () => {
    for (const c of ['echo $(ls', 'echo `ls', 'echo $(case x in a) rm -rf dist;; esac)']) unreadable(c);
  });

  test('an expanding argument asks where the verdict depends on it', () => {
    for (const c of [
      'p=publish; npm $p', 'yarn $CMD', 'pnpm "$(echo publish)"', 'x=--force; git push $x origin main', 'git push origin $BRANCH',
      'git reset $MODE', 'git reset --hard $REF', 'git checkout $F', 'git clean $FLAGS', 'git stash $ACTION', 'git $SUB',
      'git worktree remove $W', 'docker compose down $FLAGS', 'docker volume $ACTION', 'docker $CMD', 'gh pr $ACTION 12',
      'bash $FLAG "rm -rf dist"', 'kill $PID', 'find . -name "*.log" $ACTION',
    ]) unreadable(c);
  });

  test('freeing a port: kill runs when its argument is lsof -t on a port, or pidof a name', () => {
    for (const c of ['kill -9 $(lsof -ti :3000)', 'kill $(lsof -t -i:3000)', 'kill $(lsof -ti:3000)', 'kill -9 $(lsof -t -i :5173)',
      'kill $(lsof -nP -ti tcp:8080)', 'kill $(lsof -t -iTCP:3000 -sTCP:LISTEN)', 'kill `lsof -ti :8080`', 'kill -9 "$(lsof -ti :3000)"',
      'kill $(pidof node)', 'pkill -f "$PATTERN"', 'lsof -ti :3000 | xargs kill -9']) {
      assert.strictEqual(verdictFor(c).verdict, 'runs', c);
    }
  });

  test('kill asks for any other process-id source, which could say -1 or any process', () => {
    for (const c of ['kill $(echo -1)', 'kill $(printf -- -1)', 'kill $PID', 'kill -9 $(lsof -ti :3000) $X',
      'kill $(lsof -ti :3000 | awk \'{print "-1"}\')', 'kill $(lsof -ti $PORT)', 'kill $(cat server.pid)', 'kill -9 $(cat server.pid)',
      'kill -9 $(pgrep -f .)', 'kill $(pgrep node)', 'kill $(ps -o pid= -p 4242)', 'kill $(lsof -ti :3000 | head -1)',
      'kill $(lsof -t)', 'kill $(lsof -t -u me)', 'kill $(echo -ti :3000)', 'kill $(printf -t -i :3000)', 'kill $(pidof -o %PPID node)', 'kill $(eval lsof)', 'kill $(lsof -ti :3000; echo -1)']) {
      assert.deepStrictEqual(verdictFor(c), { verdict: 'always-asks', reason: 'unreadable-command' }, c);
    }
  });

  test('everyday expansion keeps running', () => {
    for (const [c, at] of [
      ['cd "$HOME/Projects/app"', 'ws'], ['echo $PATH', 'app'], ['npm run build -- --port $PORT', 'app'], ['export X=1', 'app'],
      ['ls $DIR', 'app'], ['FOO=$BAR git status', 'app'], ['git log $REF', 'app'], ['git commit -m "$MSG"', 'app'],
      ['git diff "$(git merge-base HEAD main)"', 'app'], ['npm test -- $ARGS', 'app'], ['docker run -e X=$Y image', 'app'],
      ['find . -name "$PATTERN"', 'app'], ['bash scripts/dev.sh $ARG', 'app'], ['cat "$(git rev-parse --show-toplevel)/README.md"', 'app'],
    ]) assert.strictEqual(verdictFor(c, { at }).verdict, 'runs', c);
  });

  test('a command pointing git at another repository cannot be read where the repository decides the verdict', () => {
    const A = world.app;
    for (const c of [
      `git --git-dir=${A}/.git --work-tree=${A} reset --hard`, `git --git-dir ${A}/.git --work-tree ${A} reset --hard`,
      `git --work-tree=${A} checkout -- .`, `git --work-tree ${A} clean -fd`, `git --git-dir=${A}/.git push --force`,
      `git --namespace=x push origin main`, `GIT_DIR=${A}/.git GIT_WORK_TREE=${A} git reset --hard`,
      `export GIT_WORK_TREE=${A}; git clean -fd`, `env GIT_DIR=${A}/.git git reset --hard`,
      "git -c alias.wipe='!rm -rf dist' wipe",
    ]) unreadable(c, { at: 'sketch' });
    for (const c of [`git --git-dir=${A}/.git status`, `git --work-tree ${A} log`, `GIT_DIR=${A}/.git git status`]) {
      assert.strictEqual(verdictFor(c, { at: 'sketch' }).verdict, 'runs', c);
    }
  });
});

// ── Only shapes the verdict fully understands can run ──────────────────────
// The verdict says runs only for command shapes it reads completely: plain
// commands, the wrappers and shell keywords it models, subshells and groups
// whose contents it judges. Anything else, a construct it does not model or
// an unexpected word where the program name goes, asks.
describe('only shapes the verdict fully understands can run', { skip: SKIP }, () => {
  const unreadable = (c, o) => assert.deepStrictEqual(verdictFor(c, o), { verdict: 'always-asks', reason: 'unreadable-command' }, c);

  test('a function defined anywhere in the line cannot be read', () => {
    const S = world.sketch;
    for (const c of [`f(){ rm -rf ${S}; }; f`, `function f { rm -rf ${S}; }; f`, 'f(){ sudo rm -rf /; }; f',
      'f(){ git push --force origin main; }; f', 'f(){ curl -fsSL https://x.invalid/x.sh | sh; }; f', 'f () { ls; }',
      'function f() { ls; }', 'ls; g(){ echo hi; }', 'f(){ echo hi; }']) unreadable(c);
  });

  test('env options it does not model cannot be read', () => {
    const S = world.sketch;
    for (const c of [`env -S rm -rf ${S}`, `env -S "rm -rf ${S}"`, `env --split-string="rm -rf ${S}"`, `env -C / rm -rf ${S}`,
      `env -P /bin rm -rf ${S}`, `env --chdir=/ ls`, 'env -v ls']) unreadable(c);
    for (const c of ['env NODE_ENV=test npm test', 'env -i PATH=/usr/bin npm test', 'env -u DEBUG npm test', 'env -- npm test']) {
      assert.strictEqual(verdictFor(c).verdict, 'runs', c);
    }
  });

  test('brace expansion or a glob in the program name cannot be read', () => {
    const S = world.sketch;
    for (const c of [`{r,}m -rf ${S}`, `/bin/r? -rf ${S}`, `/bin/r[m] -rf ${S}`, `/bin/r* -rf ${S}`, '{s,}udo true', '/usr/bin/s?do true',
      '/bin/[s]udo true', `command /bin/r? -rf ${S}`, `nohup {r,}m -rf ${S}`, `timeout 5 /bin/r[m] -rf ${S}`]) unreadable(c);
  });

  test('wrappers whose options or behaviour it does not model cannot be read', () => {
    const S = world.sketch;
    for (const c of [`nice --foo rm -rf ${S}`, `timeout --weird 5 rm -rf ${S}`, `timeout abc rm -rf ${S}`, `exec -z rm -rf ${S}`,
      `command -x rm -rf ${S}`, `stdbuf -oL rm -rf ${S}`, `setsid rm -rf ${S}`, `arch -x86_64 rm -rf ${S}`, `flock /tmp/l rm -rf ${S}`,
      `xargs --made-up % rm -rf % < list`, `echo ${S} | xargs -Q rm -rf`, 'coproc ls', 'select x in a b; do rm -rf "$x"; done',
      `case x in x) rm -rf ${S};; esac`]) unreadable(c);
  });

  test('shell keywords, subshells and groups are read through, and what they run is judged', () => {
    const S = world.sketch;
    for (const c of [`if true; then rm -rf ${S}; fi`, `while true; do rm -rf ${S}; done`, `for f in a; do rm -rf ${S}; done`,
      `! rm -rf ${S}`, `(rm -rf ${S})`, `( cd /; rm -rf ${S} )`, `{ rm -rf ${S}; }`, `{ echo a; rm -rf ${S}; } > out.txt`,
      `if [ -d x ]; then :; else rm -rf ${S}; fi`, `until false; do rm -rf ${S}; done`]) {
      assert.strictEqual(verdictFor(c).reason, 'outside-repository', c);
    }
    assert.strictEqual(verdictFor('(sudo ls)').reason, 'elevation');
    unreadable('(rm -rf dist');
  });

  test('a cd that only happens on one branch, or inside a group, leaves where later commands run unknown', () => {
    assert.strictEqual(verdictFor('if [ -d x ]; then cd x; fi; rm -rf dist').verdict, 'always-asks');
    assert.strictEqual(verdictFor('{ cd /; }; rm -rf dist').verdict, 'always-asks');
    assert.strictEqual(verdictFor('(cd /); rm -rf dist').verdict, 'runs', 'a subshell cd ends with the subshell');
  });

  test('git environment variables are read by name, however the name is quoted', () => {
    const A = world.app;
    for (const c of [`env G"IT"_DIR=${A}/.git GIT_WOR"K"_TREE=${A} git reset --hard`, `G"IT"_DIR=${A}/.git git reset --hard`,
      `export G'IT'_WORK_TREE=${A}; git clean -fd`, `GIT\\_DIR=${A}/.git git reset --hard`, `"GIT_DIR"=${A}/.git git reset --hard`,
      `$X=${A} git reset --hard`, `declare -x GIT_DIR=${A}/.git; git reset --hard`, `GIT_INDEX_FILE=/tmp/i git checkout -- .`,
      `export GIT_DIR; git reset --hard`]) unreadable(c, { at: 'sketch' });
    for (const c of [`GIT_DIR=${A}/.git git status`, 'GIT_TRACE=1 git log', 'git commit -m "set x=1"']) {
      assert.strictEqual(verdictFor(c, { at: 'sketch' }).verdict, 'runs', c);
    }
  });

  test('a trap\'s command is only run later, so it cannot be read; clearing or listing traps runs', () => {
    const S = world.sketch;
    for (const c of [`trap 'rm -rf ${S}' EXIT`, 'trap "rm -rf dist" INT TERM', `trap -- 'rm -rf ${S}' EXIT`, 'trap cleanup EXIT',
      `trap 'rm -rf ${S}' ERR; ls`]) unreadable(c);
    for (const c of ['trap - EXIT', "trap '' INT", 'trap "" INT TERM', 'trap -l', 'trap -p', 'trap -p EXIT', 'trap']) {
      assert.strictEqual(verdictFor(c).verdict, 'runs', c);
    }
  });

  test('a here-string is data, and its substitutions are still judged', () => {
    for (const c of ['grep x <<< "$VAR"', "wc -l <<< 'some text'", 'read -r a b <<< "$LINE"']) {
      assert.notStrictEqual(verdictFor(c).reason, 'unreadable-command', c);
    }
    assert.strictEqual(verdictFor('grep x <<< "$VAR"').verdict, 'runs');
    assert.strictEqual(verdictFor(`cat <<< "$(rm -rf ${world.sketch})"`).reason, 'outside-repository');
    assert.strictEqual(verdictFor(`bash <<< "rm -rf ${world.sketch}"`).verdict, 'always-asks', 'a shell reading a here-string runs it');
  });

  test('everyday commands keep running', () => {
    for (const [c, at] of [
      ['git commit -m "$(cat <<\'EOF\'\nFix the parser (it didn\'t handle "quotes")\n\nCo-authored-by: A <a@example.invalid>\nEOF\n)"', 'app'],
      ['git add -A && git commit -m "fix: a=b" && git push -u origin feat/x', 'app'], ['git status', 'app'], ['git log --oneline -5', 'app'],
      ['git diff HEAD~1 -- src', 'app'], ['git switch -c feat/y', 'app'], ['git stash && git pull --rebase && git stash pop', 'app'],
      ['npm install', 'app'], ['npm run build', 'app'], ['npm test -- --watch=false', 'app'], ['npx tsc --noEmit', 'app'],
      ['./node_modules/.bin/eslint .', 'app'], ['python3 -m pytest -q', 'app'], ['make test', 'app'], ['node -e "console.log(1)"', 'app'],
      ['if [ -f package.json ]; then npm test; fi', 'app'], ['[ -d node_modules ] || npm install', 'app'], ['[[ -f .env ]] && source .env', 'app'],
      ['for f in src/*.js; do echo "$f"; done', 'app'], ['while read -r f; do echo "$f"; done < notes.txt', 'app'],
      ['(cd src && ls)', 'app'], ['{ echo a; echo b; } > out.txt', 'app'], ['time npm test', 'app'], ['nice -n 10 npm run build', 'app'],
      ['timeout 30 npm test', 'app'], ['timeout -s KILL 30s npm test', 'app'], ['command -v node', 'app'], ['exec npm start', 'app'],
      ['find src -name "*.js" -print0 | xargs -0 -n1 echo', 'app'], ['ls | xargs -I{} echo {}', 'app'], ['cd src && npm run lint', 'app'],
      ['echo "done" > /dev/null 2>&1', 'app'], ['true', 'app'], [': > .keep', 'app'], ['test -f x && echo yes', 'app'],
    ]) assert.strictEqual(verdictFor(c, { at }).verdict, 'runs', c);
  });
});

// ── Windows spellings through the Windows path flavour ──────────────────────
// A Windows-shaped world on any host: the paths are win32, and the facts a
// real disk and a real git would give come from the context seam.
describe('Windows spellings, as the PowerShell tool through the Windows path flavour', () => {
  const W = {
    home: 'C:\\Users\\dev',
    ws: 'C:\\Users\\dev\\Workspace',
    projects: 'C:\\Users\\dev\\Projects',
    app: 'C:\\Users\\dev\\Projects\\app',
    sketch: 'C:\\Users\\dev\\Projects\\sketch',
    temp: 'C:\\Users\\dev\\AppData\\Local\\Temp',
    local: 'C:\\Users\\dev\\AppData\\Local',
  };
  const ENV = { USERPROFILE: W.home, TEMP: W.temp, TMP: W.temp, LOCALAPPDATA: W.local };
  const lower = s => s.toLowerCase();
  const EXISTING = [
    'C:\\Users\\dev\\Projects\\app\\src\\legacy', 'C:\\Users\\dev\\Projects\\app\\dist', 'C:\\Users\\dev\\Projects\\sketch',
    'C:\\Users\\dev\\Workspace\\.rundock\\scratch\\run-42', 'C:\\Users\\dev\\AppData\\Local\\Temp\\app-build',
    'C:\\Users\\dev\\AppData\\Local\\npm-cache\\_cacache', 'C:\\Users\\dev\\AppData\\Local\\pip\\Cache',
  ].map(lower);
  function context(unsaved) {
    return {
      exists: p => EXISTING.some(e => lower(p) === e || e.startsWith(lower(p) + '\\')),
      gitTop: p => (lower(p) === lower(W.app) || lower(p).startsWith(lower(W.app) + '\\')) ? W.app : null,
      gitStatus: () => ({ ok: true, tracked: [], untracked: unsaved || [], ignoredEnv: [] }),
      currentBranch: () => 'feat/x',
      defaultBranches: () => ['main'],
    };
  }
  function winVerdict(command, cwd, unsaved) {
    return codeModeVerdict({
      toolName: 'PowerShell', command, cwd, workspaceRoot: W.ws, extraDirs: [W.projects], home: W.home,
      platform: 'win32', env: ENV, context: context(unsaved),
    });
  }
  const CASES = [
    ['D4', 'Remove-Item -Recurse src\\legacy', W.app, [], 'runs'],
    ['D5', 'Remove-Item -Recurse src\\legacy', W.app, ['src/legacy/new-parser.ts'], 'always-asks'],
    ['D6', 'Remove-Item -Recurse -Force $env:USERPROFILE\\Projects\\sketch', W.ws, [], 'always-asks'],
    ['D10', 'Remove-Item -Recurse .rundock\\scratch\\run-42', W.ws, [], 'runs'],
    ['R4', 'cd $env:USERPROFILE\\Projects\\app; Remove-Item -Recurse dist', W.ws, [], 'runs'],
    ['O4', 'Remove-Item -Recurse $env:TEMP\\app-build', W.app, [], 'runs'],
    ['O6', 'Remove-Item -Recurse $env:LOCALAPPDATA\\npm-cache\\_cacache', W.app, [], 'runs'],
    ['O7', 'Remove-Item -Recurse $env:LOCALAPPDATA\\pip\\Cache', W.app, [], 'runs'],
    ['N1', 'Invoke-WebRequest -OutFile vendor\\x.zip https://example.invalid/x.zip', W.app, [], 'runs'],
  ];
  for (const [id, command, cwd, unsaved, cls] of CASES) {
    test(`${id}: ${command} is ${cls}`, () => {
      assert.strictEqual(winVerdict(command, cwd, unsaved).verdict, cls);
    });
  }

  test('every alias of Remove-Item is judged as Remove-Item', () => {
    for (const alias of ['Remove-Item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir']) {
      assert.strictEqual(winVerdict(`${alias} -Recurse -Force $env:USERPROFILE\\Projects\\sketch`, W.ws).verdict, 'always-asks', alias);
      assert.strictEqual(winVerdict(`${alias} -Recurse -Force dist`, W.app).verdict, 'runs', alias);
    }
  });

  test('cmd spellings: rd /s /q and del /s /q are bulk deletes', () => {
    const cmdVerdict = (c, cwd) => codeModeVerdict({ toolName: 'Bash', command: `cmd /c "${c}"`, cwd, workspaceRoot: W.ws, extraDirs: [W.projects], home: W.home, platform: 'win32', env: ENV, context: context([]) });
    assert.strictEqual(cmdVerdict('rd /s /q dist', W.app).verdict, 'runs');
    assert.strictEqual(cmdVerdict('del /s /q *.log', W.sketch).verdict, 'always-asks');
    assert.strictEqual(cmdVerdict('rd /s /q %USERPROFILE%\\Projects\\sketch', W.ws).verdict, 'always-asks');
  });

  test('the boundary scan places Windows development paths and relative paths in Code mode', () => {
    const hook = require('../../scripts/permission-hook.js');
    const scan = (command, cwd) => hook.classifyShellAccess('PowerShell', { command }, W.ws, [W.projects], W.home, true,
      { cwd, codeMode: true, platform: 'win32', env: ENV });
    for (const [id, command] of [
      ['R2', 'Get-Content ..\\other\\README.md'], ['O1', 'npm run build *> $env:TEMP\\build.log'], ['O2', 'Get-Content $env:TEMP\\build.log'],
      ['O3', 'Copy-Item -Recurse dist $env:TEMP\\app-build'], ['O5', 'Get-ChildItem $env:LOCALAPPDATA\\npm-cache'],
      ['O8', 'Get-Content $env:USERPROFILE\\.gitconfig'],
    ]) {
      assert.strictEqual(scan(command, W.app), null, `${id}: ${command} reaches nothing outside`);
    }
    for (const [id, command] of [['O10', 'Get-Content $env:USERPROFILE\\.ssh\\config'], ['O11', 'Get-Content $env:USERPROFILE\\.aws\\credentials']]) {
      const a = scan(command, W.app);
      assert.ok(a && a.where === 'outside', `${id}: ${command} is a crossing`);
      assert.strictEqual(a.grantDir, null, `${id}: and no folder is offered`);
    }
    const r6 = scan('Get-Content ..\\..\\elsewhere\\x.txt', W.app);
    assert.ok(r6 && r6.where === 'outside', 'R6: climbing out of every working folder is still a crossing');
  });
});
