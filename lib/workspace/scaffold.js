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
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getWorkspace } = require('../config.js');
const { readState, writeState } = require('../store/persistence.js');

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
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
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

// Scans workspace for code files. Returns 'code' or 'knowledge'.
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
  return 'knowledge';
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
    // The runtime command sandbox. Written only when the file does not
    // already carry one: whoever edited it knows which extra roots their work
    // needs, and rewriting it on every workspace open would undo that
    // silently, on a file the product invites people to edit.
    if (!settingsLocal.sandbox) {
      const sandbox = sandboxSettings(dir, platform);
      if (sandbox) { settingsLocal.sandbox = sandbox; dirtySandbox = true; }
    }
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
      fs.writeFileSync(settingsLocalPath, JSON.stringify(settingsLocal, null, 2));
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
function sandboxSettings(dir, platform = process.platform, home = os.homedir()) {
  // Native Windows has no sandbox, and Windows is one of the two platforms
  // this product builds for. Linux is documented as supported and was NOT
  // measured here, and this file ships only what was run.
  if (platform !== 'darwin') return null;
  return {
    enabled: true,
    // The runtime's own prompt for a sandboxed command. Rundock never shows
    // it: the permission hook is the decider, and it still fires either way
    // (measured). Pinned so the behaviour does not move with a default.
    autoAllowBashIfSandboxed: true,
    filesystem: { allowWrite: [dir, path.join(home, '.npm')] },
    network: { allowedDomains: ['*'] },
  };
}

module.exports = {
  muteHooks, isEmptyWorkspace, detectWorkspaceMode, scaffoldDefaults, scaffoldWorkspace,
  sandboxSettings, wireScaffoldDeps,
};
