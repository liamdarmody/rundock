# Named sources and asking an agent: what is enforced, and how it is proved

Two capabilities widen what an extension view can do for the first time since the confinement work closed its boundary: a dashboard note can hand its view the files it names, and a view can draft a message to an agent for the person to send. This records the defences and the runs that prove each one. The contract is [EXTENSION-HOST.md](../EXTENSION-HOST.md); the confinement record this extends is [extension-confinement-evidence.md](extension-confinement-evidence.md).

## Before the build

A spike, run in both engines against canary data before any product code, measured where each capability widens if one rule is missed. What it found, stated as the rule that now holds:

- A view that may write could otherwise rewrite its own note's list and be handed any file next time, or rewrite the list of a note another view later mounts. So no write an extension causes may change the `sources` list of the file it writes, whether or not that extension declared sources, enforced in the host and again on the server.
- A case variant of a file name, a hard link and a symlink can each make a visible name mean a different or hidden file. So identity is by device and inode, never by spelling, and a file reached through any link, or with a second name, is refused.
- The browser's record of a click lasts seconds and posting a message does not use it up, so one click could carry many requests. So one click is one request, shared by `open`, `openExternal` and `ask`, across every view: a view opened by another view's click cannot use it (see [extension-confinement-evidence.md](extension-confinement-evidence.md), "Use one click for more than one request").
- A refusal that distinguishes "no such agent" from a draft would let a view probe the team. So a view may ask only agents its manifest names, checked by membership of that list, and an ask spends the click whether or not it is honoured.
- A draft can display differently from its bytes. So control, bidirectional and zero-width characters are removed before it reaches the message box.
- `createConversation` falls back to the first agent for an unknown id. So an ask is refused before that function is reached for any agent not on the team.
- Electron's `sendInputEvent` does not reach an extension frame at all. So the desktop runs send real input through the Chrome DevTools Protocol, and a pass made with the old call would prove nothing.

## How the proof runs

Received data is read from the view's own record of every message it was sent; written data is read from the disk, byte for byte; asks are read at the app's handler and on the socket. Canaries sit in hidden files, an unnamed file, a hard-linked file and a sibling folder outside the workspace, all under the run's temporary root, and every link a run plants points inside that root (`test/unit/confinement-fixtures.test.js`). Every guard has a control: the same run with that guard removed, in which the attack succeeds.

| Run | Where | What it covers |
|---|---|---|
| A real case-insensitive disk | `test/tools/case-insensitive-identity.js`, a release gate step on macOS, run twice: on the default disk, and on an APFS volume created for the run with `hdiutil` | A note's case variants are refused as the note itself by device and inode, with nothing mocked; the step fails, never skips, where no case-insensitive filesystem can be had. Outputs `trust-boundary/case-identity-default-disk.json` and `trust-boundary/case-identity-apfs-volume.json`. The release gate's own two steps, run by their gate definitions on a named commit and tree, are recorded in `trust-boundary/release-gate-case-identity.json` (`test/tools/record-case-identity-gate.js`), which is never a release gate pass. The unit-level identity test, which forces a device and inode, stays but is not the proof on a real disk |
| Unit | `test/unit/named-sources*.test.js`, `test/unit/extension-host.test.js`, `test/unit/extension-privileges.test.js`, `test/unit/ask-agent.test.js`, `test/unit/extension-file.test.js` | Every resolver rule, the transport and its watch, the host's rules, the manifest and payload, the card, the app's refusal before a conversation exists |
| Chromium | `test/e2e/trust-boundary.spec.js` | Every named-sources and ask-an-agent guard proved in the browser, each with its control, and the chain from one view to the next (a view opened by another view's click opens, fetches and drafts nothing without its own click), with its control |
| The shipped Electron | `test/electron/confinement.cjs` | The same, with real input, plus one click per open and the chain with its control |
| The real app | `test/e2e/trust-boundary-app.spec.js` | Live refresh, the open file's own refresh, the external-edit choice on a source write, the empty list for an undeclaring extension, the whole ask from click to what the agent receives, and text typed unsent in another conversation surviving an ask |

The recorded outputs are in [trust-boundary/](trust-boundary/). Each guard also has a row in `test/tools/mutate-extension-host-guards.js` that removes it, and a test fails for every row; the run's own output, every row and the tests each turned red, is [trust-boundary/mutation-run.md](trust-boundary/mutation-run.md).

## A user action grants one request, and the host bar is the only other way an ask drafts

A real click or key press inside the view grants one request, and when Rundock cannot attribute an `ask` to one, it asks the person on its own bar. Each part is shown in Chromium and in the shipped Electron with real input (CDP for pointer and key), each with a control:

- **A script-sent ask with no user action at all is refused, and the person sees the refusal line, never the bar.** Control: with a no-activation request routed to the person, the bar goes up instead.
- **One user action drafts one ask.** A burst on one click drafts the first; the second waits on the bar.
- **The ask on the bar drafts only on the person's armed press.** A press before the bar arms lands on the disabled button and drafts nothing; a press after it drafts exactly the waiting ask, agent and message, and posts nothing back; Dismiss tells the view only `you dismissed this in Rundock` and drafts nothing. Controls: with the bar armed from the moment it appears the same early press drafts; with Dismiss wired to perform the request Dismiss drafts and tells the view nothing; with the bar's Open handler removed an armed press drafts nothing; and with the ask wired to the wrong payload it drafts the wrong ask.
- **A real key press counts.** A view that focuses its own button and asks by script is refused; the person's Enter on that button drafts one ask. Control: without the click gate the script-sent ask drafts on its own.
- **Each production guard behind these proofs has a mutation row.** `test/tools/mutate-extension-host-guards.js` breaks, in the host itself, the refusal of a request with no user action, the reading of the activation a key press sets, the bar's arming, the bar's Open and Dismiss handling, and the ask's message and agent as Open drafts them; each row runs the one named Chromium test that must turn red for it. The run's own output, every row and the test it turned red, is [trust-boundary/mutation-run-a1.md](trust-boundary/mutation-run-a1.md).
- **In the real app:** an ask pressed within seconds of the tree click that opened the file goes to the bar; an early press drafts nothing, an armed press opens a new conversation with the agent and the message unsent, and Dismiss drafts nothing and tells the view only that it was refused (`test/e2e/trust-boundary-app.spec.js`).

## What was not proved closed

A parent folder swapped for a link in the moment between the server's re-check and its open of a source is not covered by the open's refusal to follow a link, which applies to the file itself. It needs an attacker already able to create links in the workspace and to win a race measured in microseconds; it is stated rather than claimed closed.
