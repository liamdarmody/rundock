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

module.exports = { seedSummarisedConversation, SUMMARY_ONLY_WORD, SHARED_WORD, DIVIDER_WORDS, BOUNDARY_UUID };
