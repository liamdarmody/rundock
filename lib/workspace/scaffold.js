'use strict';
// Workspace mode detection and scaffolding, extracted verbatim from
// server.js as part of the server decomposition. Two root-owned
// capabilities arrive through wireScaffoldDeps BY IDENTITY:
// invalidateAgentCache (the root's cascade over agent + skill + file
// caches) and rebaselineAgentsWatcher (the agents-dir watcher stays in the
// root; the sync must tell it that managed-file writes are the server's
// own, never external edits). Unwired deps throw at first use.
//
// ROOT_DIR hops from lib/workspace/ to the repo (or app.asar) root: the
// scaffold/ sources and scripts/permission-hook.js live there, and the
// Electron asar-unpacked rewrite applies to that root exactly as it did
// when this code lived in server.js.
// Rundock's own writes of the answer files are recorded, so the Codex
// answer-file guard never mistakes them for an agent's (answer-file-guard.js).
const { noteOwnWrite } = require('./answer-file-guard.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getWorkspace } = require('../config.js');
const { readState, writeState } = require('../store/persistence.js');
const { normalizeWorkingFolders, effectiveWorkingFolders } = require('./working-folders.js');
const { RUNDOCK_ANSWER_FILES, RUNTIME_GUARDED_ANSWER_FILES } = require('../../scripts/permission-hook.js');
const { normalizeWorkspaceMode } = require('./mode.js');

const ROOT_DIR = path.join(__dirname, '..', '..');

const unwired = (name) => () => {
  throw new Error(`lib/workspace/scaffold: ${name} not wired (call wireScaffoldDeps at boot)`);
};
const deps = {
  invalidateAgentCache: unwired('invalidateAgentCache'),
  rebaselineAgentsWatcher: unwired('rebaselineAgentsWatcher'),
};
function wireScaffoldDeps(next) {
  const prev = { ...deps };
  Object.assign(deps, next);
  return prev;
}

// Mute sound hooks for Rundock (idempotent: skips already-muted hooks)
function muteHooks(dir) {
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return;
  try {
    const text = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(text);
    if (!settings.hooks) return;
    let mutedCount = 0;
    const soundPattern = /afplay|aplay|paplay|powershell.*audio/i;

    for (const [event, entries] of Object.entries(settings.hooks)) {
      for (const entry of (Array.isArray(entries) ? entries : [])) {
        const hooks = entry.hooks || [entry];
        for (const hook of hooks) {
          if (!hook.command || !soundPattern.test(hook.command)) continue;
          if (hook.command.includes('$RUNDOCK')) continue; // Already muted
          hook.command = `[ -z "$RUNDOCK" ] && ${hook.command} || true`;
          mutedCount++;
        }
      }
    }
    if (mutedCount > 0) {
      const body = JSON.stringify(settings, null, 2);
      fs.writeFileSync(settingsPath, body);
      noteOwnWrite(settingsPath, body);
      console.log(`  [Scaffold] Muted ${mutedCount} sound hook(s) for Rundock`);
    }
  } catch (e) {
    console.warn(`  Warning: could not mute hooks: ${e.message}`);
  }
}

// ===== EMPTY WORKSPACE DETECTION =====

// Returns true if the workspace has no user-created content: no agents (besides
// Rundock-managed ones), no CLAUDE.md, no skills. The .claude/ directory and
// .rundock/ directory are ignored since scaffoldWorkspace() creates those.
function isEmptyWorkspace(dir, agentList) {
  // Check for CLAUDE.md
  if (fs.existsSync(path.join(dir, 'CLAUDE.md'))) return false;

  // Check for user-created agents (exclude platform agents injected by Rundock)
  const userAgents = (agentList || []).filter(a =>
    a.type !== 'platform' && a.id !== 'rundock-guide'
  );
  if (userAgents.length > 0) return false;

  // Check for skills (either location)
  const skillDirs = [
    path.join(dir, '.claude', 'skills'),
    path.join(dir, 'System', 'Playbooks'),
  ];
  for (const sd of skillDirs) {
    try {
      if (fs.existsSync(sd)) {
        const entries = fs.readdirSync(sd, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith('rundock-'));
        if (entries.length > 0) return false;
      }
    } catch (e) { /* ignore */ }
  }

  // Check for user file structure. A workspace can lack CLAUDE.md, agents,
  // and skills and still be someone's organised vault (beta incident,
  // 2026-04-30: an existing Obsidian vault was scaffolded with the default
  // folders during onboarding). Hidden entries never count: they are tool
  // state (.obsidian, .claude, .rundock, .git, .DS_Store), not structure.
  // One or two stray root files are tolerated so a folder holding a lone
  // readme still gets the full scaffold; any visible directory, or three
  // or more visible files, means the user has structure we must not
  // scaffold over.
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'));
    if (entries.some(e => e.isDirectory())) return false;
    if (entries.filter(e => e.isFile()).length >= 3) return false;
  } catch (e) { /* unreadable dir: treat as empty, matching prior behaviour */ }

  return true;
}

// ===== CODE SIGNAL AUTO-DETECTION =====

// File extensions and config files that indicate a code project.
const CODE_SIGNALS = [
  // Extensions (checked against top-level files and one level deep)
  '.js', '.jsx', '.ts', '.tsx', '.py', '.go', '.rs', '.rb', '.java',
  '.c', '.cpp', '.h', '.cs', '.swift', '.kt',
];
const CODE_CONFIG_FILES = [
  'package.json', 'requirements.txt', 'Cargo.toml', 'go.mod',
  'Makefile', 'CMakeLists.txt', 'pyproject.toml', 'Gemfile',
  'pom.xml', 'build.gradle', 'tsconfig.json', '.eslintrc.json',
  'setup.py', 'setup.cfg', 'composer.json',
];

// Scans workspace for code files. Returns 'code' or 'notes' (the value
// written for Notes since 0.15.0; readers accept 'knowledge' too, see mode.js).
function detectWorkspaceMode(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      if (entry.isFile()) {
        // Check config files
        if (CODE_CONFIG_FILES.includes(entry.name)) return 'code';
        // Check extensions
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_SIGNALS.includes(ext)) return 'code';
      }

      // Scan one level deep for code files
      if (entry.isDirectory()) {
        try {
          const subEntries = fs.readdirSync(path.join(dir, entry.name));
          for (const sub of subEntries) {
            if (CODE_CONFIG_FILES.includes(sub)) return 'code';
            const ext = path.extname(sub).toLowerCase();
            if (CODE_SIGNALS.includes(ext)) return 'code';
          }
        } catch (e) { /* skip unreadable dirs */ }
      }
    }
  } catch (e) {
    console.warn('  Code signal detection failed:', e.message);
  }
  return 'notes';
}

// ===== DEFAULT WORKSPACE SCAFFOLDING =====

// Creates default folders, CLAUDE.md, and orchestrator agent for new/empty workspaces.
// Returns { success: true } or { success: false, error: string }.
function scaffoldDefaults(dir) {
  const folderName = path.basename(dir);
  const mode = detectWorkspaceMode(dir);
  const isCode = mode === 'code';

  try {
    if (!isCode) {
      // Knowledge workspace: create default folders
      const folders = ['0 Inbox', '1 Notes', '2 Projects', '3 Resources', '4 Archive'];
      for (const folder of folders) {
        fs.mkdirSync(path.join(dir, folder), { recursive: true });
      }

      // Create CLAUDE.md with folder structure
      const claudeMd = `# ${folderName}

## Workspace structure

- **0 Inbox/**: Put things here when you don't know where they go
- **1 Notes/**: Meeting notes, ideas, quick captures
- **2 Projects/**: Things you're actively working on
- **3 Resources/**: Reference material you want to keep
- **4 Archive/**: Finished work
`;
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
    } else {
      // Code workspace: create minimal CLAUDE.md only, no folders
      const claudeMd = `# ${folderName}\n`;
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
    }

    // Mark setup as incomplete so onboarding flows through Doc
    const state = readState();
    state.setupComplete = false;
    writeState(state);

    console.log(`  [Scaffold] Created default workspace (${mode}): CLAUDE.md${isCode ? '' : ' + folders'} (setup pending)`);
    return { success: true };
  } catch (e) {
    console.error(`  [Scaffold] Default workspace creation failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ===== WORKSPACE SCAFFOLD =====

// Rundock-owned files: synced from scaffold/ on every workspace open.
// Only rundock-* prefixed files are managed. User files are never touched.
const RUNDOCK_MANAGED_FILES = [
  { source: 'rundock-guide.md',            target: '.claude/agents/rundock-guide.md' },
  { source: 'rundock-workspace.md',  target: '.claude/skills/rundock-workspace/SKILL.md' },
  { source: 'rundock-agents.md',    target: '.claude/skills/rundock-agents/SKILL.md' },
  { source: 'rundock-skills.md',    target: '.claude/skills/rundock-skills/SKILL.md' },
  { source: 'rundock-tuneup.md',    target: '.claude/skills/rundock-tuneup/SKILL.md' },
];

function scaffoldWorkspace(dir, opts = {}) {
  // opts.platform: test seam for the platform-specific hook wiring below
  // (same injection pattern as resolveCodexBin in codex.js).
  const platform = opts.platform || process.platform;
  // Never create the workspace directory as a side effect. If it was
  // deleted or renamed externally, bail so callers can handle the miss.
  if (!fs.existsSync(dir)) return;
  try {
    fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });

    // Sync Rundock-owned agents and skills from scaffold sources
    let wroteManagedFile = false;
    for (const entry of RUNDOCK_MANAGED_FILES) {
      const sourceContent = fs.readFileSync(path.join(ROOT_DIR, 'scaffold', entry.source), 'utf-8');
      const targetPath = path.join(dir, entry.target);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      let action = null;
      if (!fs.existsSync(targetPath)) {
        action = 'Created';
      } else {
        const deployed = fs.readFileSync(targetPath, 'utf-8');
        if (deployed !== sourceContent) action = 'Updated';
      }

      if (action) {
        fs.writeFileSync(targetPath, sourceContent, 'utf-8');
        wroteManagedFile = true;
        console.log(`  [Scaffold] ${action}: ${entry.target}`);
      }
    }
    // Writing a managed agent or skill (Doc, the platform skills) changes what
    // discovery would return, so drop the agent and skill caches. Without this,
    // a caller that primed the cache before this sync (the workspace-open path
    // does exactly that) would keep reading stale agents and the platform
    // skills would show as unassigned until a reload.
    if (wroteManagedFile) {
      deps.invalidateAgentCache();
      // These writes are the server's own, not external edits: refresh the
      // watcher baseline so the next poll stays quiet.
      if (dir === getWorkspace()) deps.rebaselineAgentsWatcher();
    }

    // Create .rundock/ directory for session persistence
    const rundockPath = path.join(dir, '.rundock');
    fs.mkdirSync(rundockPath, { recursive: true });

    // Ensure .rundock/ is gitignored (contains session IDs and timestamps)
    const gitignorePath = path.join(dir, '.gitignore');
    try {
      const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
      if (!existing.includes('.rundock')) {
        const line = (existing && !existing.endsWith('\n') ? '\n' : '') + '.rundock/\n';
        fs.appendFileSync(gitignorePath, line);
        console.log(`  Scaffolded: .rundock/ added to .gitignore`);
      }
    } catch (e) {
      console.warn(`  Warning: could not update .gitignore: ${e.message}`);
    }

    // Auto-mute sound hooks for Rundock
    muteHooks(dir);

    // Configure PreToolUse permission hooks in .claude/settings.local.json.
    // This makes Claude Code call our hook script before executing tools,
    // which bridges to the Rundock browser UI for user approval.
    // Separate matchers for Bash commands and MCP tools (mcp__*).
    // In Electron, ROOT_DIR is inside the read-only asar. The scripts/
    // directory is marked asarUnpack in package.json, so it exists on disk
    // at app.asar.unpacked/scripts/ and must be referenced from there.
    const hookScript = process.env.RUNDOCK_ELECTRON
      ? path.join(ROOT_DIR.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked'), 'scripts', 'permission-hook.js')
      : path.join(ROOT_DIR, 'scripts', 'permission-hook.js');
    // Claude Code launches the PreToolUse hook as a child process. Packaged
    // users have no system `node`, so the hook must run via Rundock's own runtime
    // (process.execPath: the Electron binary, run as Node via ELECTRON_RUN_AS_NODE;
    // or plain node when run from source). Relying on ELECTRON_RUN_AS_NODE being
    // INHERITED through Claude's hook spawn proved unreliable on Windows (the flag
    // didn't reach the hook, so Rundock.exe launched the app instead of running as
    // Node, and the hook never executed). So we write a tiny launcher that sets the
    // flag explicitly, then execs the runtime against the hook script. The launcher
    // lives in the gitignored .rundock/ dir (always writable, unlike the read-only
    // app bundle on macOS). Named permission-hook.* so the stale-entry cleanup
    // below still recognises it.
    const rundockDir = path.join(dir, '.rundock');
    let expectedHookCommand;
    let expectedHookShell; // set on Windows only; POSIX entries carry no shell field
    try {
      fs.mkdirSync(rundockDir, { recursive: true });
      if (platform === 'win32') {
        const launcher = path.join(rundockDir, 'permission-hook.cmd');
        fs.writeFileSync(launcher,
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${hookScript}" %*\r\n`);
        // Claude Code runs hooks under Git Bash on Windows when Git is
        // installed; PowerShell is only the fallback (docs: hooks shell
        // defaults to bash, or powershell when Git Bash is absent). Both
        // shell-agnostic command forms fail under Git Bash, verified live:
        // `& "launcher"` is a bash syntax error (fail-closed), and
        // `cmd /c "launcher"` gets its /c switch rewritten to a drive path
        // by MSYS argument conversion, so cmd starts an interactive session
        // instead of running the launcher (fail-open). The documented fix
        // is the hooks `shell` field: pin the entry to PowerShell and use
        // the call-operator form PowerShell requires to execute a quoted
        // path. Machines without Git Bash already default to PowerShell,
        // so behaviour converges. The stale-entry cleanup below migrates
        // both earlier forms automatically.
        expectedHookCommand = `& "${launcher}"`;
        expectedHookShell = 'powershell';
      } else {
        const launcher = path.join(rundockDir, 'permission-hook.sh');
        fs.writeFileSync(launcher,
          `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${hookScript}" "$@"\n`);
        fs.chmodSync(launcher, 0o755);
        expectedHookCommand = `sh "${launcher}"`;
      }
    } catch (e) {
      // Fallback: direct invocation (relies on inherited ELECTRON_RUN_AS_NODE).
      expectedHookCommand = `"${process.execPath}" "${hookScript}"`;
    }
    const settingsLocalPath = path.join(dir, '.claude', 'settings.local.json');
    let settingsLocal = {};
    let dirtySandbox = false;
    if (fs.existsSync(settingsLocalPath)) {
      try { settingsLocal = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf-8')); } catch (e) { /* start fresh */ }
    }
    // The runtime command sandbox. Written when the file does not already
    // carry one, and OUR copy kept in step with where the workspace is.
    //
    // A block a person wrote or edited is never touched: whoever edited it
    // knows which extra roots their work needs. Tested with `in` rather than
    // falsiness, because a user who wrote false decided something and
    // treating that as absent would switch it back on at the next open.
    //
    // The reconcile exists because the block names the workspace by absolute
    // path while living INSIDE that workspace, so the two travel together
    // when the folder is moved, renamed or copied to another machine. Left
    // alone, the root then names where the workspace used to be, and the
    // operating system refuses every write inside the new location: the
    // retry raises a boundary card for a path that is in the workspace,
    // while the release notes say the workspace is writable.
    //
    // TWO INPUTS. The switch ("Keep agents inside this workspace") decides the
    // enable: on writes the enabled shape, off writes the same paths with
    // `enabled: false`. The named folders decide which paths the block carries.
    // Mode is not an input: it used to be, which is how choosing Code also
    // turned the operating system's write block off.
    //
    // sandboxShapeFor reads the switch stored for THIS dir, falling back to the
    // value its mode always implied, so a workspace that predates the switch
    // reconciles to exactly the block it already has and nothing is rewritten.
    // The open path records a new workspace's switch before calling here, so
    // its very first open writes the right block too. workingFoldersFor reads
    // that same dir's folder list for the same reason.
    const desired = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), sandboxShapeFor(dir));
    const ownsSettings = rundockOwnsSettings(settingsLocal);
    if (reconcileSandboxBlock(settingsLocal, desired)) dirtySandbox = true;
    if (ownsSettings && reconcileAdditionalDirectories(settingsLocal, additionalDirectoriesFor(dir))) dirtySandbox = true;
    if (!settingsLocal.hooks) settingsLocal.hooks = {};
    if (!settingsLocal.hooks.PreToolUse) settingsLocal.hooks.PreToolUse = [];

    const hookEntry = (matcher) => ({
      matcher,
      hooks: [{
        type: 'command',
        command: expectedHookCommand,
        ...(expectedHookShell ? { shell: expectedHookShell } : {}),
        timeout: 300
      }]
    });

    // Drop any existing permission-hook entries whose command OR shell does
    // NOT match the current expected form. This forces rewrite of stale
    // entries left behind by earlier versions: paths inside the read-only
    // asar archive, the unpinned `& "..."` form (bash syntax error), and
    // the `cmd /c "..."` form (MSYS-mangled under Git Bash).
    const hookUpToDate = (h) => h.command === expectedHookCommand &&
      (expectedHookShell ? h.shell === expectedHookShell : h.shell === undefined);
    const beforeStale = settingsLocal.hooks.PreToolUse.length;
    settingsLocal.hooks.PreToolUse = settingsLocal.hooks.PreToolUse.filter(e => {
      const hooks = e.hooks || [];
      const hasStaleHook = hooks.some(h =>
        h.command && h.command.includes('permission-hook') && !hookUpToDate(h)
      );
      return !hasStaleHook;
    });
    let dirty = dirtySandbox || settingsLocal.hooks.PreToolUse.length < beforeStale;

    const hasMatcher = (matcher) => settingsLocal.hooks.PreToolUse.some(e =>
      e.matcher === matcher && (e.hooks || []).some(hookUpToDate)
    );

    if (!hasMatcher('Bash')) {
      settingsLocal.hooks.PreToolUse.push(hookEntry('Bash'));
      dirty = true;
    }
    // File tools route through the hook for the workspace boundary: the hook
    // allows in-workspace targets instantly (no server round-trip) and sends
    // out-of-workspace targets to the permission card unless a standing
    // folder grant covers them. Before this matcher existed, Write and Edit
    // were pre-approved EVERYWHERE under acceptEdits: an agent wrote the
    // workspace CLAUDE.md into the user's home directory with zero friction.
    const FILE_TOOLS_MATCHER = 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep';
    if (!hasMatcher(FILE_TOOLS_MATCHER)) {
      settingsLocal.hooks.PreToolUse.push(hookEntry(FILE_TOOLS_MATCHER));
      dirty = true;
    }
    // On Windows (and wherever CLAUDE_CODE_USE_POWERSHELL_TOOL is on) Claude Code
    // runs shell commands through the PowerShell tool, not Bash. Without this
    // matcher those commands bypass the permission system entirely.
    if (!hasMatcher('PowerShell')) {
      settingsLocal.hooks.PreToolUse.push(hookEntry('PowerShell'));
      dirty = true;
    }
    if (!hasMatcher('mcp__.*')) {
      settingsLocal.hooks.PreToolUse.push(hookEntry('mcp__.*'));
      dirty = true;
    }
    // Clean up Write/Edit hook entries if they exist from a previous version
    const before = settingsLocal.hooks.PreToolUse.length;
    settingsLocal.hooks.PreToolUse = settingsLocal.hooks.PreToolUse.filter(e =>
      !(e.matcher === 'Write' || e.matcher === 'Edit')
    );
    if (settingsLocal.hooks.PreToolUse.length < before) dirty = true;
    if (dirty) {
      const body = JSON.stringify(settingsLocal, null, 2);
      fs.writeFileSync(settingsLocalPath, body);
      noteOwnWrite(settingsLocalPath, body);
      console.log('  [Scaffold] Configured permission hooks in .claude/settings.local.json');
    }
  } catch (e) {
    console.warn(`  Warning: scaffold failed for ${dir}: ${e.message}`);
  }
}

// What the spawned runtime is told about which roots a shell command may
// write to. Returns null where there is nothing to configure.
//
// The rationale lives in ARCHITECTURE.md, in the "An agent stays inside your
// workspace" audit bullet: why there are two instruments, why the network
// list is open, and why the allowlist being additive is stated to users
// rather than claimed away. It is kept in one place because five copies of
// one argument do not get edited together.
//
// The decisions that bear on the VALUES below, each measured against the
// runtime rather than read from documentation:
//   - Leaving `network.allowedDomains` out refuses every outbound host for
//     shell commands, and a refused host produces no retry, so the command
//     just fails.
//   - Leaving the npm cache out fails `npm install` inside its own cache,
//     reported as a file-ownership error rather than a refused write.
//   - macOS only. Windows has no sandbox. Linux has one and is left off
//     because it was not run here.
// Did Rundock write this block, or did a person?
//
// Recognised by regenerating: take the workspace root the block CLAIMS (its
// first writable root) and ask whether this is exactly what would have been
// written for it. Anything else is not Rundock's to touch, which is what
// stops the reconcile from discarding roots somebody added deliberately.
//
// The known limit, recorded now rather than discovered later: recognition is
// against the CURRENT shape. If the shape below ever changes, blocks written
// by an earlier version stop being recognised, are treated as user-authored,
// and a workspace moved after that upgrade keeps a stale root. That is the
// safe direction, since the alternative is clobbering real edits, and it is
// still a cost.
function sameSandbox(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function isRundockSandbox(block, platform = 'darwin') {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  const roots = block.filesystem && block.filesystem.allowWrite;
  if (!Array.isArray(roots)) return false;
  const [claimedWorkspace, claimedCache] = roots;
  if (typeof claimedWorkspace !== 'string' || typeof claimedCache !== 'string') return false;
  // BOTH roots come from the block, not from this machine.
  //
  // The cache root is under the home directory of whoever wrote it, so
  // regenerating with THIS machine's home meant a workspace copied to another
  // machine or another account never matched its own block. It was then read
  // as user-authored, kept the workspace root from the old machine, and the
  // operating system refused every write inside the new location, which is
  // the failure the release notes say cannot happen.
  //
  // The cache root is what tells us which home the block was written under.
  // The endsWith test is a legibility filter rather than a guard, and is
  // labelled so nobody credits it with safety: a wrong home simply
  // regenerates blocks that fail every comparison below. The comparisons are
  // what decide, here as everywhere in this function.
  const suffix = path.posix.sep + '.npm';
  if (!claimedCache.endsWith(suffix)) return false;
  const claimedHome = claimedCache.slice(0, -suffix.length);
  if (!claimedHome) return false;
  // Rundock is the author if this is EXACTLY what it would write for that
  // workspace and that home, under any of the shapes it has ever written.
  //
  // The current shape carries this machine's temp roots in its tail, and a
  // block written on another machine carries THAT machine's, so the tail is
  // recognised structurally: the head must match position for position, and
  // whatever follows must be one or two non-empty strings. A block that
  // matches structurally but not byte for byte is ours and stale, which is
  // exactly what lets the reconcile above rewrite it for this machine, the
  // same journey the workspace root already makes when a folder moves.
  //
  // The 0.12.0 two-root shape is recognised verbatim, so a block that
  // release wrote upgrades on the next open instead of being read as a
  // person's edit and left denying the runtime its own bookkeeping.
  if (sameSandbox(block, legacySandboxSettings(claimedWorkspace, claimedHome))) return true;
  const expectedHead = [claimedWorkspace, claimedCache, ...runtimeRoots(claimedHome)];
  const tail = roots.slice(expectedHead.length);
  // WHAT DECIDES AUTHORSHIP, NOW THAT THE TAIL HAS NO FIXED LENGTH.
  //
  // The tail used to be one or two temp roots, so its length was a check in
  // its own right. It now also carries the folders the user named, and that
  // list is arbitrary in both length and content, so no bound on it can
  // separate our block from someone else's. The head does that work instead:
  // six entries in fixed positions, derived from the block's OWN claimed
  // workspace and home, and rebuilt for the comparison below. A person's block
  // does not accidentally open with a workspace root, an `.npm` cache under
  // the same home, and this release's four runtime roots in order.
  //
  // What is given up, deliberately: a path a person APPENDS to our block now
  // reads as a working folder rather than as their edit, and is regenerated
  // away on the next open. The supported place to name a folder is the Working
  // Folders setting, which is what the card already points people at. The
  // alternative is worse and is the failure this whole card exists to end: a
  // block Rundock wrote that Rundock can no longer recognise is a block it can
  // never rewrite or withdraw, which strands the workspace with an operating
  // system nobody can talk to.
  //
  // The tail is accepted from ANY machine (a block scaffolded elsewhere and
  // opened here still has to reconcile rather than read as a stranger's edit),
  // so it is never checked against THIS host's temp roots or THIS workspace's
  // current folder list. A tail that differs from what this machine would
  // write is ours and stale, which is exactly what lets the reconcile rewrite
  // it, the same journey the workspace root already makes when a folder moves.
  if (roots.length < expectedHead.length + 1) return false;
  if (!tail.every(t => typeof t === 'string' && t.length > 0)) return false;
  // WHICH SHAPE THIS CLAIMS TO BE. Read from the block, so a workspace that
  // changed mode still recognises what it wrote before and reconciles to the
  // shape its current mode wants.
  //
  // THE VALUE DECIDES, NOT THE KEY. This asked `'enabled' in block`, on the
  // premise that only Knowledge mode wrote the key at all. Code mode now writes
  // `enabled: false` (it turns the sandbox off rather than staying silent about
  // it), so presence no longer separates the two: every Code mode block would
  // claim to be Knowledge, rebuild as the wrong shape, match nothing, and be
  // read as a person's edit. Never rewritten, never withdrawn.
  //
  // Three shapes map onto two modes. `true` is Knowledge. `false` is Code.
  // ABSENT is also Code: that is the key-less block every workspace opened in
  // Code mode before this change still carries, and it must rebuild as Code so
  // priorShapes can recognise it and this open can upgrade it.
  const claimedMode = block.enabled === true ? 'knowledge' : 'code';
  // Everything OUTSIDE the root list must still be exactly ours, and the head
  // inside it must rebuild byte for byte. The tail is borrowed from the block
  // wholesale: it is this machine's own values either way, so it is carried
  // rather than judged, and the comparison decides the rest.
  //
  // It is handed back through the temp-roots parameter rather than the folders
  // one because the two are concatenated in that order and the whole tail is
  // being replayed, not re-derived. Going through sandboxSettings rather than
  // sandboxBlock keeps the platform guard doing its job: on a platform Rundock
  // writes no block for, there is no block of ours to recognise.
  const rebuilt = sandboxSettings(claimedWorkspace, platform, claimedHome, tail, [], claimedMode);
  if (sameSandbox(block, rebuilt)) return true;
  // EVERY DENY SHAPE RUNDOCK HAS EVER WRITTEN, recognised so a block already on
  // disk upgrades on the next open instead of reading as a person's edit.
  // Without this a workspace scaffolded by an earlier build is refused by its
  // own recogniser, which means never rewritten and never withdrawn: the exact
  // stranding this file goes to some length elsewhere to avoid.
  //
  // There are three, and there have been three since permissions.json joined
  // the list: no denyWrite at all, state.json alone, and the current pair. The
  // middle one is what every workspace opened under 0.13.1 and 0.13.2 carries,
  // so leaving it out strands precisely the people upgrading rather than
  // starting fresh.
  if (rebuilt === null) return false;
  return priorShapes(rebuilt).some((shape) => sameSandbox(block, shape));
}

// Every shape Rundock has ever written, across BOTH axes that have moved: the
// deny list, which grew an entry at a time, and Code mode's `enabled` key,
// which was absent until it became `false`. Composed from the current block
// rather than listed as frozen copies, for the same reason the deny shapes are:
// a third change to either axis extends this automatically instead of quietly
// stranding the workspaces written under the second.
//
// Every workspace opened in Code mode before this carries the key-less shape.
// Without it here, its own recogniser reads it as a person's edit, which means
// it is never reconciled and never withdrawn: it would keep a sandbox Code mode
// is documented as not having, which is the precise bug this change fixes.
function priorShapes(block) {
  return priorDenyShapes(block).flatMap((shape) => (
    shape.enabled === false ? [shape, withoutEnabled(shape)] : [shape]
  ));
}
// Key order survives because `enabled` is written first: dropping it leaves
// `filesystem` where it already was, and sameSandbox compares serialised text.
function withoutEnabled(block) {
  const { enabled, ...rest } = block;
  return rest;
}

// The block as it was written under each earlier deny list. Derived by
// narrowing the CURRENT list rather than by keeping frozen copies, so the
// shapes cannot drift apart as the rest of the block changes, and so a deny
// entry added later extends this automatically: every proper prefix of the
// current list is a shape this once wrote, in the order the entries were added.
//
// Key order is preserved because sameSandbox compares serialised text:
// `filesystem` keeps its position in the outer object, and replacing or
// dropping denyWrite leaves allowWrite where it was.
function priorDenyShapes(block) {
  const deny = (block.filesystem && block.filesystem.denyWrite) || [];
  const shapes = [block, withoutDenyWrite(block)];
  for (let n = 1; n < deny.length; n++) shapes.push(withDenyWrite(block, deny.slice(0, n)));
  return shapes;
}
function withoutDenyWrite(block) {
  const { denyWrite, ...filesystem } = block.filesystem;
  return { ...block, filesystem };
}
function withDenyWrite(block, denyWrite) {
  return { ...block, filesystem: { ...block.filesystem, denyWrite } };
}

// The temp directory as the block should carry it: both spellings. macOS
// gives every user a per-user temp under /var/folders, and /var is a symlink
// to /private/var, so the same directory has two absolute names and commands
// meet both. A block naming only one refuses writes spelled the other way.
// The realpath can fail on an exotic setup; the raw name alone is then the
// honest best.
function tempRoots(tmp = os.tmpdir()) {
  const roots = [tmp];
  try {
    const real = fs.realpathSync(tmp);
    if (real !== tmp) roots.push(real);
  } catch (e) { /* the raw name alone */ }
  return roots;
}

// The fixed writable roots every block carries beyond the workspace, the
// cache and the temp directory: the runtime's own bookkeeping. MEASURED, NOT
// REASONED, against Claude Code 2.1.259 on 2026-09-03 (the diagnosis is in
// ARCHITECTURE.md's boundary section): fourteen subsystems under
// ~/.claude written within one day of ordinary use (sessions, projects,
// shell-snapshots, telemetry, tasks, caches and more), the ~/.claude.json
// config written continuously, and /tmp/claude used for task output. The
// 0.12.0 block omitted these on the reasoning that the runtime keeps its own
// defaults writable; in the field that trust did not hold, and every user
// met a wall of cards for plumbing they never see.
function runtimeRoots(home) {
  return [
    path.posix.join(home, '.claude'),
    path.posix.join(home, '.claude.json'),
    '/tmp/claude',
    '/private/tmp/claude',
  ];
}

// THE BLOCK, GIVEN ITS WRITE LIST AND WHICH MODE IS ASKING.
//
// Rundock owns ONE settings layer and the sandbox is decided across all of
// them. `sandbox.enabled` resolves as `enabled ?? false`, so no block means no
// sandbox. The enable is an OR across every layer: the shipped runtime reads
// `[...layers, localSettings].some(e => e?.sandbox?.enabled === !0)`, measured
// against Claude Code 2.1.266 and read again in 2.1.281. Claude Code's settings
// documentation (code.claude.com/docs/en/settings, "Settings precedence")
// describes a key taking the highest layer's value, but the runtime ORs
// `enabled`. So a user who switched the sandbox on in their own
// ~/.claude/settings.json has switched it on for every workspace on the machine,
// and nothing Rundock writes into its own layer can switch it back off; the
// Permissions row (lib/workspace/sandbox-status.js) says so.
//
// That is why Code mode contributed PATHS WITHOUT AN ENABLE. Deleting the block
// was correct and was never enough: it removed Rundock's enable and left the
// user's, and then the workspace met an operating system that had never been
// told which folders the user named. A block carrying `filesystem` alone
// enables nothing on its own (verified against a real machine running exactly
// that shape) and is unioned in when some other layer has done the enabling.
//
// `network` and `autoAllowBashIfSandboxed` stay OUT of the Code-mode shape on
// purpose. `allowedDomains: ['*']` in a unioned layer would widen a network
// policy the user set deliberately, and this change is about filesystem paths.
function sandboxBlock(allowWrite, mode) {
  // POSIX paths throughout: this block is only ever written for macOS, so every
  // path in it is POSIX by construction and the recogniser reads it back the
  // same way. Judged with the host's separator instead, a Windows machine
  // opening a workspace scaffolded on a Mac would fail to recognise Rundock's
  // own block and would neither reconcile nor withdraw it.
  const filesystem = { allowWrite, denyWrite: denyWriteFor(allowWrite[0]) };
  // CODE MODE TURNS THE BLOCK OFF, it does not merely decline to turn it on.
  //
  // This returned `{ filesystem }` with no `enabled`, on the reasoning that
  // omitting it avoids fighting a layer that did the enabling. In practice the
  // layer that does the enabling is the user's own ~/.claude/settings.json, or
  // the runtime's default once any sandbox key exists, and silence loses to
  // both. So Code mode inherited a sandbox it is documented as not having.
  //
  // What that cost: headless Chromium cannot launch under Seatbelt at all. It
  // is refused a process-launch primitive, not a file, so no allowWrite entry
  // fixes it (the design-export skill documents exactly this). The only escape
  // is running with the sandbox off, which Rundock cards every time and never
  // remembers, so every render raised a prompt that could not be silenced. A
  // designer rendering a dozen exports met a dozen cards.
  //
  // The mode description already promised this: "On macOS the operating-system
  // write block is off here, because tools that launch their own processes,
  // such as a headless browser, can fail under it regardless of folder
  // permissions." Saying `false` makes the code match the sentence.
  //
  // The filesystem block stays beside it so the allowWrite list survives a
  // switch back to Knowledge mode rather than being rebuilt from nothing.
  // The switch passes 'on' or 'off'; 'knowledge' and 'code' are the shapes the
  // recogniser replays for blocks written while mode decided this.
  if (mode === 'code' || mode === 'off') return { enabled: false, filesystem };
  return {
    enabled: true,
    // The runtime's own prompt for a sandboxed command. Rundock never shows
    // it: the permission hook is the decider, and it still fires either way
    // (measured). Pinned so the behaviour does not move with a default.
    autoAllowBashIfSandboxed: true,
    filesystem,
    network: { allowedDomains: ['*'] },
  };
}

// THE ONE FILE INSIDE THE WORKSPACE THAT THIS BLOCK IS BUILT FROM.
//
// `.rundock/state.json` holds the workspace mode and the named working folders,
// and both decide what goes in the block above: the mode decides whether
// Rundock claims the enable, the folders decide which paths are writable. It
// also sits inside the workspace root, so the permission hook classifies a
// write to it as `inside` and never cards it, which is correct for every other
// file in there and wrong for this one. An agent that can write it can widen
// the boundary it is standing inside, then wait for the next reconcile to make
// that widening real: the sandbox would be configured by the thing it contains.
//
// `denyWrite` is documented by the runtime as "additional paths to deny writing
// within the sandbox", merged rather than replacing, so naming it here holds
// whichever layer turned the sandbox on. It is carried in the Code-mode shape
// too: that shape enables nothing by itself, but when another layer has done
// the enabling this is the only place the deny would come from.
//
// This does not protect the file when no sandbox is running at all. Nothing in
// this layer can, and there is then no boundary to widen either.
//
// Deliberately this file alone, not the folder. Agents legitimately write
// scratch under `.rundock/`, and a deny over the directory would take that away
// to protect one file.
// DERIVED FROM THE HOOK'S REGISTRY, never restated. The hook cards a write to
// these files on every platform; this denies it outright where a sandbox runs.
// Two lists of the same files, maintained apart, is a drift waiting to happen:
// a file added to one and not the other is protected on some platforms and not
// others, and nothing would say so. One list, two enforcement points.
// The OS block's deny list keeps the files it has always named. The
// workspace's .claude/settings.json is an answer file for the card, but it is
// not added here: the block's shape is what recognises it as Rundock's own,
// and the operating-system sandbox is unchanged in this release.
function denyWriteFor(workspaceDir) {
  return [...RUNDOCK_ANSWER_FILES, ...RUNTIME_GUARDED_ANSWER_FILES].map(f => path.posix.join(workspaceDir, f));
}

// THE WRITE LIST. The workspace, the cache, the runtime's fixed roots, the temp
// roots, then the folders the user named.
//
// Folders go LAST so a workspace with none produces the list this function has
// always produced, byte for byte, and so the head the recogniser checks keeps
// its fixed positions. What follows the head is this machine's own values, and
// is the reason a block written on another machine reconciles rather than
// matching.
// De-duplicated against what the list already carries, because the two sources
// genuinely overlap: the runtime's own scratch is a BUILTIN working folder
// (see builtinWorkingFolders) and is also a runtime root here. Left in twice
// the block would still work and would still be recognised, being compared
// against a regeneration that repeats the same duplicate, but it would read as
// a mistake to the next person who opens the file.
function sandboxAllowWrite(dir, home, tmpRoots, folders) {
  const base = [dir, path.posix.join(home, '.npm'), ...runtimeRoots(home), ...tmpRoots];
  return [...base, ...folders.filter((f) => !base.includes(f))];
}

function sandboxSettings(dir, platform = process.platform, home = os.homedir(), tmpRoots = tempRoots(), folders = [], mode = 'knowledge') {
  // Native Windows has no sandbox, and Windows is one of the two platforms
  // this product builds for. Linux is documented as supported and was NOT
  // measured here, and this file ships only what was run.
  if (platform !== 'darwin') return null;
  return sandboxBlock(sandboxAllowWrite(dir, home, tmpRoots, folders), mode);
}

// The 0.12.0 block, frozen verbatim so blocks written by that release are
// still recognised as Rundock's own and upgraded, rather than read as a
// person's edit and left denying the runtime its plumbing forever.
function legacySandboxSettings(dir, home) {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    filesystem: { allowWrite: [dir, path.posix.join(home, '.npm')] },
    network: { allowedDomains: ['*'] },
  };
}

// The write/update/withdraw decision for the sandbox block inside a parsed
// settings.local.json object. One place, called from both the on-open
// reconcile in scaffoldWorkspace and the immediate write in
// reconcileSandboxForMode: this is the rule that decides whether Rundock
// ever touches a block a person wrote, and having it live twice meant a
// fourth case or a changed authorship test added to one copy could leave the
// other deciding differently, so a workspace could reconcile one way on open
// and another way through the mode switch.
//
// `ours` is tested with `in` rather than falsiness, because a user who wrote
// `sandbox: false` decided something and treating that as absent would
// switch it back on. Withdrawing (not just updating) when desired is null
// matters on its own: a workspace scaffolded on macOS and opened on a
// platform Rundock writes no block for was still handing the runtime a
// block with a macOS absolute root, because recognising our own block only
// in order to update it left it in place exactly where it could do the most
// harm.
//
// Mutates settingsLocal in place, the shape both callers already keep
// around a JSON round trip, and returns whether it changed anything.
//
// Authorship is always checked against the darwin shape (isRundockSandbox's
// own default), never against the current host's platform: a Rundock-
// authored block only ever exists in darwin shape, because sandboxSettings
// returns null everywhere else, so a block regenerated against any other
// platform would fail to match its own author's work. `desired`, in
// contrast, IS platform-dependent, and callers compute it with the platform
// they mean before calling in.
// WHETHER THE SANDBOX IN THIS WORKSPACE IS ONE RUNDOCK CAN ACTUALLY CHANGE.
//
// Rundock never touches a block a person wrote, which protects anyone who
// configured their own policy deliberately. The cost was paid in silence: the
// mode switch still SAID Code mode, and Code mode's own description promises
// the operating-system write block is off, while a hand-authored block kept it
// on. The product made a promise it could see it was not keeping, and the only
// way to find out was to read the file.
//
// Reported from the field after a headless render failed in a workspace that
// was in Code mode: the sandbox was on, because the block was not Rundock's.
// This is the answer the settings pane needs to stop claiming otherwise.
//
// Read-only, and deliberately says nothing about whether the foreign block is
// correct or wise. It reports one fact: mode changes will not move it.
//
// Beside isRundockSandbox rather than in the server, so the notice and the
// reconcile can never disagree about who owns a block.
function sandboxOwnership(dir, platform = process.platform) {
  let settingsLocal;
  try {
    settingsLocal = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8'));
  } catch (e) {
    // No file, or one this cannot read. Nothing is claiming the sandbox, so
    // there is nothing to warn about: the next open writes Rundock's own.
    return { managed: true, present: false, enabled: null };
  }
  const block = settingsLocal && settingsLocal.sandbox;
  if (!block || typeof block !== 'object') return { managed: true, present: false, enabled: null };
  return {
    managed: isRundockSandbox(block),
    present: true,
    // What the block actually says, so the pane can report the state rather
    // than infer it from the mode, which is the inference that was wrong.
    enabled: block.enabled === true,
  };
}

// THE WORKING FOLDERS REACH CLAUDE CODE AS ADDITIONAL DIRECTORIES, through the
// settings file it is launched with, and never as --add-dir.
//
// Claude Code documents that a `cd` carries over to the next command only while
// it stays inside the project or an additional directory; outside them the
// shell is reset to the project. Without this, every `cd ~/Projects/app` was
// undone by the next call, and agents repeated `cd ... &&` on every command.
// `permissions.additionalDirectories` in a settings file grants file access and
// loads no configuration, where `--add-dir` would also load skills, commands
// and subagents from the folder that Rundock never shows, and fails on a
// folder that does not exist, which is a state Settings shows on purpose.
//
// MEASURED, not only documented: on Claude Code 2.1.283 (2026-09-28), with a
// working folder listed only in the settings file's
// `permissions.additionalDirectories` and no `--add-dir`, a `cd` into it in one
// Bash call was still in effect in the next, with no reset notice. So the
// settings file is enough, and the `--add-dir` fallback is not used.
//
// Only folders that exist are listed. Rundock owns this list the way it owns
// its sandbox block: it is rewritten from the named folders on every reconcile.
//
// AND ONLY WHERE RUNDOCK OWNS THE SETTINGS. A settings file whose sandbox
// block a person wrote is theirs: Rundock rewrites no part of it, this list
// included. Working folders there are still named folders to Rundock (the
// permission hook covers them), but a `cd` into one lasts only for that
// command.
// Whether Rundock owns this settings file: no sandbox block yet (the next
// reconcile writes Rundock's), or one Rundock wrote. Read before the reconcile
// changes anything.
function rundockOwnsSettings(settingsLocal) {
  return !settingsLocal || !('sandbox' in settingsLocal) || isRundockSandbox(settingsLocal.sandbox);
}
function additionalDirectoriesFor(dir) {
  return workingFoldersFor(dir).filter((d) => {
    try { return fs.statSync(d).isDirectory(); } catch (e) { return false; }
  });
}
function reconcileAdditionalDirectories(settingsLocal, dirs) {
  const perms = (settingsLocal.permissions && typeof settingsLocal.permissions === 'object' && !Array.isArray(settingsLocal.permissions))
    ? settingsLocal.permissions : null;
  const current = perms && Array.isArray(perms.additionalDirectories) ? perms.additionalDirectories : null;
  if (!dirs.length) {
    if (!current) return false;
    delete perms.additionalDirectories;
    if (!Object.keys(perms).length) delete settingsLocal.permissions;
    return true;
  }
  if (current && current.length === dirs.length && current.every((d, i) => d === dirs[i])) return false;
  if (!perms) settingsLocal.permissions = {};
  settingsLocal.permissions.additionalDirectories = dirs.slice();
  return true;
}

function reconcileSandboxBlock(settingsLocal, desired) {
  const ours = 'sandbox' in settingsLocal && isRundockSandbox(settingsLocal.sandbox);
  if (!('sandbox' in settingsLocal)) {
    if (desired) { settingsLocal.sandbox = desired; return true; }
    return false;
  }
  if (ours && desired && !sameSandbox(settingsLocal.sandbox, desired)) {
    settingsLocal.sandbox = desired;
    return true;
  }
  if (ours && !desired) {
    delete settingsLocal.sandbox;
    return true;
  }
  return false;
}

// WHETHER AGENTS ARE KEPT INSIDE THIS WORKSPACE: the switch, stored in the
// workspace's own state file as `sandboxSwitch`, 'on' or 'off'.
//
// ABSENT MEANS WHAT THE MODE ALWAYS IMPLIED: off for Code, on for anything
// else. That is the value every block was written with before the switch
// existed, so a workspace that predates it reconciles to the block it already
// has, and nothing is rewritten on open. The key is written only when the
// person acts (the switch, the one-time notice, a mode change, bringing their
// own rules in) or when Rundock meets a workspace for the first time.
//
// Read from the dir's own file, never the current workspace's, for the reason
// workspaceModeFor gives below.
const NEW_WORKSPACE_SANDBOX_SWITCH = 'on';

function sandboxSwitchFromState(state) {
  const st = state && typeof state === 'object' ? state : {};
  if (st.sandboxSwitch === 'on' || st.sandboxSwitch === 'off') return { on: st.sandboxSwitch === 'on', stored: true };
  return { on: normalizeWorkspaceMode(st.workspaceMode) !== 'code', stored: false };
}

function readOwnState(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'state.json'), 'utf-8')); } catch (e) { return {}; }
}

function sandboxSwitchFor(dir) {
  return sandboxSwitchFromState(readOwnState(dir));
}

// The shape name sandboxSettings takes for this dir's switch.
function sandboxShapeFor(dir) {
  return sandboxSwitchFor(dir).on ? 'on' : 'off';
}

// A workspace Rundock has never opened (no mode recorded) gets its mode
// detected and the switch recorded at the new-workspace default, before the
// scaffold's reconcile reads either. One already opened is left alone, so
// this can never move an existing workspace's switch.
function recordFirstOpen(dir) {
  const state = readOwnState(dir);
  if (state.workspaceMode) return state;
  state.workspaceMode = detectWorkspaceMode(dir);
  if (!sandboxSwitchFromState(state).stored) state.sandboxSwitch = NEW_WORKSPACE_SANDBOX_SWITCH;
  fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
  const body = JSON.stringify(state, null, 2);
  fs.writeFileSync(path.join(dir, '.rundock', 'state.json'), body);
  noteOwnWrite(path.join(dir, '.rundock', 'state.json'), body);
  return state;
}

// The workspace's own persisted mode, read directly from its state file
// rather than through the store module, for the same reason the opt-out this
// replaces used to: this runs during scaffolding, before the workspace is
// necessarily the current one, and the mode read must belong to the folder
// being scaffolded, never to whatever workspace happens to be current.
// Defaults to 'knowledge', the same default every other reader of an unset
// mode uses (handleGetWorkspaces, detectWorkspaceMode's own return).
function workspaceModeFor(dir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'state.json'), 'utf-8'));
    return normalizeWorkspaceMode(state.workspaceMode);
  } catch (e) { return normalizeWorkspaceMode(undefined); }
}

// The folders THIS workspace named, read from its own state file for exactly
// the reason workspaceModeFor reads the mode from there: readWorkingFolders()
// resolves through readState(), which answers for whatever workspace is
// CURRENT, and this runs during scaffolding, when the folder being set up may
// not be that one. Handing the current workspace's folders to a different
// workspace's sandbox would widen a boundary nobody named.
//
// The effective list, not the stored one, so the runtime's own scratch is
// covered here exactly as it is at the hook. The overlap with the runtime
// roots is removed in sandboxAllowWrite rather than here.
function workingFoldersFor(dir) {
  let stored = [];
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'state.json'), 'utf-8'));
    stored = normalizeWorkingFolders(state.workingFolders);
  } catch (e) { /* unreadable or absent: the builtins still apply */ }
  return effectiveWorkingFolders(stored);
}

// The block's immediate write/withdraw outside an open: when the switch is
// flipped, and when a named folder changes, so either takes effect without
// waiting for the next workspace open. `mode` is the shape to write ('on' or
// 'off' from the switch; 'knowledge' and 'code' are accepted as the same two
// shapes). Only Rundock's own block is ever touched; a block a person wrote
// stays exactly as they wrote it, in both directions.
// `platform` is the same defaulted seam every sibling in this feature takes
// (sandboxSettings, isRundockSandbox's caller in scaffoldWorkspace): a test
// can drive either arm on any host.
function reconcileSandboxForMode(dir, mode, platform = process.platform) {
  const settingsLocalPath = path.join(dir, '.claude', 'settings.local.json');
  let settingsLocal = {};
  try {
    settingsLocal = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf-8'));
  } catch (e) {
    // Absent (ENOENT) is the only failure {} may stand in for. Anything else
    // means the file EXISTS and could not be read or parsed: a hand-added
    // comment, a torn read while Claude Code is itself mid-write to it, an
    // EACCES. Starting from {} there would compute `desired` against nothing,
    // overwrite the file with a lone sandbox key, and silently discard every
    // PreToolUse hook entry it carried, leaving the next runtime spawn with
    // no permission hook at all until the workspace is reopened. So this
    // throws instead of swallowing: the caller's own catch turns it into
    // workspace_error naming this path, never workspace_mode_changed, and
    // the file's bytes are never touched.
    if (e.code !== 'ENOENT') throw new Error(`could not read ${settingsLocalPath}: ${e.message}`);
  }
  // Off no longer means "no block". It means a block that names the folders
  // and states `enabled: false`: withdrawing ours would leave the decision to
  // whichever lower settings layer sets it, and would stop telling any sandbox
  // that runs which folders the person named.
  const desired = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), mode);
  const ownsSettings = rundockOwnsSettings(settingsLocal);
  let dirty = reconcileSandboxBlock(settingsLocal, desired);
  if (ownsSettings && reconcileAdditionalDirectories(settingsLocal, additionalDirectoriesFor(dir))) dirty = true;
  if (dirty) {
    fs.mkdirSync(path.dirname(settingsLocalPath), { recursive: true });
    const body = JSON.stringify(settingsLocal, null, 2);
    fs.writeFileSync(settingsLocalPath, body);
    noteOwnWrite(settingsLocalPath, body);
  }
}

module.exports = {
  muteHooks, isEmptyWorkspace, detectWorkspaceMode, scaffoldDefaults, scaffoldWorkspace,
  sandboxSettings, isRundockSandbox, sandboxOwnership, wireScaffoldDeps, reconcileSandboxForMode, workspaceModeFor,
  sandboxSwitchFor, sandboxSwitchFromState, sandboxShapeFor, recordFirstOpen, NEW_WORKSPACE_SANDBOX_SWITCH,
  tempRoots, workingFoldersFor,
  // Exported so callers can ask which files Rundock rewrites rather than
  // keeping a second copy of the list that drifts (server.js's model error
  // card must not recommend editing one of them).
  RUNDOCK_MANAGED_FILES,
};
