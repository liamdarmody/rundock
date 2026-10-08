'use strict';
// ONE PLAIN SENTENCE FOR AN ERROR THE OPERATING SYSTEM RAISED.
//
// A failed file operation arrives from Node as its own words: on Windows,
// "EPERM, Permission denied: \\?\C:\..." in place of anything a person can
// act on. This module turns an error with a known system code into one
// sentence that says what Rundock was doing, why it failed, and what to try
// next, and keeps the raw code and message as the detail a "Details" control
// shows. The server calls it where it answers a request; the run detail calls
// it on a run record's stored reason. Same UMD pattern as pins-model.js.
//
// THE SENTENCE NEVER CARRIES A PATH. It is built only from the fixed words
// below and the action the caller names, so nothing from the error's message
// can reach it; the path stays in the detail.
//
// AN ERROR WITH NO SYSTEM CODE IS NOT RE-WORDED. Rundock's own refusals are
// already sentences, and a domain code such as 'empty-package' is how a client
// classifies a state, so `describe` returns null for both and `readable` keeps
// the caller's own words.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockReadableError = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // Each code: why it failed, as two clauses (the first when the operation
  // named its object, so "it" reads; the second when only the caller's action
  // is known), and what to try next.
  const NETWORK = {
    known: 'the connection failed', unknown: 'the connection failed',
    next: 'Check your internet connection, then try again.',
  };
  const CODES = {
    EPERM: {
      known: "your computer didn't allow it", unknown: "your computer didn't allow a change to a file",
      next: 'It may be open in another program, such as a sync app or virus scanner, or set to read-only. Close any program that might be using it, then try again.',
    },
    EACCES: {
      known: "Rundock doesn't have permission to use it", unknown: "Rundock doesn't have permission to use a file",
      next: 'Check that your account can change that folder, and close any program that has it open, then try again.',
    },
    EBUSY: {
      known: 'another program is using it', unknown: 'another program is using a file',
      next: 'Close the program that has it open, then try again.',
    },
    ENOENT: {
      known: "it couldn't be found", unknown: "a file or folder couldn't be found",
      next: "It may have been moved, renamed or deleted. Check it's still there, then try again.",
    },
    ENAMETOOLONG: {
      known: 'its location is too long for your computer', unknown: "a file's location is too long for your computer",
      next: 'Move the workspace to a folder nearer the top of your drive, or use shorter names, then try again.',
    },
    EXDEV: {
      known: "it can't be moved between two drives in one step", unknown: "a file can't be moved between two drives in one step",
      next: 'Move the workspace onto the same drive as your user folder, then try again.',
    },
    ENOSPC: {
      known: 'the drive is full', unknown: 'the drive is full',
      next: 'Free up some space on the drive, then try again.',
    },
    EROFS: {
      known: 'the drive is read-only', unknown: 'the drive is read-only',
      next: 'Choose a folder on a drive that can be changed, then try again.',
    },
    EEXIST: {
      known: 'something with that name already exists', unknown: 'something with that name already exists',
      next: 'Choose a different name, or move the existing one out of the way, then try again.',
    },
    ENOTEMPTY: {
      known: "it isn't empty", unknown: "a folder isn't empty",
      next: 'Close any program that is using that folder, then try again.',
    },
    EISDIR: {
      known: 'there is a folder where a file should be', unknown: 'there is a folder where a file should be',
      next: 'Rename or move that folder, or choose a different name, then try again.',
    },
    ENOTDIR: {
      known: 'part of its location is a file where a folder should be', unknown: 'part of a location is a file where a folder should be',
      next: 'Check the names of the folders it sits in, then try again.',
    },
    EMFILE: {
      known: 'too many files are open at once', unknown: 'too many files are open at once',
      next: 'Close some programs or restart Rundock, then try again.',
    },
    ETIMEDOUT: NETWORK, ECONNRESET: NETWORK, ECONNREFUSED: NETWORK, ENOTFOUND: NETWORK, EAI_AGAIN: NETWORK, ENETUNREACH: NETWORK,
  };
  CODES.ENFILE = CODES.EMFILE;

  // A program that could not be started is its own case: ENOENT there means
  // the program is missing, not a file the person was working on.
  const SPAWN_MISSING = {
    reason: "it isn't installed or couldn't be found",
    next: "Check that it's installed, then try again.",
  };

  const GENERIC = {
    known: 'something unexpected went wrong', unknown: 'something unexpected went wrong',
    next: 'Try again, and if it keeps happening, include the details when you report it.',
  };

  // The system calls whose operation is more precise than any caller's action.
  // A call missing here (open, read, write, stat) says nothing a save or an
  // install does not already say, so the caller's action is used instead.
  const OPERATIONS = {
    unlink: 'remove a file', rm: 'remove a file', rmdir: 'remove a folder',
    rename: 'move a file', copyfile: 'copy a file', cp: 'copy a file',
    mkdir: 'create a folder', scandir: 'read a folder', opendir: 'read a folder',
    symlink: 'create a link', link: 'create a link',
    spawn: 'start a program',
  };

  const DEFAULT_ACTION = 'finish that';

  // The system code an error carries, or null. A code on the error wins; a
  // non-system code (a domain code) means this is not a system error at all.
  // A wrapped error that lost its code is read from its cause, then from its
  // message, where only a code this module knows is accepted, so an ordinary
  // capitalised word is never mistaken for one.
  function codeOf(err) {
    if (err && typeof err === 'object') {
      if (typeof err.code === 'string' && err.code) return isSystemCode(err.code) ? err.code : null;
      if (err.cause && typeof err.cause.code === 'string' && isSystemCode(err.cause.code)) return err.cause.code;
    }
    const m = /(?:^|[^A-Z0-9_])(E[A-Z][A-Z0-9_]+)(?=$|[^A-Z0-9_])/.exec(messageOf(err));
    return m && Object.prototype.hasOwnProperty.call(CODES, m[1]) ? m[1] : null;
  }

  function isSystemCode(code) {
    // Node's own ERR_* codes are programming errors, not the system's.
    return (/^E[A-Z][A-Z0-9_]+$/.test(code) && !/^ERR_/.test(code)) || code === 'UNKNOWN';
  }

  function messageOf(err) {
    if (err == null) return '';
    if (typeof err === 'string') return err;
    if (typeof err.message === 'string') return err.message;
    return String(err);
  }

  // The system call, from the error or from Node's own message shapes:
  // "EPERM: operation not permitted, unlink '...'" and "spawn claude ENOENT".
  function syscallOf(err) {
    if (err && typeof err === 'object' && typeof err.syscall === 'string') return err.syscall.split(' ')[0];
    const text = messageOf(err);
    if (/(?:^|\s)spawn\s/.test(text)) return 'spawn';
    const m = /^E[A-Z0-9_]+: [^,]*, ([a-z]+)\b/.exec(text);
    return m ? m[1] : null;
  }

  // The raw words for Details: the message as Node wrote it, with the code in
  // front when the message does not already carry it.
  function detailOf(err, code) {
    const text = messageOf(err).trim();
    if (!text) return code;
    return text.indexOf(code) === -1 ? `${code}: ${text}` : text;
  }

  /**
   * The plain sentence and the raw detail for a system error, or null when
   * the error carries no system code.
   *
   * @param {unknown} err an Error, an error-shaped object, or a stored message
   * @param {{ action?: string }} [opts] what Rundock was doing, as a verb phrase
   *   that follows "Rundock couldn't", for example 'save this file'
   * @returns {{ message: string, detail: string, code: string } | null}
   */
  function describe(err, opts) {
    const code = codeOf(err);
    if (!code) return null;
    const syscall = syscallOf(err);
    const op = syscall && Object.prototype.hasOwnProperty.call(OPERATIONS, syscall) ? OPERATIONS[syscall] : null;
    const action = op || (opts && typeof opts.action === 'string' && opts.action.trim() ? opts.action.trim() : DEFAULT_ACTION);
    let reason;
    let next;
    if (syscall === 'spawn' && code === 'ENOENT') {
      reason = SPAWN_MISSING.reason; next = SPAWN_MISSING.next;
    } else {
      const words = Object.prototype.hasOwnProperty.call(CODES, code) ? CODES[code] : GENERIC;
      reason = op ? words.known : words.unknown; next = words.next;
    }
    return { message: `Rundock couldn't ${action} because ${reason}. ${next}`, detail: detailOf(err, code), code };
  }

  /**
   * Always an answer: the system error's sentence and detail, or, for any
   * other error, the caller's fallback (or the error's own message) with no
   * detail.
   *
   * @param {unknown} err
   * @param {{ action?: string, fallback?: string }} [opts]
   * @returns {{ message: string, detail: string | null }}
   */
  function readable(err, opts) {
    const described = describe(err, opts);
    if (described) return { message: described.message, detail: described.detail };
    const fallback = opts && typeof opts.fallback === 'string' ? opts.fallback : messageOf(err);
    return { message: fallback, detail: null };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * The "Details" control, in the disclosure the permission card already uses
   * (styles/views/chat.css), or '' when there is nothing to disclose.
   *
   * @param {string | null | undefined} detail
   * @returns {string}
   */
  function detailsHtml(detail) {
    if (typeof detail !== 'string' || !detail.trim()) return '';
    return `<details class="permission-detail-collapse error-details"><summary>Details</summary><code class="permission-detail">${escapeHtml(detail)}</code></details>`;
  }

  /**
   * The same control as an element, for a surface that writes text rather
   * than markup (the editor's status line, the workspace error), or null.
   *
   * @param {Document} doc
   * @param {string | null | undefined} detail
   * @returns {HTMLElement | null}
   */
  function detailsElement(doc, detail) {
    if (typeof detail !== 'string' || !detail.trim()) return null;
    const details = doc.createElement('details');
    details.className = 'permission-detail-collapse error-details';
    const summary = doc.createElement('summary');
    summary.textContent = 'Details';
    const code = doc.createElement('code');
    code.className = 'permission-detail';
    code.textContent = detail;
    details.appendChild(summary);
    details.appendChild(code);
    return details;
  }

  /**
   * Write a sentence and, when there is one, its Details into an element,
   * replacing what it held.
   *
   * @param {HTMLElement} el
   * @param {string} message
   * @param {string | null | undefined} detail
   */
  function showIn(el, message, detail) {
    el.textContent = message;
    const details = detailsElement(el.ownerDocument, detail);
    if (details) el.appendChild(details);
  }

  return { CODES, OPERATIONS, GENERIC, DEFAULT_ACTION, describe, readable, detailsHtml, detailsElement, showIn, codeOf, syscallOf };
}));
