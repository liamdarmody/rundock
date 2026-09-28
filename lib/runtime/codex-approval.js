'use strict';
// CODEX ESCALATIONS, GRADED BY THE RULES CLAUDE CODE AGENTS MEET.
//
// Codex never runs the permission hook. What reaches Rundock is an escalation
// out of Codex's own sandbox: a command, or a file change carrying only its
// grantRoot. This grades each one in process, with the same boundary scan and
// the same Code-mode verdict the hook uses, and answers:
//
//   { decision: 'accept' }            no card; the glue answers `accept`,
//                                     never `acceptForSession`, which would let
//                                     Codex's own matching answer later
//                                     commands nobody here has graded
//   { decision: 'card', request }     the request the browser receives, with
//                                     the same fields a hook request carries
//
// Commands in Code mode: the boundary scan, then the verdict, from the
// approval's own cwd. Commands in Notes mode: today's grading, so always a
// card. File changes, in both modes: inside the workspace or a working folder
// they are accepted; a runtime-home surface, instruction file or secret always
// asks; anywhere else is a boundary card that can name a working folder.
//
// THE WORKSPACE'S OWN PERMISSION ANSWERS ARE NEVER ACCEPTED BY GRADING. A file
// change whose grantRoot is, or contains, `.rundock/permissions.json`,
// `.rundock/state.json` or `.claude/settings.local.json`, and a command that
// writes one, is the answer-file card in either mode. This holds whatever
// Codex's own sandbox does about those paths; stopping the writes that never
// escalate at all is the job of the thread-level protection in codex-glue.js.
const path = require('path');
const os = require('os');
const fs = require('fs');
const hook = require('../../scripts/permission-hook.js');
const { codeModeVerdict } = require('../../scripts/code-mode-verdict.js');
const devPaths = require('../../scripts/dev-paths.js');

function under(p, root) {
  const a = path.resolve(p);
  const b = path.resolve(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function gradeCodexApproval({ kind, params = {}, workspaceRoot, extraDirs = [], codeMode = false, home = os.homedir() }) {
  if (kind === 'command') return gradeCommand(params, { workspaceRoot, extraDirs, codeMode, home });
  return gradeFileChange(params, { workspaceRoot, extraDirs, codeMode, home });
}

function gradeCommand(params, { workspaceRoot, extraDirs, codeMode, home }) {
  const toolName = process.platform === 'win32' ? 'PowerShell' : 'Bash';
  const command = String(params.command || '');
  const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : undefined;
  const input = { command, ...(cwd ? { cwd } : {}), ...(params.reason ? { description: params.reason } : {}) };
  const access = hook.classifyShellAccess(toolName, { command }, workspaceRoot, extraDirs, home, undefined, { cwd, codeMode });
  const verdict = codeMode ? codeModeVerdict({ toolName, command, cwd, workspaceRoot, extraDirs, home }) : null;
  if (codeMode && !access && verdict.verdict === 'runs') return { decision: 'accept' };
  return { decision: 'card', request: requestFor(toolName, input, access, verdict) };
}

function requestFor(toolName, input, access, verdict) {
  const request = { tool_name: toolName, input };
  if (verdict) request.code_mode_verdict = verdict;
  if (access && access.where === 'outside') {
    const crossings = hook.boundaryCrossingsFor(access);
    const onlyAnswerFiles = crossings.length > 0 && crossings.every(c => c && c.answerFile);
    if (onlyAnswerFiles) {
      Object.assign(request, { answer_file: true, resolved_path: crossings[0].path, grant_dir: null, crossings });
    } else {
      Object.assign(request, {
        boundary: true,
        resolved_path: access.resolvedPath || (crossings[0] && crossings[0].path) || null,
        grant_dir: (crossings[0] && crossings[0].grantDir) || access.grantDir || null,
        crossings,
      });
    }
  }
  return request;
}

// Whether `g` is, or contains, an answer file: one of this workspace's own, or
// another Rundock workspace's `.rundock` files, matched by name wherever they
// sit (self-permission by proxy through a named parent folder). A `.rundock`
// folder, and a folder that directly holds one, count as containing them.
function touchesAnswerFile(g, workspaceRoot) {
  const root = hook.canonicalize(workspaceRoot);
  const own = hook.WORKSPACE_ANSWER_FILES.some((f) => {
    const af = hook.canonicalize(path.join(root, ...f.split('/')));
    return under(af, g);
  });
  if (own) return true;
  if (hook.isAnswerFileOfAnyWorkspace(g)) return true;
  if (path.basename(g) === '.rundock') return true;
  // A Rundock workspace's `.claude` folder holds its settings files.
  if (path.basename(g) === '.claude' && fs.existsSync(path.join(path.dirname(g), '.rundock', 'state.json'))) return true;
  return hook.RUNDOCK_ANSWER_FILES.some(f => fs.existsSync(path.join(g, ...f.split('/'))));
}

// Whether `g` reaches another Rundock workspace's agents or skills: inside
// them, or a folder that holds them (that workspace's `.claude`, or its root).
function touchesOtherWorkspaceAgents(g, workspaceRoot) {
  if (hook.isOtherWorkspaceAgentSurface(path.join(g, 'x'), workspaceRoot) || hook.isOtherWorkspaceAgentSurface(g, workspaceRoot)) return true;
  const other = hook.otherWorkspaceRootOf(path.join(g, 'x'), workspaceRoot);
  return !!other && (g === other || g === path.join(other, '.claude'));
}

// Whether `g`, inside a runtime home, is or contains a surface or a secret.
function touchesRuntimeSurface(g, home) {
  return hook.runtimeHomes(home).some((h) => {
    if (!under(g, h.root) && !under(h.root, g)) return false;
    const entries = [...h.secrets, ...h.dirs, ...h.files].map(e => path.join(h.root, e));
    return entries.some(e => under(e, g) || under(g, e));
  });
}

function gradeFileChange(params, { workspaceRoot, extraDirs, codeMode, home }) {
  const raw = typeof params.grantRoot === 'string' && params.grantRoot ? params.grantRoot : workspaceRoot;
  const g = hook.canonicalize(path.resolve(workspaceRoot, raw));
  const input = { path: g, content: null, approvalKind: 'fileChange', reason: params.reason || null };
  const card = extra => ({ decision: 'card', request: { tool_name: 'WriteFile', input, ...extra } });

  if (touchesAnswerFile(g, workspaceRoot)) {
    return card({ answer_file: true, resolved_path: g, grant_dir: null, crossings: [{ path: g, answerFile: true }] });
  }
  if (touchesOtherWorkspaceAgents(g, workspaceRoot)) {
    return card({ boundary: true, resolved_path: g, grant_dir: null, grantable: false, crossings: [{ path: g, write: true, persistenceSurface: true, otherWorkspace: true }] });
  }
  if (touchesRuntimeSurface(g, home)) {
    const tags = {
      secret: hook.isSecretPath(g, home), persistenceSurface: true,
      ...(hook.isInstructionSurface(g, home) ? { instructionFile: true } : {}),
    };
    return card({ boundary: true, resolved_path: g, grant_dir: null, grantable: false, crossings: [{ path: g, agentHome: true, write: true, ...tags }] });
  }
  if (under(g, hook.canonicalize(workspaceRoot)) || extraDirs.some(d => under(g, hook.canonicalize(d)))) return { decision: 'accept' };
  // The runtime homes' own scratch is free, as it is for Claude Code.
  if (hook.runtimeHomes(home).some(h => under(g, h.root))) return { decision: 'accept' };
  if (codeMode && devPaths.isDevPath(g, { home, canonical: hook.canonicalize })) return { decision: 'accept' };

  const hidden = hook.hiddenHomeRootOf(g, home);
  const offered = offerFor(g, home);
  input.graded = 'boundary';
  return card({
    boundary: true, resolved_path: g, grant_dir: offered,
    crossings: [{ path: g, grantDir: offered, write: true, ...(hidden ? { hiddenHome: path.basename(hidden) } : {}) }],
  });
}

// The folder a file-change card may offer to name: the grantRoot itself when
// it is a folder, or the folder holding it; never home or above, never a
// hidden folder under home, never one that does not exist.
function offerFor(g, home) {
  let dir = g;
  try { if (!fs.statSync(g).isDirectory()) dir = path.dirname(g); } catch (e) { dir = path.dirname(g); }
  if (!fs.existsSync(dir)) return null;
  const h = hook.canonicalize(home);
  if (dir === h || under(h, dir)) return null;
  if (hook.hiddenHomeRootOf(dir, home)) return null;
  if (dir === path.parse(dir).root) return null;
  return dir;
}

module.exports = { gradeCodexApproval };
