'use strict';
// GitHub workflow files read as text: their jobs, each job's steps, and what
// each step runs. Read as text rather than parsed as YAML, as the other
// workflow tests are: they assert what the workflows say, and a parser would
// add a dependency to prove less.
//
// THE SHAPE IT READS is the shape these workflows are written in: jobs under a
// top-level `jobs:`, a job's keys one level in, its steps as `- ` items below
// `steps:`, and a step's `run:` on its own line or as a `|` or `>` block below
// it. A comment is never read as a command: only a step's `run:` is.
//
// IT REFUSES RATHER THAN RETURNING SHORT. A workflow with no jobs, or a job
// with no steps, throws, so a reshaped file fails the tests that read it
// instead of passing them on nothing.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const indent = (line) => line.length - line.trimStart().length;
const isComment = (line) => line.trimStart().startsWith('#');

/**
 * The keys of a block mapping, each with its inline value and the deeper
 * lines below it. The mapping's indentation is that of its first key; a
 * comment at that indentation is skipped, and a deeper line belongs to the
 * key above it.
 */
function mapping(lines) {
  const first = lines.find((l) => l.trim() && !isComment(l));
  const keys = {};
  if (!first) return keys;
  const at = indent(first);
  let last = null;
  for (const line of lines) {
    if (line.trim() && indent(line) <= at) {
      if (isComment(line)) continue;
      const m = /^([\w-]+):\s*(.*)$/.exec(line.slice(at));
      last = m ? { value: m[2].trim(), below: [] } : null;
      if (m) keys[m[1]] = last;
      continue;
    }
    if (last) last.below.push(line);
  }
  return keys;
}

const scalars = (keys) => Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.value]));

/**
 * What a `run:` holds: an inline command, or a block's lines with their
 * indentation removed, kept as lines for `|` and folded into one for `>`.
 */
function scalarText({ value, below }) {
  const body = [...below];
  while (body.length && !body[body.length - 1].trim()) body.pop();
  if (!/^[|>]/.test(value)) return [value, ...body.map((l) => l.trim())].filter(Boolean).join(' ');
  const depth = Math.min(...body.filter((l) => l.trim()).map(indent));
  const text = body.map((l) => l.slice(depth));
  return value.startsWith('>') ? text.map((l) => l.trim()).filter(Boolean).join(' ') : text.join('\n');
}

function listOf(entry) {
  if (!entry) return [];
  const inline = /^\[(.*)\]$/.exec(entry.value);
  if (inline) return inline[1].split(',').map((s) => s.trim()).filter(Boolean);
  if (entry.value) return [entry.value];
  return entry.below.filter((l) => l.trim().startsWith('- ')).map((l) => l.trim().slice(2).trim());
}

function stepsOf(lines) {
  const first = lines.find((l) => l.trimStart().startsWith('- '));
  if (!first) return [];
  const at = indent(first);
  const steps = [];
  let current = null;
  for (const line of lines) {
    if (indent(line) === at && line.trimStart().startsWith('- ')) {
      // The item's first key, moved to where the rest of its keys sit.
      current = [`${' '.repeat(at + 2)}${line.trimStart().slice(2)}`];
      steps.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return steps.map((stepLines) => {
    const keys = mapping(stepLines);
    const at2 = (k) => (keys[k] ? keys[k].value : undefined);
    return {
      name: at2('name'),
      uses: at2('uses'),
      if: at2('if'),
      continueOnError: at2('continue-on-error'),
      run: keys.run ? scalarText(keys.run) : undefined,
      env: keys.env ? scalars(mapping(keys.env.below)) : {},
      with: keys.with ? scalars(mapping(keys.with.below)) : {},
    };
  });
}

/** A workflow's jobs by id, from its text. `label` names it in a refusal. */
function parseWorkflow(text, label = 'the workflow') {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const bodies = {};
  let current = null;
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (line.trim() && indent(line) === 0) break;
    const head = /^ {2}([\w-]+):\s*$/.exec(line);
    if (head) {
      current = [];
      bodies[head[1]] = current;
    } else if (current && !(indent(line) <= 2 && isComment(line))) {
      current.push(line);
    }
  }
  if (!Object.keys(bodies).length) throw new Error(`${label}: the workflow text has no jobs`);
  const jobs = {};
  for (const [id, body] of Object.entries(bodies)) {
    const keys = mapping(body);
    const steps = keys.steps ? stepsOf(keys.steps.below) : [];
    if (!steps.length) throw new Error(`${label}: job ${id} has no steps`);
    jobs[id] = {
      id,
      name: keys.name ? keys.name.value : undefined,
      needs: listOf(keys.needs),
      if: keys.if ? keys.if.value : undefined,
      timeoutMinutes: keys['timeout-minutes'] ? keys['timeout-minutes'].value : undefined,
      continueOnError: keys['continue-on-error'] ? keys['continue-on-error'].value : undefined,
      steps,
      text: body.join('\n'),
    };
  }
  return { label, jobs };
}

/** A workflow under .github/workflows, read and parsed. */
function readWorkflow(name) {
  return parseWorkflow(fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8'), name);
}

/** Every command a workflow runs, with the job and step it is in. */
function runCommands(workflow) {
  return Object.values(workflow.jobs).flatMap((job) => job.steps
    .filter((s) => s.run !== undefined)
    .map((s) => ({ job: job.id, step: s.name, run: s.run })));
}

module.exports = { parseWorkflow, readWorkflow, runCommands };
