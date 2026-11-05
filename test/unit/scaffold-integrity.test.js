// Every reference inside the scaffolded platform files must resolve.
//
// The scaffold ships into every new workspace, and a reference to a skill
// that does not exist sends Doc confidently down a dead end (a live audit
// found exactly that: a guided flow pointing at a skill that was never
// shipped). Structural audits of USER workspaces cannot catch it, because
// the defect is in what Rundock itself ships.
//
// The check is deliberately mechanical: any backtick-quoted `rundock-*`
// name mentioned in any scaffolded file must exist as a scaffold file.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCAFFOLD = path.join(__dirname, '..', '..', 'scaffold');

describe('scaffolded platform files', () => {
  test('every referenced rundock-* skill exists in the scaffold', () => {
    // A prohibition scan passes on an empty result, so the pattern proves it
    // can still find a reference before the absence of failures is believed.
    // ONE VALUE for the specimen and the scan: a specimen matched against its
    // own copy of the pattern stays green while the scan goes blind.
    const SKILL_REF = /`(rundock-[a-z][a-z-]*)`/g;
    const specimen = [...'see `rundock-example-skill` for the shape'.matchAll(SKILL_REF)];
    assert.strictEqual(specimen.length, 1, 'the skill-reference pattern no longer matches its own specimen');
    const files = fs.readdirSync(SCAFFOLD).filter((f) => f.endsWith('.md'));
    const shipped = new Set(files.map((f) => f.replace(/\.md$/, '')));
    const failures = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(SCAFFOLD, f), 'utf-8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(SKILL_REF)) {
          if (!shipped.has(m[1])) {
            failures.push(`${f}:${i + 1} references \`${m[1]}\`, which is not a scaffolded file`);
          }
        }
      });
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
});

// Issue #307. The frontmatter examples inside Doc's own instructions are not
// illustrations, they are what Doc copies: the block under
// `<!-- RUNDOCK:SAVE_AGENT -->` is emitted verbatim when Doc creates an agent.
// So a concrete model named there is written into every agent Doc builds, for
// every user, which is how a gateway user's whole team ends up pinned to a
// model their runtime cannot serve. Doc's own frontmatter being right is not
// enough; the templates have to agree with it.
describe('the models Doc teaches', () => {
  const guide = fs.readFileSync(path.join(SCAFFOLD, 'rundock-guide.md'), 'utf-8');

  test('Doc itself inherits', () => {
    const frontmatter = guide.split('---')[1] || '';
    assert.match(frontmatter, /^model: inherit$/m,
      "Doc is the first agent a new user meets, on a machine Rundock cannot name a model for");
  });

  test('the SAVE_AGENT template Doc emits sets inherit', () => {
    const block = guide.split('<!-- RUNDOCK:SAVE_AGENT')[1];
    assert.ok(block, 'the SAVE_AGENT template must exist; this test is worthless if it is renamed');
    const template = block.split('```')[1] || '';
    assert.match(template, /^model: inherit$/m,
      'every agent Doc creates inherits unless the user asks for something specific');
  });

  // Both scaffolded files that teach frontmatter, not just the guide. The
  // guide's own template only covers onboarding; `## Creating agents` routes
  // every other agent operation to the rundock-agents skill, so a concrete
  // model left there is written into every agent Doc builds afterwards. The
  // first version of this test scanned the guide alone and passed while the
  // skill still said `model: {opus|sonnet|haiku}`.
  const AUTHORING_FILES = ['rundock-guide.md', 'rundock-agents.md'];

  test('no frontmatter example in either authoring file names a concrete model to copy', () => {
    for (const name of AUTHORING_FILES) {
      const src = fs.readFileSync(path.join(SCAFFOLD, name), 'utf-8');
      // Not prose: `model:` lines, which are the ones a reader or an agent copies.
      const named = src.split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /^model:\s*\S/.test(line))
        .filter(([, line]) => !/^model:\s*inherit\b/.test(line));
      assert.deepStrictEqual(named, [],
        `${name}: a frontmatter example naming opus/sonnet/haiku teaches a pin that breaks gateway users`);
    }
  });

  test('neither authoring file tells Doc a model must always be set', () => {
    for (const name of AUTHORING_FILES) {
      const src = fs.readFileSync(path.join(SCAFFOLD, name), 'utf-8');
      assert.doesNotMatch(src, /Always set `model`/,
        `${name}: "always set a model" is the instruction that pins gateway users to a model they cannot serve`);
    }
  });

  test('the audit checklist does not treat an unrecognised model as invalid', () => {
    const skill = fs.readFileSync(path.join(SCAFFOLD, 'rundock-agents.md'), 'utf-8');
    assert.doesNotMatch(skill, /Claude agents use opus\/sonnet\/haiku/,
      'an audit that enforces the three names reverts a gateway identifier the user deliberately set');
  });
});

// WHAT DOC TEACHES ABOUT FRONTMATTER VALUES. Claude Code reads the part of an
// agent file between the --- lines as YAML and drops the whole file when it
// cannot, so a colon used as a separator inside a value there costs the agent
// its instructions and its tools: line. Doc's guide used to tell it to use
// colons to separate labels from descriptions in "any text within the agent
// file", descriptions included. The colon belongs in the instructions body;
// a frontmatter value keeps it out, or goes in double quotes.
describe('the frontmatter Doc teaches', () => {
  const guide = fs.readFileSync(path.join(SCAFFOLD, 'rundock-guide.md'), 'utf-8');
  const lines = guide.split('\n');

  test('colons as separators are recommended for the instructions body only', () => {
    const SEPARATOR_ADVICE = /colons? (to|as) separat/i;
    const advice = lines.filter((line) => SEPARATOR_ADVICE.test(line));
    // A prohibition scan passes on an empty result, so the guide is required
    // to still give the advice before its scope is checked.
    assert.ok(advice.length >= 1, 'the guide no longer gives any separator advice; this check has gone blind');
    for (const line of advice) {
      const recommends = /use colons? (to|as) separat/i.test(line);
      if (recommends) {
        assert.match(line, /in the instructions below the frontmatter, use colons/i,
          `a line recommends colons as separators without keeping them out of frontmatter values:\n${line}`);
      }
    }
  });

  test('a frontmatter value is kept plain, or put in double quotes', () => {
    const rule = lines.find((line) => /never use a colon as a separator inside a frontmatter value/i.test(line));
    assert.ok(rule, 'the guide does not tell Doc to keep colons out of frontmatter values');
    assert.match(rule, /colon followed by a space/);
    assert.match(rule, /double quotes/);
  });

  test("Doc's own file loads in Claude Code's reading", () => {
    const { readAgentFile } = require('../helpers/claude-code-agents.js');
    const read = readAgentFile(guide);
    assert.ok(read.loads, `Doc's file would be dropped: ${read.why}`);
  });
});
