#!/usr/bin/env node
// Local update feed for testing the desktop updater without publishing anything.
//
// The problem this solves: an updater fix normally cannot be verified until
// it ships, and the mechanism that would ship it is the one under repair. So
// changes to it were being made blind and confirmed a week later by whoever
// hit them. Serving the files electron-builder already generates (the
// installer artefacts plus latest-mac.yml / latest.yml) over plain HTTP is
// exactly what electron-updater's generic provider reads, so the whole update
// cycle runs locally instead, in minutes, with nothing published.
//
// Usage:
//   node scripts/update-harness/serve.mjs [--dir <feed-dir>] [--port <port>]
//
// Default feed dir is scripts/update-harness/feed/, populated by build.mjs.
//
// Deliberately dependency-free: this is a dev tool and the project keeps its
// production footprint to three packages. Node's http and fs are enough.

import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function parseArgs(argv) {
  const out = { dir: join(HERE, 'feed'), port: 8384 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) out.dir = resolve(argv[++i]);
    else if (argv[i] === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
  }
  return out;
}

// Content types that matter to electron-updater. The .yml manifests must not
// be served as octet-stream or some clients refuse them; everything else is a
// binary blob and the type is irrelevant to the download.
const TYPES = {
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.zip': 'application/zip',
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.json': 'application/json',
};

// Resolve a request path inside the feed directory and refuse anything that
// escapes it. A dev tool still should not serve the whole disk to localhost.
export function resolveInside(rootDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const candidate = normalize(join(rootDir, decoded));
  const root = normalize(rootDir);
  if (candidate !== root && !candidate.startsWith(root + '/')) return null;
  return candidate;
}

export function createFeedServer(feedDir) {
  return createServer((req, res) => {
    const filePath = resolveInside(feedDir, req.url || '/');
    if (!filePath) {
      res.writeHead(403).end('outside feed directory');
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404).end('not found');
      console.log(`  404  ${req.method} ${req.url}`);
      return;
    }
    const size = statSync(filePath).size;
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
      'Content-Length': size,
      // electron-updater issues ranged requests when resuming a part-finished
      // download. Advertising support keeps that path exercisable here.
      'Accept-Ranges': 'bytes',
    });
    console.log(`  200  ${req.method} ${req.url}  (${(size / 1048576).toFixed(1)} MB)`);
    createReadStream(filePath).pipe(res);
  });
}

// Entry point only when run directly, so the exports above stay unit-testable.
if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  const { dir, port } = parseArgs(process.argv.slice(2));

  if (!existsSync(dir)) {
    console.error(`Feed directory does not exist: ${dir}`);
    console.error('Run: node scripts/update-harness/build.mjs --version 0.11.5-test.1');
    process.exit(1);
  }

  const files = readdirSync(dir);
  const manifests = files.filter((f) => f.endsWith('.yml'));
  if (manifests.length === 0) {
    console.error(`No .yml manifest in ${dir}. electron-updater has nothing to read.`);
    console.error('The feed needs latest-mac.yml (macOS) or latest.yml (Windows).');
    process.exit(1);
  }

  createFeedServer(dir).listen(port, '127.0.0.1', () => {
    console.log(`\n  Update feed on http://127.0.0.1:${port} (loopback only)`);
    console.log(`  Serving ${dir}\n`);
    for (const m of manifests) console.log(`    manifest: ${m}`);
    for (const f of files.filter((f) => !f.endsWith('.yml'))) {
      console.log(`    artefact: ${f}`);
    }
    console.log('\n  Point a build at it with:');
    console.log(`    RUNDOCK_UPDATE_FEED=http://127.0.0.1:${port} npm run electron\n`);
  });
}
