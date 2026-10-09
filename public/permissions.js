'use strict';
// Client permission/trust decision logic. Pure functions, extracted from
// app.js so they are unit-testable under node --test and findable by name:
// "the human leads" and the trust page's claims rest on exactly these
// functions, and the licence invites anyone to audit them. Same UMD pattern
// as code-language.js and markers.js.
//
// The permission decision path spans THREE layers (see ARCHITECTURE.md):
// the PreToolUse hook script, the server bridge, and THIS module in the
// browser. The auto-allow POLICY for low-risk read-only commands lives here,
// client-side, and nowhere else; what counts as read-only FOR A BASH COMMAND
// is a separate question, answered once in public/read-only-shell.js and read
// by the hook as well, because a command the hook read as harmless used to be
// carded here anyway by a narrower list kept alongside the policy.
//
// SCOPED TO BASH, DELIBERATELY. classifyRisk's PowerShell branch below still
// judges read-only-ness with a wider heuristic of its own (any `Get-*`,
// `Where-Object`) that the shared module does not know about, so the hook and
// this file can still disagree about the same PowerShell text in exactly the
// shape the Bash path no longer can. That is a known gap carried on its own
// card; this comment states where the single answer stops rather than
// implying the whole file has one.
//
// What this module decides (pinned by test/unit/permissions.test.js):
//   classifyRisk()        low / medium / high per tool request
//   describeToolRequest() human-readable card copy (summary/context/detail)
//   toolAllowKey()        the pattern "Always allow" matches on
//   decidePermission()    auto-allow (always-allowed or low-risk) vs card
//   offersAlwaysAllow()   high-risk requests never get a standing allow
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./read-only-shell.js'));
  else root.RundockPermissions = factory(root.RundockReadOnlyShell);
}(typeof self !== 'undefined' ? self : this, function (RundockReadOnlyShell) {

  // The one definition of read-only, shared with the permission hook. This
  // module used to keep a second, narrower one, and the two disagreed: a
  // command the hook read as harmless was carded here anyway. See
  // public/read-only-shell.js.
  var DISCARDING_REDIRECT_RE = RundockReadOnlyShell.DISCARDING_REDIRECT_RE;
  var shellSegments = RundockReadOnlyShell.shellSegments;
  var isReadOnlyShellCommand = RundockReadOnlyShell.isReadOnlyShellCommand;
  var isDestructiveShellCommand = RundockReadOnlyShell.isDestructiveShellCommand;

  const BASH_DESCRIPTIONS = {
    ls: 'List directory contents', cat: 'Read file contents', head: 'Read start of file',
    tail: 'Read end of file', grep: 'Search file contents', rg: 'Search file contents',
    find: 'Find files', echo: 'Print text', pwd: 'Show current directory',
    mkdir: 'Create directory', cp: 'Copy files', mv: 'Move or rename files',
    rm: 'Delete files', npm: 'Run npm', node: 'Run JavaScript', python: 'Run Python',
    python3: 'Run Python', pip: 'Install Python packages', git: 'Run git command',
    curl: 'Make HTTP request', wget: 'Download file', chmod: 'Change permissions',
    sudo: 'Run as superuser'
  };

  function bashBin(cmd) { return cmd.split(/\s+/)[0].replace(/^.*\//, ''); }

  // ON WINDOWS, -Force IS HOW YOU SEE A HIDDEN FILE AT ALL. Get-ChildItem
  // -Force lists dot-folders; it overwrites nothing. Treating the switch as
  // destructive wherever it appeared meant every listing of a config folder
  // carded, with copy claiming it "may overwrite or delete", which was untrue
  // of the command in front of the reader. A warning that is wrong is worse
  // than no warning, because it is the one that teaches people to click
  // through the real ones.
  //
  // So -Force is judged against the cmdlet it modifies, and ONLY a cmdlet
  // known to read is exempt. Anything else, including a cmdlet this list has
  // never heard of, keeps the old verdict: the switch genuinely does bypass
  // confirmation on Remove-Item, Copy-Item, Move-Item, Set-Content and
  // New-Item, which is why it was here in the first place.
  var FORCE_SAFE_READ_CMDLETS = /^(Get-ChildItem|gci|dir|ls|Get-Content|gc|cat|type|Get-Item|gi|Get-Location|gl|Test-Path|Resolve-Path|Split-Path|Select-String|sls|Get-Acl|Get-ItemProperty)\b/i;

  function forceIsDestructive(cmd) {
    if (!/-Force\b/i.test(cmd)) return false;
    // Judged per segment: a read with -Force must not shield a removal with
    // -Force later on the same line.
    var segs = shellSegments(cmd);
    for (var i = 0; i < segs.length; i++) {
      if (/-Force\b/i.test(segs[i]) && !FORCE_SAFE_READ_CMDLETS.test(segs[i])) return true;
    }
    return false;
  }

  // Risk of a shell command. The destructive tests run FIRST and read the
  // whole command text, quotes included, so a read that also deletes can never
  // grade low. Only after those does the read-only question get asked, and it
  // is asked of the shared definition rather than of a list kept here: two
  // places answering it about the same text is exactly how a command the hook
  // read as harmless came to be carded anyway.
  //
  // Naive splitting can over-flag an operator inside a quoted string, which
  // only ever errs toward showing a card (safe for a gate).
  function classifyBashRisk(rawCmd) {
    var raw = String(rawCmd || '').trim();
    // A redirection that discards output writes nothing, so it must not change
    // what a command is graded as; the destructive tests below read the whole
    // string and cannot otherwise tell a discard from a write.
    var cmd = raw.replace(DISCARDING_REDIRECT_RE, ' ').trim();
    if (!cmd) return 'low';
    // Asked of the shared definition rather than of a copy kept here, for the
    // same reason the read-only question below is. This list used to live in
    // this file alone, which meant the hook's Code mode branch could approve a
    // command with no card at all while this grader stood ready to paint the
    // card it never drew as high risk.
    if (isDestructiveShellCommand(raw)) return 'high';
    // Command/process substitution used to be tested here and nowhere else,
    // which meant the hook exempted a crossing for text this grader would not
    // auto-allow. It is part of the shared definition of a read now.
    if (isReadOnlyShellCommand(raw)) return 'low';
    return 'medium';
  }

  // Classify risk level of a tool request.
  function classifyRisk(toolName, input) {
    if (toolName === 'Bash') return classifyBashRisk((input.command || '').trim());
    if (toolName === 'PowerShell') {
      // Windows shell tool. Same input shape as Bash (a `command` field).
      // Destructive checks run first so a read that also deletes can't be low.
      const cmd = (input.command || '').trim();
      const highRisk = /(^|[;&|]\s*)(Remove-Item|ri|rm|del|erase|rmdir|rd|Stop-Process|spps|kill|Stop-Service|Format-Volume|Clear-Content|Clear-Item|Set-ExecutionPolicy|Uninstall-[A-Za-z]+)\b/i.test(cmd)
        || forceIsDestructive(cmd)
        || /\b(iex|Invoke-Expression)\b/i.test(cmd)
        || /\b(irm|Invoke-RestMethod|iwr|Invoke-WebRequest|curl|wget)\b[\s\S]*\|\s*(iex|Invoke-Expression)/i.test(cmd);
      if (highRisk) return 'high';
      const lowRisk = /^(Get-[A-Za-z]+|ls|dir|gci|gc|cat|type|pwd|gl|echo|Write-Output|Write-Host|Select-Object|Where-Object|Measure-Object|Test-Path|Resolve-Path|Split-Path|Format-Table|Format-List|Sort-Object)\b/i.test(cmd);
      if (lowRisk) return 'low';
      return 'medium';
    }
    if (toolName === 'WriteFile') {
      // Codex write-request cards. High, with no "Always allow": a standing
      // allow keyed on the tool would let a prompt-injected agent write files
      // ungated. The one exception is a file change the server has already
      // graded as an ordinary outside write: that card is the boundary card,
      // graded medium, and what it can remember is a folder, never the tool.
      return (input && input.graded === 'boundary') ? 'medium' : 'high';
    }
    if (toolName.startsWith('mcp__')) {
      // MCP reads auto-approve in the permission hook, so by the time a request
      // reaches the card it's a write or destructive action. Flag destructive ones
      // as high (no "Always allow"); other writes are medium.
      const action = toolName.split('__').slice(2).join('_').toLowerCase();
      if (/(^|[_\-])(delete|remove|destroy|drop|cancel|abort|archive|trash|purge|clear|uninstall)([_\-]|$)/.test(action)) return 'high';
      return 'medium';
    }
    return 'medium';
  }

  // Build human-readable summary and context for a tool request. The
  // WriteFile branch names the requesting agent; the caller supplies the
  // id-to-display-name resolver so this module stays free of app state.
  function describeToolRequest(toolName, input, deps) {
    const agentName = (deps && deps.agentDisplayName) || (id => id || 'The agent');
    let summary = '';
    let context = '';
    let detail = '';

    if (toolName === 'Bash') {
      const cmd = (input.command || '').trim();
      detail = cmd;
      const bin = bashBin(cmd);
      summary = input.description || BASH_DESCRIPTIONS[bin] || `Run ${bin}`;
      if (bin === 'rm') context = 'This will permanently delete files';
      else if (bin === 'sudo') context = 'This runs with elevated privileges';
      else if (/git\s+push/.test(cmd)) context = 'This will push changes to a remote repository';
      else if (/git\s+reset\s+--hard/.test(cmd)) context = 'This will discard uncommitted changes';
      else if (bin === 'npm' && /install/.test(cmd)) context = 'This will install packages and modify node_modules';
    } else if (toolName === 'PowerShell') {
      const cmd = (input.command || '').trim();
      detail = cmd;
      summary = input.description || 'Run PowerShell command';
      if (/(^|[;&|]\s*)(Remove-Item|ri|rm|del|erase|rmdir|rd)\b/i.test(cmd)) context = 'This will delete files';
      else if (forceIsDestructive(cmd)) context = 'This uses -Force and may overwrite or delete without confirmation';
      else if (/\b(iex|Invoke-Expression)\b/i.test(cmd)) context = 'This executes a downloaded or dynamic script';
    } else if (toolName === 'WriteFile') {
      const p = input.path || '';
      const hasContent = typeof input.content === 'string' && input.content.length > 0;
      if (hasContent) {
        // Content-bearing write request: the card IS the consent for the
        // exact content shown, so the path leads and the payload is
        // displayed.
        const content = input.content;
        summary = `Write ${p}`;
        context = `${agentName(input.agent)} requested this file write. The content below will be written exactly as shown.`;
        detail = content.length > 1500 ? content.slice(0, 1500) + `\n… (${content.length - 1500} more characters)` : content;
      } else {
        // Approval-style request (app-server fileChange): only the grant
        // root and the runtime's reason are available, so the copy must
        // never claim the content is shown. Consent here is for write
        // access under the path; the reason is the honest context and takes
        // the detail slot when present.
        summary = `Approve file changes in ${p}`;
        context = `${agentName(input.agent)} wants to change files here. The sandbox flagged this for approval.`;
        detail = input.reason || p;
      }
    } else if (toolName === 'Write') {
      summary = 'Create a file';
      detail = input.file_path || '';
    } else if (toolName === 'Edit') {
      summary = 'Edit a file';
      detail = input.file_path || '';
    } else if (toolName === 'Read') {
      summary = 'Read a file';
      detail = input.file_path || '';
    } else if (toolName.startsWith('mcp__')) {
      const parts = toolName.split('__');
      const server = (parts[1] || 'connector').replace(/^claude_ai_/, '').replace(/_/g, ' ').trim();
      const action = parts.slice(2).join('_').replace(/^api[_\-\s]+/i, '').replace(/[_\-]+/g, ' ').trim();
      summary = action ? `${server}: ${action}` : `Use ${server}`;
      detail = toolName;
    } else {
      summary = `Use ${toolName}`;
      detail = JSON.stringify(input).substring(0, 200);
    }
    return { summary, context, detail };
  }

  // Key for always-allow matching.
  function toolAllowKey(toolName, input) {
    if (toolName === 'Bash') {
      return 'Bash:' + bashBin((input.command || '').trim());
    }
    if (toolName === 'PowerShell') {
      const verb = ((input.command || '').trim().match(/^[A-Za-z][\w-]*/) || ['PowerShell'])[0];
      return 'PowerShell:' + verb;
    }
    return toolName;
  }

  // The auto-allow decision path. Given the classified risk, the allow key,
  // and the session's always-allowed set, returns:
  //   { action: 'allow', reason: 'always-allowed' }  user granted a standing allow
  //   { action: 'allow', reason: 'low-risk' }        read-only auto-approve policy
  //   { action: 'card' }                             ask the human
  function decidePermission(risk, key, alwaysAllowedSet, verdict) {
    // IN CODE MODE THE HOOK'S VERDICT DECIDES, whatever this grader would have
    // painted. Always asks is carded ahead of every standing allow; Asks once
    // is answered only by a standing allow under its own rule key, never by a
    // legacy binary key such as Bash:git; Runs is allowed. With no verdict,
    // which is every Notes-mode request, nothing below changes.
    if (verdict && verdict.verdict) {
      if (verdict.verdict === 'always-asks') return { action: 'card' };
      if (verdict.verdict === 'asks-once') {
        const ruleKey = verdictAllowKey(verdict);
        return (ruleKey && alwaysAllowedSet && alwaysAllowedSet.has(ruleKey))
          ? { action: 'allow', reason: 'always-allowed' } : { action: 'card' };
      }
      if (verdict.verdict === 'runs') return { action: 'allow', reason: 'code-mode' };
    }
    // A high-risk (destructive) command is always carded, ahead of any standing
    // allow. The allow-key is coarse (the leading command), so a standing allow
    // granted for a benign command must never auto-approve a destructive one
    // that shares the key. High-risk requests never offer "Always allow"
    // either (offersAlwaysAllow), so nothing legitimate depends on this path.
    if (risk === 'high') return { action: 'card' };
    if (alwaysAllowedSet && alwaysAllowedSet.has(key)) return { action: 'allow', reason: 'always-allowed' };
    if (risk === 'low') return { action: 'allow', reason: 'low-risk' };
    return { action: 'card' };
  }

  // High-risk requests never offer a standing "Always allow". In Code mode only
  // an Asks-once verdict offers one, remembered under its rule.
  function offersAlwaysAllow(risk, verdict) {
    if (verdict && verdict.verdict) return verdict.verdict === 'asks-once';
    return risk !== 'high';
  }

  // ── The Code-mode verdict's card ─────────────────────────────────────────
  // The rule keys an Asks-once verdict is remembered under, and the words
  // Settings lists them in. A key here answers only its own rule.
  const RULE_COPY = {
    'Bash:git-push:default-branch': {
      sentence: v => `This can be undone, but other people see it first: it pushes to ${v.branch || 'main'}, the branch this repository treats as its default.`,
      always: v => `Always allow pushes to ${v.branch || 'main'}`,
      label: 'Pushes to the default branch',
    },
    'Bash:git-push:tags': {
      sentence: () => 'This can be undone, but a pushed tag often starts a release.',
      always: () => 'Always allow pushing tags',
      label: 'Pushing tags',
    },
    'Bash:git-push:delete-remote-ref': {
      sentence: v => `This removes ${v.ref || 'a branch'} from ${v.remote || 'the remote'}. Your copy stays, but others lose it.`,
      always: () => 'Always allow deleting remote branches',
      label: 'Deleting remote branches and tags',
    },
    'PowerShell:execution-policy:change': {
      sentence: () => 'This changes which scripts Windows will run for your account.',
      always: () => 'Always allow execution policy changes',
      label: 'Changing the PowerShell execution policy',
    },
  };
  function namesOf(v) {
    const files = Array.isArray(v.files) ? v.files : [];
    const more = Number(v.more) || 0;
    if (!files.length) return '';
    if (more > 0) return `${files.join(', ')} and ${more} more`;
    if (files.length === 1) return files[0];
    return `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}`;
  }
  const REASON_COPY = {
    'unsaved-work': v => (namesOf(v)
      ? `This deletes files git has never saved: ${namesOf(v)} would be lost for good.`
      : 'This deletes files git has never saved, and they would be lost for good.'),
    'unsaved-discard': v => (namesOf(v)
      ? `This throws away changes git has never saved: ${namesOf(v)} would be lost for good.`
      : 'This throws away changes git has never saved, and they would be lost for good.'),
    'git-unchecked': () => 'Rundock couldn\'t check with git what this would lose, so it can\'t tell whether it can be undone.',
    'outside-repository': v => {
      // A folder is unnamed; named files are named, as the unsaved-work card does.
      const names = namesOf(v);
      if (!names) return 'This deletes a folder that isn\'t in a git repository, so nothing can bring it back.';
      const one = v.files.length === 1 && !(Number(v.more) > 0);
      return one
        ? `This deletes ${names}, which isn't in a git repository, so nothing can bring it back.`
        : `This deletes ${names}, which aren't in a git repository, so nothing can bring them back.`;
    },
    'repository': () => 'This deletes the repository\'s history, which is what lets every other change be undone.',
    'git-internals': () => 'This changes git\'s own files, which are what let every other change be undone.',
    'find-from-top': () => 'Starting at the top of the repository, this can delete git\'s own files as well as yours.',
    'unknown-targets': () => 'This deletes files whose names are only worked out when it runs, so Rundock can\'t check what they are.',
    'unreadable-command': () => 'Rundock can\'t tell what this command will do until it runs, so it asks first.',
    'force-push': v => `This replaces the history of ${v.remoteBranch || 'a remote branch'}. Commits that are only on the remote will be lost.`,
    'force-push-default': v => `This rewrites ${v.branch || 'main'}, the branch everyone else builds on.`,
    'delete-default': v => `This deletes ${v.branch || 'main'} from the remote, the branch everyone else builds on.`,
    'remote-refs': () => 'This can delete branches and tags on the remote that this machine doesn\'t have, and nothing here can bring them back.',
    'stash-or-reflog': () => 'This deletes git\'s only saved copy of those changes.',
    'history-rewrite': () => 'This rewrites every commit in the repository\'s history.',
    'worktree-force': () => 'This deletes a working tree even if it holds changes git has never saved.',
    'elevation': () => 'This runs as an administrator, beyond anything Rundock can see or check.',
    'fetched-code': () => 'This runs a script from the internet without showing it to anyone first.',
    'volumes': () => 'This deletes the Docker volumes for this project, including any database data in them.',
    'disk': () => 'This writes directly to a disk or erases one.',
    'wsl-unregister': () => 'This deletes the Linux distribution and everything stored in it.',
    'publish': () => 'This publishes a package version that can never be replaced.',
    'every-process': () => 'This stops every program you have open, Rundock included.',
  };
  const ALWAYS_ASKS_CLOSING = 'Rundock asks about commands like this every time, even in Code mode, so there is no Always allow.';

  // The standing-allow key an Asks-once verdict is remembered under.
  function verdictAllowKey(verdict) {
    return verdict && verdict.verdict === 'asks-once' && typeof verdict.rule === 'string' ? verdict.rule : null;
  }
  // The words on the card a verdict raises.
  function verdictCardCopy(verdict) {
    if (!verdict || !verdict.verdict || verdict.verdict === 'runs') return null;
    if (verdict.verdict === 'asks-once') {
      const r = RULE_COPY[verdict.rule];
      return {
        sentence: r ? r.sentence(verdict) : 'This can be undone, but other people see it first.',
        closing: null, allowLabel: 'Allow',
        alwaysLabel: r ? r.always(verdict) : 'Always allow',
      };
    }
    const f = REASON_COPY[verdict.reason];
    return {
      sentence: f ? f(verdict) : 'This can\'t be undone.',
      closing: ALWAYS_ASKS_CLOSING, allowLabel: 'Allow once', alwaysLabel: null,
    };
  }
  // Which Allow a card draws. "Allow once" on a card that always asks (high
  // risk, never remembered) is the outline button; the everyday Allow and the
  // answer-file card's Allow stay the solid one.
  function allowButtonClass(allowLabel, answerFile) {
    return allowLabel === 'Allow once' && !answerFile ? 'btn-allow-once' : 'btn-allow';
  }

  // A stored rule key in words, for Settings; null for any other key.
  function ruleKeyLabel(key) {
    return RULE_COPY[key] ? RULE_COPY[key].label : null;
  }

  // The copy for a crossing into the agent's own folder, table-driven so the
  // card and its tests read one source. A read never reaches this: it is
  // free everywhere except the secrets tier, and a secret always cards
  // regardless of the act. Only a write to a persistence surface, or any
  // access at all to a secrets-registry path, needs its stakes named.
  // The answer-file sentence is shared: the same stake whether the file is the
  // agent's own (~/.claude) or the workspace's. It is reached through
  // answerFileCopy() as well, so a workspace card does not have to go through a
  // name asserting it lives in the agent's home.
  const ALWAYS_ASK_COPY = {
    secret: 'This is the credential file for your Claude account. A leak here cannot be undone, '
      + 'so this always asks, on any access, and no grant, mode or setting can silence it.',
    persistenceSurface: 'Writing here persists: it takes effect in every later session and every '
      + 'other workspace, including an unattended routine run.',
    // The workspace's own answers to permission questions, which includes the
    // file the permission checks themselves are configured from. Named
    // because a card that reads like an ordinary config write gets answered
    // like one, and this is the write that decides what gets asked about.
    instructionFile: 'This file is loaded as instructions by every later session in every workspace, including routines that run unattended. '
      + 'An agent can ask to change it, but Rundock asks every time and can\'t remember the answer.',
    unremembered: 'This changes a file outside your workspace and working folders, somewhere Rundock can\'t offer to remember, so it asks every time.',
    answerFile: 'This file holds your own answers about what agents may do, and the checks '
      + 'that ask you. An agent can request a change to it, but never keep the '
      + 'permission: this asks every time, and there is no option to stop being asked.',
  };
  // Named for what it decides, not for where the file happens to live. It was
  // agentHomeBoundaryCopy, written when every caller was a ~/.claude crossing;
  // pointing workspace files at it is how a card about a file inside the
  // workspace came to announce that the workspace had been left.
  function alwaysAskCopy(crossing) {
    if (!crossing) return null;
    if (crossing.secret) return ALWAYS_ASK_COPY.secret;
    if (crossing.answerFile) return ALWAYS_ASK_COPY.answerFile;
    if (crossing.instructionFile) return ALWAYS_ASK_COPY.instructionFile;
    if (crossing.hiddenHome) return hiddenHomeCopy(crossing.hiddenHome, crossing.write === true);
    if (crossing.persistenceSurface) return ALWAYS_ASK_COPY.persistenceSurface;
    if (crossing.unremembered) return ALWAYS_ASK_COPY.unremembered;
    return null;
  }
  // A hidden folder directly under home: ~/.ssh first, and every other one by
  // rule. Never remembered, and the card says why and what to do instead.
  function hiddenHomeCopy(name, write) {
    const folder = `~/${String(name).replace(/^~\//, '')}`;
    const act = write ? 'changes' : 'reads';
    if (folder === '~/.ssh') {
      return `This ${act} inside ~/.ssh, where your SSH keys are kept. `
        + 'Rundock asks every time for this folder and can\'t offer to remember it: one "always" here would hand over your private keys along with it. '
        + 'Connecting over SSH and pushing with git don\'t need this, and never ask. '
        + 'If you do want agents working in this folder, name ~/.ssh yourself under Settings, Permissions, Folders agents can also change.';
    }
    return `This ${act} inside ${folder}, a folder where tools usually keep credentials. `
      + 'Rundock asks every time for this folder and can\'t offer to remember it: one "always" here would hand over everything in it along with it. '
      + `If you do want agents working in this folder, name ${folder} yourself under Settings, Permissions, Folders agents can also change.`;
  }

  // ── Pending permission requests for background conversations ────────────
  // A control_request for a conversation that is not on screen must never
  // be dropped (the server auto-denies an unanswered request at the
  // timeout, silently degrading work the user never got to consent to).
  // These functions own the store's decisions; app.js glues them to the
  // DOM (render on open, unread badge) and the socket. Pinned by
  // test/unit/permissions.test.js; the server's acceptance of the late
  // response a queued card produces is pinned in
  // test/integration/background-approvals.test.js.

  // Where a permission request goes when it arrives. Auto-allow decisions
  // (standing grants, low-risk reads) answer immediately regardless of
  // which conversation is on screen; anything needing a card renders when
  // its conversation is active and queues when it is not.
  function routePermissionRequest(decision, isActive) {
    if (decision && decision.action === 'allow') return 'respond-allow';
    return isActive ? 'render' : 'queue';
  }

  // byConvo: Map convoId -> Map requestId -> payload (the raw
  // control_request message). Keyed by requestId so a server re-send
  // (reconnect) never duplicates. Returns the conversation's queue size.
  function queuePendingPermission(byConvo, convoId, requestId, payload) {
    if (!requestId) return 0;
    let m = byConvo.get(convoId);
    if (!m) { m = new Map(); byConvo.set(convoId, m); }
    m.set(requestId, payload);
    return m.size;
  }

  // The still-pending payloads for a conversation, in arrival order.
  function pendingPermissionsFor(byConvo, convoId) {
    const m = byConvo.get(convoId);
    return m ? Array.from(m.values()) : [];
  }

  // Remove a request wherever it is stored (answered, timed out, or
  // otherwise resolved server-side) so a stale card can never be rendered
  // or answered. Returns the conversation it was queued under, or null.
  function removePendingPermission(byConvo, requestId) {
    for (const entry of byConvo) {
      const convoId = entry[0], m = entry[1];
      if (m.delete(requestId)) {
        if (m.size === 0) byConvo.delete(convoId);
        return convoId;
      }
    }
    return null;
  }

  // Drop every queued request for one conversation (the server's cancel
  // sweep has already answered them). Returns how many were dropped.
  function clearPendingPermissions(byConvo, convoId) {
    const m = byConvo.get(convoId);
    if (!m) return 0;
    byConvo.delete(convoId);
    return m.size;
  }

  // ── Who a request belongs to ─────────────────────────────────────────────
  // A request is shown where its owner is, and only there. A conversation's
  // request goes to that conversation. A routine's request carries the run
  // the server matched it to, and goes to the approvals dock under the
  // routine's name. A request the server could match to nothing is shown as
  // exactly that. None of them ever borrows the conversation on screen: that
  // fallback is how a routine's request to change a person's email was once
  // shown inside an unrelated chat, one click from being approved there.
  function permissionOwner(d) {
    const convoId = d && d._conversationId;
    if (convoId) return { kind: 'conversation', convoId };
    const run = d && d._run;
    if (run && run.id) return { kind: 'routine', run };
    return { kind: 'unattributed' };
  }

  // ── Requests that have ended ─────────────────────────────────────────────
  // A request ends by timing out, by being answered (here or in another
  // window), by its conversation being stopped, or by the process that asked
  // going away. Once ended, no card for it may offer an answer, however the
  // card is reached: live, from the background queue, or replayed after a
  // reconnect. The record is kept by request id and bounded, because the
  // copy that arrives late is the case it exists for.
  const ENDED_LIMIT = 500;
  const ENDED_COPY = {
    timeout: { label: '✕ Timed out', why: 'Nobody answered in time, so it was denied.' },
    cancelled: { label: '✕ Stopped', why: 'The agent was stopped before this was answered.' },
    ended: { label: '✕ No longer waiting', why: 'The agent that asked has finished, so there is nothing left to answer.' },
    'not-pending': { label: '✕ Too late', why: 'This request had already ended, so nothing was approved.' },
  };
  function markPermissionEnded(ended, requestId, reason, allow) {
    if (!requestId) return;
    ended.delete(requestId);
    ended.set(requestId, { reason: reason || 'ended', allow: allow === true });
    while (ended.size > ENDED_LIMIT) ended.delete(ended.keys().next().value);
  }
  function permissionEnded(ended, requestId) {
    return (requestId && ended.get(requestId)) || null;
  }
  // What an ended card says: a short label, whether it reads as allowed, and
  // one sentence of why. An answer given in another window keeps its answer.
  function endedPermissionCopy(reason, allow) {
    if (reason === 'answered') {
      return { allowed: allow === true, label: allow === true ? '✓ Answered in another window' : '✕ Answered in another window', why: '' };
    }
    const c = ENDED_COPY[reason] || ENDED_COPY.ended;
    return { allowed: false, label: c.label, why: c.why };
  }
  // The held request ids a window must treat as over, given what the server
  // says is still pending after a reconnect.
  function staleRequestIds(heldIds, pendingIds) {
    const live = new Set(pendingIds || []);
    return (heldIds || []).filter(id => id && !live.has(id));
  }
  // The payload queued for a request, wherever it is queued, or null.
  function findPendingPermission(byConvo, requestId) {
    for (const entry of byConvo) {
      const payload = entry[1].get(requestId);
      if (payload) return { convoId: entry[0], payload };
    }
    return null;
  }

  function answerFileCopy() { return ALWAYS_ASK_COPY.answerFile; }

  // ── The put-back card ────────────────────────────────────────────────────
  // Rundock has already put back a change to one of the workspace's permission
  // files; the card says so, in the past tense, and asks whether to keep the
  // change instead. `putBack` is { runtime: 'claude' | 'codex', outsideTurn,
  // relative }. Approved copy, word for word.
  const PUT_BACK_RUNTIME = { claude: 'Claude Code', codex: 'Codex' };
  function putBackCardCopy(putBack) {
    const p = putBack || {};
    const file = p.relative || 'a permission file';
    const who = PUT_BACK_RUNTIME[p.runtime] || PUT_BACK_RUNTIME.claude;
    return p.outsideTurn ? {
      origin: 'No agent was running when this happened',
      unattributed: true,
      heading: 'Rundock put back a change to your permission answers',
      body: `${file} changed while no agent was running. Rundock restored it straight away. Keep that change instead?`,
      disclosure: 'Show change', leave: 'Leave it restored', keep: 'Keep the change',
    } : {
      origin: `${who}, running in this conversation`,
      unattributed: false,
      heading: 'Rundock put back a change to your permission answers',
      body: `${who} ran a command that changed ${file}, the file that holds your own answers about what agents may do. `
        + 'Rundock restored it straight away. Keep the agent\'s change instead?',
      disclosure: 'Show change', leave: 'Leave it restored', keep: 'Keep the change',
    };
  }

  // The change, line by line: [{ kind: 'ctx' | 'del' | 'add' | 'gap', text }].
  // Unchanged stretches are folded to two lines either side of a change, and
  // trailing spaces on a changed line are shown as `·`, so a change that is
  // only whitespace is still visible. `before` or `after` null means the file
  // did not exist, or was removed.
  const DIFF_MAX_LINES = 400;
  const DIFF_CONTEXT = 2;
  function diffLinesOf(text) {
    if (text === null || text === undefined) return [];
    const lines = String(text).split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  function showTrailing(line) {
    const m = /[ \t]+$/.exec(line);
    return m ? line.slice(0, m.index) + m[0].replace(/./g, '·') : line;
  }
  function putBackDiffLines(before, after) {
    const a = diffLinesOf(before);
    const b = diffLinesOf(after);
    let ops;
    if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
      ops = [...a.map(t => ({ kind: 'del', text: t })), ...b.map(t => ({ kind: 'add', text: t }))];
    } else {
      // Longest common subsequence of lines, then walked in order.
      const n = a.length;
      const m = b.length;
      const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
      ops = [];
      let i = 0;
      let j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) { ops.push({ kind: 'ctx', text: a[i] }); i++; j++; }
        else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { ops.push({ kind: 'add', text: b[j] }); j++; }
        else { ops.push({ kind: 'del', text: a[i] }); i++; }
      }
      // Removals before additions within a changed stretch, as a reader expects.
      for (let k = 0; k < ops.length; k++) {
        if (ops[k].kind === 'ctx') continue;
        let e = k;
        while (e < ops.length && ops[e].kind !== 'ctx') e++;
        const run = ops.slice(k, e);
        ops.splice(k, run.length, ...run.filter(o => o.kind === 'del'), ...run.filter(o => o.kind === 'add'));
        k = e - 1;
      }
    }
    const near = ops.map(() => false);
    ops.forEach((o, k) => {
      if (o.kind === 'ctx') return;
      for (let d = -DIFF_CONTEXT; d <= DIFF_CONTEXT; d++) if (ops[k + d]) near[k + d] = true;
    });
    const out = [];
    ops.forEach((o, k) => {
      if (o.kind !== 'ctx') { out.push({ kind: o.kind, text: showTrailing(o.text) }); return; }
      if (near[k]) { out.push(o); return; }
      if (!out.length || out[out.length - 1].kind !== 'gap') out.push({ kind: 'gap', text: '…' });
    });
    return out;
  }
  // Retained so a caller outside this change keeps working; both names
  // reach the same table, and new callers should use alwaysAskCopy.
  const agentHomeBoundaryCopy = alwaysAskCopy;

  return { BASH_DESCRIPTIONS, bashBin, classifyRisk, describeToolRequest, toolAllowKey, decidePermission, offersAlwaysAllow, alwaysAskCopy, answerFileCopy,
    putBackCardCopy, putBackDiffLines,
    verdictAllowKey, verdictCardCopy, ruleKeyLabel, ALWAYS_ASKS_CLOSING, allowButtonClass,
    routePermissionRequest, queuePendingPermission, pendingPermissionsFor, removePendingPermission, clearPendingPermissions,
    permissionOwner, markPermissionEnded, permissionEnded, endedPermissionCopy, staleRequestIds, findPendingPermission };
}));
