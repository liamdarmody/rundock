#!/usr/bin/env node

/**
 * Release script for Rundock (tag-and-let-CI-build model).
 *
 * A release is one pull request and four commands, and the gaps between them
 * are the point. See docs/RELEASING.md for the full order.
 *
 *   npm run release -- bump <version>       # version + promoted changelog, committed with the candidate
 *   ...push the candidate, open its pull request, let CI finish on it...
 *   npm run release:gate                    # what CI cannot do, on the candidate's exact tree
 *   ...write the release summary; where it flags a hands-on check, try the candidate from source...
 *   npm run release -- signoff <version> --confirm <version>   # sign off this tree, yourself
 *       (or, given in chat: the agent adds --on-instruction - and passes the words on stdin)
 *   ...merge that pull request...
 *   npm run release -- tag <version>        # tag the merged commit, here only; it prints the push
 *   git push origin v<version>              # push the tag, as its own bare command, which starts the build
 *   ...watch the build, review the draft it publishes...
 *   npm run release -- publish <version> --confirm <version>   # publish the reviewed draft
 *
 * WHICH CHECKS COME FROM CI. The suite on Node 22 and 24, coverage with its
 * floors, the browser suite (E2E), typecheck and hygiene are required checks on
 * the pull request. The gate does not run them again: it reads their results
 * for the exact tree it gates and refuses, naming the check, unless each
 * passed there. It runs only what CI cannot (scripts/release-gate.js).
 *
 * ONE PULL REQUEST. The candidate carries its version bump and promoted
 * changelog, so the commit that merges is the content the gate passed. The
 * gate record names a TREE, and `tag` accepts it when the merged commit has
 * that tree: a merge that makes a new commit with identical content needs no
 * second gate, and any difference is refused. The record, like the sign-off,
 * is kept in git's common directory, so a gate run in the release worktree is
 * seen by the checkout of main that tags.
 *
 * A RECUT of an unpublished draft is: delete the draft release, delete the tag
 * locally and on the remote, merge the fix, run the gate on main, sign the
 * new tree off, tag again and push the tag.
 * Once the tag is gone the version on main is one release past the latest tag
 * again, which is all the gate asks.
 *
 * WHY IT IS NOT ONE COMMAND. main requires status checks with admin
 * enforcement, so nothing pushes to it directly, and merging the pull request
 * is a reviewed step of its own (docs/RELEASING.md says who merges).
 *
 * Pushing the tag starts something that cannot be un-started: the GitHub
 * Actions workflow that builds, signs, notarizes, and publishes a DRAFT
 * release. Building does not happen on your laptop, and no Apple or signing
 * credentials are needed locally: those live in the CI environment. But CI
 * never makes anything public. It produces a DRAFT and stops there.
 *
 * `tag` DOES NOT PUSH. It creates the tag here, prints the push as one bare
 * command, and stops. It used to push the tag itself, and under a sandbox
 * that push has no credential: it failed, the tag was removed again, and an
 * earlier version logged "pushed" when the push had been held back. The push
 * is run as its own command, with nothing before or after it, where the
 * credential is.
 *
 * `publish` is the step that matters most, and CI never runs it. Only a
 * person decides a specific version is ready for everyone, and `publish`
 * runs on that decision, at a terminal or on an instruction given in chat to
 * the agent that runs it, with --confirm naming that exact version (see
 * hasPublishConfirmation). This was not always enforced: on 2026-08-27 an
 * agent ran `publish` unprompted, straight after fixing unrelated build
 * bugs, because nothing but a naming convention separated it from `tag`.
 * See Ratchet-Log "A split command is not a control", 2026-08-27.
 *
 * Recovery: if the CI build fails (e.g. an expired Apple agreement), fix the
 * cause and re-run the workflow on the same tag (gh run rerun, or the Actions
 * UI). There is no need to revert main: the bump and the tag stay, and the
 * draft is still there to publish once CI passes.
 *
 * Update the Rundock Site download links once the release is published.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const { LEGACY_GATE_FILE_NAME, findGateRecord } = require('./release-gate.js');

const ROOT = path.join(__dirname, '..');
const REPO = 'liamdarmody/rundock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A step's line, or, with no step, a bare line: a command printed to be
// copied as it stands, with nothing in front of it.
function logStep(step, msg) {
  console.log(step ? `[release:${step}] ${msg}` : msg);
}

function fail(step, msg) {
  console.error(`[release:${step}] ERROR: ${msg}`);
  process.exit(1);
}

// A git runner bound to one repository. Every step takes its runner as an
// option so the release flow can be exercised end to end against a throwaway
// repository in a temp directory rather than against this checkout.
function gitIn(root) {
  return (args, opts = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', ...opts });
}

const git = gitIn(ROOT);

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

// Must be on main, with a fully clean tree, in sync with origin. Runs BEFORE
// anything is created so a failed pre-flight leaves nothing behind. Whether
// the tag already exists is judged by tagRelease, which knows the commit it
// would go on. Throws so it is unit-testable; the main flow converts to
// fail().
function preflight(version, { root = ROOT, git = gitIn(root) } = {}) {
  let branch;
  try {
    branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { stdio: 'pipe' }).trim();
  } catch (err) {
    // A DETACHED HEAD is on no branch at all, which git reports, quietly, as
    // exit status 1; every other failure is 128 and keeps its own words. Said
    // in plain words, because the raw "fatal: ref HEAD is not a symbolic ref"
    // names neither the cause nor the fix, and the fix is always the same: a
    // release is tagged from main.
    if (err.status === 1) {
      let at = '';
      try { at = ` at ${git(['rev-parse', '--short', 'HEAD'], { stdio: 'pipe' }).trim()}`; } catch { /* no commit to name */ }
      throw new Error(
        `HEAD is detached${at}: this checkout is on no branch, and a release is tagged from main. ` +
        'Switch to main ("git switch main") and run this again. Nothing has been tagged.'
      );
    }
    throw new Error(`Could not determine current branch: ${err.message}`);
  }
  if (branch !== 'main') {
    throw new Error(`Must be on main to release (currently on "${branch}").`);
  }

  const status = git(['status', '--porcelain']).trim();
  if (status) {
    throw new Error(`Working tree is not clean. Commit or stash changes before releasing:\n${status}`);
  }

  try {
    git(['fetch', 'origin', 'main'], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`git fetch origin main failed: ${err.message}`);
  }
  const behind = git(['rev-list', '--count', 'HEAD..origin/main']).trim();
  if (parseInt(behind, 10) > 0) {
    throw new Error(`Local main is ${behind} commit(s) behind origin/main. Pull before releasing.`);
  }
}

// The tag refuses to move without a gate pass on the exact tree being tagged.
// The gate record is written only by a fully green `npm run release:gate` on a
// clean tree, in git's common directory, so a pass made in the release
// worktree is read from the checkout of main that tags. It names the TREE it
// passed on, so a merge that makes a new commit with identical content is
// accepted and any difference at all is refused. A record gated without live
// smoke, or without reading CI's results, is refused too.
//
// For one release, a record the gate left in the folder it ran in, before it
// kept its record in the common directory, is read as well, from any worktree
// of the repository: it is judged by the same rules, and every refusal of one
// names the file, so a stale copy is found rather than guessed at. Throws so
// it is unit-testable; the main flow converts to fail().
function requireGatePass(headTree, { root = ROOT, git = gitIn(root), log = logStep } = {}) {
  const found = findGateRecord(headTree, { root, git });
  const record = found.record;
  if (!record) {
    throw new Error(
      `No release gate pass found: ${found.file || 'the gate record'} is missing or unreadable, and no worktree ` +
      `holds one at the old location (${LEGACY_GATE_FILE_NAME}). ` +
      `Run "npm run release:gate" on this candidate first; the tag refuses to move without it.`
    );
  }
  const where = found.legacy ? ` (the record read is ${found.file}, at the old location)` : '';
  if (!record.tree) {
    throw new Error(
      `The gate record names no tree (it was written by an older gate, keyed by commit)${where}. ` +
      `Re-run "npm run release:gate" on the candidate.`
    );
  }
  if (record.tree !== headTree) {
    throw new Error(
      `The release gate passed on tree ${record.tree.slice(0, 12)} but the commit being tagged has tree ${headTree.slice(0, 12)}${where}. ` +
      `Any change to the content invalidates the gate. Re-run "npm run release:gate" on what is being tagged.`
    );
  }
  if (!record.live) {
    throw new Error(
      `The gate on tree ${record.tree.slice(0, 12)} ran without live smoke (--no-live)${where}. ` +
      `Releases require the full gate: re-run "npm run release:gate" without flags.`
    );
  }
  if (!record.ci || record.ci.skipped || !record.ci.checks) {
    throw new Error(
      `The gate on tree ${record.tree.slice(0, 12)} did not read CI's results (--no-ci)${where}. ` +
      `Releases require them: re-run "npm run release:gate" without flags.`
    );
  }
  if (found.legacy) {
    log('tag', `Read the gate pass from ${found.file}, where the gate kept its record before it moved to git's common directory`);
  }
}

// ---------------------------------------------------------------------------
// Sign-off subcommand: the hands-on check from source, recorded by tree
// ---------------------------------------------------------------------------

// Before the cut, where the release summary calls for it, Rundock is started
// from the release branch and a short test list tried in the browser. That is
// the step that found both blockers of the first 0.15.1 cut, which every gate
// had passed because their tests reached the store and not the handler.
// `signoff` records that the tree was signed off, against that tree, and
// `tag` refuses any other.
//
// The record lives in git's common directory, so a sign-off made in a
// worktree on the release branch is seen by the checkout that tags main, and
// it can never be committed. It holds how the sign-off was given, the tree,
// the version and the time, with the optional note typed at the terminal or
// the words of an instruction given in chat, and nothing else.
//
// AT A TERMINAL, three things stand between an agent and a sign-off:
// --confirm must name the version (as publish's does); the command refuses
// inside an agent session (Claude Code sets CLAUDECODE for every command it
// runs); and the note is read from the controlling terminal, not from stdin
// or argv, so nothing can be piped into it and a shell without a terminal,
// which is what an agent's tool runs in, is refused. Copying a printed
// command satisfies none of these.
//
// IN CHAT, the sign-off is given to an agent, which records it with
// --on-instruction carrying the words verbatim: on stdin with `-`, which is
// the form printed and documented because nothing in the words passes
// through the shell, or inline as the next argument. That lifts the session and
// terminal refusals and nothing else: --confirm, the clean tree and the
// version are checked as before, and the record says `given: "chat"` with the
// words beside the tree. It is an audit trail, not proof of who typed the
// words: on one machine under one identity, nothing here can tell a person's
// instruction from an agent's own. Publishing is already run that way, on an
// instruction in chat with --confirm, and the two steps are kept alike. The
// words stay in the local record: nothing prints them, and the tag, its build
// and the release notes never carry them.
//
// Writing the file by hand is forgery, and is the one thing this cannot stop:
// like the gate record, it is a friction boundary, not a security one.
const SIGNOFF_FILE_NAME = 'rundock-release-signoff.json';

// How each kind of sign-off is named in what the release prints.
const SIGNED_OFF = { chat: 'signed off in chat on instruction', terminal: 'signed off in the terminal' };

function signoffPath({ root = ROOT, git = gitIn(root) } = {}) {
  return path.resolve(root, git(['rev-parse', '--git-common-dir']).trim(), SIGNOFF_FILE_NAME);
}

function readSignoff(opts = {}) {
  try { return JSON.parse(fs.readFileSync(signoffPath(opts), 'utf8')); } catch { return null; }
}

// One line read from the controlling terminal, synchronously. Throws when
// there is none (ENXIO), which is the case for every agent's shell.
function askAtTerminal(prompt, { open = () => fs.openSync('/dev/tty', 'r+') } = {}) {
  const fd = open();
  try {
    fs.writeSync(fd, prompt);
    const buf = Buffer.alloc(1);
    const bytes = [];
    while (fs.readSync(fd, buf, 0, 1, null) === 1 && buf[0] !== 10) bytes.push(buf[0]);
    return Buffer.from(bytes).toString('utf8').trim();
  } finally {
    fs.closeSync(fd);
  }
}

// Whether words hold anything a reader could see: not only whitespace,
// control and format characters (zero-width spaces and joiners, a byte-order
// mark).
function hasVisibleWords(words) {
  return typeof words === 'string' && words.replace(/[\s\p{Cc}\p{Cf}]/gu, '') !== '';
}

// The way every sign-off refusal prints to give the words of a chat
// sign-off: on stdin, through a here-document whose quoted delimiter keeps
// the shell from expanding anything in them. The delimiter is one nobody
// types, because a line of the words that matched it would end the
// here-document early, cut the record short and run the rest as commands.
// It starts on a line of its own, so its closing line is still at the start
// of a line when copied.
const WORDS_DELIMITER = 'END_OF_SIGNOFF_WORDS';
const THEIR_WORDS = '<their words>';
function onInstructionForm(command) {
  return `${command} --on-instruction - <<'${WORDS_DELIMITER}'\n${THEIR_WORDS}\n${WORDS_DELIMITER}`;
}

// Whether the words are the printed placeholder and nothing else: a refusal
// copied without being filled in, which would record a sign-off nobody gave.
function isPlaceholder(words) {
  return typeof words === 'string' && words.replace(/^[\s\p{Cc}\p{Cf}]+|[\s\p{Cc}\p{Cf}]+$/gu, '') === THEIR_WORDS;
}

// The words of a sign-off given in chat, or null when --on-instruction is
// absent. `-` reads them from stdin, all of it less the one newline a
// here-document ends with; anything else after the flag is the words, inline.
// A read lasts until the input ends, so it is refused when stdin is a
// terminal, where it would wait silently for Ctrl-D, and announced on its own
// line otherwise, so a pipe that never closes is visibly what is waited on.
// Every form that could record something other than the words given is
// refused, naming the form to use: an "=" form, the flag twice, inline words
// that begin with "--" (they read as the next flag), and words with nothing
// visible in them. A refusal never repeats the words.
function instructionFrom(argv, stdin, form) {
  if (argv.some((a) => a.startsWith('--on-instruction='))) {
    throw new Error(`--on-instruction takes its words as the next argument, or on stdin as "-", never after "=":\n${form}`);
  }
  const at = argv.flatMap((a, i) => (a === '--on-instruction' ? [i] : []));
  if (!at.length) return null;
  if (at.length > 1) {
    throw new Error(`--on-instruction is given ${at.length} times, and a sign-off records one instruction:\n${form}`);
  }
  let words = argv[at[0] + 1];
  if (words === '-') {
    if (stdin.isTerminal()) {
      throw new Error(`--on-instruction - reads the words until the input ends, and stdin here is a terminal, so it would wait for Ctrl-D. Give the words through the here-document:\n${form}`);
    }
    stdin.notice('Reading the sign-off words from stdin until the input ends');
    try {
      words = stdin.read().replace(/\n$/, '');
    } catch (err) {
      throw new Error(`The words could not be read from stdin (${err.code || err.message}):\n${form}`);
    }
  } else if (typeof words === 'string' && words.startsWith('--')) {
    throw new Error(`--on-instruction is followed by something that begins with "--", which reads as the next flag: inline words cannot begin with "--". Give them on stdin:\n${form}`);
  }
  if (!hasVisibleWords(words)) {
    throw new Error(`--on-instruction needs the words the sign-off was given in, verbatim, and has none with anything visible in them:\n${form}`);
  }
  if (isPlaceholder(words)) {
    throw new Error(`--on-instruction holds the placeholder, not the words given: put the words the sign-off was given in, verbatim, where ${THEIR_WORDS} stands:\n${form}`);
  }
  return words;
}

function signoffRelease(version, {
  root = ROOT, git = gitIn(root), argv = process.argv, env = process.env, ask = askAtTerminal, now = () => new Date(), log = logStep,
  readStdin = () => fs.readFileSync(0, 'utf8'), stdinIsTerminal = () => require('tty').isatty(0),
  notice = (line) => console.error(`[release:signoff] ${line}`),
} = {}) {
  const command = `npm run release -- signoff ${version} --confirm ${version}`;
  if (!hasConfirmation(argv, version)) {
    throw new Error(`A sign-off needs --confirm naming the version being signed off:\n    ${command}`);
  }
  const form = onInstructionForm(command);
  const instruction = instructionFrom(argv, { read: readStdin, isTerminal: stdinIsTerminal, notice }, form);
  const givenInChat = `If it was given to you in chat, record it with the words verbatim, on stdin:\n${form}`;
  if (instruction === null && env.CLAUDECODE) {
    throw new Error(`This is running inside an agent session. The hands-on check is yours: run the sign-off yourself, at a terminal.\n${givenInChat}`);
  }
  if (git(['status', '--porcelain']).trim()) {
    throw new Error('The working tree is not clean, so what you tried is not a committed tree. Commit or stash, try it again, then sign off.');
  }
  const pkg = JSON.parse(git(['show', 'HEAD:package.json']));
  if (pkg.version !== version) {
    throw new Error(`This checkout is ${pkg.version}, not ${version}. Sign off on the release candidate, which carries the bump.`);
  }
  const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
  let record;
  if (instruction !== null) {
    record = { given: 'chat', instruction, tree, version, signedAt: now().toISOString() };
  } else {
    let note;
    try {
      note = ask(`Tried ${version} from source on tree ${tree.slice(0, 12)}. Note (optional, Enter to record): `);
    } catch (err) {
      throw new Error(`A sign-off is typed at a terminal, and this has none (${err.code || err.message}). Run it yourself, at a terminal.\n${givenInChat}`);
    }
    record = { given: 'terminal', tree, version, signedAt: now().toISOString(), ...(note ? { note } : {}) };
  }
  fs.writeFileSync(signoffPath({ root, git }), JSON.stringify(record, null, 2) + '\n');
  // What was recorded, never the words, and no claim of a hands-on check.
  log('signoff', record.given === 'chat'
    ? `Recorded a sign-off given in chat for ${version} on tree ${tree.slice(0, 12)}`
    : `Recorded a sign-off typed at the terminal for ${version} on tree ${tree.slice(0, 12)}`);
  return record;
}

// How a recorded sign-off was given. A record from before sign-offs said so
// was typed at the terminal. A chat sign-off without its words, or any other
// kind, is not one signoffRelease writes, and is null.
function signoffKind(record) {
  if (record.given === undefined || record.given === 'terminal') return 'terminal';
  if (record.given === 'chat' && hasVisibleWords(record.instruction) && !isPlaceholder(record.instruction)) return 'chat';
  return null;
}

// The tag refuses without a sign-off for exactly the tree it tags, of either
// kind, and returns the kind. A fix after the sign-off changes the tree, so
// it needs signing off again. Both refusals name the chat kind in words and
// never print a ready command for it: one is recorded only when a sign-off
// was actually given.
function requireSignoff(headTree, version, opts = {}) {
  const signoff = readSignoff(opts);
  const command = `npm run release -- signoff ${version} --confirm ${version}`;
  if (!signoff) {
    throw new Error(
      `No sign-off found for tree ${headTree.slice(0, 12)}. A sign-off records the hands-on check of the tree being tagged: ` +
      `where the release summary calls for one, start Rundock from the release branch and try the test list in the browser. ` +
      `Then sign it off at a terminal: ${command}\n` +
      'A sign-off given in chat is recorded by the agent it was given to, with --on-instruction and the words verbatim, ' +
      'and only when it was actually given.'
    );
  }
  if (signoff.tree !== headTree) {
    throw new Error(
      `This release was signed off on tree ${String(signoff.tree).slice(0, 12)} but the commit being tagged has tree ${headTree.slice(0, 12)}: ` +
      `something changed after the sign-off. Sign this tree off again, at a terminal (${command}) or, when it is given in chat, ` +
      'with --on-instruction, and do the hands-on check again where the release summary calls for one.'
    );
  }
  const kind = signoffKind(signoff);
  if (!kind) {
    throw new Error(
      `The sign-off for tree ${headTree.slice(0, 12)} is not one this command writes: it is given in the terminal, ` +
      `or in chat with the words it was given in. Sign off again: ${command}`
    );
  }
  return kind;
}

// ---------------------------------------------------------------------------
// Publish subcommand
// ---------------------------------------------------------------------------

// Default GitHub API transport via the gh CLI. `api(method, path, body)`.
// The gh argument list for one API call. Split out from ghApi so the encoding
// can be tested without a network call: the bug this exists to prevent was in
// the encoding, and the publish tests inject a fake transport, so nothing ever
// exercised the real arguments.
function ghApiArgs(method, apiPath, body) {
  const args = ['api', '-X', method, apiPath];
  if (body) {
    for (const [key, value] of Object.entries(body)) {
      // Strings go through -f, everything else through -F.
      //
      // -F preserves JSON types, which is what booleans need: draft=false has
      // to arrive as a boolean, not as the word "false". But -F with a
      // JSON.stringify'd STRING sends the quote marks as part of the value, so
      // tag_name arrived as "v0.11.7" WITH quotes and the tag binding silently
      // became garbage. Caught publishing 0.11.7 by the verification below,
      // which is the only reason it did not ship that way.
      if (typeof value === 'string') args.push('-f', `${key}=${value}`);
      else args.push('-F', `${key}=${JSON.stringify(value)}`);
    }
  }
  return args;
}

function ghApi(method, apiPath, body) {
  const out = execFileSync('gh', ghApiArgs(method, apiPath, body), { cwd: ROOT, encoding: 'utf8' });
  return out ? JSON.parse(out) : {};
}

// THE NOTES AND THE BUILD MUST DESCRIBE THE SAME WORK.
//
// Publishing binds a tag to a draft and flips a flag. Nothing in it asked
// whether the draft was built from anything current, so a tag cut days earlier,
// with a build to match, published happily under release notes written from a
// main that had moved a long way past it. That is the worst shape a release
// failure takes: every check green, the notes accurate about the work, and the
// binary missing all of it, so the notes read as a lie rather than an oversight.
// Caught once by hand, two days and seven merges after the tag was cut.
//
// COMPARED BY CHANGELOG SECTION, NOT BY COMMIT. A tag is legitimately behind
// main by the time anyone publishes, because main moves on, so "the tag must be
// main" or "no more than N commits behind" would refuse healthy releases and
// teach people to pass a force flag. What must NOT differ is this version's
// changelog section: the flow promotes it, merges, tags, builds, publishes, and
// nothing in that order rewrites the section after the tag. If it differs, one
// of the two is stale, and which one hardly matters: either the notes promise
// what the build lacks, or the build carries what the notes do not mention.
//
// Read through git rather than the API because publish is always run from a
// clone, and a local read cannot be fooled by a stale API cache. Injected for
// tests, like every other seam in this file.
function requireNotesMatchBuild(version, { root = ROOT, git = gitIn(root), log = logStep } = {}) {
  const tag = `v${version}`;
  try {
    git(['fetch', 'origin', 'main', '--tags'], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Could not fetch origin before publishing: ${err.message}`);
  }

  let atTag;
  try {
    atTag = git(['show', `${tag}:CHANGELOG.md`]);
  } catch (err) {
    throw new Error(`Could not read CHANGELOG.md at ${tag}: ${err.message}. Does the tag exist?`);
  }
  const atMain = git(['show', 'origin/main:CHANGELOG.md']);

  const tagged = extractChangelogEntry(version, atTag);
  const current = extractChangelogEntry(version, atMain);
  if (!tagged) {
    throw new Error(
      `CHANGELOG.md at ${tag} has no "## ${version}:" section, so the build carries no notes for this release. ` +
      `The tag was cut before the changelog was promoted.`
    );
  }
  if (!current) {
    throw new Error(`CHANGELOG.md at origin/main has no "## ${version}:" section, so there are no notes to publish.`);
  }

  if (tagged.title !== current.title || tagged.body !== current.body) {
    const taggedSha = git(['rev-parse', `${tag}^{commit}`]).trim().slice(0, 9);
    const mainSha = git(['rev-parse', 'origin/main']).trim().slice(0, 9);
    const behind = git(['rev-list', '--count', `${tag}..origin/main`]).trim();
    throw new Error(
      `The notes for ${version} differ between ${tag} (${taggedSha}) and origin/main (${mainSha}), ` +
      `which is ${behind} commit(s) ahead of the tag.\n` +
      `The build was made from the tag and the notes are published from it, so publishing now would ` +
      `describe work the build may not contain.\n` +
      `Recut deliberately: delete the draft release, delete the tag locally and on the remote, then ` +
      `"npm run release -- tag ${version}" to tag current main, and push the tag it prints, which rebuilds.`
    );
  }
  log('publish', `Notes at ${tag} match origin/main, so the build and its notes describe the same work`);
}

// Publish the draft release for `version`, binding the tag BEFORE flipping
// the draft flag. The 0.11.6 lesson mechanised: after a recut deletes a tag,
// the draft's tag_name falls back to `untagged-*`, and publishing in that
// state binds the release to the junk tag permanently. Order is the fix:
// PATCH tag_name, VERIFY it stuck, only then PATCH draft=false.
function publishRelease(version, { api = ghApi, log = (msg) => console.log(`[release:publish] ${msg}`), checkNotes = requireNotesMatchBuild } = {}) {
  const tag = `v${version}`;
  // Before anything is bound or flipped: the draft has to have been built from
  // the work these notes describe. Nothing downstream can undo a publish.
  checkNotes(version);
  const releases = api('GET', `repos/${REPO}/releases`);
  const draft = (releases || []).find(r => r.draft && (
    r.tag_name === tag || (r.name && r.name.startsWith(`${version}:`))
  ));
  if (!draft) {
    throw new Error(
      `No draft release found for ${version} (looked for tag_name ${tag} or a name starting "${version}:"). ` +
      `Has the CI build finished and produced its draft?`
    );
  }

  log(`Found draft ${draft.id} "${draft.name}" (tag_name currently "${draft.tag_name}")`);
  const bound = api('PATCH', `repos/${REPO}/releases/${draft.id}`, { tag_name: tag });
  if (!bound || bound.tag_name !== tag) {
    throw new Error(
      `Binding the tag failed: asked for tag_name ${tag}, release reports "${bound && bound.tag_name}". ` +
      `Draft left untouched (still a draft); nothing was published.`
    );
  }
  log(`Tag bound: ${tag}`);

  const published = api('PATCH', `repos/${REPO}/releases/${draft.id}`, { draft: false });
  log(`Published: ${published.html_url || `release ${draft.id}`}`);
  return { id: draft.id, tag, url: published.html_url };
}

// Reads --confirm <version> from argv and checks it names the exact version
// being published. This is a friction boundary, not a security one: anyone
// who can run this script can also type the flag. Its purpose is that the
// command tag prints for its own next step deliberately does not include a
// working --confirm, so publish can never be run by copying the previous
// step's own output. See Ratchet-Log "A split command is not a control",
// 2026-08-27: publish and tag were already separate commands specifically
// so a person decides when the last one runs (at a terminal, or by an
// instruction in chat to the agent that runs it), and nothing but that naming
// convention stopped an agent running it unprompted mid-task. A stale
// confirmation for a different version does not satisfy this, so an old
// command cannot be reused for a new release by habit.
function hasConfirmation(argv, version) {
  const i = argv.indexOf('--confirm');
  return i !== -1 && argv[i + 1] === version;
}
const hasPublishConfirmation = hasConfirmation;

function setVersion(version, { root = ROOT, log = logStep } = {}) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log('version', `Set version to ${version}`);
}

// Extract the title line and body of a specific version from CHANGELOG.md.
// Pass `changelogText` to parse supplied content (used by tests and by
// scripts/release-notes.js); omit it to read the repository's CHANGELOG.md.
function extractChangelogEntry(version, changelogText) {
  let text = changelogText;
  if (typeof text !== 'string') {
    const changelogPath = path.join(ROOT, 'CHANGELOG.md');
    if (!fs.existsSync(changelogPath)) return null;
    text = fs.readFileSync(changelogPath, 'utf8');
  }
  const lines = text.split('\n');
  const matchesHeading = (line) => {
    if (version === 'Unreleased') return /^## Unreleased\s*$/.test(line);
    return line.startsWith(`## ${version}:`);
  };
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (matchesHeading(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;
  const title = lines[start].replace(/^## /, '').trim();
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join('\n')
    .replace(/^---\s*$/gm, '')
    .trim();
  return { title, body };
}

// Promote the `## Unreleased` heading to the versioned heading for this release.
// If `## ${version}:` already exists, no-op. If neither exists, abort: we must
// not release without notes. The release name is read from a `**Name:**` line.
// Returns the versioned heading it wrote, or the one already present, so the
// caller can quote it without re-parsing the file. Throws so it is
// unit-testable; the main flow converts to fail().
function promoteUnreleasedChangelog(version, { root = ROOT, log = logStep } = {}) {
  const changelogPath = path.join(root, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    throw new Error(`CHANGELOG.md not found at ${changelogPath}`);
  }
  const original = fs.readFileSync(changelogPath, 'utf8');

  const versionHeadingRe = new RegExp(`^## ${version.replace(/\./g, '\\.')}:.*$`, 'm');
  const alreadyPromoted = original.match(versionHeadingRe);
  if (alreadyPromoted) {
    log('changelog', `Versioned heading for ${version} already present, skipping promotion`);
    return alreadyPromoted[0];
  }

  const unreleasedRe = /^## Unreleased[ \t]*$/m;
  if (!unreleasedRe.test(original)) {
    throw new Error(
      `No "## Unreleased" block and no "## ${version}:" block in CHANGELOG.md. ` +
      `Add release notes under "## Unreleased" before running release.`
    );
  }

  // Parse the block we already have in memory rather than re-reading the file,
  // which is what makes this work against any root, not only this checkout.
  const entry = extractChangelogEntry('Unreleased', original);
  const nameMatch = entry && entry.body.match(/^\s*\*\*Name:\*\*\s*(.+?)\s*$/m);
  let name;
  if (nameMatch) {
    name = nameMatch[1];
  } else {
    log('changelog', 'WARNING: No "**Name:**" line in Unreleased body, falling back to "Release"');
    name = 'Release';
  }

  const today = new Date().toISOString().slice(0, 10);
  const newHeading = `## ${version}: ${name} (${today})`;
  let updated = original.replace(unreleasedRe, newHeading);
  updated = updated.replace(/^[ \t]*\*\*Name:\*\*[ \t]*.+?[ \t]*$\n?/m, '');
  updated = updated.replace(/\n{3,}/g, '\n\n');

  fs.writeFileSync(changelogPath, updated, 'utf8');
  log('changelog', `Promoted "## Unreleased" to "${newHeading}"`);
  return newHeading;
}

// ---------------------------------------------------------------------------
// Bump subcommand
// ---------------------------------------------------------------------------

// The candidate carries its own version: this writes the bump and promotes the
// changelog in the working tree, for the release engineer to commit with the
// candidate. It runs no git and touches nothing else, so a mistake is an edit
// to discard. Throws so it is unit-testable; the main flow converts to fail().
function bumpRelease(version, { root = ROOT, log = logStep } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    throw new Error(`"${version}" is not plain semver MAJOR.MINOR.PATCH.`);
  }
  const heading = promoteUnreleasedChangelog(version, { root, log });
  setVersion(version, { root, log });
  return { heading };
}

// ---------------------------------------------------------------------------
// Tag subcommand
// ---------------------------------------------------------------------------

// Run after the release pull request has been reviewed and merged. It cannot
// assume the merge landed just because it was asked to run, so it reads the
// state of `origin/main` and refuses unless the release commit is actually
// there. Pushing the tag is the irreversible half of a release: the pushed
// tag is what starts the build, sign, notarize and draft publish workflow.
//
// THE GATE IS CHECKED HERE, BY TREE. The candidate carries its bump, so the
// merged commit is the gated content itself: a merge that makes a new commit
// with the same tree is accepted, and any difference is refused.
//
// IT TAGS HERE AND STOPS. The tag is created locally and the push is printed
// as one bare command, for the person to run as its own step; nothing here
// pushes, and nothing here says a push was made. Run again after the push
// failed or was skipped, it finds its own tag on the commit being tagged,
// checks everything again, creates nothing new and prints the push again. A
// tag left here on another commit, or one already on the remote, is refused.
//
// Throws so it is unit-testable; the main flow converts to fail().
function tagRelease(version, { root = ROOT, git = gitIn(root), log = logStep } = {}) {
  const tag = `v${version}`;

  // On main, clean tree, not behind origin.
  preflight(version, { root, git });

  // The tag must land on the reviewed commit, so local main has to BE that
  // commit rather than merely contain it: the preflight rules out being behind,
  // and this rules out being ahead.
  const head = git(['rev-parse', 'HEAD']).trim();
  const merged = git(['rev-parse', 'origin/main']).trim();
  if (head !== merged) {
    throw new Error(
      `Local main is at ${head.slice(0, 9)} but origin/main is at ${merged.slice(0, 9)}. ` +
      `The tag must land on the reviewed commit, so local main must carry nothing of its own.`
    );
  }

  let pkg;
  try {
    pkg = JSON.parse(git(['show', `${merged}:package.json`]));
  } catch (err) {
    throw new Error(`Could not read package.json at origin/main: ${err.message}`);
  }
  if (pkg.version !== version) {
    throw new Error(
      `package.json at origin/main is ${pkg.version}, not ${version}. ` +
      `The release pull request for ${version} has not merged yet: the candidate carries the bump ("npm run release -- bump ${version}"), so merge it first.`
    );
  }

  // The version alone is not proof the release commit landed. A tree with the
  // bump but no promoted heading would publish a release with empty notes,
  // which is the failure the changelog promotion exists to prevent.
  const changelog = git(['show', `${merged}:CHANGELOG.md`]);
  const headingRe = new RegExp(`^## ${version.replace(/\./g, '\\.')}:`, 'm');
  if (!headingRe.test(changelog)) {
    throw new Error(
      `CHANGELOG.md at origin/main has no "## ${version}:" heading, so the changelog promotion is not on main. ` +
      `Tagging now would publish a release with no notes.`
    );
  }

  const mergedTree = git(['rev-parse', `${merged}^{tree}`]).trim();
  requireGatePass(mergedTree, { root, git, log });
  const signedOff = requireSignoff(mergedTree, version, { root, git });
  // Which way it was signed off, never the words: they stay in the local record.
  log('tag', `Tree ${mergedTree.slice(0, 12)} was ${SIGNED_OFF[signedOff]}`);

  // Already on the remote: it was pushed, and its build started then, so
  // there is nothing left for this command to do.
  const remote = remoteTagCommit(git, tag);
  if (remote === merged) {
    throw new Error(
      `Tag ${tag} is already on the remote, on ${merged.slice(0, 9)}, the commit being tagged: it has been pushed, ` +
      `and its build started when it was. Watch it: https://github.com/${REPO}/actions`
    );
  }
  if (remote) {
    throw new Error(
      `Tag ${tag} is already on the remote, on ${remote.slice(0, 9)}, not on ${merged.slice(0, 9)}, the commit being tagged. ` +
      'Choose a new version, or recut deliberately by deleting it first, here and on the remote (docs/RELEASING.md, "A recut").'
    );
  }

  // Already here: on this commit it is this command's own tag from a run whose
  // push failed or was skipped, and it is reused; on another commit it is left
  // from an earlier cut, and moving it is not this command's to do.
  const local = localTagCommit(git, tag);
  if (local && local !== merged) {
    throw new Error(
      `Tag ${tag} already exists here, on ${local.slice(0, 9)}, not on ${merged.slice(0, 9)}, the commit being tagged, ` +
      `and the remote does not have it. It is left from an earlier cut: delete it ("git tag -d ${tag}") and run this again.`
    );
  }
  if (!local) git(['tag', tag], { stdio: 'pipe' });

  const push = `git push origin ${tag}`;
  log('tag', local
    ? `${tag} was already tagged here on ${merged.slice(0, 9)} by an earlier run, and is not on the remote: nothing new was created, and nothing has been pushed`
    : `Tagged ${tag} on ${merged.slice(0, 9)}, here only: nothing has been pushed`);
  // What comes next, as the tag's own output. The push is printed on a line
  // of its own, exactly as it is to be run. The publish line names --confirm
  // with a placeholder, never the version, so publishing cannot be started by
  // copying it: see hasConfirmation.
  log('done', 'Push the tag yourself, as one bare command with nothing before or after it. Pushing it starts the build:');
  log(null, push);
  log('done', 'Once it is pushed, GitHub Actions builds, signs, notarizes and publishes a DRAFT release.');
  log('done', `Watch the build:   https://github.com/${REPO}/actions`);
  log('done', `Review the draft:  https://github.com/${REPO}/releases`);
  log('done', `If the push fails, the tag stays here: fix what stopped it and push again. "npm run release -- tag ${version}" run again checks everything again, creates nothing new and prints the push again.`);
  log('done', 'Do not publish yet. Download and test the draft build on your own machine(s) first.');
  log('done', `Once you have decided ${tag} is ready for everyone: npm run release -- publish ${version} --confirm <version>`);
  log('done', `If CI fails (e.g. expired Apple agreement): fix it and re-run the workflow on tag ${tag}: no need to revert main.`);
  return { tag, sha: merged, push, created: !local };
}

// The commit a tag on the remote names, or null when the remote has none: the
// peeled line for an annotated tag, which is listed only when asked for by
// name, and the tag's own line otherwise.
function remoteTagCommit(git, tag) {
  const lines = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]).trim().split('\n').filter(Boolean);
  const peeled = lines.find((l) => l.endsWith(`refs/tags/${tag}^{}`));
  const line = peeled || lines.find((l) => l.endsWith(`refs/tags/${tag}`));
  return line ? line.split(/\s+/)[0] : null;
}

// The commit a tag here names, or null when there is none.
function localTagCommit(git, tag) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { stdio: 'pipe' }).trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = [
  'Usage:',
  '  npm run release -- bump <version>                       write the version and promote the changelog, to commit with the candidate',
  '  npm run release -- signoff <version> --confirm <version>   after trying the candidate from source yourself, record it for its tree',
  "  npm run release -- signoff <version> --confirm <version> --on-instruction - <<'END_OF_SIGNOFF_WORDS'   record a sign-off given in chat: its words follow on stdin, verbatim, then a line END_OF_SIGNOFF_WORDS",
  '  npm run release -- tag <version>                        after the gated, signed-off release pull request merges, tag the merged commit here and print the push',
  '  git push origin v<version>                              push the tag, as its own bare command: this starts the build',
  '  npm run release -- publish <version> --confirm <version>   publish the draft release CI built for that tag, only after you have tested it yourself',
].join('\n');

// Guarded so the changelog helpers are requireable (by tests and by
// scripts/release-notes.js) without starting a release.
if (require.main === module) {
  const [subcommand, arg] = process.argv.slice(2);

  const versionFor = (step) => {
    if (!arg || !/^\d+\.\d+\.\d+$/.test(arg)) {
      fail(step, `Usage: npm run release -- ${step} <version> (e.g. npm run release -- ${step} 0.12.0)`);
    }
    return arg;
  };

  if (subcommand === 'prepare') {
    // Retired: the candidate carries its own bump, so there is no second pull
    // request to open. Say what replaced it rather than fail as unknown.
    fail('prepare',
      'prepare is retired: the release candidate carries its own version bump and promoted changelog, in one pull request.\n' +
      `${USAGE}\n  See docs/RELEASING.md for the order.`);
  } else if (subcommand === 'bump') {
    const version = versionFor('bump');
    let result;
    try {
      result = bumpRelease(version);
    } catch (err) {
      fail('bump', err.message);
    }
    console.log('');
    logStep('done', `package.json is ${version} and CHANGELOG.md's top heading is "${result.heading.replace(/^##\s*/, '')}".`);
    logStep('done', 'Commit both with the candidate, push it and open its pull request. Once CI is green on it: npm run release:gate');
  } else if (subcommand === 'signoff') {
    const version = versionFor('signoff');
    try {
      signoffRelease(version);
    } catch (err) {
      fail('signoff', err.message);
    }
  } else if (subcommand === 'tag') {
    const version = versionFor('tag');
    try {
      tagRelease(version);
    } catch (err) {
      fail('tag', err.message);
    }
  } else if (subcommand === 'publish') {
    // Publishes the reviewed draft, binding the tag before the draft flip.
    // --confirm is required and must name this exact version: see
    // hasPublishConfirmation's own comment for why.
    const version = versionFor('publish');
    if (!hasPublishConfirmation(process.argv, version)) {
      fail('publish',
        `Publishing v${version} makes it downloadable by everyone, not just you testing the draft.\n` +
        `  This requires --confirm naming this exact version, typed fresh after you have tested the build yourself:\n` +
        `    npm run release -- publish ${version} --confirm <version>\n` +
        `  Never run this because it was the next line printed by an earlier step, and an agent must never supply --confirm on its own.`
      );
    }
    try {
      const result = publishRelease(version);
      console.log('');
      logStep('done', `v${version} is live: ${result.url || `https://github.com/${REPO}/releases`}`);
      logStep('done', 'Site download links resolve via /releases/latest; no bump needed.');
    } catch (err) {
      fail('publish', err.message);
    }
  } else if (/^\d+\.\d+\.\d+$/.test(subcommand || '')) {
    // The form this script used to take. It pushed the bump straight to main,
    // which a protected branch refuses, so it cannot be made to work: say what
    // replaced it rather than start something that dies halfway through.
    fail('usage', `A release is no longer one command: the bump goes through the release pull request like any other change.\n${USAGE}`);
  } else {
    fail('usage', `${subcommand ? `Unknown subcommand "${subcommand}".` : 'No subcommand given.'}\n${USAGE}`);
  }
}

module.exports = {
  extractChangelogEntry,
  requireNotesMatchBuild,
  promoteUnreleasedChangelog,
  preflight,
  requireGatePass,
  signoffRelease,
  requireSignoff,
  readSignoff,
  askAtTerminal,
  SIGNOFF_FILE_NAME,
  bumpRelease,
  tagRelease,
  publishRelease,
  hasPublishConfirmation,
  ghApiArgs,
};
