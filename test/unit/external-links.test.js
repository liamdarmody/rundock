'use strict';
// The one rule for external links, both halves: the page's delegated click
// handler (public/external-links.js) and the desktop window's guards
// (electron/external-links.js).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const page = require('../../public/external-links.js');
const desktop = require('../../electron/external-links.js');

function shell(html) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: 'http://localhost:3000/' });
  const opened = [];
  dom.window.open = (...args) => { opened.push(args); return null; };
  page.install(dom.window.document, dom.window);
  const click = (selector, init = {}) => {
    const ev = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    dom.window.document.querySelector(selector).dispatchEvent(ev);
    return ev;
  };
  return { dom, opened, click };
}

describe('the page rule', () => {
  test('a click on an http or https link opens it in a new tab and the page stays', () => {
    const { opened, click } = shell('<a id="a" href="https://example.org/x">x</a><a id="b" href="http://127.0.0.1:9/y"><span id="inner">y</span></a>');
    assert.strictEqual(click('#a').defaultPrevented, true);
    assert.strictEqual(click('#inner').defaultPrevented, true, 'a click on something inside the link counts');
    assert.deepStrictEqual(opened, [['https://example.org/x', '_blank', 'noopener,noreferrer'], ['http://127.0.0.1:9/y', '_blank', 'noopener,noreferrer']]);
  });

  test('a protocol-relative link is external too, opened at the page\'s own scheme', () => {
    const { opened, click } = shell('<a id="p" href="//example.com/path">p</a>');
    assert.strictEqual(click('#p').defaultPrevented, true);
    assert.deepStrictEqual(opened, [['http://example.com/path', '_blank', 'noopener,noreferrer']]);
  });

  test('anchors, relative links, wikilinks, mailto and other schemes are left alone', () => {
    const { opened, click } = shell('<a id="h" href="#top">h</a><a id="r" href="notes/plan.md">r</a><a id="w" class="wikilink" data-wikilink="Plan">w</a>'
      + '<a id="m" href="mailto:a@example.org">m</a><a id="j" href="javascript:void(0)">j</a><a id="s" href="/settings">s</a>');
    for (const id of ['#h', '#r', '#w', '#m', '#j', '#s']) assert.strictEqual(click(id).defaultPrevented, false, id);
    assert.deepStrictEqual(opened, []);
  });

  test('a modified or non-primary click is left to the browser, which opens a tab itself', () => {
    const { opened, click } = shell('<a id="a" href="https://example.org/x">x</a>');
    click('#a', { metaKey: true });
    click('#a', { ctrlKey: true });
    click('#a', { button: 1 });
    assert.deepStrictEqual(opened, []);
  });

  test('it runs ahead of every surface\'s own handler, so none can navigate the page first', () => {
    const { dom, opened, click } = shell('<div id="surface"><a id="a" href="https://example.org/x">x</a></div>');
    let surfaceSawDefault = null;
    dom.window.document.getElementById('surface').addEventListener('click', (e) => { surfaceSawDefault = e.defaultPrevented; });
    click('#a');
    assert.strictEqual(surfaceSawDefault, true);
    assert.strictEqual(opened.length, 1);
  });

  test('installs once per document', () => {
    const { dom, opened, click } = shell('<a id="a" href="https://example.org/x">x</a>');
    assert.strictEqual(page.install(dom.window.document, dom.window), false);
    click('#a');
    assert.strictEqual(opened.length, 1);
  });
});

describe('the desktop guards', () => {
  function fakeContents() {
    const handlers = {};
    return {
      handlers,
      setWindowOpenHandler(fn) { handlers.open = fn; },
      on(name, fn) { handlers[name] = fn; },
    };
  }
  function installed() {
    const wc = fakeContents();
    const handed = [];
    desktop.installExternalLinkGuards(wc, { appOrigin: 'http://localhost:3000', openExternal: (u) => handed.push(u) });
    const navigate = (url) => { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; wc.handlers['will-navigate'](ev, url); return ev.prevented; };
    return { wc, handed, navigate };
  }

  test('a new window is always denied; a web or mail address goes to the system browser, anything else to nothing', () => {
    const { wc, handed } = installed();
    for (const url of ['https://example.org/', 'http://127.0.0.1:9/', 'mailto:a@example.org', 'file:///etc/passwd', 'javascript:alert(1)', 'rundock://x']) {
      assert.deepStrictEqual(wc.handlers.open({ url }), { action: 'deny' }, url);
    }
    assert.deepStrictEqual(handed, ['https://example.org/', 'http://127.0.0.1:9/', 'mailto:a@example.org']);
  });

  test('the window never navigates off the app\'s own origin, compared exactly', () => {
    const { handed, navigate } = installed();
    assert.strictEqual(navigate('http://localhost:3000/#x'), false, 'the app itself is allowed');
    for (const url of ['https://example.org/', 'http://localhost:3000@example.com/', 'http://localhost:30001/', 'file:///etc/passwd']) {
      assert.strictEqual(navigate(url), true, url);
    }
    assert.deepStrictEqual(handed, ['https://example.org/', 'http://localhost:3000@example.com/', 'http://localhost:30001/']);
  });
});
