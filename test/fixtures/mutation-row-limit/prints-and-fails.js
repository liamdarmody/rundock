'use strict';
// A suite that prints more than a row with no verdict keeps, names paths
// inside and outside the folder it runs in, and fails. Run by
// test/unit/mutation-suite-output.test.js, from the repository.

const os = require('node:os');
const path = require('node:path');

const progress = [];
for (let i = 0; i < 100; i++) progress.push(`progress line ${i} of a suite that prints a great deal`);
process.stdout.write(`${progress.join('\n')}\nthe last line on stdout\n`);

process.stderr.write([
  `Error: it broke at ${path.join(process.cwd(), 'node_modules', 'electron', 'index.js')}:43:13`,
  `    at load (file://${path.join(process.cwd(), 'lib', 'loader.js')}:1:1)`,
  '    at fetch (/home/someone/.cache/electron/get.js:5:2)',
  `    under ${path.join(os.tmpdir(), 'a-run-folder', 'x')}`,
  '    and C:\\Users\\someone\\get.js',
  '    see https://github.com/electron/electron/releases/download/v1/electron.zip',
  'the last line on stderr',
  '',
].join('\n'));
process.exit(1);
