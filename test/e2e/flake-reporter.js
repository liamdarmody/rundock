'use strict';
// A Playwright reporter for one thing: a test that passed only on its retry.
//
// A retry is allowed only where docs/FLAKES.md names the test, and a pass on
// the retry is exactly the evidence the register's two-strike rule counts.
// Playwright calls it "flaky" and exits 0, so without this nobody would see
// it and no strike would be added. Each such pass is said once: a GitHub
// warning annotation in CI, a plain line locally.
//
// Not a spec: Playwright collects only *.spec.js and *.test.js from this
// folder, so this file is loaded as a reporter and never run as a test.

const path = require('node:path');

// GitHub's workflow-command escaping: data loses its line breaks, a property
// also its separators.
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

class FlakeReporter {
  constructor({ configDir = path.join(__dirname, '..', '..'), env = process.env,
    write = (line) => process.stdout.write(`${line}\n`) } = {}) {
    this.root = configDir;
    this.env = env;
    this.write = write;
  }

  onTestEnd(test, result) {
    if (result.status !== 'passed' || !result.retry) return;
    const file = path.relative(this.root, test.location.file).split(path.sep).join('/');
    const message = `"${test.title}" passed only on retry ${result.retry}: add a strike for it in docs/FLAKES.md `
      + '(a test that flakes twice is fixed or quarantined)';
    if (this.env.GITHUB_ACTIONS) {
      this.write(`::warning file=${escapeProperty(file)},line=${test.location.line},title=Flaky test::${escapeData(message)}`);
    } else {
      this.write(`[flake] ${file}:${test.location.line} ${message}`);
    }
  }
}

module.exports = FlakeReporter;
