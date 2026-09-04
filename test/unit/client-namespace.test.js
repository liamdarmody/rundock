'use strict';
// The client's global namespace, guarded.
//
// The nine modules under public/views/ republish every function they export
// onto the root object, because index.html's inline handlers, generated
// onclick attributes and cross-module calls all resolve these names as bare
// window properties. That is deliberate and load-bearing, and it has one sharp
// edge: two modules exporting the same name silently clobber each other, the
// winner decided by script order in index.html, with nothing thrown and
// nothing warned. A function would keep working until someone added a module,
// then quietly become a different function.
//
// Until now this was checked by one person running a throwaway script by hand
// on each extraction slice. The extraction work is finished, so the hand check
// would simply stop being run.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const VIEWS = path.join(PUBLIC, 'views');

// The public surface of each view module, exactly. Adding or removing a name
// here is the deliberate edit: a surface that appears without a matching entry
// fails the manifest test, which is the point. Sorted so diffs stay readable.
const MANIFEST = {
  "chat.js": [
    "addAgentMsg",
    "addSystemMsg",
    "addUserMsg",
    "agentDisplayName",
    "buildActivitySummary",
    "buildDelegationDivider",
    "cancelProcessing",
    "classifyRisk",
    "copyAuthCmd",
    "createHistoryDivider",
    "describeToolRequest",
    "dispatchMessage",
    "finishProcessing",
    "formatToolName",
    "formatToolShort",
    "handleActiveProcesses",
    "handlePermissionRequest",
    "renderAuthErrorCard",
    "renderCodexErrorPill",
    "renderCodexGuidanceCard",
    "renderCodexQuotaCard",
    "renderPendingPermissionCards",
    "renderPermissionCard",
    "renderSessionHistory",
    "resolvePermissionCard",
    "respondPermission",
    "scrollBottom",
    "sendMessage",
    "startProcessing",
    "toolAllowKey",
  ],
  "conversations.js": [
    "archiveConversation",
    "closeConvoMenu",
    "convoMenuEsc",
    "convoStateDot",
    "createConversation",
    "deleteConversation",
    "discardIfEmpty",
    "formatRecency",
    "handlePersistedConversations",
    "maybeShowCodexFirstRun",
    "newConversation",
    "openConversation",
    "openConvoListMenu",
    "openConvoMenu",
    "persistConversation",
    "renameConversation",
    "renderConvoItem",
    "renderConvoList",
    "renderListPills",
    "sendPrompt",
    "setSidebarPill",
    "setupChat",
    "startConversation",
    "startSetupConversation",
    "toggleConvoListMembership",
    "toggleConvoStatus",
    "togglePin",
  ],
  "files.js": [
    "attachArtifactReviewForCurrentFile",
    "buildFloatingMenu",
    "buildTree",
    "closeFilesMenu",
    "closeOpenFile",
    "contentForKind",
    "creationRow",
    "currentLiveContent",
    "destroyActiveArtifactReview",
    "destroyActiveFileViewer",
    "destroyTiptapEditorIfActive",
    "editorGoBack",
    "findFileInTree",
    "flushBoardSave",
    "getFileContentForSave",
    "handleExternalFileChange",
    "hideExternalEditConflict",
    "highlightFileInSidebar",
    "initTiptapEditor",
    "loadFileContent",
    "loadTiptapEditorModule",
    "loadViewersModule",
    "menuIconSvg",
    "onTiptapEditorUpdate",
    "openBinaryOrUnsupportedFile",
    "openBoardFile",
    "openCreateMenu",
    "openLegacyTextFile",
    "openMarkdownFile",
    "openRowContextMenu",
    "openSkillFile",
    "openWikilink",
    "openWorkspaceFilePath",
    "paletteFileIcon",
    "promptCreate",
    "renderEditorContent",
    "renderFileTree",
    "saveFileGuarded",
    "saveTiptapFile",
    "setEditorMode",
    "showExternalEditConflict",
    "treeIconSvg",
    "updateEditorBackButton",
  ],
  "find.js": [
    "clearArtifactFind",
    "clearFindMatches",
    "closeFindBar",
    "detectFindBackend",
    "ensureArtifactFindStyle",
    "escapeOverlay",
    "frameRangeFor",
    "frameTextIndex",
    "gotoNextFindMatch",
    "gotoPrevFindMatch",
    "initFindBar",
    "isFindHotkey",
    "openFindBar",
    "paintArtifactHighlights",
    "removeTextareaOverlay",
    "runArtifactFind",
    "runFindSearch",
    "runTextareaFind",
    "scrollArtifactMatch",
    "scrollTextareaMatch",
    "searchDomSubtree",
    "setCurrentFindMatch",
    "syncTiptapFindStateFromPlugin",
    "updateFindButtons",
    "updateFindCount",
    "updateTextareaOverlay",
  ],
  "palette.js": [
    "closePalette",
    "handlePaletteResults",
    "hoverPaletteItem",
    "movePaletteSelection",
    "openPalette",
    "openPaletteResult",
    "paletteHl",
    "paletteItemHtml",
    "paletteOpenConversation",
    "paletteOpenFile",
    "paletteOpenSkill",
    "paletteSnippetPlain",
    "renderPalette",
    "renderPaletteStatus",
    "runPaletteSearch",
    "schedulePaletteSearch",
    "setPaletteScope",
    "togglePalette",
    "tryMessageAnchor",
    "updatePaletteSelection",
  ],
  "profile.js": [
    "showProfile",
  ],
  // The routine editor. Its surface is wider than the other views because
  // every step and every field is reached from a generated handler, and a
  // handler resolves by bare name at click time.
  "routine-editor.js": [
    "addRoutine",
    "addRoutineForAgent",
    "addRoutineForSkill",
    "browserTimezone",
    "editRoutineSchedule",
    "openRoutineEditor",
    "renderRoutineEditor",
    "routineEditorBuildSkill",
    "routineEditorFailed",
    "routineEditorHtml",
    "routineEditorLeave",
    "routineEditorPick",
    "routineEditorRunOn",
    "routineEditorSaved",
    "routineEditorSetField",
    "routineEditorSkillsArrived",
    "routineEditorStep",
    "routinesListNav",
    "saveRoutine",
  ],
  "routines-panel.js": [
    "renderRoutinesPanel",
    "routinesPanelAdd",
    "routinesPanelReset",
    "routinesScopeAgentId",
    "setRoutinesScope",
  ],
  "routines.js": [
    "renderRoutines",
    "routinesActionCleared",
    "routinesActionFailed",
    "routinesAskDelete",
    "routinesCancelDelete",
    "routinesConfirmDelete",
    "routinesEditSchedule",
    "routinesOpenSkill",
    "routinesSetEnabled",
    "routinesSetPaused",
    "routinesViewLastRun",
    "showRoutinesForAgent",
  ],
  "run-detail.js": [
    "openRunDetail",
    "renderRunDetail",
    "runArrived",
    "runDetailBack",
    "runDetailRosterUpdated",
    "runDetailStop",
    "stopRequestArrived",
  ],
  "settings.js": [
    "changeWorkspace",
    "extensionBack",
    "extensionConfirm",
    "extensionDecline",
    "extensionReplyArrived",
    "extensionSubmit",
    "packagesCancel",
    "packagesConfirm",
    "packagesConnectionLost",
    "packagesReplyArrived",
    "packagesRetry",
    "packagesSubmit",
    "packagesWorkspaceChanged",
    "renderRuntimesCard",
    "renderSettingsSection",
    "runtimeRowHtml",
    "runtimesCardHtml",
    "setWorkspaceMode",
    "showSettingsSection",
  ],
  "skills.js": [
    "renderSkills",
    "renderSkillsEmpty",
    "renderSkillsIfEmpty",
    "renderSkillsSidebar",
    "selectSkill",
  ],
  "team.js": [
    "addToTeam",
    "getWorkingAgentIds",
    "orgCardHtml",
    "orgZoom",
    "renderAgentList",
    "renderConvoEmptyAgents",
    "renderOrgChart",
  ],};

function viewModules() {
  return fs.readdirSync(VIEWS).filter(f => f.endsWith('.js')).sort();
}

function exportsOf(file) {
  const p = path.join(VIEWS, file);
  delete require.cache[require.resolve(p)];
  return Object.keys(require(p)).sort();
}

// Every hand-written client script plus index.html, which is where the inline
// handlers live. Vendored trees are third-party and the editor bundle is
// generated, so neither is ours to hold to this.
function clientSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (['vendor', 'editor'].includes(entry.name)) continue;
      clientSources(path.join(dir, entry.name), out);
    } else if ((entry.name.endsWith('.js') || entry.name.endsWith('.html')) && !entry.name.endsWith('.min.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// Comments mention names constantly (module headers list their dependencies),
// and a mention is not a call. Strip them before looking for uses.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

function declarationRe(name) {
  return new RegExp('^\\s*(?:async )?function ' + name + '\\b|^\\s*(?:const|let|var) ' + name + '\\b');
}

test('no two view modules claim the same global name', () => {
  const claimedBy = new Map();
  const collisions = [];
  for (const file of viewModules()) {
    for (const name of exportsOf(file)) {
      if (claimedBy.has(name)) collisions.push(`${name}: ${claimedBy.get(name)} and ${file}`);
      else claimedBy.set(name, file);
    }
  }
  assert.deepStrictEqual(collisions, [], 'two modules republish the same name; script order in index.html decides the winner silently');
});

test('no view module claims a name app.js already declares at top level', () => {
  // app.js is a classic script too, so its top-level declarations are window
  // properties competing in the same namespace.
  const src = stripComments(fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf-8'));
  const appTop = new Set();
  for (const line of src.split('\n')) {
    const m = /^(?:async )?function (\w+)|^(?:const|let|var) (\w+)/.exec(line);
    if (m) appTop.add(m[1] || m[2]);
  }
  assert.ok(appTop.size > 50, `sanity: found ${appTop.size} top-level declarations in app.js`);
  const clashes = [];
  for (const file of viewModules()) {
    for (const name of exportsOf(file)) if (appTop.has(name)) clashes.push(`${name}: app.js and ${file}`);
  }
  assert.deepStrictEqual(clashes, [], 'a view module republishes a name app.js also declares');
});

test('the republished surface matches the manifest exactly', () => {
  const actual = {};
  for (const file of viewModules()) actual[file] = exportsOf(file);
  assert.deepStrictEqual(actual, MANIFEST);
});

test('every republished name is used somewhere by its bare name', () => {
  // Republication exists so that a BARE name resolves. A member access through
  // a namespace (RundockPalette.normAnchorText) needs no republication, so it
  // is not evidence the republished name is used; the lookbehind excludes it.
  //
  // A file that declares its own version of the name is skipped, because by JS
  // scoping a bare call inside it resolves to that local declaration and not to
  // the global. Without this the check reports a dead wrapper as alive whenever
  // some other module happens to define the same name, which is exactly how the
  // records came to claim the wrong two functions were dead.
  const owner = new Map();
  for (const file of viewModules()) for (const name of exportsOf(file)) owner.set(name, file);

  const sources = clientSources(PUBLIC)
    .concat(clientSources(path.join(__dirname, '..', '..', 'test')))
    .map(f => [f, stripComments(fs.readFileSync(f, 'utf-8')).split('\n')]);

  const unused = [];
  for (const [name, file] of owner) {
    const ownerPath = path.join(VIEWS, file);
    const decl = declarationRe(name);
    const bare = new RegExp('(?<![.\\w$])' + name + '\\b');
    let used = false;
    for (const [f, lines] of sources) {
      if (f !== ownerPath && lines.some(l => decl.test(l))) continue;
      let exportStart = -1, exportEnd = -1;
      if (f === ownerPath) {
        for (let i = lines.length - 1; i >= 0; i--) if (/^\s*return \{/.test(lines[i])) { exportStart = i; break; }
        if (exportStart >= 0) for (let i = exportStart; i < lines.length; i++) if (/^\s*\};/.test(lines[i])) { exportEnd = i; break; }
      }
      for (let i = 0; i < lines.length; i++) {
        if (!bare.test(lines[i])) continue;
        if (f === ownerPath) {
          if (decl.test(lines[i])) continue;
          if (exportStart >= 0 && i >= exportStart && i <= exportEnd) continue;
        }
        used = true; break;
      }
      if (used) break;
    }
    if (!used) unused.push(`${name} (${file})`);
  }
  assert.deepStrictEqual(unused.sort(), [], 'republished but never called by its bare name: delete it, or stop exporting it');
});
