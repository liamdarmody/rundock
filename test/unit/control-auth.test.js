'use strict';
// Unit: the pieces of the control-connection lock, each on its own.
//
//   lib/auth                         the one question, browser sessions, hook tokens
//   lib/http-router isOpenRoute      which routes need no key
//   lib/workspace/link-safe-write    writes never leave the workspace through a link
//   public/sign-in-model             the key in the fragment, and the one line
//   electron/window-key              the header only to this server, never a frame
//   package.json build.electronFuses no debugging switches in a shipped build
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const auth = require('../../lib/auth/index.js');

function fakeReq(headers = {}, extra = {}) { return { headers, method: 'GET', url: '/api/agents', ...extra }; }
function fakeRes() {
  const res = { status: null, headers: null, body: null };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers || {}; };
  res.end = (body) => { res.body = body; };
  return res;
}

describe('lib/auth: the one question', () => {
  test('the launch key in the header authenticates; anything else does not', () => {
    assert.strictEqual(auth.authenticate(fakeReq({ [auth.KEY_HEADER]: auth.launchKey() }), 3000), true);
    assert.strictEqual(auth.authenticate(fakeReq({}), 3000), false);
    assert.strictEqual(auth.authenticate(fakeReq({ [auth.KEY_HEADER]: auth.launchKey().slice(1) }), 3000), false);
    assert.strictEqual(auth.authenticate(fakeReq({ [auth.KEY_HEADER]: '' }), 3000), false);
  });

  test('the key is not in the environment', () => {
    assert.ok(!Object.values(process.env).join('\n').includes(auth.launchKey()));
  });

  test('a browser trades a one-time code for a session token, sent as a header, for this port only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-auth-'));
    const store = path.join(dir, 'sessions.json');
    auth.configureSessionStore(store);
    auth.setLinkPrinter(() => {});
    try {
      const refused = fakeRes();
      auth.signInBrowser(fakeReq({}), refused, 4100);
      assert.strictEqual(refused.status, 401);
      const keyRefused = fakeRes();
      auth.signInBrowser(fakeReq({ [auth.CODE_HEADER]: auth.launchKey() }), keyRefused, 4100);
      assert.strictEqual(keyRefused.status, 401, 'the launch key is never a code');

      const res = fakeRes();
      auth.signInBrowser(fakeReq({ [auth.CODE_HEADER]: auth.codeOf(auth.signInLink(4100)) }), res, 4100);
      assert.strictEqual(res.status, 200);
      const { token } = JSON.parse(res.body);
      const cookie = res.headers['Set-Cookie'];
      assert.match(cookie, /^rundock_media_4100=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/workspace-file; Max-Age=\d+$/,
        'the only cookie is for pictures and PDFs');
      const media = cookie.split(';')[0];

      assert.strictEqual(auth.authorisedBy(fakeReq({ [auth.SESSION_HEADER]: token }), 4100), 'session');
      assert.strictEqual(auth.authorisedBy(fakeReq({ 'sec-websocket-protocol': `rundock, ${auth.WS_SESSION_PREFIX}${token}` }), 4100), 'session');
      assert.strictEqual(auth.authenticate(fakeReq({ [auth.SESSION_HEADER]: token }), 4101), false, 'not on another port');
      assert.strictEqual(auth.authenticate(fakeReq({ [auth.SESSION_HEADER]: `${token}x` }), 4100), false);
      assert.strictEqual(auth.authenticate(fakeReq({ cookie: `rundock_session_4100=${token}` }), 4100), false, 'never as a cookie');
      assert.strictEqual(auth.authorisedBy(fakeReq({ cookie: media }, { url: '/workspace-file?path=a.png' }), 4100), 'media');
      assert.strictEqual(auth.authenticate(fakeReq({ cookie: media }, { url: '/api/file?path=a.md' }), 4100), false, 'the media cookie opens nothing else');
      assert.strictEqual(auth.authenticate(fakeReq({ cookie: media }, { url: '/workspace-file?path=a.png', method: 'POST' }), 4100), false);

      const onDisk = fs.readFileSync(store, 'utf-8');
      assert.ok(!onDisk.includes(token), 'only a fingerprint is kept on disk');
      assert.ok(!onDisk.includes(auth.launchKey()), 'and never the key');

      // A restart reads the same file: still let in.
      auth.configureSessionStore(store);
      assert.strictEqual(auth.authenticate(fakeReq({ [auth.SESSION_HEADER]: token }), 4100), true);
    } finally {
      auth.configureSessionStore(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the status route says only whether this page is let in', () => {
    auth.setLinkPrinter(() => {});
    const res = fakeRes();
    auth.sessionStatus(fakeReq({}), res, 4100);
    assert.deepStrictEqual(JSON.parse(res.body), { signedIn: false });
    assert.ok(!('idle' in JSON.parse(res.body)), 'only a server the launcher started says whether it is idle');
    const keyed = fakeRes();
    auth.sessionStatus(fakeReq({ [auth.KEY_HEADER]: auth.launchKey() }), keyed, 4100);
    assert.deepStrictEqual(JSON.parse(keyed.body), { signedIn: true });
  });

  test('only the newest browsers are remembered', () => {
    auth.configureSessionStore(null);
    auth.setLinkPrinter(() => {});
    const exchange = () => auth.exchangeCode(auth.codeOf(auth.signInLink(4200)), 4200);
    const oldest = exchange().token;
    for (let i = 0; i < auth.MAX_SESSIONS; i++) exchange();
    assert.strictEqual(auth.authenticate(fakeReq({ [auth.SESSION_HEADER]: oldest }), 4200), false);
  });
});

describe('lib/auth: the hook\'s tokens', () => {
  test('each conversation has its own token, stable for the launch', () => {
    const a = auth.issueHookToken('convo-a');
    assert.strictEqual(auth.issueHookToken('convo-a'), a);
    assert.notStrictEqual(auth.issueHookToken('convo-b'), a);
    assert.strictEqual(auth.hookTokenScope(a), 'convo-a');
  });

  test('a routine run\'s token belongs to no conversation; an unknown token to nothing at all', () => {
    const routine = auth.issueHookToken(null);
    assert.strictEqual(auth.hookTokenScope(routine), null);
    assert.strictEqual(auth.hookTokenScope('made-up'), undefined);
    assert.strictEqual(auth.hookTokenScope(''), undefined);
    assert.strictEqual(auth.hookScopeOf(fakeReq({ [auth.HOOK_HEADER]: routine })), null);
  });

  test('a hook token is never the window\'s key', () => {
    const t = auth.issueHookToken('convo-key');
    assert.strictEqual(auth.authenticate(fakeReq({ [auth.KEY_HEADER]: t }), 3000), false);
  });
});

describe('lib/http-router: the routes that need no key', () => {
  const { isOpenRoute } = require('../../lib/http-router.js');
  const open = (url, method = 'GET') => isOpenRoute({ url, method });

  test('the page and its static files', () => {
    for (const url of ['/', '/index.html', '/?x=1', '/app.js', '/favicon.svg', '/marked.min.js', '/sign-in-model.js', '/styles/tokens.css', '/views/files.js', '/vendor/fonts/x.woff2', '/rundock-ui/gallery']) {
      assert.strictEqual(open(url), true, url);
    }
  });

  test('the sign-in routes and the hook\'s two routes, which check a token of their own', () => {
    assert.strictEqual(open('/api/auth/status'), true);
    assert.strictEqual(open('/api/auth/session', 'POST'), true);
    assert.strictEqual(open('/api/agent-notice?conversation=x'), true);
    assert.strictEqual(open('/api/permission-request', 'POST'), true);
  });

  test('everything else, including a route nobody has written yet', () => {
    for (const url of ['/api/agents', '/api/files', '/api/graph', '/api/file?path=a.md', '/workspace-file?path=a.png', '/api/connectors/machine', '/api/anything-new', '/app.js?x=1']) {
      assert.strictEqual(open(url), false, url);
    }
    assert.strictEqual(open('/api/review-sidecar', 'POST'), false);
    assert.strictEqual(open('/', 'POST'), false);
  });
});

describe('lib/workspace/link-safe-write: a write lands where it really is', () => {
  const { writeLandsInside, writeFileNoFollow } = require('../../lib/workspace/link-safe-write.js');
  const make = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-lsw-')));
    const ws = path.join(root, 'ws');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(ws); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'target.md'), 'x');
    fs.symlinkSync(path.join(outside, 'target.md'), path.join(ws, 'link.md'));
    fs.symlinkSync(outside, path.join(ws, 'linkdir'));
    fs.symlinkSync(ws, path.join(root, 'ws-alias'));
    return { root, ws, outside };
  };

  test('inside, and new files inside, are allowed; through a link outward is not', () => {
    const { ws } = make();
    assert.strictEqual(writeLandsInside(path.join(ws, 'note.md'), [ws]), true);
    assert.strictEqual(writeLandsInside(path.join(ws, 'new', 'deeper', 'note.md'), [ws]), true);
    assert.strictEqual(writeLandsInside(path.join(ws, 'link.md'), [ws]), false);
    assert.strictEqual(writeLandsInside(path.join(ws, 'linkdir', 'new.md'), [ws]), false);
  });

  test('a working folder the workspace names is a root too', () => {
    const { ws, outside } = make();
    assert.strictEqual(writeLandsInside(path.join(ws, 'linkdir', 'new.md'), [ws, outside]), true);
  });

  test('the workspace reached through a link of its own is still the workspace', () => {
    const { root, ws } = make();
    assert.strictEqual(writeLandsInside(path.join(ws, 'note.md'), [path.join(root, 'ws-alias')]), true);
  });

  test('the last step never follows a link', { skip: process.platform === 'win32' }, () => {
    const { ws, outside } = make();
    assert.throws(() => writeFileNoFollow(path.join(ws, 'link.md'), 'y'), { code: 'ELOOP' });
    assert.strictEqual(fs.readFileSync(path.join(outside, 'target.md'), 'utf-8'), 'x');
    writeFileNoFollow(path.join(ws, 'plain.md'), 'z');
    assert.strictEqual(fs.readFileSync(path.join(ws, 'plain.md'), 'utf-8'), 'z');
  });
});

describe('public/sign-in-model: the key in the fragment, and the one line', () => {
  const m = require('../../public/sign-in-model.js');
  test('the code is read from #c= and nothing else', () => {
    const code = 'A'.repeat(43);
    assert.strictEqual(m.codeFromHash(`#c=${code}`), code);
    assert.strictEqual(m.codeFromHash(`#x=1&c=${code}`), code);
    assert.strictEqual(m.codeFromHash(''), null);
    assert.strictEqual(m.codeFromHash('#c='), null);
    assert.strictEqual(m.codeFromHash('#c=<script>'), null);
    assert.strictEqual(m.codeFromHash(`#cc=${code}`), null);
    assert.strictEqual(m.codeFromHash(`#k=${code}`), null);
  });
  test('the token goes in a header to this page\'s own server, and nowhere else', async () => {
    const seen = [];
    const f = m.withSessionHeader(async (input, init) => { seen.push([input, init && init.headers ? new Headers(init.headers).get('X-Rundock-Session') : null]); }, () => 'T'.repeat(30), 'http://localhost:3000');
    await f('/api/agents');
    await f('http://localhost:3000/api/file?path=a');
    await f('http://localhost:5173/preview');
    await f('https://example.com/');
    assert.deepStrictEqual(seen.map(([, h]) => h), ['T'.repeat(30), 'T'.repeat(30), null, null]);
    const none = m.withSessionHeader(async (input, init) => { seen.push(init); }, () => null, 'http://localhost:3000');
    await none('/api/agents');
    assert.strictEqual(seen[seen.length - 1], undefined, 'no token, nothing added');
  });
  test('the socket offers rundock, and the token only beside it', () => {
    assert.deepStrictEqual(m.socketProtocols(null), ['rundock']);
    assert.deepStrictEqual(m.socketProtocols('tok'), ['rundock', 'rundock.session.tok']);
  });
  test('a token is kept and read back only when it is shaped like one', () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) };
    m.keepToken(storage, 'A'.repeat(30));
    assert.strictEqual(m.readToken(storage), 'A'.repeat(30));
    store.set(m.STORAGE_KEY, 'not a token!');
    assert.strictEqual(m.readToken(storage), null);
    assert.strictEqual(m.readToken({ getItem: () => { throw new Error('blocked'); } }), null);
  });
  test('a tab that was connected says Rundock restarted; one that never was says to open the link', () => {
    assert.strictEqual(m.signedOutLine(true), 'Rundock restarted. Open it from the link in your terminal');
    assert.strictEqual(m.signedOutLine(false), 'Open Rundock from the link in your terminal');
  });
  test('a Rundock the Windows launcher started points to its icon, never to a terminal it has not got', () => {
    assert.strictEqual(m.signedOutLine(false, true), 'Open Rundock again from its icon on your desktop');
    assert.strictEqual(m.signedOutLine(true, true), 'Open Rundock again from its icon on your desktop');
  });
  test('the exchange is tried again until the server itself answers', () => {
    assert.strictEqual(m.exchangeFinal(200), true);
    assert.strictEqual(m.exchangeFinal(401), true, 'a refused code is final');
    for (const s of [0, 500, 502, 503, 504]) assert.strictEqual(m.exchangeFinal(s), false, String(s));
  });
});

describe('electron/window-key: the header goes only to this server, never from a frame', () => {
  const wk = require('../../electron/window-key.js');
  const frame = { parent: null, origin: 'http://localhost:5000' };
  const extensionFrame = { parent: {}, origin: 'null' };

  test('this server on every loopback name, HTTP and WebSocket', () => {
    for (const url of ['http://localhost:5000/', 'http://127.0.0.1:5000/api/file?path=a', 'ws://localhost:5000/', 'http://[::1]:5000/x']) {
      assert.strictEqual(wk.shouldAddKey({ url, frame }, 5000), true, url);
    }
    assert.ok(wk.keyedUrlPatterns(5000).includes('ws://localhost:5000/*'));
  });

  test('never another port, another host or another scheme', () => {
    for (const url of ['http://localhost:5001/', 'https://localhost:5000/', 'http://example.com:5000/', 'http://localhost.example.com:5000/', 'file:///etc/passwd']) {
      assert.strictEqual(wk.shouldAddKey({ url, frame }, 5000), false, url);
    }
  });

  test('never a request that names another origin, or none of its own (null)', () => {
    for (const origin of ['null', 'https://example.com', 'http://localhost:5001']) {
      assert.strictEqual(wk.shouldAddKey({ url: 'http://localhost:5000/api/file', frame: null, requestHeaders: { Origin: origin } }, 5000), false, origin);
    }
    assert.strictEqual(wk.shouldAddKey({ url: 'http://localhost:5000/', frame, requestHeaders: { Origin: 'http://localhost:5000' } }, 5000), true);
  });

  test('never a request an extension frame makes', () => {
    assert.strictEqual(wk.shouldAddKey({ url: 'http://localhost:5000/api/file?path=a', frame: extensionFrame }, 5000), false);
  });

  test('the debugging switches are recognised, with or without a value', () => {
    assert.strictEqual(wk.debugSwitchIn(['/app', '--remote-debugging-port=9222']), '--remote-debugging-port');
    assert.strictEqual(wk.debugSwitchIn(['/app', '--inspect']), '--inspect');
    assert.strictEqual(wk.debugSwitchIn(['/app', '--inspect-brk=0']), '--inspect-brk');
    assert.strictEqual(wk.debugSwitchIn(['/app', '--some-flag']), null);
  });

  test('a shipped build refuses to start with one', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf-8');
    assert.match(main, /if \(app\.isPackaged\) \{\n  const debugSwitch = debugSwitchIn\(process\.argv\);/);
    assert.match(main, /app\.exit\(1\);/);
    assert.match(main, /installWindowKey\(mainWindow\.webContents\.session, \{ port, key: auth\.launchKey\(\), header: auth\.KEY_HEADER \}\);/);
  });
});

describe('package.json: no debugging switches in a shipped build', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'));
  test('the Node inspect switches and NODE_OPTIONS are off', () => {
    assert.strictEqual(pkg.build.electronFuses.enableNodeCliInspectArguments, false);
    assert.strictEqual(pkg.build.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  });
  test('run-as-Node stays on, because the permission hook runs that way in the shipped app', () => {
    assert.strictEqual(pkg.build.electronFuses.runAsNode, true);
  });
});
