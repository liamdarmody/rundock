'use strict';
// What one run's record says, turned into the words a reader sees. No DOM in
// this file, which is what makes every sentence below assertable line by line
// rather than reachable only by a browser.
//
// THE ONE DISTINCTION THIS FILE EXISTS TO PRESERVE.
//
// A run record answers two different questions about files with two different
// shapes. `filesStatus: 'known'` with `files: []` is a run that changed
// nothing. `filesStatus: 'unknown'` with `files: null` and a named reason is a
// run whose changes nobody can read. The writer went to real trouble to keep
// those apart, and it holds all the way to this file.
//
// This is the first thing that has ever consumed those records, and the
// collapse is one line: `record.files || []`. It type-checks, it reads as
// tidiness, and it turns "nobody could tell" into "it changed nothing"
// silently and for good. The interface would then tell a user their routine
// changed nothing when the truth is that nobody knows what it changed.
//
// The difference is not academic. A routine that changed nothing is a routine
// working normally. A routine whose changes are unknown is one where something
// is wrong with the observation, and the two demand opposite responses from
// somebody deciding whether to trust an unattended run or revert it.
//
// So `changedFiles` below is the ONLY road from a record to a file list, it
// takes `known` from the record's own claim rather than from a length, and it
// returns two shapes that cannot be mistaken for each other: the unknown one
// carries no `entries` key at all, so nothing downstream can count it.
//
// NO RAW STATUS WORD LEAVES THIS FILE.
//
// A record says `running`, `succeeded`, `failed` or `interrupted`. That is the
// run store's own vocabulary, chosen so the record and the routine state
// describe an abandoned run in one word rather than two, and it is not
// English. One of the four is actively misleading if printed: `interrupted` is
// written in exactly one place, by the startup close, for a record a dead
// process left open, and it means the ending never ran rather than that the
// run failed. The work may well have finished a moment before the machine went
// down. Naming an outcome nobody witnessed is the invention the record store
// refuses everywhere else, and it would be a poor place for this screen to
// start.
//
// So every word comes from a table keyed by the status, the table is TOTAL (a
// status this version has never seen still yields plain words), and nothing
// anywhere interpolates `record.status`.
//
// THE CLOCK IS A PARAMETER. Everything here takes `now` from its caller, so
// these words are the same at 23:59 as at noon and the same in London as in
// Auckland.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockRunDetailModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // ===== THE FOUR STATES, IN WORDS =====
  //
  // `chip` is the label beside the dot, `headline` the sentence under it, and
  // `tone` a CLASS NAME rather than a colour, for the reason the routines list
  // records at length: a colour table in a module that nothing renders can
  // agree with its tests forever while the stylesheet says something else.
  // Colour and weight live in public/styles/views/run-detail.css.
  //
  // EVERY PAIR DIFFERS ON WORDING AS WELL AS TONE. The pair that matters most
  // is `failed` against `interrupted`: one is a run that ran and did not get
  // through what it was asked to, the other is a run whose ending never
  // happened, and a reader who reads the second as the first will revert work
  // that may have completed perfectly.
  const RUN_STATES = {
    running: {
      tone: 'live',
      chip: 'Still going',
      headline: 'This run is still going.',
      guidance: 'Nothing about it is settled yet, including what it has changed.',
    },
    succeeded: {
      tone: 'ok',
      chip: 'Finished',
      headline: 'This run got to the end and did what it was asked to.',
      guidance: null,
    },
    failed: {
      tone: 'bad',
      chip: 'Stopped early',
      headline: 'This run started and did not get through what it was asked to.',
      guidance: null,
    },
    // NOT A FAILURE, and the words say so twice: the chip does not name an
    // outcome and the headline names the ending rather than the work. What is
    // being reported is an absence of evidence, not evidence of a problem.
    interrupted: {
      tone: 'unwitnessed',
      chip: 'No ending recorded',
      headline: 'Rundock closed while this run was under way, so the run never reached its ending.',
      guidance: 'Nothing recorded how it turned out. It may have got everything done a moment '
        + 'before Rundock closed, and it may not.',
    },
  };

  // A status this version has never been shown. Reached by a record written by
  // a newer Rundock, or by a record somebody hand-edited. Described rather
  // than printed, because printing it is the thing this file forbids and an
  // unrecognised word is the case where the temptation is strongest.
  const UNRECOGNISED_STATE = {
    tone: 'unwitnessed',
    chip: 'Not recognised',
    headline: 'This run\'s record carries an outcome this version of Rundock does not recognise.',
    guidance: 'Nothing here can say how it ended. Updating Rundock may let it read this record.',
  };

  // No record at all. Distinct from every state above, and in particular
  // distinct from a run that changed nothing: the absence of a record is not
  // the presence of an empty one.
  const NO_RECORD_STATE = {
    tone: 'unwitnessed',
    chip: 'Nothing on file',
    headline: 'There is no record of this run.',
    guidance: 'Rundock writes a record when a run starts, so a run with none either never '
      + 'started or its record has been removed.',
  };

  // Three of the four failure endings carry no reason: a child that ran and
  // exited non-zero leaves an exit code, and an exit code is not a message.
  // That is a fact about the ending rather than a gap in the record, and it
  // reads better said than left blank.
  const NO_REASON_GIVEN = 'It gave no reason. Nothing it printed was kept, so what went wrong '
    + 'is not recorded here.';

  // ===== WHY A FILE LIST CAN BE UNKNOWN, IN WORDS =====
  //
  // Nine codes. Six are the transcript reader's, 'running' is the scheduler's
  // own, and the last two come from the progress read. A code is a machine
  // identifier and no reader should ever meet one, so each has a sentence and
  // the lookup has a floor.
  const FILES_UNKNOWN_WORDS = {
    running: 'This run is still going, so what it has changed is not settled yet.',
    'no-session': 'This run opened no session of its own, so there is nothing that records '
      + 'which files it touched.',
    'no-transcript': 'The file that records what this run did is not on disk, so its changes '
      + 'cannot be read.',
    unreadable: 'The file that records what this run did could not be opened, so its changes '
      + 'cannot be read.',
    unrecognised: 'The file that records what this run did is in a shape Rundock does not '
      + 'understand, so its changes cannot be read.',
    unresolved: 'This run asked to change a file and never got an answer back, so whether the '
      + 'change happened is not recorded.',
    delegated: 'This run handed work to another agent, which keeps a record of its own, so the '
      + 'files it changed cannot be read from here.',
    'no-record': 'There is no record of this run, so nothing can say what it changed.',
    'no-activity': 'Nothing this run did has been recorded yet, so what it has changed cannot '
      + 'be read.',
  };

  const FILES_UNKNOWN_FALLBACK = 'Rundock cannot tell what this run changed, and the reason '
    + 'its record gives is one this version does not recognise.';

  // 'created' and 'edited' are the only two the reader writes, and telling
  // them apart is the difference between a file that did not exist before this
  // run and one that did.
  const CHANGE_LABELS = { created: 'Created', edited: 'Edited' };
  const CHANGE_FALLBACK = 'Changed';

  const FILES_LABELS = {
    // A run that stopped partway labels its list differently, because the list
    // is then a partial one and a reader deciding whether to revert needs to
    // know that before they read a line of it.
    complete: 'Files changed',
    partial: 'Files changed before it stopped',
  };

  const NO_FILES_CHANGED = 'This run changed no files.';
  const UNKNOWN_FILES_LEAD = 'Rundock cannot tell what this run changed.';

  /**
   * The file list, or the reason there is none.
   *
   * THE ONE ROAD FROM A RECORD TO A LIST, deliberately, so there is exactly
   * one place a default could be written and exactly one place to guard.
   *
   * Returns `{ known: true, entries, label }` or `{ known: false, reason }`.
   * The unknown shape carries NO `entries` key: a caller that reaches for one
   * gets `undefined` and fails loudly, rather than getting `[]` and rendering
   * a confident, wrong answer about a routine nobody could observe.
   */
  function changedFiles(record, stopped) {
    // KNOWN IS CLAIMED, NEVER INFERRED. Anything that is not the record's own
    // claim of 'known' is unknown, including a record with no filesStatus at
    // all, which is what a record from before the observation work looks like.
    if (!record || record.filesStatus !== 'known') {
      // NO RECORD NAMES ITSELF. Falling through to the catch-all here would
      // tell a reader the record gives a reason this version cannot read,
      // when the truth is there is no record to give one.
      return { known: false, lead: UNKNOWN_FILES_LEAD, reason: unknownWords(record ? record.filesReason : 'no-record') };
    }
    // A RECORD THAT CLAIMS TO KNOW AND CARRIES NO LIST IS UNKNOWN. The claim
    // and the list disagree, and there are only two ways to read a
    // disagreement: assume the list or assume the claim. Assuming the list
    // says "it changed nothing", which is the erasure this file exists to
    // prevent, arriving by a second door.
    if (!Array.isArray(record.files)) {
      return { known: false, lead: UNKNOWN_FILES_LEAD, reason: FILES_UNKNOWN_FALLBACK };
    }
    return {
      known: true,
      label: stopped ? FILES_LABELS.partial : FILES_LABELS.complete,
      empty: record.files.length === 0 ? NO_FILES_CHANGED : null,
      entries: record.files.map(entry => ({
        path: entry && typeof entry.path === 'string' ? entry.path : '',
        name: baseName(entry && entry.path),
        changeLabel: CHANGE_LABELS[entry && entry.change] || CHANGE_FALLBACK,
      })),
    };
  }

  /** The reason a list is unknown, as a sentence. Never the code itself. */
  function unknownWords(reason) {
    return FILES_UNKNOWN_WORDS[reason] || FILES_UNKNOWN_FALLBACK;
  }

  /**
   * The part of a path a reader recognises.
   *
   * Both separators, because a record is written on the machine that ran and
   * read on whichever one is open now.
   */
  function baseName(filePath) {
    if (typeof filePath !== 'string' || !filePath) return '';
    const parts = filePath.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : filePath;
  }

  /**
   * How long a run took, in words, or null where nothing knows.
   *
   * NULL FOR A RUN STILL GOING AND FOR ONE WHOSE ENDING NEVER RAN, because in
   * neither case does the record carry a duration. The startup close leaves it
   * null on purpose: stamping the moment an orphan was noticed would report a
   * run that died three days ago as one that took three days.
   */
  function durationWords(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return null;
    if (ms < 1000) return 'under a second';
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }

  /**
   * One run's record, as the words a reader sees.
   *
   * `now` is taken rather than read, so nothing here depends on the machine
   * the test runs on.
   */
  function describeRun(record, options) {
    const opts = options || {};
    const found = !!(record && typeof record === 'object' && typeof record.id === 'string');
    // THE STATE IS LOOKED UP, NEVER PASSED THROUGH. Three separate lookups,
    // each with its own floor, and no branch anywhere reads record.status into
    // a string.
    const state = !found
      ? NO_RECORD_STATE
      : (Object.prototype.hasOwnProperty.call(RUN_STATES, record.status) ? RUN_STATES[record.status] : UNRECOGNISED_STATE);
    // A run that did not get to the end has a partial list, which its label
    // has to say. Asked of the state rather than of the status word.
    const stopped = state === RUN_STATES.failed || state === RUN_STATES.interrupted;
    return {
      found,
      id: found ? record.id : null,
      agent: found ? (record.agent || null) : null,
      routine: found ? (record.routine || null) : null,
      startedAt: found ? (record.startedAt || null) : null,
      now: opts.now || null,
      state: {
        tone: state.tone,
        chip: state.chip,
        headline: state.headline,
        guidance: guidanceFor(state, found ? record : null),
      },
      duration: found ? durationWords(record.durationMs) : null,
      files: changedFiles(found ? record : null, stopped),
    };
  }

  /**
   * The sentence under the headline.
   *
   * A failure's own reason belongs here when it gave one, framed rather than
   * dumped: the record holds whatever message the ending was handed, and that
   * message is the whole of what anybody has to go on.
   */
  function guidanceFor(state, record) {
    if (state !== RUN_STATES.failed) return state.guidance;
    const reason = record && typeof record.error === 'string' && record.error.trim() ? record.error.trim() : null;
    return reason ? `The reason it gave: ${reason}` : NO_REASON_GIVEN;
  }

  return {
    RUN_STATES, UNRECOGNISED_STATE, NO_RECORD_STATE, FILES_UNKNOWN_WORDS, FILES_UNKNOWN_FALLBACK,
    CHANGE_LABELS, FILES_LABELS, NO_FILES_CHANGED, UNKNOWN_FILES_LEAD, NO_REASON_GIVEN,
    changedFiles, unknownWords, durationWords, describeRun, baseName,
  };
}));
