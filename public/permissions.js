'use strict';
// Client permission/trust decision logic. Pure functions, extracted from
// app.js so they are unit-testable under node --test and findable by name:
// "the human leads" and the trust page's claims rest on exactly these
// functions, and the licence invites anyone to audit them. Same UMD pattern
// as code-language.js and markers.js.
//
// The permission decision path spans THREE layers (see docs/ARCHITECTURE):
// the PreToolUse hook script, the server bridge, and THIS module in the
// browser. The auto-allow policy for low-risk read-only commands lives
// here, client-side, and nowhere else.
//
// What this module decides (pinned by test/unit/permissions.test.js):
//   classifyRisk()        low / medium / high per tool request
//   describeToolRequest() human-readable card copy (summary/context/detail)
//   toolAllowKey()        the pattern "Always allow" matches on
//   decidePermission()    auto-allow (always-allowed or low-risk) vs card
//   offersAlwaysAllow()   high-risk requests never get a standing allow
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockPermissions = factory();
}(typeof self !== 'undefined' ? self : this, function () {

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

  // Risk of a shell command, judged across EVERY segment of a compound command
  // (split on &&, ||, ;, |, &, and newlines), not just the first token. This
  // stops a read-only prefix from smuggling a destructive command past the gate
  // ("ls && rm x" is high, not low) and stops a harmless leading cd from
  // forcing an all-read-only chain to look risky ("cd dir && ls" is low, so
  // ordinary exploration is not carded). A destructive flag, a
  // download-piped-to-a-shell, or a find that runs/deletes anywhere in the
  // command is high regardless of segmenting. Structure the segmenter cannot
  // see into (command/process substitution, backticks) never earns the low
  // auto-allow verdict, so a destructive command hidden inside it still cards.
  // Naive splitting can over-flag an operator inside a quoted string, which
  // only ever errs toward showing a card (safe for a gate).
  function classifyBashRisk(cmd) {
    if (!cmd) return 'low';
    if (/--force|--hard|-rf\b/.test(cmd)) return 'high';
    if (/git\s+(push|reset|clean|checkout\s+\.)/.test(cmd)) return 'high';
    if (/\b(curl|wget)\b[\s\S]*\|\s*(sh|bash|zsh|dash)\b/.test(cmd)) return 'high';
    // find is read-only until it runs a command or deletes: -exec/-execdir/-ok
    // spawn an arbitrary command per match and -delete removes files, so a bare
    // find leading segment must not shield these.
    if (/\bfind\b[\s\S]*-(exec(dir)?|delete|ok(dir)?)\b/.test(cmd)) return 'high';
    const DESTRUCTIVE = /^(rm|sudo|chmod|chown|kill|mkfs|dd)/;
    // Note: `node -e`/`python -c` are deliberately NOT here. They are arbitrary
    // code execution, not reads (a fs.rmSync or fetch payload would auto-run with
    // no card), so they fall through to a permission card like `node script.js`.
    const READ_ONLY = /^(ls|cat|head|tail|echo|pwd|whoami|which|grep|rg|find|wc|sort|uniq|diff|file|stat|date|env|printenv)/;
    const NEUTRAL = /^(cd|pushd|popd|true)(\s|$)/;
    // Command/process substitution and backticks run an inner command the
    // segmenter cannot see (`ls $(rm x)`), so their presence disqualifies the
    // low (auto-allow) verdict: the command falls to at least a card.
    const HIDES_SUBCOMMAND = /\$\(|`|<\(|>\(/;
    // Split on newlines as well as shell operators: bash runs each newline as a
    // separate command, so a read-only first line must not shield a destructive
    // one below it.
    const segments = cmd.split(/\s*(?:&&|\|\||[;|&\n\r])\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
    var anyHigh = false, allSafe = true;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (DESTRUCTIVE.test(seg)) anyHigh = true;
      else if (READ_ONLY.test(seg) || NEUTRAL.test(seg)) continue;
      else allSafe = false;
    }
    if (anyHigh) return 'high';
    if (allSafe && !HIDES_SUBCOMMAND.test(cmd)) return 'low';
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
        || /-Force\b/i.test(cmd)
        || /\b(iex|Invoke-Expression)\b/i.test(cmd)
        || /\b(irm|Invoke-RestMethod|iwr|Invoke-WebRequest|curl|wget)\b[\s\S]*\|\s*(iex|Invoke-Expression)/i.test(cmd);
      if (highRisk) return 'high';
      const lowRisk = /^(Get-[A-Za-z]+|ls|dir|gci|gc|cat|type|pwd|gl|echo|Write-Output|Write-Host|Select-Object|Where-Object|Measure-Object|Test-Path|Resolve-Path|Split-Path|Format-Table|Format-List|Sort-Object)\b/i.test(cmd);
      if (lowRisk) return 'low';
      return 'medium';
    }
    if (toolName === 'WriteFile') {
      // Codex write-request cards. Always high: every write gets its own
      // card and "Always allow" is never offered. A standing allow here
      // would let a prompt-injected agent write files ungated.
      return 'high';
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
      else if (/-Force\b/i.test(cmd)) context = 'This uses -Force and may overwrite or delete without confirmation';
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
  function decidePermission(risk, key, alwaysAllowedSet) {
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

  // High-risk requests never offer a standing "Always allow".
  function offersAlwaysAllow(risk) { return risk !== 'high'; }

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

  return { BASH_DESCRIPTIONS, bashBin, classifyRisk, describeToolRequest, toolAllowKey, decidePermission, offersAlwaysAllow,
    routePermissionRequest, queuePendingPermission, pendingPermissionsFor, removePendingPermission, clearPendingPermissions };
}));
