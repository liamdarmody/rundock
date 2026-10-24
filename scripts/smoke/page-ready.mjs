// What a smoke journey asks of the page before it acts, asked of the page's
// own state rather than guessed with a sleep.
//
// WHY. The persona journeys slept a fixed 1.5 seconds after signing in and
// then called into the page, and started a conversation with an agent half a
// second after asking for it. Both bet that the machine is as fast as it was
// when the numbers were chosen. Inside the release gate the persona step runs
// after the Electron and browser steps, on a loaded machine, and the bet can
// lose in two ways. The socket is still connecting when the journey sends on
// it, so the journey aborts. Or the page has not yet received the roster that
// names the agent the journey starts a conversation with, and the client,
// which falls back to the first agent it knows for an id it does not, opens a
// conversation with that agent instead, without a word; the journey's message
// then goes to the wrong agent and its check fails 45 seconds later. Both pass
// when the step is run alone.
//
// Every question here is a function run IN the page, through page.evaluate,
// reading the client's own globals (`ws`, `currentWorkspacePath`, `agents`,
// `activeConversation`), which the browser suite reads the same way.
//
// EVERY ASK IS BOUNDED, BY WHAT IS LEFT OF ITS WAIT. A page that is frozen, or
// busy past the point of answering, leaves page.evaluate waiting with no limit
// of its own, and the journey with it. Each ask is raced against the time left
// in the wait it belongs to, not against the wait's whole timeout, so a slow
// ask near the end cannot carry the wait past its stated limit; one that does
// not answer in time fails with that reason, stated against the wait's limit.

const DEFAULTS = { timeout: 30000, interval: 100 };

// page.evaluate, or a rejection saying the page did not answer within `ms`.
export function evaluateWithin(page, ms, fn, arg) {
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`the page did not answer within ${ms / 1000}s`), { timedOut: true })), ms);
  });
  return Promise.race([page.evaluate(fn, arg), late]).finally(() => clearTimeout(timer));
}

// Why an ask failed, in its wait's own terms: a page that did not answer is
// reported against the limit the wait was given, whatever was left of it.
function reasonFor(err, timeout) {
  return err.timedOut ? `the page did not answer within ${timeout / 1000}s` : err.message;
}

// Polls one question of the page until it answers truthily or the wait's
// time is up, giving each ask only the time that is left. A question that
// throws means "not yet". Returns { value } on success; otherwise { error },
// the last reason the page gave for not answering, or null when it answered
// and the answer was no.
async function askUntil(page, ask, { timeout, interval }) {
  const deadline = Date.now() + timeout;
  let error = null;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { error };
    try {
      const answer = await ask(page, left);
      error = null;
      if (answer) return { value: answer };
    } catch (err) {
      error = err;
    }
    const rest = deadline - Date.now();
    if (rest <= 0) return { error };
    await new Promise((resolve) => setTimeout(resolve, Math.min(interval, rest)));
  }
}

// The page has an open socket to the server, and the server has told it which
// workspace it shows: what a journey needs before it sends anything.
export function pageConnected(page, { timeout = DEFAULTS.timeout } = {}) {
  return evaluateWithin(page, timeout, () => typeof ws !== 'undefined' && !!ws && ws.readyState === 1
    && typeof currentWorkspacePath !== 'undefined' && !!currentWorkspacePath);
}

// The page's roster holds this agent.
export function pageKnowsAgent(page, agentId, { timeout = DEFAULTS.timeout } = {}) {
  return evaluateWithin(page, timeout, (id) => typeof agents !== 'undefined' && Array.isArray(agents)
    && agents.some((a) => a.id === id), agentId);
}

// Waits for the page to be connected. Returns { ok, detail }, the detail
// saying why when it is not.
export async function waitForPage(page, { timeout = DEFAULTS.timeout, interval = DEFAULTS.interval } = {}) {
  const asked = await askUntil(page, (p, ms) => pageConnected(p, { timeout: ms }), { timeout, interval });
  if (asked.value) return { ok: true, detail: '' };
  return {
    ok: false,
    detail: asked.error
      ? reasonFor(asked.error, timeout)
      : `the socket did not open, or the server did not name the workspace, within ${timeout / 1000}s`,
  };
}

// Starts a conversation with `agentId` once the page knows the agent, and
// checks that a conversation with that agent is what opened. Returns
// { ok, detail }, the detail saying what went wrong, so the journey records
// the step as failed with its reason rather than sending to the wrong agent.
//
// `timeout` bounds the whole call: the start is given what the wait for the
// roster left of it.
export async function startConversationWith(page, agentId, { timeout = DEFAULTS.timeout, interval = DEFAULTS.interval } = {}) {
  const deadline = Date.now() + timeout;
  const asked = await askUntil(page, (p, ms) => pageKnowsAgent(p, agentId, { timeout: ms }), { timeout, interval });
  if (!asked.value) {
    return {
      ok: false,
      detail: asked.error
        ? `${reasonFor(asked.error, timeout)}, so no conversation with ${agentId} was started`
        : `the page's roster never held ${agentId} within ${timeout / 1000}s, so no conversation was started`,
    };
  }
  let opened;
  try {
    opened = await evaluateWithin(page, Math.max(1, deadline - Date.now()), (id) => {
      window.startConversation(id);
      return activeConversation ? activeConversation.agentId : null;
    }, agentId);
  } catch (err) {
    return { ok: false, detail: `${reasonFor(err, timeout)} when asked to start a conversation with ${agentId}` };
  }
  if (opened !== agentId) {
    return { ok: false, detail: `a conversation with ${agentId} was asked for, and one with ${opened} opened` };
  }
  return { ok: true, detail: '' };
}
