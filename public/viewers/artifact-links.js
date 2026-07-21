// Classify a link clicked inside a rendered artifact (HTML/SVG) so the host can
// route it: an external URL opens in the browser, a link to another workspace
// file opens inside Rundock, and an in-page anchor is left to the frame. Pure
// (no DOM), so it is unit-tested directly.

// Resolve a relative or workspace-root path against the artifact's own path.
// Returns a workspace-relative path (no leading slash, `.`/`..` collapsed).
function resolveWorkspacePath(target, basePath) {
  if (target.startsWith('/')) target = target.replace(/^\/+/, '');   // workspace-root
  else {
    const stack = String(basePath || '').split('/').slice(0, -1);    // artifact's folder
    for (const seg of target.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (stack.length) stack.pop(); }
      else stack.push(seg);
    }
    return stack.join('/');
  }
  return target;
}

// -> { kind: 'external', value: url }        open in the default browser
//    { kind: 'wikilink', value: name }       open by name in Rundock (any type)
//    { kind: 'path',     value: wsPath }     open the workspace file in Rundock
//    null                                     in-page anchor / empty: leave the frame
export function resolveArtifactLink(href, artifactPath) {
  const raw = String(href || '').trim();
  if (!raw || raw.startsWith('#')) return null;                       // in-page anchor
  const wl = raw.match(/^\[\[\s*([^\]|#]+?)\s*(?:[|#][^\]]*)?\]\]$/);  // [[target|alias]]
  if (wl) return { kind: 'wikilink', value: wl[1].trim() };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { kind: 'external', value: raw }; // has a scheme
  let target = raw.split(/[?#]/)[0];
  try { target = decodeURIComponent(target); } catch { /* keep raw */ }
  if (!target) return null;
  const path = resolveWorkspacePath(target, artifactPath);
  return path ? { kind: 'path', value: path } : null;
}
