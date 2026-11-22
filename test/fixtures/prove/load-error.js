'use strict';
// A fixture that fails before any test runs. Never part of `npm test`.
const { test } = require('node:test');

throw new Error('this file fails as it loads');

// eslint-disable-next-line no-unreachable
test('an assertion fails', () => {});
