#!/usr/bin/env node
'use strict';
// Break each rule that lets an approval card name the agent that asked, and
// keeps its buttons from taking a click meant for another card, in turn, and
// report which tests notice.
//
// A card names its asker from one thing: the hook token the server issued to
// that agent's process at its spawn, kept in the server's own memory and keyed
// by the conversation and the agent together. Every spawn site has to pass the
// right agent, the route has to read the agent from the token and never the
// request, and the replay and the recorded decision have to keep it. On the
// page the name has to come from the card's `_agent` and go into the markup
// escaped, and a card's buttons have to wait half a second after the card
// appears or moves. Each of those can be lost with most tests still green,
// which is why each is broken on purpose here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-approvals-asker-guards.js            # report
//   node test/tools/mutate-approvals-asker-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The harness
// is the same shape as its siblings, deliberately a separate copy: pulling
// them together means editing instruments already in the gate.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
  runSuite, didNotFinishWhy, suiteOutput,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The server end to end: each spawn site, the route, the replay, the record.
const ASKER = 'test/integration/approvals-name-asker.test.js';
// The token map, which tells one agent's token from another's.
const TOKENS = { src: path.join(ROOT, 'lib', 'auth', 'index.js'), suite: 'test/unit/control-auth.test.js' };
// What a spawn is started with.
const SPAWN_ENV = { src: path.join(ROOT, 'lib', 'runtime', 'claude.js'), suite: 'test/unit/spawn-environments.test.js' };
const ENGINE = { src: path.join(ROOT, 'lib', 'delegation', 'engine.js'), suite: ASKER };
const SERVER = { src: path.join(ROOT, 'server.js'), suite: ASKER };
const ROUTER = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: ASKER };
const ANSWER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'process-control.js'), suite: ASKER };
// The page: the card's line and its wait, under jsdom.
const PAGE = 'test/unit/approvals-asked-by-card.test.js';
const CHAT = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: PAGE };
const MARKUP = { src: path.join(ROOT, 'public', 'chat-markup.js'), suite: 'test/unit/innerhtml-payloads.test.js' };
const DOCK_CSS = { src: path.join(ROOT, 'public', 'styles', 'components', 'approvals-dock.css'), suite: 'test/unit/permission-card-contrast.test.js' };

// ONE NAMED TEST, FOR A ROW WHOSE SUITE STARTS A SERVER. The integration suite
// starts a server and agents for every test, and a broken guard can leave
// several of them waiting out their timeouts, so a row that ran all of it
// would cost minutes. Such a row names the test that proves it
// (`suite#test name`), one that fails on an assertion rather than by waiting
// out a timeout, and only that test runs. A name that matches nothing runs
// nothing, which turns nothing red and is reported as a failure.
const named = new Map();
function only(target, testName) {
  const suite = `${target.suite}#${testName}`;
  const key = `${target.src}\n${suite}`;
  if (!named.has(key)) named.set(key, { src: target.src, suite });
  return named.get(key);
}

const MUTATIONS = [
  // ===== ONE TOKEN PER AGENT IN EACH CONVERSATION =====
  [TOKENS, 'the token map keys on the conversation only',
    '  const key = JSON.stringify([scope.conversationId, scope.agentId]);',
    '  const key = scope.conversationId;'],
  [TOKENS, 'the pair key keeps the two ids apart, whatever characters they hold',
    '  const key = JSON.stringify([scope.conversationId, scope.agentId]);',
    '  const key = `${scope.conversationId}:${scope.agentId}`;'],
  [SPAWN_ENV, 'a conversation spawn that names no agent is refused',
    "  if (convoId && (typeof agentIdOrRunToken !== 'string' || !agentIdOrRunToken)) throw new TypeError('a conversation spawn needs the agent it starts');\n",
    ''],

  // ===== EACH SPAWN SITE STARTS ITS AGENT WITH THAT AGENT'S TOKEN =====
  [only(ENGINE, 'lib/delegation/engine.js finishDelegateClose: the parent restarted after its delegate closes asks as the parent, with the token it had'),
    'the parent restarted after its delegate is given the parent\'s token, not the delegate\'s',
    '        env: getSpawnEnv(convoId, parentAgentId),',
    '        env: getSpawnEnv(convoId, targetAgent.id),'],
  [only(ENGINE, 'lib/delegation/engine.js handleScopeReturn: the orchestrator started for a handback asks as the orchestrator'),
    'the orchestrator started for a handback is given its own token, not the specialist\'s',
    '    env: getSpawnEnv(convoId, orchestrator.id),',
    '    env: getSpawnEnv(convoId, specialistEntry.agentId),'],
  [only(ENGINE, 'lib/delegation/engine.js handleDelegation: an intercepted delegation naming no parent hands back to the agent it found, asking as that agent, and the server stays up'),
    'an intercepted delegation that names no parent hands back to the agent whose process it found',
    '  const originalAgentId = isIntercepted ? (msg._parentAgentId || existing?.agentId) : existing.agentId;',
    '  const originalAgentId = isIntercepted ? msg._parentAgentId : existing.agentId;'],
  [only(SERVER, 'server.js, the chat message (interactive): the token is for the id discovery resolved, never the slug the message named'),
    'the chat message starts its agent with the token of the id discovery resolved, not the slug it named',
    "              env: getSpawnEnv(convoId, agentData ? agentData.id : 'default'),",
    "              env: getSpawnEnv(convoId, msg.agent || 'default'),"],

  // ===== THE SERVER NAMES THE ASKER FROM THE TOKEN, AND KEEPS IT =====
  [only(ROUTER, 'a request whose body sets `agent` to another agent still names the token\'s agent'),
    'the permission route never takes the agent from the request',
    "        const askedBy = scope ? scope.agentId : '';",
    "        const askedBy = data.agent || (scope ? scope.agentId : '');"],
  [only(SERVER, 'a window that reconnects while a card waits is sent the card naming the same agent'),
    'a card replayed to a window that reconnects still names its agent',
    '      // The agent the server filed it for, as the first delivery named it.\n      ...(pending.agentId ? { _agent: pending.agentId } : {}),\n',
    ''],
  [only(SERVER, 'a Codex agent\'s command card names that agent, live and on the replay'),
    'a card the server raises itself keeps the agent its caller named',
    'function requestServerPermission({ convoId, agentId, toolName, toolInput, onDecision, grading }) {',
    'function requestServerPermission({ convoId, toolName, toolInput, onDecision, grading }) {\n  const agentId = undefined;'],
  [only(ANSWER, 'the person\'s answer is recorded with the agent the server filed the card for, never one the window\'s message names'),
    'the person\'s answer is recorded with the agent the server filed, never one the window names',
    "agent: pending.agentId, d: { tool: pending.toolName, decision: allow ? 'allow' : 'deny' } });",
    "agent: msg.agentId, d: { tool: pending.toolName, decision: allow ? 'allow' : 'deny' } });"],
  [only(ROUTER, 'the agent notice is handed to the conversation an agent\'s token names'),
    'the agent notice route reads the conversation out of the token\'s scope',
    "    const id = scope ? scope.conversationId : '';",
    "    const id = scope || '';"],

  // ===== THE PAGE DRAWS THE NAME FROM _agent, AS TEXT =====
  [CHAT, 'the card names the agent from _agent, not the agent the repeat hint would name',
    "      : (asker ? RundockChatMarkup.askedByHtml(asker) : ''));",
    "      : (asker ? RundockChatMarkup.askedByHtml({ ...asker, displayName: repeatHintAgent(convoId) }) : ''));"],
  [MARKUP, 'the asker\'s name goes into the card\'s markup escaped',
    '<span>Asked by ${name}</span></div>`;',
    '<span>Asked by ${agent.displayName}</span></div>`;'],

  // ===== A CARD'S BUTTONS WAIT BEFORE THEY TAKE A CLICK =====
  [CHAT, 'a card drawn waits before its buttons take a click',
    'function cardPlaced(card) {\n  unarmCard(card);\n',
    'function cardPlaced(card) {\n'],
  [CHAT, 'a card waits again when a card before it settles',
    '  // either way the cards around it move.\n  unarmCardsIn(card.parentNode, card);\n',
    '  // either way the cards around it move.\n'],
  [CHAT, 'the click handlers honor aria-disabled',
    "const cardArmed = (btn) => btn.getAttribute('aria-disabled') !== 'true';",
    'const cardArmed = (btn) => !btn.disabled;'],
  [CHAT, 'a card that has moved waits again',
    '    if (moved) unarmCard(n);\n',
    ''],
  [CHAT, 'only a card whose top changed waits again',
    'const moved = top !== cardTops.get(n);',
    'const moved = true;'],
  [CHAT, 'where a card is now is what the next measurement is compared with',
    '    cardTops.set(n, top);\n',
    ''],
  [CHAT, 'a card drawn is measured where it was drawn',
    '  cardTops.set(card, cardTop(card));\n',
    ''],
  [CHAT, 'the host a card is drawn into is watched for moves',
    '  watchCardMoves(card.parentNode);\n',
    ''],
  [CHAT, 'a scroll of the host measures its cards',
    "  host.addEventListener('scroll', measure);\n",
    ''],
  [CHAT, 'a change inside the host measures its cards',
    '  new view.MutationObserver(measure).observe(host, { childList: true, subtree: true, characterData: true, attributes: true });\n',
    ''],
  [CHAT, 'a change deep inside the host measures its cards',
    'subtree: true, characterData',
    'subtree: false, characterData'],
  [CHAT, 'a change to the characters of a text measures the cards',
    'characterData: true, attributes',
    'characterData: false, attributes'],
  [CHAT, 'a change to an attribute measures the cards',
    'attributes: true });',
    'attributes: false });'],
  [CHAT, 'a window resize measures the cards',
    "  view.addEventListener('resize', measure);\n",
    ''],
  [DOCK_CSS, 'the origin line is drawn in the stronger secondary text colour',
    'letter-spacing: 0.02em; color: var(--text-2-strong); padding-left',
    'letter-spacing: 0.02em; color: var(--text-2); padding-left'],
];

const REPORTER = ['--test-reporter', 'spec'];

// The exact name, as a pattern node --test can match and nothing else can.
const exactly = (name) => `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

async function redTests(suite) {
  let out = '';
  let failed = false;
  const [file, testName] = String(suite).split('#');
  // NODE_TEST_CONTEXT must not reach the run: a nested node --test that
  // inherits it reports its failures in a form this cannot read and still
  // exits 0, so a red run would read as green.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    // Bounded twice over: each test by node's own timeout, and the whole
    // suite by the runner's limit, so a broken guard that leaves a run
    // waiting costs minutes and reports, rather than holding the harness for
    // hours.
    out = await runSuite('node', ['--test', '--test-timeout=120000', ...REPORTER, ...(testName ? ['--test-name-pattern', exactly(testName)] : []), file],
      { cwd: ROOT, env });
  } catch (e) {
    if (e.didNotFinish) return { didNotFinish: e.didNotFinish };
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// THE HARNESS'S OWN RUN IS CHECKED BEFORE ANY ROW IS READ. Every row is read
// through the one invocation above, so a fault in it, an option this node
// refuses or output that no longer parses, would misreport every row at once.
// Before anything is mutated, that same invocation is made on a fixture of two
// tests, one that passes and one that fails. It must read the passing one as
// green and the failing one as red, by name, or the run is refused with no
// verdict. Returns what it read wrong, or null.
const FIXTURE_GREEN = 'passes with nothing broken';
const FIXTURE_RED = 'fails when broken';
async function invocationProblem(runTests = redTests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-asker-harness-'));
  const file = path.join(dir, 'invocation.test.js');
  try {
    fs.writeFileSync(file, "'use strict';\nconst { test } = require('node:test');\n"
      + `test(${JSON.stringify(FIXTURE_GREEN)}, () => {});\n`
      + `test(${JSON.stringify(FIXTURE_RED)}, () => { throw new Error('broken'); });\n`);
    const green = await runTests(`${file}#${FIXTURE_GREEN}`);
    if (!Array.isArray(green) || green.length !== 0) {
      return `a run of a passing test read as ${JSON.stringify(green)}, not green`;
    }
    const red = await runTests(`${file}#${FIXTURE_RED}`);
    if (!Array.isArray(red) || red.length !== 1 || red[0] !== FIXTURE_RED) {
      return `a run of a failing test read as ${JSON.stringify(red)}, not that test red`;
    }
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function run() {
  const targets = targetsFromRows(MUTATIONS);
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of rowsForShard(MUTATIONS)) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST: String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, () => without));
      const red = await redTests(target.suite);
      if (red && red.didNotFinish) results.push({ label, applied: true, didNotFinish: red.didNotFinish, output: suiteOutput(), red: [] });
      else results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, output: suiteOutput(), red: [] }
        : { label, applied: true, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable, didNotFinish } of results) {
    if (didNotFinish) {
      failed++;
      const why = didNotFinishWhy(didNotFinish);
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. See
// mutate-routines-guards.js for the two runs that taught this: a full temp
// root surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(NO_VERDICT);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  invocationProblem().then((problem) => {
    if (problem) {
      console.error(`Refusing to start a mutation run: the run every row is read through misreads a result: ${problem}.`);
      process.exit(NO_VERDICT);
    }
    return run();
  }).then((results) => {
    const failed = report(results, process.argv.includes('--markdown'));
    if (failed) {
      console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
        + ' and a mutation that could break more than one place proves nothing about either.');
      process.exit(exitCodeFor(failed, results));
    }
  });
}

module.exports = { MUTATIONS, run, redTests, invocationProblem };
