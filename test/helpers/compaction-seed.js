'use strict';
// A conversation Claude Code summarised to make room, seeded on disk the way
// the server reads it back: the session file under the harness's HOME, the
// conversation record, and Rundock's transcript holding the summary's entry.
//
// The session file carries the summary as Claude Code keeps it: a user line
// marked isCompactSummary (the mark isClaudeCodeNote in server.js hides by),
// after the compact_boundary system line. The summary's text holds a word
// found nowhere else, so a search for it finds the summary or nothing.
const fs = require('node:fs');
const path = require('node:path');

const SUMMARY_ONLY_WORD = 'quokka';
const SHARED_WORD = 'heron';
const BOUNDARY_UUID = '00000000-0000-4000-8000-0c0000000001';

function seedSummarisedConversation(h, { convoId, sessionId, agentId = 'chief-of-staff' }) {
  const at = (s) => new Date(Date.parse('2026-07-01T10:00:00.000Z') + s * 1000).toISOString();
  const lines = [
    { type: 'user', message: { role: 'user', content: `First question about the ${SHARED_WORD} survey` }, timestamp: at(0) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `First answer about the ${SHARED_WORD} survey` }] }, timestamp: at(1) },
    { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', uuid: BOUNDARY_UUID, compactMetadata: { trigger: 'auto' }, timestamp: at(2) },
    {
      type: 'user',
      message: { role: 'user', content: `This session is being continued from a previous conversation. Summary: the ${SUMMARY_ONLY_WORD} budget was settled early on.` },
      isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: at(3),
    },
    { type: 'user', message: { role: 'user', content: `Second question about the ${SHARED_WORD} survey` }, timestamp: at(4) },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Second answer about the ${SHARED_WORD} survey` }] }, timestamp: at(5) },
  ];
  const sessionDir = path.join(process.env.HOME, '.claude', 'projects', h.workspaceDir.replace(/\//g, '-'));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const rundockDir = path.join(h.workspaceDir, '.rundock');
  fs.mkdirSync(path.join(rundockDir, 'transcripts'), { recursive: true });
  fs.writeFileSync(path.join(rundockDir, 'conversations.json'), JSON.stringify([{
    id: convoId, agentId, sessionId, sessionIds: [{ sessionId, agentId }], title: 'Survey planning', status: 'active',
    createdAt: at(-1), lastActiveAt: new Date().toISOString(),
  }], null, 2));
  fs.writeFileSync(path.join(rundockDir, 'transcripts', `${convoId}.json`), JSON.stringify([
    { role: 'user', agent: 'user', text: lines[0].message.content, timestamp: at(0) },
    { role: 'agent', agent: agentId, text: lines[1].message.content[0].text, timestamp: at(1) },
    { role: 'system', agent: null, text: '', type: 'compaction', key: BOUNDARY_UUID, timestamp: at(2) },
    { role: 'user', agent: 'user', text: lines[4].message.content, timestamp: at(4) },
    { role: 'agent', agent: agentId, text: lines[5].message.content[0].text, timestamp: at(5) },
  ], null, 2));
  return { visibleTurns: 4 };
}

// The words the window draws for a summary, live and settled.
const DIVIDER_WORDS = ['Earlier messages were summarised to make room', 'summarised', 'Summarising earlier messages', 'Why?'];

// The session file Claude Code itself kept for a run of a reply, /compact, then
// a reply (test/fixtures/compaction/claude-compact-session.jsonl). Its summary
// holds a word found nowhere else; its two prompts share words no other seeded
// conversation has.
const CAPTURED_SESSION_FILE = path.join(__dirname, '..', 'fixtures', 'compaction', 'claude-compact-session.jsonl');
const CAPTURED_SUMMARY_WORD = 'tardigrade';
const CAPTURED_PROMPT_WORDS = 'single word';
const capturedSessionLines = () => fs.readFileSync(CAPTURED_SESSION_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// That file seeded as a conversation, laid out as seedSummarisedConversation
// lays it out. The file is written byte for byte under its own session id, the
// name Claude Code gives it, so every line still agrees with its file and what
// the server reads is the capture itself. The transcript holds what Rundock
// records live: the prompts it sent (marked promptSource "sdk"), the replies,
// and the summary's entry keyed by the boundary's uuid. The conversation record
// joins any already seeded rather than replacing them.
function seedCapturedSession(h, { convoId, agentId = 'chief-of-staff' }) {
  const lines = capturedSessionLines();
  const { sessionId } = lines.find((l) => l.sessionId);
  const boundary = lines.find((l) => l.subtype === 'compact_boundary');
  const transcript = lines.flatMap((l) => {
    if (l.type === 'user' && l.promptSource === 'sdk') return [{ role: 'user', agent: 'user', text: l.message.content, timestamp: l.timestamp }];
    if (l.type === 'assistant') return [{ role: 'agent', agent: agentId, text: l.message.content.map((b) => b.text).join('\n\n'), timestamp: l.timestamp }];
    if (l === boundary) return [{ role: 'system', agent: null, text: '', type: 'compaction', key: l.uuid, timestamp: l.timestamp }];
    return [];
  });
  const sessionDir = path.join(process.env.HOME, '.claude', 'projects', h.workspaceDir.replace(/\//g, '-'));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.copyFileSync(CAPTURED_SESSION_FILE, path.join(sessionDir, `${sessionId}.jsonl`));

  const rundockDir = path.join(h.workspaceDir, '.rundock');
  fs.mkdirSync(path.join(rundockDir, 'transcripts'), { recursive: true });
  const listFile = path.join(rundockDir, 'conversations.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(listFile, 'utf8')).filter((c) => c.id !== convoId); } catch (e) { /* none seeded yet */ }
  list.push({
    id: convoId, agentId, sessionId, sessionIds: [{ sessionId, agentId }], title: 'Short replies', status: 'active',
    createdAt: transcript[0].timestamp, lastActiveAt: new Date().toISOString(),
  });
  fs.writeFileSync(listFile, JSON.stringify(list, null, 2));
  fs.writeFileSync(path.join(rundockDir, 'transcripts', `${convoId}.json`), JSON.stringify(transcript, null, 2));
  return { sessionId, boundaryUuid: boundary.uuid, transcript };
}

// The summary as Claude Code's output stream carries it
// (test/fixtures/compaction/claude-compact.jsonl): a user line marked
// isSynthetic, with no isCompactSummary. Its word is found nowhere else.
const STREAM_CAPTURE_FILE = path.join(__dirname, '..', 'fixtures', 'compaction', 'claude-compact.jsonl');
const STREAM_SUMMARY_WORD = 'placeholder';
const STREAM_PROMPT_WORD = 'marmot';
const streamSummaryRaw = () => fs.readFileSync(STREAM_CAPTURE_FILE, 'utf8').trim().split('\n')
  .find((raw) => { const l = JSON.parse(raw); return l.type === 'user' && l.isSynthetic === true; });

// A session file holding an ordinary prompt and then that captured line, byte
// for byte, under the capture's own session id, seeded as a conversation and
// joined to any already seeded. The prompt is in the line's own shape, less
// the mark, so a search for its word shows the session is read.
function seedStreamSummarySession(h, { convoId, agentId = 'chief-of-staff' }) {
  const raw = streamSummaryRaw();
  const summary = JSON.parse(raw);
  const sessionId = summary.session_id;
  const prompt = {
    type: 'user', message: { role: 'user', content: `How many ${STREAM_PROMPT_WORD} burrows were counted?` },
    session_id: sessionId, parent_tool_use_id: null, uuid: '00000000-0000-4000-8000-050000000004', timestamp: '2026-11-16T15:54:30.000Z',
  };
  const sessionDir = path.join(process.env.HOME, '.claude', 'projects', h.workspaceDir.replace(/\//g, '-'));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), `${JSON.stringify(prompt)}\n${raw}\n`);

  const rundockDir = path.join(h.workspaceDir, '.rundock');
  fs.mkdirSync(path.join(rundockDir, 'transcripts'), { recursive: true });
  const listFile = path.join(rundockDir, 'conversations.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(listFile, 'utf8')).filter((c) => c.id !== convoId); } catch (e) { /* none seeded yet */ }
  list.push({
    id: convoId, agentId, sessionId, sessionIds: [{ sessionId, agentId }], title: 'Field notes', status: 'active',
    createdAt: prompt.timestamp, lastActiveAt: new Date().toISOString(),
  });
  fs.writeFileSync(listFile, JSON.stringify(list, null, 2));
  fs.writeFileSync(path.join(rundockDir, 'transcripts', `${convoId}.json`), JSON.stringify([
    { role: 'user', agent: 'user', text: prompt.message.content, timestamp: prompt.timestamp },
  ], null, 2));
  return { sessionId, summary };
}

module.exports = {
  seedSummarisedConversation, SUMMARY_ONLY_WORD, SHARED_WORD, DIVIDER_WORDS, BOUNDARY_UUID,
  seedCapturedSession, capturedSessionLines, CAPTURED_SUMMARY_WORD, CAPTURED_PROMPT_WORDS,
  seedStreamSummarySession, STREAM_SUMMARY_WORD, STREAM_PROMPT_WORD,
};
