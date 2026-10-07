'use strict';
// The Windows from-source launcher makes the link's one-time code and opens
// the link itself, because the server it starts runs hidden with its output
// going to a log file. These pin both halves: the server takes a launcher's
// code out of its environment at once, accepts it once, prints no link, and
// never uses it as the launch key; the launcher's own script hands the code
// over only through that environment variable and the link it opens.
//
// What cannot be checked here, on a machine without Windows: that PowerShell
// runs the generated launcher, that Start-Process opens a link carrying a
// `#` fragment in the default browser intact, and that the variable is gone
// from the launcher's environment afterwards. The script's text is checked
// instead.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const CODE = 'L'.repeat(20) + '_-' + 'k'.repeat(21); // 43 URL-safe characters

function probeAuth(env) {
  const script = `const a = require(${JSON.stringify(path.join(ROOT, 'lib', 'auth', 'index.js'))});`
    + 'a.setLinkPrinter(() => {});'
    + `const first = !!a.exchangeCode(${JSON.stringify(CODE)}, 3000);`
    + `const second = !!a.exchangeCode(${JSON.stringify(CODE)}, 3000);`
    + 'process.stdout.write(JSON.stringify({ first, second, isKey: a.launchKey() === ' + JSON.stringify(CODE) + ', fromLauncher: a.codeFromLauncher(), envLeft: process.env.RUNDOCK_LAUNCH_CODE || null }));';
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, ...env }, encoding: 'utf-8' });
  return JSON.parse(r.stdout);
}

describe('a code handed over by the launcher', () => {
  test('is good once, is never the launch key, and is out of the environment before anything can inherit it', () => {
    const r = probeAuth({ RUNDOCK_LAUNCH_CODE: CODE });
    assert.strictEqual(r.first, true);
    assert.strictEqual(r.second, false, 'used once, it is dead');
    assert.strictEqual(r.isKey, false);
    assert.strictEqual(r.fromLauncher, true);
    assert.strictEqual(r.envLeft, null);
  });

  test('is ignored unless it is shaped like a code, and still removed', () => {
    for (const bad of ['short', 'has space ' + 'x'.repeat(40), '']) {
      const r = probeAuth({ RUNDOCK_LAUNCH_CODE: bad });
      assert.strictEqual(r.fromLauncher, false, JSON.stringify(bad));
      assert.strictEqual(r.envLeft, null);
    }
  });

  test('the launch key cannot be handed over at all', () => {
    const r = spawnSync(process.execPath, ['-e', `const a = require(${JSON.stringify(path.join(ROOT, 'lib', 'auth', 'index.js'))}); process.stdout.write(a.launchKey() === process.env.RUNDOCK_LAUNCH_KEY ? 'taken' : 'made')`],
      { env: { ...process.env, RUNDOCK_LAUNCH_KEY: CODE }, encoding: 'utf-8' });
    assert.strictEqual(r.stdout, 'made');
  });

  test('a server given its code prints the address without a link, and the code lets a page in once', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-launcher-home-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, PORT: '0', HOME: home, USERPROFILE: home, RUNDOCK_ELECTRON: '1', WORKSPACE: '', RUNDOCK_LAUNCH_CODE: CODE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    try {
      const port = await new Promise((resolve, reject) => {
        let poll;
        const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`no banner without a link:\n${out.replace(/#c=[A-Za-z0-9_-]+/g, '#c=…')}`)); }, 10000);
        poll = setInterval(() => {
          const m = /Rundock is running: http:\/\/localhost:(\d+)\s/.exec(out);
          if (m && /No workspace set/.test(out)) { clearTimeout(timer); clearInterval(poll); resolve(Number(m[1])); }
        }, 25);
      });
      const status = await (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).json();
      assert.deepStrictEqual(status, { signedIn: false, launcher: true, idle: true },
        'the launcher can tell this is its own idle server, and the page that it has no terminal');
      const exchange = () => fetch(`http://127.0.0.1:${port}/api/auth/session`, { method: 'POST', headers: { 'X-Rundock-Code': CODE } });
      const first = await exchange();
      assert.strictEqual(first.status, 200);
      const { token } = await first.json();
      assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/agents`, { headers: { 'X-Rundock-Session': token } })).status, 200);
      assert.strictEqual((await exchange()).status, 401, 'once only');
      assert.ok(!out.includes(CODE), 'the code is nowhere in what the server printed');
      assert.ok(!out.includes('#c='), 'no link is printed, then or after the code is used');
    } finally {
      child.kill('SIGTERM');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the generated Windows launcher', () => {
  const installer = fs.readFileSync(path.join(ROOT, 'scripts', 'install-windows-source.ps1'), 'utf-8');
  const start = installer.indexOf("$launcherBody = @'");
  const end = installer.indexOf("\n'@", start);
  const body = installer.slice(start, end);

  test('is found', () => {
    assert.ok(start > 0 && end > start);
  });

  test('makes a code of the shape the server accepts, from a cryptographic source', () => {
    assert.match(body, /\[System\.Security\.Cryptography\.RandomNumberGenerator\]::Create\(\)/);
    assert.match(body, /New-Object byte\[\] 32/);
    assert.match(body, /\.TrimEnd\('='\)\.Replace\('\+', '-'\)\.Replace\('\/', '_'\)/);
  });

  test('hands it to the server only for the start, then removes it', () => {
    const set = body.indexOf('$env:RUNDOCK_LAUNCH_CODE = $Code');
    const startNode = body.indexOf("Start-Process -FilePath 'node'");
    const removed = body.indexOf('Remove-Item Env:RUNDOCK_LAUNCH_CODE');
    assert.ok(set > 0 && set < startNode && startNode < removed, 'set, start, remove, in that order');
    assert.match(body, /\} finally \{\s+Remove-Item Env:RUNDOCK_LAUNCH_CODE/);
    assert.doesNotMatch(body, /RUNDOCK_LAUNCH_KEY/);
  });

  test('opens the link it made once the server answers, waiting out a slow first start', () => {
    assert.match(body, /return "\$Url\/#c=\$Code"/);
    assert.match(body, /\$Open\s+= \$Url\n/);
    assert.match(body, /\nStart-Process \$Open$/);
    assert.match(body, /\$deadline = \(Get-Date\)\.AddSeconds\(120\)/, 'two minutes, not ten seconds');
  });

  test('opened again, it restarts only a Rundock it started that is idle, for a fresh code; a busy one is left alone', () => {
    assert.match(body, /Set-Content -Path \$PidFile -Value \$server\.Id/);
    assert.match(body, /if \(\$ours -and \$ours\.ProcessName -eq 'node' -and \$status -and \$status\.launcher -and \$status\.idle\) \{\s+Stop-Process -Id \$ours\.Id -Force/);
  });

  test('never writes the code anywhere', () => {
    for (const line of body.split('\n')) {
      if (!line.includes('$Code')) continue;
      assert.doesNotMatch(line, /Out-File|Add-Content|Set-Content|Write-|Tee-Object|\$Log|>/, line.trim());
    }
  });
});
