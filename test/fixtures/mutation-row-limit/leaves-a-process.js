'use strict';
// A suite that starts a process in its own group, holding none of its output,
// and finishes once that process has recorded itself, leaving it running.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { record } = require('./record.js');

const left = spawn(process.execPath, ['-e', [
  `require(${JSON.stringify(require.resolve('./record.js'))}).record('leftover');`,
  'setInterval(() => {}, 1000);',
].join('\n')], { stdio: 'ignore' });
record('suite');
const dir = process.env.MUTATION_FIXTURE_PIDS;
const finish = () => {
  process.stdout.write('suite finished, leaving a process behind\n');
  process.exit(0);
};
left.on('spawn', () => {
  if (!dir) return finish();
  const started = setInterval(() => {
    if (fs.existsSync(path.join(dir, `leftover.${left.pid}`))) { clearInterval(started); finish(); }
  }, 20);
});
