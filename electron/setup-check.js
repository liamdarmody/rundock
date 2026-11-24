// The desktop's Claude Code setup check: is it installed, does it start, is
// it signed in.
//
// The setup screen polls this while the person installs Claude Code, so
// nothing here may hold the main process: every child is started
// asynchronously, without a shell, and overlapping requests share the check
// already running. On Windows the folder Claude Code was found in is added to
// the User PATH as soon as it is found, before Claude Code is first started,
// since that first start can be slow while Windows scans a newly downloaded
// program, and a new PowerShell window should recognise `claude` either way.
//
// Pure of Electron: electron/main.js passes in what it knows. Every effect
// goes through `deps`, which tests replace in-process.

'use strict';

// One entry of the User PATH, or the folder, in the form two are compared in:
// Windows paths ignore case, and one trailing backslash names the same folder.
const comparable = (entry) => entry.toLowerCase().replace(/\\$/, '');

// %NAME% references expanded from `env`, with Windows' case-insensitive names.
// A name with no value is left as written, as Windows leaves it.
function expandNames(entry, env) {
  return entry.replace(/%([^%;]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? whole : String(env[key]);
  });
}

// The User PATH to write so that it holds `folder`, or null for no change.
// `raw` is the value as stored, unexpanded. Every existing entry is kept byte
// for byte and in order, empty ones and %NAME% references included, and the
// folder is appended only when no entry already names it.
function mergeUserPath(raw, folder, env) {
  const text = raw == null ? '' : String(raw);
  if (!text) return folder;
  const want = comparable(folder);
  if (text.split(';').some((entry) => comparable(expandNames(entry, env)) === want)) return null;
  const separator = text.endsWith(';') ? '' : ';';
  return text + separator + folder;
}

module.exports = { mergeUserPath };
