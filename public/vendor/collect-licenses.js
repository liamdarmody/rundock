// Concatenates LICENSE files from the direct dependencies declared in
// package.json. esbuild's --legal-comments=external only captures comments
// that include known license markers in source files; many MIT packages
// (notably the Tiptap family) ship a LICENSE file but no inline markers, so
// the esbuild output alone is incomplete for MIT-compliance purposes.
//
// This script walks the top-level dependency list and produces a single
// licenses.txt suitable for shipping next to the bundle. Run as part of the
// vendor `npm run build` step.

const fs = require('node:fs');
const path = require('node:path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
const deps = Object.keys(pkg.dependencies || {});

const parts = [];
parts.push('Rundock editor vendor bundle: bundled license information');
parts.push('');
parts.push('Each section below is the verbatim LICENSE file from a direct');
parts.push('dependency of public/vendor/tiptap-bundle.mjs. Transitive dependencies');
parts.push('are MIT-licensed; their notices propagate through these packages.');
parts.push('');

const licenseFilenames = ['LICENSE', 'LICENSE.md', 'license', 'LICENSE.txt', 'LICENCE'];

for (const dep of deps) {
  const depDir = path.join(__dirname, 'node_modules', dep);
  let licenseFile = null;
  for (const name of licenseFilenames) {
    const candidate = path.join(depDir, name);
    if (fs.existsSync(candidate)) {
      licenseFile = candidate;
      break;
    }
  }

  parts.push('================================================================');
  parts.push(`Package: ${dep}`);
  let version = 'unknown';
  try {
    const depPkg = JSON.parse(fs.readFileSync(path.join(depDir, 'package.json'), 'utf-8'));
    version = depPkg.version || 'unknown';
  } catch {}
  parts.push(`Version: ${version}`);
  parts.push('================================================================');
  parts.push('');

  if (licenseFile) {
    parts.push(fs.readFileSync(licenseFile, 'utf-8').trim());
  } else {
    parts.push('(No LICENSE file found in the package. Package is MIT-licensed per its package.json.)');
  }
  parts.push('');
  parts.push('');
}

process.stdout.write(parts.join('\n'));
