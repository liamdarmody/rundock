'use strict';
// Named sources: the files a note lists in its frontmatter for the view
// mounted on it to read. Pure: no IO, no DOM. Loaded as a classic script in
// the page (window.RundockNamedSources, read by the extension host) and
// required by the server, so the grammar the host checks a write against and
// the grammar the server resolves are one grammar.
//
// THE PERSON CURATES, NOTHING IS ENUMERATED. A source is an exact
// workspace-relative path the note's author wrote. There is no glob, no
// folder, no search by name, no path outside the workspace and no hidden
// path, so the only files a view can ever be handed are ones a person typed.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RundockNamedSources = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const SOURCES_KEY = 'sources';
  const MAX_SOURCES = 12;
  const MAX_NAME_CHARS = 512;
  // The most text a view is handed at mount, the note and its sources
  // together. The same number as the host's MAX_INIT_CONTENT_CHARS (a test
  // holds the two equal: the host is a module this classic script cannot
  // import), so a view's whole init is under one cap.
  const MAX_TOTAL_CHARS = 2000000;
  const GLOB = /[*?[\]{}]/;

  // The frontmatter block, or null. The same opening and closing rule the
  // renderer registry's marker detection uses.
  function frontmatter(content) {
    const src = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
    if (!src.startsWith('---\n')) return null;
    const closing = src.slice(4).match(/(^|\n)---(\n|$)/);
    if (!closing) return null;
    return src.slice(4, 4 + closing.index);
  }

  function unquote(value) {
    const v = value.trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
      return v.slice(1, -1);
    }
    return v;
  }

  // "[[notes/a.csv]]" is how Obsidian writes a link in frontmatter. Accepted
  // only as a spelling of an exact path: the brackets are removed and the
  // inside is judged like any other name. An alias or heading is refused,
  // not resolved, because resolving it would be a search.
  function unwrapLink(value) {
    const m = value.match(/^\[\[(.*)\]\]$/);
    return m ? m[1] : value;
  }

  /**
   * The names a note lists, as written, or a reason the list cannot be read.
   * No `sources` key is an empty list, not an error.
   * @returns {{ names: string[], error: string|null }}
   */
  function listedSources(content) {
    const fm = frontmatter(content);
    if (fm === null) return { names: [], error: null };
    const lines = fm.split('\n');
    const at = lines.findIndex((l) => /^sources\s*:/.test(l));
    if (at < 0) return { names: [], error: null };
    const inline = lines[at].replace(/^sources\s*:/, '').trim();
    let raw = [];
    if (inline) {
      const m = inline.match(/^\[(.*)\]$/);
      if (!m) return { names: [], error: 'sources must be a list of file paths' };
      // Names with a comma in them must use the block form.
      raw = m[1].trim() ? m[1].split(',') : [];
    } else {
      for (let i = at + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.trim()) continue;
        const item = line.match(/^\s+-\s+(.*)$/) || line.match(/^-\s+(.*)$/);
        if (!item) break;
        raw.push(item[1]);
      }
    }
    const names = raw.map((r) => unwrapLink(unquote(r))).filter((n) => n.length > 0);
    if (names.length > MAX_SOURCES) {
      return { names: [], error: `a note may list at most ${MAX_SOURCES} sources` };
    }
    return { names, error: null };
  }

  /**
   * Why a listed name can never be a source, judged on the string alone, or
   * null. The server additionally resolves it on disk (links, existence, file
   * type, second names); this is the part that needs no IO. A reason names
   * the rule, never the target.
   */
  function nameRefusal(name) {
    if (typeof name !== 'string' || !name) return 'a source must be a file path';
    if (name.length > MAX_NAME_CHARS) return 'the path is too long';
    // Control characters include NUL, which some filesystem calls truncate at.
    if (/[\u0000-\u001f\u007f]/.test(name)) return 'the path contains a control character';
    if (name.includes('\\')) return 'a source path uses forward slashes';
    if (name.startsWith('/') || name.startsWith('~') || /^[A-Za-z]:/.test(name)) {
      return 'a source is a path inside this workspace, written relative to it';
    }
    if (GLOB.test(name)) return 'a source names one file; patterns are not resolved';
    if (name.includes('|') || name.includes('#')) return 'a source names one file; aliases and headings are not resolved';
    for (const seg of name.split('/')) {
      if (seg === '') return 'the path has an empty segment';
      if (seg === '.' || seg === '..') return 'a source path may not step out of or around a folder';
      if (seg.startsWith('.')) return 'a hidden file, or a file in a hidden folder, is never handed to an extension';
    }
    return null;
  }

  // Whether two versions of a file list the same sources, in the same order,
  // with the same error. No write an extension causes may change this list:
  // if it could, it could name any file and be handed it on the next read.
  function sameSources(before, after) {
    const a = listedSources(before);
    const b = listedSources(after);
    if (a.error !== b.error) return false;
    if (a.names.length !== b.names.length) return false;
    return a.names.every((n, i) => n === b.names[i]);
  }

  const CHANGED_LIST_REASON = 'a view cannot change which files a note lists as sources';

  return { SOURCES_KEY, MAX_SOURCES, MAX_TOTAL_CHARS, listedSources, nameRefusal, sameSources, CHANGED_LIST_REASON };
}));
