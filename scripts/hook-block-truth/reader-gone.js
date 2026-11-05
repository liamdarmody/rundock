#!/usr/bin/env node
'use strict';
// A HOOK WHOSE STANDARD OUTPUT'S READER HAS GONE. Starts the command named on
// its own command line with standard output on a pipe, closes the reading end
// of that pipe, and only then hands the command its input, so whatever the
// command writes to standard output fails, as it does when the runtime has
// stopped reading. Standard error is passed through, and this exits with the
// command's own exit code, so the runtime sees what the command did. With
// HOOK_BLOCK_TRUTH_LOG set, the code and what was said on standard error are
// also written to that file.
//
// Used by scripts/hook-block-truth/capture.js, between Claude Code and the
// permission hook.

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
const input = [];
let stderr = '';
let readerGone = false;
let inputEnded = false;
const handOver = () => { if (readerGone && inputEnded) child.stdin.end(Buffer.concat(input)); };

child.stderr.on('data', (c) => { stderr += c; process.stderr.write(c); });
child.stdout.on('close', () => { readerGone = true; handOver(); });
child.stdout.destroy();
process.stdin.on('data', (c) => { input.push(c); });
process.stdin.on('end', () => { inputEnded = true; handOver(); });
child.on('close', (code, signal) => {
  if (process.env.HOOK_BLOCK_TRUTH_LOG) {
    fs.writeFileSync(process.env.HOOK_BLOCK_TRUTH_LOG, JSON.stringify({ code, signal, stderr }));
  }
  process.exit(code === null ? 1 : code);
});
