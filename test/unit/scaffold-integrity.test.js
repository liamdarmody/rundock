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
    const files = fs.readdirSync(SCAFFOLD).filter((f) => f.endsWith('.md'));
    const shipped = new Set(files.map((f) => f.replace(/\.md$/, '')));
    const failures = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(SCAFFOLD, f), 'utf-8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/`(rundock-[a-z][a-z-]*)`/g)) {
          if (!shipped.has(m[1])) {
            failures.push(`${f}:${i + 1} references \`${m[1]}\`, which is not a scaffolded file`);
          }
        }
      });
    }
    assert.deepStrictEqual(failures, [], failures.join('\n'));
  });
});
