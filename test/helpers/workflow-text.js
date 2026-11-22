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
//
// YAML ANCHORS ARE READ IN ONE FORM ONLY: a `run:` or `env:` value written once
// as `run: &name` and reused as the whole value `run: *name`. Each alias is
// replaced by the value it names, moved to the alias's indentation, before
// anything else reads the text, so every reader sees each step written out in
// full. Any other anchor, alias or merge key is refused, and so is an anchor
// defined twice or never used, an alias with no anchor before it, and an
// alias with anything after its name. A workflow with none passes through
// unchanged.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const indent = (line) => line.length - line.trimStart().length;
const isComment = (line) => line.trimStart().startsWith('#');

const ANCHORED_KEYS = ['run', 'env'];
const BLOCK_SCALAR = /^[|>][0-9+-]*\s*(#.*)?$/;

/**
 * A line's indentation, its `- ` list markers, its key when it has one, and
 * what follows: the key's value, or the rest of the line when there is no key.
 */
function lineParts(line) {
  const [, lead, dashes, rest] = /^( *)((?:- +)*)(.*)$/.exec(line);
  const at = lead.length + dashes.length;
  const keyed = /^([^\s#&*!|>'"[\]{},][^:#]*?|"[^"]*"|'[^']*')[ \t]*:(?=[ \t]|$)[ \t]*(.*)$/.exec(rest);
  if (!keyed) return { lead, dashes, at, value: rest };
  return { lead, dashes, at, key: keyed[1], head: line.slice(0, line.indexOf(':', at) + 1), value: keyed[2] };
}

/** Whether a flow collection (`[...]` or `{...}`) holds an anchor or alias outside its quoted text. */
function flowMarks(value) {
  const unquoted = value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '""');
  return /(^|[\s[{,:])[&*][^\s,[\]{}]/.test(unquoted);
}

/**
 * The workflow text with each `run:` or `env:` alias replaced by the value its
 * anchor names, and each anchor dropped from where it is defined. `label`
 * names the workflow in a refusal.
 */
function expandAliases(text, label = 'the workflow') {
  const lines = text.split('\n');
  const bare = lines.map((l) => l.replace(/\r$/, ''));
  const refuse = (n, cause) => { throw new Error(`${label}: line ${n + 1}: ${cause} (${bare[n].trim()})`); };
  const ELSEWHERE = 'an anchor or alias anywhere but the whole value of run or env';
  const anchors = new Map();
  const sites = new Map();
  let block = -1;
  let within = -1;
  for (let n = 0; n < bare.length; n++) {
    const line = bare[n];
    if (block !== -1) {
      if (!line.trim() || indent(line) > block) continue;
      block = -1;
    }
    if (!line.trim() || isComment(line)) continue;
    const { lead, dashes, at, key, head, value } = lineParts(line);
    if (key === '<<') refuse(n, 'a merge key');
    let rest = value;
    if (/^[&*]/.test(value)) {
      if (key === undefined) refuse(n, dashes ? 'an anchor or alias on a list item' : ELSEWHERE);
      if (!ANCHORED_KEYS.includes(key) || n <= within) refuse(n, ELSEWHERE);
      if (value.startsWith('*')) {
        const [, name, after] = /^\*([\w-]*)(.*)$/.exec(value);
        if (after || !name) refuse(n, 'an alias with something after its name');
        if (!anchors.has(name)) refuse(n, 'an alias with no anchor before it');
        const below = bare.findIndex((l, m) => m > n && l.trim());
        if (below !== -1 && indent(bare[below]) > at) refuse(below, 'an alias with something after its name');
        anchors.get(name).used = true;
        sites.set(n, { alias: name, head, at });
        continue;
      }
      const [, name, after] = /^&([\w-]*)(.*)$/.exec(value);
      if (!name || (after && !/^\s/.test(after))) refuse(n, 'an anchor with something joined to its name');
      if (anchors.has(name)) refuse(n, `an anchor defined twice, first at line ${anchors.get(name).n + 1}`);
      rest = after.trim();
      let end = n;
      for (let m = n + 1; m < bare.length && (!bare[m].trim() || indent(bare[m]) > at); m++) if (bare[m].trim()) end = m;
      anchors.set(name, { n, at, rest, value: lines.slice(n + 1, end + 1), used: false });
      sites.set(n, { anchor: name, head, rest });
      within = end;
    }
    if (/^[[{]/.test(rest) && flowMarks(rest)) refuse(n, ELSEWHERE);
    if (BLOCK_SCALAR.test(rest)) block = key === undefined ? lead.length + Math.max(dashes.length - 2, 0) : at;
  }
  for (const [, a] of anchors) if (!a.used) refuse(a.n, 'an anchor never used');
  if (!sites.size) return text;

  const out = [];
  lines.forEach((line, n) => {
    const site = sites.get(n);
    if (!site) return out.push(line);
    const cr = line.endsWith('\r') ? '\r' : '';
    const anchor = anchors.get(site.alias || site.anchor);
    out.push(`${site.head}${anchor.rest ? ` ${anchor.rest}` : ''}${cr}`);
    if (!site.alias) return undefined;
    const shift = site.at - anchor.at;
    for (const l of anchor.value) out.push(!l.trim() ? l : shift >= 0 ? ' '.repeat(shift) + l : l.slice(-shift));
    return undefined;
  });
  return out.join('\n');
}

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
  const lines = expandAliases(text, label).split('\n');
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

module.exports = { expandAliases, parseWorkflow, readWorkflow, runCommands };
