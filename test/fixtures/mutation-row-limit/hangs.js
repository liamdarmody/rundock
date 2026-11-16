'use strict';
// A node:test file whose one test never settles, the shape a removed guard
// leaves behind when a test waits on something that now never happens. It
// records itself and the test runner that started it.
const { test } = require('node:test');
const { record } = require('./record.js');

record('suite');
record('runner', process.ppid);
test('waits for an answer that never comes', () => new Promise(() => { setInterval(() => {}, 1000); }));
