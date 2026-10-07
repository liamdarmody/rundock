// Installs the vendored example packages (packages/README.md) into a demo
// workspace, offline and deterministically, through Rundock's own install
// code: the same plan, decision, apply and extension-install functions the
// Packages page drives over the socket, with the clock and the receipt run id
// fixed so every run writes the same bytes.
//
// It also serves each package from a local git repository under the build
// root, so the live server's install review and update check run unchanged.
// The server is pointed at those repositories with git's own url rewriting
// (serverGitEnv below), exactly as the e2e suite points a fixture organisation
// at repositories it seeds.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VENDORED = path.join(__dirname, 'packages');
const lib = (rel) => require(path.join(REPO_ROOT, 'lib', 'packages', rel));

// The organisation the packages are published under. The package cards and the
// install review show their real repository link, so this one public handle
// is allowed through the sanitisation gate, and only inside these URLs.
export const PACKAGE_ORG = 'liamdarmody';
const url = (repo) => `https://github.com/${PACKAGE_ORG}/${repo}`;

// One entry per vendored package. `releases` are the tags its local repository
// carries, oldest first; each names the files it adds over the one before.
export const PACKAGES = {
  investmentPartner: { dir: 'investment-partner', repo: 'rundock-investment-partner', releases: [{ tag: 'v1.0.0' }] },
  csvViewer: { dir: 'csv-table', repo: 'rundock-csv-extension', releases: [{ tag: 'v1.0.4' }] },
  leanAgentTeam: {
    dir: 'lean-agent-team', repo: 'lean-agent-team',
    releases: [{ tag: 'v1.2.0' }, { tag: 'v1.2.1', overlay: 'v1.2.1' }],
  },
  myTracker: { dir: 'my-tracker', repo: 'rundock-package-starter', releases: [{ tag: 'v0.1.0' }] },
};

// Every package URL the demo can show, for the sanitisation gate's allowance.
export const PACKAGE_URLS = Object.values(PACKAGES).map((p) => url(p.repo));

// Fixed git identity and dates, so a repository's commits (and so the commit
// the install review shows) are identical on every run.
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid',
  GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid',
  GIT_AUTHOR_DATE: '2026-07-01T09:00:00Z', GIT_COMMITTER_DATE: '2026-07-01T09:00:00Z',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

function copyTree(from, to, skip = () => false) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    if (skip(entry.name)) continue;
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(dest, { recursive: true }); copyTree(src, dest); }
    else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); }
  }
}

// XDG_CONFIG_HOME points git's per-user files (an ignore list, attributes)
// at the repository itself, where there are none, so nothing outside the
// build root is read.
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV, XDG_CONFIG_HOME: cwd }, encoding: 'utf8' }).trim();
}

// Builds `<root>/repos/<repo>` with one commit and tag per release, and a
// clean copy of each release's tree under `<root>/snapshots/<repo>@<tag>` to
// install from. Returns { [tag]: { snapshot, commit } }.
function buildRepository(root, pkg) {
  const repoDir = path.join(root, 'repos', pkg.repo);
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '--quiet', '--initial-branch=main');
  const base = path.join(VENDORED, pkg.dir);
  const overlays = new Set(pkg.releases.map((r) => r.overlay).filter(Boolean));
  const out = {};
  for (const release of pkg.releases) {
    if (release.overlay) copyTree(path.join(base, release.overlay), repoDir);
    else copyTree(base, repoDir, (name) => overlays.has(name));
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '--quiet', '-m', `Release ${release.tag}`);
    git(repoDir, 'tag', release.tag);
    const snapshot = path.join(root, 'snapshots', `${pkg.repo}@${release.tag}`);
    copyTree(repoDir, snapshot, (name) => name === '.git');
    out[release.tag] = { snapshot, commit: git(repoDir, 'rev-parse', `${release.tag}^{commit}`) };
  }
  return out;
}

// The environment that points the server's git at the local repositories.
export function serverGitEnv(root) {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${path.join(root, 'repos')}/.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://github.com/${PACKAGE_ORG}/`,
  };
}

// The decisions a person makes by accepting the offer as it stands, except
// that an incoming leader joins the team as a specialist under the workspace's
// own, which is the offer's own alternative to skipping it.
function acceptOffer(plan) {
  const decisions = {};
  for (const item of plan.items) {
    if (item.agent && item.agent.adopt) decisions[item.id] = 'adopt';
    else decisions[item.id] = item.collision ? 'skip' : 'add';
  }
  return lib('import-plan.js').decide(plan, decisions);
}

// Installs one release: its extension (if it has one) and then its agents,
// skills and starter files, as the two steps of the Packages page do.
function installRelease(workspace, pkg, release, { tag, at, run, extensionOnly = false }) {
  const source = { url: url(pkg.repo), reference: tag };
  const { snapshot, commit } = release;
  const { classifySnapshot, readPackageDisplayName } = lib('extension-manifest.js');
  let displayName = readPackageDisplayName(snapshot) || null;
  if (classifySnapshot(snapshot).kind !== 'content') {
    const { planExtensionInstall, installExtension } = lib('extension-install.js');
    const plan = planExtensionInstall(workspace, snapshot, { ...source, commit });
    installExtension(workspace, snapshot, plan, { now: at });
    displayName = plan.manifest.displayName || displayName;
    // The second step is offered only when the package carries agents or
    // skills beside its extension, as the Packages page decides.
    if (extensionOnly || !(plan.facts.agents || plan.facts.skills)) return;
  }
  const plan = lib('import-plan.js').buildPlan(workspace, snapshot, { id: source.url, reference: tag });
  const result = lib('import-apply.js').applyImport(workspace, snapshot, acceptOffer(plan), {
    receipt: { now: at, run, commit, displayName },
  });
  if (result.status !== 'ready') throw new Error(`demo install of ${pkg.repo} ${tag} was refused: ${result.status}`);
}

// Serves every package from a local repository, and installs the ones a
// variant asks for. `installs` is a list of { key, tag, at, run, enabled,
// extensionOnly }, applied in order.
export function setUpPackages(root, workspace, installs = []) {
  const releases = {};
  for (const [key, pkg] of Object.entries(PACKAGES)) releases[key] = buildRepository(root, pkg);
  for (const step of installs) {
    const pkg = PACKAGES[step.key];
    installRelease(workspace, pkg, releases[step.key][step.tag], step);
    if (step.enabled === false) {
      const name = JSON.parse(fs.readFileSync(path.join(releases[step.key][step.tag].snapshot, 'rundock.json'), 'utf8')).name;
      lib('extension-manage.js').setExtensionEnabled(workspace, name, false);
    }
  }
}
