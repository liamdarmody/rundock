'use strict';
// A suite that never ends and ignores SIGTERM, so only the escalation ends it.
const { record } = require('./record.js');

process.on('SIGTERM', () => {});
record('suite');
process.stdout.write('ignoring SIGTERM\n');
setInterval(() => {}, 1000);
