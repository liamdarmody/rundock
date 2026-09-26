# Mutation run: Amendment A1 guards, in a real engine

The output of `node test/tools/mutate-extension-host-guards.js --markdown --only 'A1:'`, run against the sources staged for the commit that adds this file. Each row breaks one production guard in `public/extension-host.js` behind the Amendment A1 proofs, and runs the one named Chromium test in `test/e2e/trust-boundary.spec.js` that must turn red for it (Playwright, on the harness's own port). The middle column counts the tests that turned red, and the last names them. A row that turned nothing red would fail the run; this run exited 0.

| Guard broken | Tests red | Which |
|---|---|---|
| A1: a request with no user action at all is refused, never put to the person | 1 | `a script-sent ask with no user action at all is refused with its reason and shows the refusal line, never the bar` |
| A1: in a view the person uses from the keyboard, a script-sent ask with no key press is refused | 1 | `a real key press inside the view grants one ask; the same view's script-sent ask with no key press is refused` |
| A1: the activation a real key press sets is what grants the ask | 1 | `a real key press inside the view grants one ask; the same view's script-sent ask with no key press is refused` |
| A1: the ask bar is unarmed when it appears, so a press before it arms drafts nothing | 1 | `the ask on the bar: one click drafts one; the next waits on the bar, a press before it arms drafts nothing, and only a press after it drafts` |
| A1: the bar's Open performs the waiting ask | 1 | `the armed Open drafts exactly the waiting ask, agent and message, and tells the view nothing` |
| A1: Dismiss refuses the waiting ask and performs nothing | 1 | `Dismiss on the ask bar tells the view only that it was refused, and drafts nothing` |
| A1: the bar's Open drafts the waiting ask's own message | 1 | `the armed Open drafts exactly the waiting ask, agent and message, and tells the view nothing` |
| A1: the bar's Open drafts to the waiting ask's own agent | 1 | `the armed Open drafts exactly the waiting ask, agent and message, and tells the view nothing` |
