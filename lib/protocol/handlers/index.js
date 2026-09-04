'use strict';
// Dispatch table for the WS protocol handlers extracted from server.js.
// The composition root builds the table once (buildDispatch) and routes any
// message whose type appears here; the four root shims (chat, delegate,
// end_delegation, flush_buffer) are handled in server.js and never appear.
// save_agent keeps its legacy aliases (create_agent/update_agent) mapped to
// the same handler, exactly as the old if-chain did.
const workspace = require('./workspace.js');
const conversations = require('./conversations.js');
const history = require('./history.js');
const team = require('./team.js');
const files = require('./files.js');
const processControl = require('./process-control.js');
const runs = require('./runs.js');
const packages = require('./packages.js');

function buildDispatch() {
  return {
    permission_response: processControl.handlePermissionResponse,
    cancel: processControl.handleCancel,
    get_workspaces: workspace.handleGetWorkspaces,
    client_render_time: workspace.handleClientRenderTime,
    list_workspaces: workspace.handleListWorkspaces,
    set_workspace: workspace.handleSetWorkspace,
    pick_folder: workspace.handlePickFolder,
    create_workspace: workspace.handleCreateWorkspace,
    set_workspace_mode: workspace.handleSetWorkspaceMode,
    get_agents: team.handleGetAgents,
    get_runtime_status: team.handleGetRuntimeStatus,
    get_files: files.handleGetFiles,
    get_skills: team.handleGetSkills,
    get_run: runs.handleGetRun,
    cancel_routine_run: runs.handleCancelRoutineRun,
    plan_package_import: packages.handlePlanPackageImport,
    apply_package_import: packages.handleApplyPackageImport,
    get_conversations: conversations.handleGetConversations,
    set_last_active_conversation: conversations.handleSetLastActiveConversation,
    save_conversation: conversations.handleSaveConversation,
    get_lists: conversations.handleGetLists,
    create_list: conversations.handleCreateList,
    delete_list: conversations.handleDeleteList,
    delete_conversation: conversations.handleDeleteConversation,
    read_file: files.handleReadFile,
    add_to_team: team.handleAddToTeam,
    save_agent: team.handleSaveAgent,
    create_agent: team.handleSaveAgent,
    update_agent: team.handleSaveAgent,
    delete_agent: team.handleDeleteAgent,
    save_skill: team.handleSaveSkill,
    delete_skill: team.handleDeleteSkill,
    save_routine: team.handleSaveRoutine,
    delete_routine: team.handleDeleteRoutine,
    set_routine_paused: team.handleSetRoutinePaused,
    set_routine_enabled: team.handleSetRoutineEnabled,
    approve_routine_plan: team.handleApproveRoutinePlan,
    set_routine_schedule: team.handleSetRoutineSchedule,
    search_conversations: history.handleSearchConversations,
    search_universal: history.handleSearchUniversal,
    get_session_history: history.handleGetSessionHistory,
    save_file: files.handleSaveFile,
    create_path: files.handleCreatePath,
    reveal_in_finder: files.handleRevealInFinder,
  };
}

module.exports = { buildDispatch };
