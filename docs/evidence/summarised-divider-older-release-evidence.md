# The summary divider: what main does with its entry

This change keeps one entry in a conversation's transcript for each time an agent's earlier conversation is summarised, so that a reopened conversation can draw the divider where it was drawn live. A workspace is a folder of files, and the same folder can be opened by a Rundock without this change, on another computer or after a downgrade. This file records what main at commit `07bc82f`, the code this change is built on, which has no code for the entry, does with it: in the history it rebuilds when a conversation is opened, and in the catch-up it writes for an agent that comes back to a conversation or joins it.

## What was run

```
node main-history-run.js <main> <branch>
```

`<main>` is main at `07bc82f`, extracted with `git archive`, and `<branch>` is this branch's checkout. The script is not part of the change. It:

- writes a transcript with this branch's code: ordinary entries as `appendTranscript` in `server.js` adds them, and three summary entries by `appendCompaction` in `lib/store/transcripts.js`, one between two turns, one inside a reply (stored before the reply's own entry), and one after the replying agent's last turn;
- calls main's `handleGetSessionHistory` (`lib/protocol/handlers/history.js`) as the app does when a conversation is opened, with the session file and with no session at all. The session parser lives in `server.js`, so it is given what that parser returns for the session file: the five turns, with their times;
- calls main's `deltaSince` (`lib/store/transcripts.js`) as `lib/delegation/engine.js` does, for a returning agent, an arriving agent, and the agent whose reply held the second entry;
- runs each again on the same transcript with the three entries taken out, and compares the two.

Times are left out of the printed history. The output:

```
--- the transcript as the branch wrote it ---
{"role":"user","agent":"user","text":"First question about alpha","timestamp":"2026-11-17T10:52:56.283Z"}
{"role":"agent","agent":"example-alpha","text":"First answer about alpha","timestamp":"2026-11-17T10:52:56.284Z"}
{"role":"system","agent":null,"text":"","type":"compaction","key":"00000000-0000-4000-8000-000000000002","timestamp":"2026-11-17T10:52:56.284Z"}
{"role":"user","agent":"user","text":"Second question about beta","timestamp":"2026-11-17T10:52:56.284Z"}
{"role":"system","agent":null,"text":"","type":"compaction","key":"00000000-0000-4000-8000-000000000004","timestamp":"2026-11-17T10:52:56.284Z"}
{"role":"agent","agent":"example-beta","text":"Second answer about beta","timestamp":"2026-11-17T10:52:56.284Z"}
{"role":"system","agent":null,"text":"","type":"compaction","key":"00000000-0000-4000-8000-000000000006","timestamp":"2026-11-17T10:52:56.284Z"}
{"role":"user","agent":"user","text":"Third question about alpha","timestamp":"2026-11-17T10:52:56.285Z"}
--- handleGetSessionHistory, with the session file ---
thrown: none; logged: none; replies sent: 1
[{"type":"session_history","totalCount":5,"messages":[{"role":"user","content":"First question about alpha","agentId":null},{"role":"assistant","content":"First answer about alpha","agentId":"example-alpha"},{"role":"user","content":"Second question about beta","agentId":null},{"role":"assistant","content":"Second answer about beta","agentId":"example-beta"},{"role":"user","content":"Third question about alpha","agentId":null}]}]
empty bubbles: 0; names a summary key or type: false; same as without the summary entries: true
--- handleGetSessionHistory, no session at all, transcript only ---
thrown: none; logged: none; replies sent: 1
[{"type":"session_history","totalCount":5,"messages":[{"role":"user","content":"First question about alpha","agentId":null},{"role":"assistant","content":"First answer about alpha","agentId":"example-alpha"},{"role":"user","content":"Second question about beta","agentId":null},{"role":"assistant","content":"Second answer about beta","agentId":"example-beta"},{"role":"user","content":"Third question about alpha","agentId":null}]}]
empty bubbles: 0; names a summary key or type: false; same as without the summary entries: true
--- deltaSince, a returning agent (example-alpha, arriving=false) ---
thrown: none; logged: none
{"text":"USER: Second question about beta\n\nBETA: Second answer about beta\n\nUSER: Third question about alpha","truncated":0,"clipped":0}
names a summary key or type: false; same as without the summary entries: true
--- deltaSince, an arriving agent (example-gamma, arriving=true) ---
thrown: none; logged: none
{"text":"USER: First question about alpha\n\nALPHA: First answer about alpha\n\nUSER: Second question about beta\n\nBETA: Second answer about beta\n\nUSER: Third question about alpha","truncated":0,"clipped":0}
names a summary key or type: false; same as without the summary entries: true
--- deltaSince, the replying agent (example-beta, arriving=false) ---
thrown: none; logged: none
{"text":"USER: Third question about alpha","truncated":0,"clipped":0}
names a summary key or type: false; same as without the summary entries: true
```

Nothing was thrown or logged. The history holds the five turns, each attributed to the agent that gave it, with no bubble, empty or otherwise, for any entry. Each catch-up names the turns it should and no line for an entry, and nothing is counted as left out. Every result is the one the same transcript gives without the entries.

## Why

- **The history:** line 243 of main's handler takes any role other than `user` for an agent's turn, and the entry is neither a `routing` nor a `team` entry, so it reaches the agent branch, where lines 275 and 276 skip a turn with no text (`if (!cleanPrefix) continue;`). The entry is passed over before any session line is looked up for it, so it claims none, and the reply after it keeps its own. No divider is drawn and nothing is shown in its place.
- **The catch-up:** lines 233 and 234 of main's transcript store drop every entry whose rendered text is empty, before anything is rendered and before the cap counts what it leaves out.

## Kept as it is

Main adds to a transcript by pushing the new entry onto the array it loaded and writing the whole array back (`appendTranscript` in `server.js`, `saveTranscript` in the transcript store), so an entry it does not know is kept as it was, and leaves only as any entry does, when a transcript of 1,000 entries drops its second to make room. Opened again with this change, the conversation draws its dividers where they were.
