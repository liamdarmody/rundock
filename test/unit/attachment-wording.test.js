'use strict';
// The words a person reads about an attachment: sizes in the units the limits
// use, and one title and one sentence for every refusal the server or the
// composer can give.

const { describe, test } = require('node:test');
const assert = require('node:assert');

const wording = (() => {
  try { return require('../../public/attachment-wording.js'); } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /attachment-wording/.test(String(e.message))) return null;
    throw e;
  }
})();

const has = (name) => assert.strictEqual(typeof (wording && wording[name]), 'function', `attachment-wording exports ${name}`);
const refusal = (code, fields) => Object.assign(new Error(code), { code }, fields);
const NOT_SENT = 'Message not sent';
const FALLBACK = { title: NOT_SENT, text: 'Rundock couldn\'t save the files. Your message and files are still here.' };

describe('formatSize: KB below a megabyte, MB from it, always rounded up', () => {
  for (const [bytes, shown] of [
    [1, '1 KB'], [1000, '1 KB'], [1001, '2 KB'], [999999, '1000 KB'],
    [1000000, '1 MB'], [1000001, '1.1 MB'], [1100000, '1.1 MB'],
    [3500000, '3.5 MB'], [3500001, '3.6 MB'], [9999999, '10 MB'],
    [10000000, '10 MB'], [10000001, '11 MB'], [20000001, '21 MB'], [28000001, '29 MB'],
  ]) {
    test(`${bytes} bytes is ${shown}`, () => {
      has('formatSize');
      assert.strictEqual(wording.formatSize(bytes), shown);
    });
  }
});

describe('refusalWording: a refusal about one file is titled with its name', () => {
  for (const [code, fields, text] of [
    ['pdf-bytes', { name: 'alpha.pdf', bytes: 14000000, limit: 10000000 }, 'This file is 14 MB; the limit is 10 MB per file'],
    ['text-bytes', { name: 'notes.txt', bytes: 1400000, limit: 1000000 }, 'This file is 1.4 MB; the limit is 1 MB per text file'],
    ['image-bytes', { name: 'Screen Shot.png', bytes: 4100000, limit: 3500000 }, 'This image is still 4.1 MB after scaling; the limit is 3.5 MB per image'],
    ['unsupported', { name: 'beta.zip' }, 'Rundock can attach images (PNG, JPEG, GIF, WebP), PDF, text, Markdown and CSV files'],
    ['heic', { name: 'Screen Shot.heic' }, 'Rundock can\'t attach HEIC photos. Save it as JPEG or PNG first.'],
  ]) {
    test(`${code} names ${fields.name}`, () => {
      has('refusalWording');
      assert.deepStrictEqual(wording.refusalWording(refusal(code, fields), 1), { title: fields.name, text });
    });
  }
});

describe('refusalWording: a refusal about the whole message', () => {
  test('too-many-files counts the files the message sent', () => {
    has('refusalWording');
    assert.deepStrictEqual(wording.refusalWording(refusal('too-many-files', { count: 7, limit: 5 }), 7),
      { title: '7 files not added', text: 'That would make 7 files; the limit is 5 per message' });
  });

  test('too-many-bytes gives the total, rounded up', () => {
    has('refusalWording');
    assert.deepStrictEqual(wording.refusalWording(refusal('too-many-bytes', { bytes: 23000000, limit: 20000000 }), 2),
      { title: '2 files not added', text: 'That would make 23 MB; the limit is 20 MB per message' });
  });

  test('the title of a too-many refusal is the file count given, not the count in the refusal', () => {
    has('refusalWording');
    assert.strictEqual(wording.refusalWording(refusal('too-many-files', { count: 6, limit: 5 }), 3).title, '3 files not added');
  });

  test('a too-many refusal of one named file is titled with its name, with the same text', () => {
    has('refusalWording');
    assert.deepStrictEqual(wording.refusalWording({ code: 'too-many-files', count: 6, limit: 5, name: 'a.txt' }, 1),
      { title: 'a.txt', text: 'That would make 6 files; the limit is 5 per message' });
    assert.deepStrictEqual(wording.refusalWording({ code: 'too-many-bytes', bytes: 21000000, limit: 20000000, name: 'alpha.pdf' }, 1),
      { title: 'alpha.pdf', text: 'That would make 21 MB; the limit is 20 MB per message' });
  });

  test('too-large gives the frame size, rounded up, against 28 MB', () => {
    has('refusalWording');
    assert.deepStrictEqual(wording.refusalWording({ code: 'too-large', bytes: 28000001 }, 2),
      { title: NOT_SENT, text: 'This message is too large to send (29 MB with its files; the limit is 28 MB). Remove a file or shorten the text.' });
  });

  test('codex-files, a code nothing sends any more, gives the fallback', () => {
    has('refusalWording');
    assert.deepStrictEqual(wording.refusalWording(refusal('codex-files'), 1), FALLBACK);
  });

  test('codex-pdf names the PDF and asks for a screenshot or the text', () => {
    has('refusalWording');
    assert.deepStrictEqual(wording.refusalWording(refusal('codex-pdf', { name: 'Incident-Report-22-Nov.pdf' }), 3),
      { title: 'Incident-Report-22-Nov.pdf', text: 'This agent runs on Codex, which can\'t read PDFs yet. Attach a screenshot of the page or paste the text.' });
  });

  test('codex-images gives what a Codex agent is sent in one conversation', () => {
    has('refusalWording');
    assert.deepStrictEqual(wording.refusalWording(refusal('codex-images'), 3),
      { title: NOT_SENT, text: 'This agent runs on Codex, and Rundock sends a Codex agent at most 20 images or 10 MB of images in one conversation. Remove an image or start a new conversation.' });
  });

  test('deleted says the conversation went in another window', () => {
    has('refusalWording');
    assert.deepStrictEqual(wording.refusalWording(refusal('deleted'), 1),
      { title: NOT_SENT, text: 'This conversation was deleted in another window.' });
  });

  test('disk-full names the file it could not save', () => {
    has('refusalWording');
    assert.deepStrictEqual(wording.refusalWording(refusal('disk-full', { name: 'Incident-Report-22-Nov.pdf' }), 3),
      { title: NOT_SENT, text: 'Rundock couldn\'t save Incident-Report-22-Nov.pdf because the disk is full. Your message and files are still here.' });
  });

  for (const code of ['save-failed', 'image-pixels', 'bad-id', 'bad-payload', 'bad-entry', 'no-such-code']) {
    test(`${code} gets the fallback`, () => {
      has('refusalWording');
      assert.deepStrictEqual(wording.refusalWording(refusal(code, { name: 'Screen Shot.png', width: 9000, height: 10, limit: 8000 }), 1), FALLBACK);
    });
  }

  test('a refusal with no code at all gets the fallback', () => {
    has('refusalWording');
    assert.deepStrictEqual(wording.refusalWording(new Error('boom'), 0), FALLBACK);
    assert.deepStrictEqual(wording.refusalWording(null, 0), FALLBACK);
  });
});
