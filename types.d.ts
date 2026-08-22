// Rundock core shapes. The single home for the types that flow between
// distant code: process entries, the delegation record, stream envelopes,
// the WS protocol, permission payloads, agent metadata, signal events.
//
// This is a DECLARATION file consumed by tsc --checkJs (see
// tsconfig.server.json / tsconfig.client.json). It emits nothing and ships
// nowhere: zero build step is a product requirement, so runtime files stay
// byte-identical source and their annotations live in ordinary JSDoc
// comments referencing these names.
//
// Precision policy: shapes consumed by opted-in modules are exact and the
// checker enforces them. Shapes only the monoliths touch (not yet opted in)
// are typed as faithfully as the call sites document today and tighten as
// decomposition brings their consumers under the checker. Do not widen a
// type to silence an error; fix the shape or the code.

// ---------------------------------------------------------------------------
// Delegation record: one field list, no drift
// ---------------------------------------------------------------------------

/** Durable state of one delegation, owned by lib/delegation/state.js. */
interface DelegationRecord {
  /** Every turn's text, accumulated for the handback. */
  deliveredTurns: string[];
  /** ISO timestamp bounding the transcript fallback. */
  delegationStartedAt: string;
  /** Agent calls from the delegating turn that were not run. */
  deferredTargets: string[] | null;
  /** Set by the marker scan. */
  returnMarkerSeen: 'complete' | 'return' | null;
  /** Last turn's text, retained for marker detection. */
  finalResponseText: string | undefined;
  /** Agent whose out-of-scope return produced this entry. */
  scopeReturnSource: string | null;
}

// The runtime field list in lib/delegation/state.js (RECORD_FIELDS) and this
// interface can never drift: the checker fails if either side gains or loses
// a field the other lacks. state.js derives its element type from the const
// list; these two lines assert set-equality with the interface keys.
type DelegationRecordField = (typeof import('./lib/delegation/state.js'))['RECORD_FIELDS'][number];
type _Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type _AssertRecordFieldsMatch = _Equal<DelegationRecordField, keyof DelegationRecord>;
declare const _recordFieldsMatch: _AssertRecordFieldsMatch; // resolves to `true` only when in sync

// ---------------------------------------------------------------------------
// Transcript and process entries
// ---------------------------------------------------------------------------

interface TranscriptEntry {
  role: 'user' | 'agent' | 'system';
  agent: string;
  text: string;
  /** ISO timestamp. */
  timestamp: string;
  type?: string;
}

/**
 * A live spawned runtime process for one conversation. Entries die and
 * respawn constantly by design (kill-and-respawn is how agent handoffs
 * work); state that must outlive a turn lives on the DelegationRecord, whose
 * fields attachDelegationRecord also exposes as pass-through entry
 * properties.
 */
interface ProcessEntry extends Partial<DelegationRecord> {
  process: import('child_process').ChildProcess;
  buffer: string;
  processId: number;
  agentId: string;
  responseText: string;
  exited: boolean;
  resultSent: boolean;
  pendingAgentTools: ToolCallRecord[] | null;
  toolCalls: ToolCallRecord[];
  turnStartTime: number;
  idle: boolean;
  /** Stale end_delegation guard (epoch ms). */
  handbackAt: number;
  /** The attached record itself; new code reads this, not the pass-throughs. */
  delegationRecord?: DelegationRecord;
  /** Parent linkage: who to restore on close (NOT this delegation's state). */
  delegation?: { parentAgentId: string; parentConvoId?: string } & Record<string, unknown>;
  sessionId?: string;
  runtime?: 'claude' | 'codex';
  scopeReturn?: boolean;
  scopeReturnMode?: 'complete' | 'return';
}

interface ToolCallRecord {
  tool: string;
  /** Primary argument summary (e.g. a Skill slug); never full arguments. */
  arg?: string;
}

// ---------------------------------------------------------------------------
// Runtime stream envelopes (stream-json, captured in
// scripts/stream-truth/captured-grammar.json from the real CLI)
// ---------------------------------------------------------------------------

type StreamEnvelope =
  | { type: 'system'; subtype: 'init'; session_id: string }
  | { type: 'system'; subtype: string }
  | { type: 'stream_event'; event: StreamEvent }
  | { type: 'assistant'; message: { role: 'assistant'; content: ContentBlock[] } }
  | { type: 'user'; message: { role: 'user'; content: string | ContentBlock[] } }
  | { type: 'result'; subtype: 'success' | string; is_error: boolean; result: string; session_id?: string; duration_ms?: number };

type StreamEvent =
  | { type: 'message_start' }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } | { type: 'thinking_delta' | 'signature_delta' } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason: string | null; stop_sequence: string | null }; usage: Record<string, unknown> }
  | { type: 'message_stop' };

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> }
  // `is_error` marks a tool call that failed. Declared because
  // lib/runtime/session-transcript.js decides on it: it is the only thing
  // separating a write that happened from one that was refused, and a list of
  // attempted writes is not a list of files changed. Witnessed by the
  // committed transcript capture (scripts/transcript-truth), not by a fixture
  // this repository wrote.
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'thinking' };

// ---------------------------------------------------------------------------
// WS protocol: every message type the server dispatches on, as a
// discriminated union. Fields are exact where the handler's reads are
// pinned by tests; they tighten as the WS dispatch area comes under the
// checker during decomposition.
// ---------------------------------------------------------------------------

type WsClientMessage =
  | { type: 'chat'; conversationId: string; content: string; agentId?: string; codeMode?: boolean }
  | { type: 'cancel'; conversationId: string }
  | { type: 'delegate'; conversationId: string; agentId: string; prompt?: string }
  | { type: 'end_delegation'; conversationId: string }
  | { type: 'flush_buffer'; conversationId: string }
  | { type: 'permission_response'; requestId: string; conversationId: string; allow: boolean; grantDir?: string }
  | { type: 'save_agent'; name: string; content: string }
  | { type: 'create_agent'; name: string; content: string }
  | { type: 'update_agent'; name: string; content: string }
  | { type: 'delete_agent'; name: string }
  | { type: 'add_to_team'; name: string }
  | { type: 'get_agents' }
  | { type: 'get_conversations' }
  | { type: 'save_conversation'; conversation: ConversationRecord }
  | { type: 'delete_conversation'; conversationId: string }
  | { type: 'set_last_active_conversation'; conversationId: string }
  | { type: 'get_session_history'; conversationId: string }
  | { type: 'search_conversations'; query: string }
  | { type: 'search_universal'; query: string }
  | { type: 'get_files' }
  | { type: 'read_file'; path: string }
  | { type: 'save_file'; path: string; content: string }
  | { type: 'create_path'; path: string; kind?: 'file' | 'folder' }
  | { type: 'reveal_in_finder'; path: string }
  | { type: 'get_skills' }
  | { type: 'save_skill'; name: string; content: string }
  | { type: 'delete_skill'; name: string }
  | { type: 'get_lists' }
  | { type: 'create_list'; name: string }
  | { type: 'delete_list'; name: string }
  | { type: 'get_workspaces' }
  | { type: 'list_workspaces' }
  | { type: 'create_workspace'; path: string }
  | { type: 'set_workspace'; path: string }
  | { type: 'set_workspace_mode'; mode: string }
  | { type: 'pick_folder' }
  | { type: 'get_runtime_status' }
  | { type: 'client_render_time'; ms: number };

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** POSTed by scripts/permission-hook.js to /api/permission-request. */
interface PermissionRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id?: string;
  conversation_id?: string;
  /** True when the target path is outside the workspace boundary. */
  boundary?: boolean;
  /** Absolute path the tool will really touch (boundary cards name it). */
  resolved_path?: string;
  /** Folder a standing grant would cover. */
  grant_dir?: string;
}

/** The hook's stdout decision, consumed by the Claude runtime. */
interface PermissionDecision {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

// ---------------------------------------------------------------------------
// Agents, conversations, signals
// ---------------------------------------------------------------------------

/** Parsed agent frontmatter + body, as discovery returns it. */
interface AgentMetadata {
  id: string;
  name: string;
  displayName?: string;
  role?: string;
  type?: 'orchestrator' | 'specialist' | 'platform' | string;
  order?: number;
  reportsTo?: string | null;
  model?: string;
  runtime?: 'claude' | 'codex';
  isOrchestrator?: boolean;
  instructions?: string;
  filePath?: string;
}

interface ConversationRecord {
  id: string;
  title?: string;
  agentId?: string;
  createdAt?: string;
  updatedAt?: string;
  workspace?: string;
}

/**
 * One line of .rundock/state/events-YYYY-MM.jsonl (the signal layer).
 * Structure only, never message content or tool arguments.
 */
interface SignalEvent {
  /** ISO timestamp. */
  ts: string;
  /** Event name. */
  e: 'turn' | 'delegation_start' | 'delegation_error' | 'handback' | 'permission'
    | 'routine_run' | 'runtime_error' | 'marker_error' | 'circuit_breaker' | 'docs_gap';
  conv?: string;
  agent?: string;
  runtime?: string;
  /** Event-specific structure (counts, slugs, outcomes). */
  d: Record<string, unknown>;
}
