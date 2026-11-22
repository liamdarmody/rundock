'use strict';
// The prove workflow's inline code, cut out of .github/workflows/prove.yml so
// its tests run the very text the workflow runs.
//
// Each piece sits in a step's `run:` between a `// begin <name>` line and an
// `// end <name>` line, and holds only declarations: what the step does with
// them follows the end line. A piece is made a module by evaluating its text
// with this process's `require` and returning the names asked for, so a name
// the piece no longer declares throws rather than returning undefined.
//
// A step repeated in several jobs carries the same piece in each. A piece
// found nowhere, found twice in one step, or found in copies that differ is
// refused, so a reshaped workflow fails its tests instead of passing them on
// one stale copy.
const fs = require('node:fs');
const path = require('node:path');
const { parseWorkflow } = require('./workflow-text.js');

const FILE = path.join(__dirname, '..', '..', '.github', 'workflows', 'prove.yml');

function readProve() {
  const text = fs.readFileSync(FILE, 'utf8');
  return { text, workflow: parseWorkflow(text, 'prove.yml') };
}

/** Every copy of the named piece, with the job and step it was cut from. */
function pieceCopies(name, workflow = readProve().workflow) {
  const copies = [];
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.run === undefined) continue;
      const lines = step.run.split('\n').map((l) => l.trimEnd());
      const begins = lines.filter((l) => l === `// begin ${name}`).length;
      const ends = lines.filter((l) => l === `// end ${name}`).length;
      if (!begins && !ends) continue;
      const from = lines.indexOf(`// begin ${name}`);
      const to = lines.indexOf(`// end ${name}`);
      if (begins !== 1 || ends !== 1 || to < from) {
        throw new Error(`prove.yml: job ${job.id}, step "${step.name}" must hold the piece "${name}" exactly once, begin before end`);
      }
      copies.push({ job: job.id, step: step.name, text: lines.slice(from + 1, to).join('\n') });
    }
  }
  if (!copies.length) throw new Error(`prove.yml carries no piece named "${name}"`);
  const differ = copies.find((c) => c.text !== copies[0].text);
  if (differ) {
    throw new Error(`prove.yml: the piece "${name}" in job ${differ.job} differs from the copy in job ${copies[0].job}`);
  }
  return copies;
}

/**
 * The named piece evaluated, returning the declarations listed in `names`. A
 * list of names evaluates those pieces together, in that order, for a piece
 * that uses another's declarations. `req` is the `require` the pieces see.
 */
function loadPiece(name, names, req = require) {
  const text = [].concat(name).map((n) => pieceCopies(n)[0].text).join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('require', `${text}\nreturn { ${names.join(', ')} };`)(req);
}

/**
 * Runs one step's whole `run:` text as a function handed `req` as its
 * `require` and `proc` as its `process`, the way the step's Node runs it,
 * so a test can hand it fakes. The step is taken from the named job.
 */
function runStep(jobId, stepName, req, proc, workflow = readProve().workflow) {
  const job = workflow.jobs[jobId];
  const steps = job ? job.steps.filter((s) => s.name === stepName) : [];
  if (steps.length !== 1 || steps[0].run === undefined) {
    throw new Error(`prove.yml: job ${jobId} has no single step "${stepName}" with a run block`);
  }
  // eslint-disable-next-line no-new-func
  return new Function('require', 'process', steps[0].run)(req, proc);
}

module.exports = { FILE, readProve, pieceCopies, loadPiece, runStep };
