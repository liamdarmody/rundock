#!/usr/bin/env node
/**
 * Rundock Permission Hook
 *
 * Runs as a Claude Code PreToolUse hook. When Claude wants to use a tool
 * that requires permission (e.g. Bash), this script:
 *
 * 1. POSTs the tool request to the Rundock server
 * 2. Rundock shows a permission card in the browser
 * 3. User clicks Allow or Deny
 * 4. This script receives the decision and tells Claude Code
 *
 * If not running inside Rundock (no RUNDOCK env var), passes through silently.
 * If the Rundock server is unreachable, allows by default to avoid blocking.
 */

const http = require('http');

let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  // Not running in Rundock: pass through (no decision, Claude Code handles normally)
  if (!process.env.RUNDOCK) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    // Bad input: pass through
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  const port = process.env.RUNDOCK_PORT || 3000;
  const convoId = process.env.RUNDOCK_CONVO_ID || '';

  const payload = JSON.stringify({
    tool_name: data.tool_name,
    tool_input: data.tool_input || {},
    session_id: data.session_id,
    conversation_id: convoId
  });

  const req = http.request({
    hostname: '127.0.0.1',
    port: port,
    path: '/api/permission-request',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 300000 // 5 min: server-side timeout (120s) handles the real cutoff
  }, res => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => {
      try {
        const result = JSON.parse(body);
        let reason = 'Approved in Rundock';
        if (!result.allow) {
          reason = result.reason === 'timeout'
            ? 'The permission prompt timed out because the user did not respond in time. This is not a denial. You should attempt the command again if the user asks.'
            : 'The user chose to deny this command.';
        }
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: result.allow ? 'allow' : 'deny',
            permissionDecisionReason: reason
          }
        }));
      } catch (e) {
        // Parse error: allow to avoid blocking
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Rundock hook: could not parse server response'
          }
        }));
      }
      process.exit(0);
    });
  });

  req.on('error', () => {
    // Server unreachable: allow to avoid blocking the user
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Rundock server unreachable, allowing by default'
      }
    }));
    process.exit(0);
  });

  req.on('timeout', () => {
    req.destroy();
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Permission request timed out'
      }
    }));
    process.exit(0);
  });

  req.write(payload);
  req.end();
});
