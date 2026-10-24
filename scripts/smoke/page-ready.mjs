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
import { waitFor } from './wait-for.mjs';

// The page has an open socket to the server, and the server has told it which
// workspace it shows: what a journey needs before it sends anything.
export function pageConnected(page) {
  return page.evaluate(() => typeof ws !== 'undefined' && !!ws && ws.readyState === 1
    && typeof currentWorkspacePath !== 'undefined' && !!currentWorkspacePath);
}

// The page's roster holds this agent.
export function pageKnowsAgent(page, agentId) {
  return page.evaluate((id) => typeof agents !== 'undefined' && Array.isArray(agents)
    && agents.some((a) => a.id === id), agentId);
}

// Waits for the page to be connected; true once it is, false if it never is.
export async function waitForPage(page, { timeout = 30000, interval = 100 } = {}) {
  return !!(await waitFor(() => pageConnected(page), timeout, interval));
}

// Starts a conversation with `agentId` once the page knows the agent, and
// checks that a conversation with that agent is what opened. Returns
// { ok, detail }, the detail saying what went wrong, so the journey records
// the step as failed with its reason rather than sending to the wrong agent.
export async function startConversationWith(page, agentId, { timeout = 30000, interval = 100 } = {}) {
  const known = await waitFor(() => pageKnowsAgent(page, agentId), timeout, interval);
  if (!known) {
    return { ok: false, detail: `the page's roster never held ${agentId} within ${timeout / 1000}s, so no conversation was started` };
  }
  const opened = await page.evaluate((id) => {
    window.startConversation(id);
    return activeConversation ? activeConversation.agentId : null;
  }, agentId);
  if (opened !== agentId) {
    return { ok: false, detail: `a conversation with ${agentId} was asked for, and one with ${opened} opened` };
  }
  return { ok: true, detail: '' };
}
