# The summary divider: what an older release does with its entry

This change keeps one entry in a conversation's transcript for each time an agent's earlier conversation is summarised, so that a reopened conversation can draw the divider where it was drawn live. A workspace is a folder of files, and the same folder can be opened by an older Rundock on another computer, or by this one after a downgrade. This file records what 0.15.8, the last release before this change, does with that entry: in the history it rebuilds when a conversation is opened, and in the catch-up it writes for an agent that comes back to a conversation or joins it.

## The entry

`appendCompaction` in `lib/store/transcripts.js` stores it, with the key of the summary it marks:

```js
transcript.push({ role: 'system', agent: null, text: '', type: 'compaction', key, timestamp: new Date().toISOString() });
```

The run used that entry field for field, three times in one conversation: between two turns, inside a reply (where it is stored before the reply's own entry, which is written when the reply ends), and after the replying agent's last turn. The three as written to the transcript file:

```
{"role":"system","agent":null,"text":"","type":"compaction","key":"00000000-0000-4000-8000-000000000002","timestamp":"2026-11-16T10:00:02.000Z"}
{"role":"system","agent":null,"text":"","type":"compaction","key":"00000000-0000-4000-8000-000000000004","timestamp":"2026-11-16T10:00:04.000Z"}
{"role":"system","agent":null,"text":"","type":"compaction","key":"00000000-0000-4000-8000-000000000006","timestamp":"2026-11-16T10:00:06.000Z"}
```

The whole transcript, in order:

1. the person: "First question about alpha"
2. `example-alpha`: "First answer about alpha"
3. the entry with the key ending `0002`, between two turns
4. the person: "Second question about beta"
5. the entry with the key ending `0004`, inside the reply that follows
6. `example-beta`: "Second answer about beta"
7. the entry with the key ending `0006`, after that agent's last turn
8. the person: "Third question about alpha"

## What was run

`lib/protocol/handlers/history.js` and `lib/store/transcripts.js` at the `v0.15.8` tag (commit `6d07ef9`, "Release 0.15.8: Routines That Run Without You (#441)"), and the 13 modules they load in turn by a relative path, were read out of the tag with `git show v0.15.8:<path>` into a folder of their own at their repository paths, and loaded in Node from there. Neither of the two files mentions `compaction`. Both copies have the blob ids the tag gives for them (`a0db2af` for the history handler, `0b1f9b4` for the transcript store).

`handleGetSessionHistory` was called as the app calls it when a conversation is opened, with the transcript in the workspace's `.rundock/transcripts/` folder. The session parser it is handed lives in `server.js`, outside these files, so it was given what that parser returns for the conversation's session file: the five messages of the person and the agents, with their times. `deltaSince` was called on the same transcript as `loadTranscript` reads it from that file. Every result was produced a second time for the same transcript with the three entries taken out, and the two were compared.

## The history rebuild

The conversation was opened three ways: with its session file, with a session named whose file is gone, and with no session at all, which is how a conversation whose sessions Claude Code removed is opened. The output, as the run printed it:

```
--- handleGetSessionHistory, with the session file ---
thrown: none; logged: none; replies sent: 1
{"type":"session_history","totalCount":5,"messages":[{"role":"user","content":"First question about alpha","agentId":null},{"role":"assistant","content":"First answer about alpha","agentId":"example-alpha"},{"role":"user","content":"Second question about beta","agentId":null},{"role":"assistant","content":"Second answer about beta","agentId":"example-beta"},{"role":"user","content":"Third question about alpha","agentId":null}]}
empty bubbles: 0; names a summary key or type: false; same as without the summary entries: true
--- handleGetSessionHistory, a session named whose file is gone ---
thrown: none; logged: none; replies sent: 1
{"type":"session_history","totalCount":5,"messages":[{"role":"user","content":"First question about alpha","agentId":null},{"role":"assistant","content":"First answer about alpha","agentId":"example-alpha"},{"role":"user","content":"Second question about beta","agentId":null},{"role":"assistant","content":"Second answer about beta","agentId":"example-beta"},{"role":"user","content":"Third question about alpha","agentId":null}]}
empty bubbles: 0; names a summary key or type: false; same as without the summary entries: true
--- handleGetSessionHistory, no session at all, transcript only ---
thrown: none; logged: none; replies sent: 1
{"type":"session_history","totalCount":5,"messages":[{"role":"user","content":"First question about alpha","agentId":null},{"role":"assistant","content":"First answer about alpha","agentId":"example-alpha"},{"role":"user","content":"Second question about beta","agentId":null},{"role":"assistant","content":"Second answer about beta","agentId":"example-beta"},{"role":"user","content":"Third question about alpha","agentId":null}]}
empty bubbles: 0; names a summary key or type: false; same as without the summary entries: true
```

- **With the session file:** one reply, nothing thrown and nothing logged. Five messages, the person's three and the two agents' replies, each attributed to the agent that gave it. No bubble for any entry, no empty bubble, nothing that carries a key or the type, and the messages and the count are those of the same conversation without the entries.
- **A session named whose file is gone:** the same five messages from the transcript alone, and the same with and without the entries.
- **No session at all:** the same again.

The reason is in the handler's walk over the transcript. Line 243 takes any role other than `user` for an agent's turn, the entry is neither a `routing` nor a `team` entry, so it reaches the agent branch, where lines 275 and 276 read:

```js
            const cleanPrefix = stripToolSummaries(tText).substring(0, 100);
            if (!cleanPrefix) continue;
```

The entry's text is empty, so the prefix is empty and the entry is passed over before any session line is looked up for it, with a session file or without one. Because it is never matched, it claims no line of the session file, and the reply after it keeps its own. 0.15.8 draws no divider, since it has no code for one, and shows nothing in its place.

## The catch-up

The catch-up was asked for three agents: `example-alpha` returning, which last spoke before all three entries; `example-gamma` arriving, which is given the whole conversation; and `example-beta`, the replying agent, whose reply the second entry fell inside and after whose last turn the third sits. The output:

```
--- deltaSince, a returning agent (agent example-alpha, arriving=false) ---
thrown: none; logged: none
{"text":"USER: Second question about beta\n\nBETA: Second answer about beta\n\nUSER: Third question about alpha","truncated":0,"clipped":0}
empty speaker lines: false; names a summary key or type: false; same as without the summary entries: true
--- deltaSince, an arriving agent (agent example-gamma, arriving=true) ---
thrown: none; logged: none
{"text":"USER: First question about alpha\n\nALPHA: First answer about alpha\n\nUSER: Second question about beta\n\nBETA: Second answer about beta\n\nUSER: Third question about alpha","truncated":0,"clipped":0}
empty speaker lines: false; names a summary key or type: false; same as without the summary entries: true
--- deltaSince, the replying agent (agent example-beta, arriving=false) ---
thrown: none; logged: none
{"text":"USER: Third question about alpha","truncated":0,"clipped":0}
empty speaker lines: false; names a summary key or type: false; same as without the summary entries: true
```

- **A returning agent:** its window holds all three entries, and the text it is sent names the turns after its own and nothing else. No line for an entry, no speaker line with nothing after it, nothing counted as left out, and the result is the one it gets without the entries.
- **An arriving agent:** the whole conversation, five turns, and again no line for any entry and the same result as without them.
- **The replying agent:** its window holds the third entry and the person's next message, and it is sent that message alone.

The reason is the filter at lines 233 and 234 of the transcript store:

```js
  const missed = transcript.slice(arriving ? 0 : lastOwn + 1)
    .filter((t) => t && t.type !== 'team' && !skip.has(t.agent) && renderDeltaEntryBody(t) !== '');
```

`renderDeltaEntryBody` gives an empty string for an entry whose text is empty, so each entry is dropped before anything is rendered and before the cap counts what it leaves out. Nothing is sent to an agent for it.

## Kept as it is

0.15.8 adds to a transcript by pushing the new entry onto the array it loaded and writing the whole array back (`appendTranscript` in `server.js` at the tag, and `saveTranscript` in the transcript store), so an entry it does not know is kept as it was, and leaves only as any entry does, when a transcript of 1,000 entries drops its second to make room. Opened again in a release with this change, the conversation draws its dividers where they were.
