'use strict';
// The handback payload builder: the single source of the content a parent
// agent receives when a delegate hands back.
//
// Extracted from server.js as part of giving delegation state one owner. The
// module is a factory because the builder needs two server-owned
// capabilities, transcript access and marker stripping, and taking them as
// dependencies keeps this file free of workspace globals and directly
// unit-testable.

/**
 * @param {object} deps
 * @param {(convoId: string) => TranscriptEntry[]} deps.loadTranscript - Returns
 *   the conversation transcript rows (see types.d.ts TranscriptEntry).
 * @param {(text: string) => string} deps.stripMarkers - Removes RUNDOCK
 *   markers from a turn's text.
 * @param {number} deps.maxChars - Payload cap; truncation past it is loud.
 */
function createHandbackBuilder({ loadTranscript, stripMarkers, maxChars }) {
  // The delegate's plain chat turns from the on-disk transcript, in order.
  // Boundary is a TIMESTAMP, not an index: appendTranscript splices entry 1
  // at the 1000-entry soft cap, so a stored index silently drifts on long
  // conversations. Typed rows (e.g. 'routing') are bookkeeping and carry no
  // session content.
  /**
   * @param {string} convoId
   * @param {string} agentId
   * @param {string | undefined} sinceIso
   * @returns {string[]}
   */
  function transcriptTurnsSince(convoId, agentId, sinceIso) {
    const transcript = loadTranscript(convoId) || [];
    return transcript
      .filter(t => t.role === 'agent' && t.agent === agentId && !t.type)
      .filter(t => !sinceIso || t.timestamp >= sinceIso)
      .map(t => t.text);
  }

  // Build the payload a parent agent receives when a delegate hands back:
  // every substantive turn, not just the last one.
  //
  // Incident (0.11.2): an analyst delivered a 6,665-char analysis in turn 1
  // and a 106-char sign-off in turn 2; only the sign-off reached the lead,
  // because finalResponseText holds one turn by design (responseText resets
  // per turn). The lead refused to invent the analysis and the user pasted
  // 6,050 chars by hand while the full report sat in the transcript on disk.
  //
  // Prefers in-memory accumulated turns (fast path); falls back to the
  // transcript, which survives process death and is authoritative.
  // Truncation over the cap is LOUD: the parent is told what was omitted and
  // where the full output lives, never silently handed a fragment.
  /**
   * @param {Pick<ProcessEntry, 'agentId'> & Partial<DelegationRecord>} entry
   * @param {string} convoId
   * @returns {string}
   */
  function buildHandbackPayload(entry, convoId) {
    const turns = (entry.deliveredTurns && entry.deliveredTurns.length)
      ? entry.deliveredTurns
      : transcriptTurnsSince(convoId, entry.agentId, entry.delegationStartedAt);
    const cleaned = turns.map(t => stripMarkers(t || '').trim()).filter(Boolean);
    const joined = cleaned.join('\n\n');
    if (joined.length <= maxChars) return joined;
    const omitted = joined.length - maxChars;
    return joined.substring(0, maxChars)
      + `\n\n[Handback truncated: ${omitted} of ${joined.length} characters omitted across ${cleaned.length} turn(s). Read the full output in .rundock/transcripts/${convoId}.json]`;
  }

  return { buildHandbackPayload, transcriptTurnsSince };
}

module.exports = { createHandbackBuilder };
