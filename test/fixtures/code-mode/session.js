'use strict';
// A development session: the tool calls a coding agent really makes in a
// repository under a working folder, in order, 85 of them. Pure data, so every
// build of the hook, and the Codex grading, can be replayed against exactly
// the same calls (see test/unit/code-mode-replay.test.js).
//
// Spellings, supplied per variant by the replay:
//   R   how the agent spells the repository in SHELL text (may start with ~)
//   RA  how the agent spells the repository in FILE-TOOL paths (always
//       absolute; Claude Code's file tools take absolute paths)
//   P   shell spelling of the projects folder, PA its absolute spelling
//   H   the home directory the hook process sees
//
// `cwd` is the hook input's cwd field: 'repo' (RA) after the agent has cd'd
// in, or 'ws' (the workspace root). A few calls are repeated with the other
// value on purpose.
//
// `codex` is a MODEL for the Codex replay, not an observation: whether the
// call writes outside the workspace (so Codex's workspace-write sandbox,
// scoped to the workspace cwd, escalates it) and whether it needs the network
// (workspace-write has no network by default). A real remote is assumed for
// the network column.
module.exports = function session({ R, RA, P, PA, H }) {
  const c = [];
  const bash = (group, command, o = {}) => c.push({ group, tool: 'Bash', input: { command, description: o.desc || undefined }, cwd: o.cwd || 'repo', codex: o.codex || { write: false, net: false } });
  const file = (group, tool, input, o = {}) => c.push({ group, tool, input, cwd: o.cwd || 'repo', codex: o.codex || { write: tool !== 'Read' && tool !== 'Glob' && tool !== 'Grep', net: false } });
  const W = { write: true, net: false };
  const N = { write: false, net: true };
  const WN = { write: true, net: true };

  // ── Orientation ──
  bash('git', `cd ${R} && git status`);
  bash('git', 'git status');
  bash('git', 'git log --oneline -5');
  file('file', 'Read', { file_path: `${RA}/package.json` });
  file('file', 'Glob', { pattern: '**/*.js', path: `${RA}/src` });
  file('file', 'Grep', { pattern: 'login', path: RA });

  // ── Branch, edit, commit, push ──
  bash('git', 'git switch -c feat/signup', { codex: W });
  file('file', 'Edit', { file_path: `${RA}/src/index.js`, old_string: "console.log('hello');", new_string: "console.log('hello, world');" });
  file('file', 'Write', { file_path: `${RA}/src/signup.js`, content: 'module.exports = () => true;\n' });
  file('file', 'Edit', { file_path: `${RA}/package.json`, old_string: '"version": "1.0.0"', new_string: '"version": "1.1.0"' });
  bash('git', 'git add -A && git commit -m "Add signup"', { codex: W });
  bash('git', 'git push -u origin feat/signup', { codex: WN });
  bash('git', 'git push', { codex: WN });
  bash('git', 'git push origin main', { codex: WN });
  bash('git', 'git pull', { codex: WN });
  bash('git', 'git pull --rebase', { codex: WN });
  bash('git', 'git fetch --prune', { codex: WN });
  bash('git', 'git rebase main', { codex: W });
  bash('git', 'git push --force-with-lease', { codex: WN });
  bash('git', 'git commit --amend --no-edit', { codex: W });
  bash('git', 'git stash', { codex: W });
  bash('git', 'git stash pop', { codex: W });
  bash('git', 'git reset --soft HEAD~1', { codex: W });
  bash('git', 'git reset --hard origin/feat/signup', { codex: W });
  bash('git', 'git restore src/index.js', { codex: W });
  bash('git', 'git checkout .', { codex: W });
  bash('git', 'git clean -fd', { codex: W });
  bash('git', 'git branch -D old-spike', { codex: W });
  bash('git', 'git push origin --delete old-spike', { codex: WN });
  bash('git', 'git push --force origin feat/signup', { codex: WN });
  bash('git', `git -C ${R} status`);
  bash('git', 'git diff main...feat/signup -- src/');

  // ── Deleting and moving files ──
  bash('files', 'rm notes.txt', { codex: W });
  bash('files', 'rm -rf node_modules', { codex: W });
  bash('files', 'rm -rf dist', { codex: W });
  bash('files', 'rm -rf dist', { cwd: 'ws', codex: W });
  bash('files', `cd ${R} && rm -rf dist`, { cwd: 'ws', codex: W });
  bash('files', `rm -rf ${R}/dist`, { codex: W });
  bash('files', 'rm -rf dist node_modules', { codex: W });
  bash('files', "find . -name '*.orig' -delete", { codex: W });
  bash('files', "find src -name '*.pyc' -delete", { codex: W });
  bash('files', 'mkdir -p src/components', { codex: W });
  bash('files', 'mv src/old.js src/legacy.js', { codex: W });
  bash('files', 'cp .env.example .env', { codex: W });
  file('file', 'Read', { file_path: `${RA}/.env` });
  bash('files', 'chmod +x scripts/dev.sh', { codex: W });
  bash('files', 'curl -fsSL -o vendor.tgz https://example.com/vendor.tgz', { codex: WN });

  // ── Packages and processes ──
  bash('pkg', 'npm install', { codex: WN });
  bash('pkg', 'npm ci', { codex: WN });
  bash('pkg', 'npm install --force', { codex: WN });
  bash('pkg', 'npm run build', { codex: W });
  bash('pkg', 'npm test');
  bash('pkg', 'npm run dev > /dev/null 2>&1 &');
  bash('pkg', 'kill 4242');
  bash('pkg', 'pkill -f vite');
  bash('pkg', 'lsof -ti :3000 | xargs kill -9');

  // ── Relative paths after a cd, and sibling projects ──
  bash('relative', 'ls ..');
  bash('relative', 'cat ../other/README.md');
  bash('relative', `cd ${R} && cat ../other/README.md`, { cwd: 'ws' });
  bash('relative', `cd ${P} && ls`, { cwd: 'ws' });
  bash('relative', `ls ${P}`, { cwd: 'ws' });
  bash('relative', `rm -rf ${P}/sketch`, { cwd: 'ws', codex: W });
  file('file', 'Read', { file_path: `${PA}/other/README.md` });

  // ── Path spellings the matcher has to survive ──
  file('file', 'Write', { file_path: `${RA}/src/new/deep/file.js`, content: '// unborn folders\n' });
  bash('relative', `touch ${R}/src/newfile.js`, { codex: W });
  bash('relative', `ls ${R}/../other`);
  bash('relative', 'git -C ../other status');

  // ── Beyond the working folder ──
  bash('beyond', 'npm cache verify', { codex: W });
  bash('beyond', 'ls ~/.npm/_cacache');
  bash('beyond', 'rm -rf ~/.npm/_cacache', { codex: W });
  bash('beyond', 'npm install --cache ~/.npm', { codex: WN });
  bash('beyond', 'npm run build > /tmp/build.log 2>&1', { codex: W });
  bash('beyond', 'cat /tmp/build.log');
  bash('beyond', 'mkdir -p /tmp/app-build && cp -r dist /tmp/app-build/'); // Codex workspace-write also writes /tmp by default
  bash('beyond', 'git config --global user.name');
  bash('beyond', 'cat ~/.gitconfig');
  file('file', 'Read', { file_path: `${H}/.gitconfig` });
  bash('beyond', 'ssh -T git@example.invalid', { codex: N });
  bash('beyond', 'cat ~/.ssh/config');
  bash('beyond', 'ls ~/.ssh');
  file('file', 'Read', { file_path: `${H}/.ssh/config` });
  file('file', 'Read', { file_path: `${H}/.claude/CLAUDE.md` });
  bash('beyond', 'cat ~/.claude/settings.json');
  file('file', 'Edit', { file_path: `${H}/.claude/settings.json`, old_string: '{}', new_string: '{"x":1}' });
  file('file', 'Write', { file_path: `${H}/.claude/CLAUDE.md`, content: '# global\n' });
  return c;
};
