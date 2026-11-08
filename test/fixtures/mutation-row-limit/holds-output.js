'use strict';
// A suite that never ends and leaves a grandchild behind it that ignores
// SIGTERM and holds the suite's stdout and stderr open. Run directly, not
// under node --test, so the pipes the grandchild holds are the runner's own.
const { spawn } = require('node:child_process');
const { record } = require('./record.js');

const grandchild = spawn(process.execPath, ['-e', [
  "process.on('SIGTERM', () => {});",
  `require(${JSON.stringify(require.resolve('./record.js'))}).record('grandchild');`,
  "process.stdout.write('grandchild holding stdout\\n');",
  'setInterval(() => {}, 1000);',
].join('\n')], { stdio: ['ignore', 'inherit', 'inherit'] });
record('suite');
grandchild.on('spawn', () => process.stdout.write('suite started its grandchild\n'));
setInterval(() => {}, 1000);
