import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveArtifactLink } from '../../public/viewers/artifact-links.js';

describe('resolveArtifactLink', () => {
  const from = 'Artifacts/Launch Page.html';

  test('external URLs open in the browser', () => {
    for (const href of ['https://example.com', 'http://x.io/a', 'mailto:a@b.com', 'ftp://h/f']) {
      assert.deepEqual(resolveArtifactLink(href, from), { kind: 'external', value: href });
    }
  });

  test('in-page anchors and empty hrefs are left to the frame', () => {
    assert.equal(resolveArtifactLink('#section', from), null);
    assert.equal(resolveArtifactLink('', from), null);
    assert.equal(resolveArtifactLink('   ', from), null);
  });

  test('wikilinks open by name (any supported file type)', () => {
    assert.deepEqual(resolveArtifactLink('[[plan]]', from), { kind: 'wikilink', value: 'plan' });
    assert.deepEqual(resolveArtifactLink('[[chart.png|the chart]]', from), { kind: 'wikilink', value: 'chart.png' });
  });

  test('relative links resolve to a workspace path, opened in Rundock', () => {
    assert.deepEqual(resolveArtifactLink('../Notes/plan.md', from), { kind: 'path', value: 'Notes/plan.md' });
    assert.deepEqual(resolveArtifactLink('sibling.svg', from), { kind: 'path', value: 'Artifacts/sibling.svg' });
    assert.deepEqual(resolveArtifactLink('./diagram.svg', from), { kind: 'path', value: 'Artifacts/diagram.svg' });
    assert.deepEqual(resolveArtifactLink('cover.png', from), { kind: 'path', value: 'Artifacts/cover.png' });
  });

  test('workspace-root and query/fragment handling', () => {
    assert.deepEqual(resolveArtifactLink('/Notes/plan.md', from), { kind: 'path', value: 'Notes/plan.md' });
    assert.deepEqual(resolveArtifactLink('report.pdf?x=1#p2', from), { kind: 'path', value: 'Artifacts/report.pdf' });
    assert.deepEqual(resolveArtifactLink('a%20b.md', from), { kind: 'path', value: 'Artifacts/a b.md' });
  });
});
