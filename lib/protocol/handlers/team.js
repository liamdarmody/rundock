'use strict';
// WS handlers: agent and skill CRUD plus roster/runtime queries.
// Agents live in .claude/agents/{name}.md, skills in
// .claude/skills/{name}/SKILL.md; SAVE (upsert) and DELETE are triggered by
// RUNDOCK:SAVE_AGENT / RUNDOCK:SAVE_SKILL markers in agent responses (the
// server-side path bypasses Claude Code's .claude/ protection). Extracted
// verbatim from server.js. The root owns the cache cascade, skill
// discovery, roster-refresh flagging, setup completion, slug validation,
// and the boundary guard: all injected via ctx. Workspace read at USE time.
const fs = require('fs');
const path = require('path');
const { getWorkspace } = require('../../config.js');
const { discoverAgents, rosterMessage, parseAgentFrontmatter } = require('../../agents/discovery.js');
const { appendRoutineBlock, removeRoutineBlock, updateRoutineBlock, readRoutineBlock, readRoutineBlocks , computePlanHash, normalizeRoutine } = require('../../agents/routines.js');

function handleGetAgents(ctx, ws, msg) {
  if (!getWorkspace()) { ws.send(JSON.stringify({ type: 'needs_workspace' })); return; }
  let agentList = [];
  try { agentList = discoverAgents(); } catch (e) { console.warn('  Agent discovery failed:', e.message); }
  ws.send(JSON.stringify(rosterMessage(agentList)));
}

function handleGetRuntimeStatus(ctx, ws, msg) {
  ws.send(JSON.stringify({ type: 'runtime_status', ...ctx.runtime.getRuntimeStatus() }));
}

function handleGetSkills(ctx, ws, msg) {
  let skillList = [];
  try { skillList = ctx.agents.discoverSkills(); } catch (e) { console.warn('  Skill discovery failed:', e.message); }
  ws.send(JSON.stringify({ type: 'skills', skills: skillList }));
}

function handleAddToTeam(ctx, ws, msg) {
  // Assign the next order number to an available agent
  const agentList = discoverAgents();
  const target = agentList.find(a => a.id === msg.agentId);
  if (target && target.fileName) {
    const maxOrder = Math.max(0, ...agentList.filter(a => a.order !== null).map(a => a.order));
    const nextOrder = maxOrder + 1;
    const filePath = path.join(getWorkspace(), '.claude', 'agents', target.fileName);
    let content = fs.readFileSync(filePath, 'utf-8');
    // Add or update order field in frontmatter
    if (content.match(/^order:\s/m)) {
      content = content.replace(/^order:\s.*/m, `order: ${nextOrder}`);
    } else {
      // Add order after the type field, else after the description LINE,
      // else after the opening fence (save_agent's proven insert). The old
      // fallback (`description:[\s\S]*?\n\w`) jumped the closing fence on a
      // name+description-only agent and wrote the order into the BODY, where
      // discovery never saw it, so the join silently did nothing.
      content = content.replace(/^(type:\s.*)/m, `$1\norder: ${nextOrder}`);
      if (!content.match(/^order:/m)) {
        content = content.replace(/^(description:\s.*)/m, `$1\norder: ${nextOrder}`);
      }
      if (!content.match(/^order:/m)) {
        content = content.replace(/^(---[ \t]*\r?\n)/, `$1order: ${nextOrder}\n`);
      }
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    // Invalidate before rediscovering: the roster cache was populated
    // at the top of this handler, so without this the agents message
    // would answer with the recruit still order-less and the client
    // would not show the join until a later refresh.
    ctx.agents.invalidateAgentCache();
    ws.send(JSON.stringify(rosterMessage()));
  }
}

// save_agent: upsert (create or update). Also handles legacy 'create_agent' and 'update_agent'.
function handleSaveAgent(ctx, ws, msg) {
  const name = msg.name || msg.agentId;
  if (!ctx.agents.validateAgentSlug(name)) {
    ws.send(JSON.stringify({ type: 'agent_error', message: 'Invalid agent name. Use lowercase letters, numbers, and hyphens only.' }));
  } else {
    const agentsDir = path.join(getWorkspace(), '.claude', 'agents');
    if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });
    const filePath = path.join(agentsDir, name + '.md');
    if (!ctx.workspace.isInsideWorkspace(filePath)) {
      ws.send(JSON.stringify({ type: 'agent_error', message: 'Invalid path.' }));
    } else {
      const existed = fs.existsSync(filePath);
      fs.writeFileSync(filePath, msg.content, 'utf-8');
      // For new agents: auto-assign type and order so they go straight to team
      if (!existed) {
        let saved = fs.readFileSync(filePath, 'utf-8');
        const hasType = saved.match(/^type:\s/m);
        const hasOrder = saved.match(/^order:\s/m);
        if (!hasType || !hasOrder) {
          const currentAgents = discoverAgents();
          const maxOrder = Math.max(0, ...currentAgents.filter(a => a.order !== null).map(a => a.order));
          if (!hasType && !hasOrder) {
            // No type or order: add both after description, else as the
            // first keys inside the frontmatter block. The previous
            // `^(---\s*$)/m` matched the OPENING fence and prepended the
            // keys BEFORE it, corrupting the frontmatter so the declared
            // name/role parsed as body. Anchor to the opening fence
            // line and insert AFTER it instead.
            if (saved.match(/^description:\s/m)) {
              saved = saved.replace(/^(description:\s.*)/m, `$1\ntype: specialist\norder: ${maxOrder + 1}`);
            } else {
              // KNOWN LIMITATION: this anchor skips if a BOM or leading whitespace precedes the opening fence. Low bite.
              saved = saved.replace(/^(---[ \t]*\r?\n)/, `$1type: specialist\norder: ${maxOrder + 1}\n`);
            }
          } else if (hasType && !hasOrder) {
            // Has type but no order: add order after type
            saved = saved.replace(/^(type:\s.*)/m, `$1\norder: ${maxOrder + 1}`);
          }
          fs.writeFileSync(filePath, saved, 'utf-8');
        }
      }
      console.log(`[Agent] ${existed ? 'Updated' : 'Created'}: ${name}`);
      // Tag the confirmation with the agent's runtime so the client can
      // suffix the created pill for non-default runtimes.
      const savedRuntime = String(parseAgentFrontmatter(msg.content).runtime || '').toLowerCase() === 'codex' ? 'codex' : 'claude';
      ws.send(JSON.stringify({ type: 'agent_saved', agentId: name, updated: existed, runtime: savedRuntime }));
      // Invalidate BEFORE discovering so the broadcast reflects the new
      // file. A warm (<2s) cache otherwise omits the just-saved agent
      // from this first roster broadcast.
      ctx.agents.invalidateAgentCache();
      const updatedAgents = discoverAgents();
      ws.send(JSON.stringify(rosterMessage(updatedAgents)));
      ws.send(JSON.stringify({ type: 'skills', skills: ctx.agents.discoverSkills(updatedAgents) }));
      ctx.agents.flagRosterRefresh();
      if (!existed) ctx.agents.maybeCompleteSetup(updatedAgents);
    }
  }
}

function handleDeleteAgent(ctx, ws, msg) {
  const agentList = discoverAgents();
  const target = agentList.find(a => a.id === msg.agentId);
  if (!target || !target.fileName) {
    ws.send(JSON.stringify({ type: 'agent_error', message: `Agent "${msg.agentId}" not found.` }));
  } else if (target.type === 'platform') {
    ws.send(JSON.stringify({ type: 'agent_error', message: 'Cannot delete platform agents.' }));
  } else {
    const filePath = path.join(getWorkspace(), '.claude', 'agents', target.fileName);
    if (ctx.workspace.isInsideWorkspace(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[Agent] Deleted: ${msg.agentId}`);
      ws.send(JSON.stringify({ type: 'agent_deleted', agentId: msg.agentId }));
      ctx.agents.invalidateAgentCache(); // before discovery so the broadcast omits the deleted agent
      const updatedAgents = discoverAgents();
      ws.send(JSON.stringify(rosterMessage(updatedAgents)));
      ws.send(JSON.stringify({ type: 'skills', skills: ctx.agents.discoverSkills(updatedAgents) }));
      ctx.agents.flagRosterRefresh();
    }
  }
}

/**
 * save_routine: add a routine to the agent file that declares it.
 *
 * WHY IT IS AN APPEND AND NOT A FILE WRITE. A routine lives in frontmatter
 * that also carries keys this code has never heard of, alongside routines
 * somebody wrote by hand. The data model's append path edits LINES and carries
 * every other byte through, so the risk here is not the routine going in
 * wrong, it is everything else coming out changed.
 *
 * NOTHING IS WRITTEN UNTIL THE WHOLE ROUTINE HAS BEEN ACCEPTED. The new
 * content is computed first and the file is opened for writing only if that
 * returned. A rejected routine therefore leaves the file exactly as it was,
 * rather than half of one.
 */
function handleSaveRoutine(ctx, ws, msg) {
  const fail = (message) => ws.send(JSON.stringify({ type: 'routine_error', message }));
  const routine = msg && msg.routine;
  if (!routine) { fail('A routine is required.'); return; }

  const agentList = discoverAgents();
  const target = agentList.find(a => a.id === msg.agentId);
  if (!target || !target.fileName) { fail(`Agent "${msg.agentId}" not found.`); return; }

  const filePath = path.join(getWorkspace(), '.claude', 'agents', target.fileName);
  if (!ctx.workspace.isInsideWorkspace(filePath)) { fail('That agent is outside the workspace.'); return; }

  const before = fs.readFileSync(filePath, 'utf-8');
  let next;
  try {
    next = appendRoutineBlock(before, routine);
  } catch (e) {
    // The data model refused it: a name it cannot write, a run target that is
    // reserved, or a file it cannot place a routine in. Say so rather than
    // writing something unrunnable.
    fail(e && e.message ? e.message : 'That routine could not be written.');
    return;
  }
  // A WRITE THAT CHANGES NOTHING IS NOT A SAVE. The model refuses every case
  // it knows of, and this is the backstop for the ones it does not: identical
  // bytes mean the routine is not in the file, whatever the reason, and
  // announcing it saved would be the worst outcome this path has, because the
  // user is returned to a list that does not contain what they just made and
  // nothing anywhere says so.
  if (next === before) { fail('That routine could not be written to this agent.'); return; }
  fs.writeFileSync(filePath, next, 'utf-8');
  console.log(`[Routine] Added to ${target.id}: ${routine.name}`);

  // Announced through the shared path below, which every routine change uses.
  // Three handlers writing the same four lines is three places for the
  // invalidate-before-broadcast ordering to be got wrong independently.
  announceRoutineChange(ctx, ws, { type: 'routine_saved', agentId: target.id, name: routine.name });
}

/**
 * How a refused pause or delete answers, and it is NOT the save road's answer.
 *
 * WHY THESE TWO NEED THEIR OWN MESSAGE. `routine_error` belongs to the save
 * flow: the client hands it to the editor's save-failure callback and posts it
 * to the conversation transcript. Sent for a refused delete it would invoke a
 * save callback outside any save, and put the only thing the user sees on a
 * screen they are not looking at, while the routines list they pressed the
 * control on says nothing at all. A reply that is correct and arrives in the
 * wrong place is the defect the editor card was built around.
 *
 * It carries the agent and the routine as well as the words, so the surface
 * that receives it can say which row the answer is about rather than showing a
 * loose sentence.
 */
function routineActionRefusal(ws, msg) {
  return (message) => ws.send(JSON.stringify({
    type: 'routine_action_error',
    agentId: msg && msg.agentId ? msg.agentId : null,
    name: msg && msg.name ? msg.name : null,
    message,
  }));
}

/**
 * The file a routine is declared in, or a refusal saying why not.
 *
 * Shared by the two handlers below because they refuse the same three things
 * for the same three reasons, and two copies of a refusal is how one of them
 * ends up admitting something the other does not.
 */
function locateRoutineFile(ctx, msg, fail) {
  const name = msg && msg.name;
  if (!name) { fail('A routine name is required.'); return null; }
  // WHICH BLOCK OF THAT NAME, and it is required rather than defaulted.
  //
  // Nothing makes a routine name unique within an agent file, and
  // appendRoutineBlock counts namesakes on purpose so a second can be written
  // through the interface. Defaulting a missing occurrence to zero would make
  // every caller that forgot it act on the first namesake silently, which is
  // the exact defect: a confirmation naming the routine the reader pointed at,
  // and a removal taking a different one.
  const occurrence = msg && msg.occurrence;
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    fail('Which routine of that name is required.');
    return null;
  }
  const target = discoverAgents().find(a => a.id === msg.agentId);
  if (!target || !target.fileName) { fail(`Agent "${msg.agentId}" not found.`); return null; }
  // WHETHER THE ROUTINE IS THERE IS NOT ASKED HERE, and that is deliberate.
  // The roster is a parse of the file, and the two handlers below check the
  // file itself either side of their write, which is the stronger question and
  // the one that also catches a file this module cannot address at all. A
  // second check against the roster would refuse the same cases one step
  // earlier while being unable to fail on its own, which is a guard no test
  // can notice.
  const filePath = path.join(getWorkspace(), '.claude', 'agents', target.fileName);
  if (!ctx.workspace.isInsideWorkspace(filePath)) { fail('That agent is outside the workspace.'); return null; }
  return { target, filePath, name, occurrence };
}

/**
 * Announce a routine change and put the roster back out.
 *
 * INVALIDATE BEFORE DISCOVERING, so the broadcast describes the file as it now
 * is rather than a warm cache that still holds what was just changed.
 */
function announceRoutineChange(ctx, ws, message) {
  ws.send(JSON.stringify(message));
  ctx.agents.invalidateAgentCache();
  ws.send(JSON.stringify(rosterMessage()));
  ctx.agents.flagRosterRefresh();
}

/**
 * delete_routine: take a routine out of the agent file that declares it.
 *
 * A WRITE THAT CHANGES NOTHING IS NOT A DELETE. The data model returns the
 * content unchanged for a name it cannot find, and announcing a deletion in
 * that case is the worst outcome this path has: the reader is returned to a
 * list that still contains what they just removed, with nothing anywhere
 * saying so. Identical bytes are refused instead, and nothing is written.
 */
function handleDeleteRoutine(ctx, ws, msg) {
  const fail = routineActionRefusal(ws, msg);
  const found = locateRoutineFile(ctx, msg, fail);
  if (!found) return;

  const before = fs.readFileSync(found.filePath, 'utf-8');
  const next = removeRoutineBlock(before, found.name, found.occurrence);
  // ASK WHETHER THE BLOCK WENT, not whether the bytes moved. Unchanged content
  // means two different things: no block of that name was there, and the
  // file's frontmatter could not be addressed at all, which is what a CRLF
  // checkout produces and which discovery hides by normalising line endings
  // when it READS one. A deletion announced for the second is a routine the
  // user believes is gone and which fires again tomorrow morning.
  //
  // COUNTED, not looked up by index. Removing the first of two namesakes
  // leaves the second sitting at the index the first had, so asking whether
  // that index is occupied would report a successful delete as a failure. One
  // block of that name has to have gone, and exactly one.
  if (readRoutineBlocks(next, found.name).length !== readRoutineBlocks(before, found.name).length - 1) {
    fail(`Routine "${found.name}" could not be removed from that agent's file.`);
    return;
  }
  fs.writeFileSync(found.filePath, next, 'utf-8');
  console.log(`[Routine] Deleted from ${found.target.id}: ${found.name}`);

  announceRoutineChange(ctx, ws, { type: 'routine_deleted', agentId: found.target.id, name: found.name });
}

/**
 * Set ONE boolean field on one routine, and say so.
 *
 * WHY THIS IS SHARED RATHER THAN WRITTEN TWICE. This file already extracted
 * routineActionRefusal, locateRoutineFile and announceRoutineChange on the
 * stated grounds that two copies of a refusal is how one ends up admitting
 * something the other does not. The read-back guard below is exactly that kind
 * of logic, and it was copied once before this comment was written.
 *
 * ASK WHETHER THE FIELD SAYS WHAT WAS ASKED FOR, not whether the bytes moved.
 * Unchanged content means two different things: the routine was already in
 * this state, and the file's frontmatter could not be addressed at all, which
 * is what a checkout with Windows line endings produces and which discovery
 * hides by normalising line endings when it READS one. Reading unchanged bytes
 * as success announces a routine stopped that is still scheduled to run.
 *
 * Once the field is confirmed to hold the asked value, identical bytes mean
 * one thing only: a second press, or two clients asking at once. Nothing to
 * write, and nothing to complain about.
 *
 * @param {string} field the routine key to set
 * @param {string} replyType the message type the client is listening for
 * @param {(value: boolean) => string} verb what happened, lower case and in
 *   the past, given the value being written. It reads inside a sentence in the
 *   refusal and is capitalised for the log, so it is written once in the case
 *   the sentence needs rather than twice in two cases.
 */
function setRoutineFlag(ctx, ws, msg, { field, replyType, verb }) {
  const fail = routineActionRefusal(ws, msg);
  const found = locateRoutineFile(ctx, msg, fail);
  if (!found) return;

  const value = !!(msg && msg[field]);
  writeRoutineField(ctx, ws, found, {
    field,
    value,
    refuse: () => fail(`Routine "${found.name}" could not be ${verb(value)}.`),
    reply: { type: replyType, agentId: found.target.id, name: found.name, [field]: value },
    said: verb(value),
  });
}

/**
 * Put one value on one routine, confirm it landed, and announce it.
 *
 * THE READ-BACK GUARD LIVES HERE AND IN NO OTHER HANDLER, which is the reason
 * this function exists rather than being inlined into the two that call it. The
 * guard was already copied once, and this file has extracted three helpers on
 * the stated grounds that two copies of a refusal is how one of them ends up
 * admitting something the other does not. A schedule edit is the third writer
 * on this road; a third copy would be the point at which they start to drift.
 *
 * ASK WHETHER THE FIELD SAYS WHAT WAS ASKED FOR, not whether the bytes moved.
 * Unchanged content means two different things: the routine was already in this
 * state, and the file's frontmatter could not be addressed at all, which is what
 * a checkout with Windows line endings produces and which discovery hides by
 * normalising line endings when it READS one. Reading unchanged bytes as success
 * announces a routine moved to the afternoon that still fires in the morning.
 *
 * Once the field is confirmed to hold the asked value, identical bytes mean one
 * thing only: a second press, or two clients asking at once. Nothing to write,
 * and nothing to complain about.
 *
 * THE WRITER CAN REFUSE THE VALUE ITSELF, and it does for a schedule. Nothing
 * is written when it does: the new content is computed first and the file is
 * opened for writing only if that returned, so a rejected value leaves the file
 * exactly as it was rather than half of one.
 *
 * @param {{field: string, value: any, refuse: (why: string|null) => void,
 *          reply: object, said: string}} what
 *   `refuse` is how the CALLER answers, because the two callers answer on two
 *   different roads: a row's controls answer the routines list, and an edit
 *   answers the editor the reader is still looking at. It is handed the
 *   writer's own words when the writer supplied any, and nothing when the
 *   refusal is that the write did not land.
 */
function writeRoutineField(ctx, ws, found, { field, value, fields, refuse, reply, said }) {
  // One field for the flag writers, several for a writer whose record is two
  // keys that must land together, such as the approval's hash and moment.
  // One updates shape either way, so the guard below asks the same question
  // of every key that was meant to land.
  const updates = fields || { [field]: value };
  const before = fs.readFileSync(found.filePath, 'utf-8');
  let next;
  try {
    next = updateRoutineBlock(before, found.name, updates, found.occurrence);
  } catch (e) {
    // The data model refused the value: a schedule nothing can read, a line
    // break, a field name it will not write. Say so rather than writing
    // something the scheduler will never fire.
    refuse(e && e.message ? e.message : null);
    return;
  }
  const written = readRoutineBlock(next, found.name, found.occurrence);
  if (!written || Object.entries(updates).some(([key, wanted]) => written[key] !== wanted)) {
    refuse(null);
    return;
  }
  if (next !== before) {
    fs.writeFileSync(found.filePath, next, 'utf-8');
    console.log(`[Routine] ${said.charAt(0).toUpperCase()}${said.slice(1)} on ${found.target.id}: ${found.name}`);
  }
  announceRoutineChange(ctx, ws, reply);
}

/**
 * set_routine_paused: stop a routine happening, or start it again.
 *
 * PAUSING IS NOT RESCHEDULING. It writes one field and leaves the schedule,
 * the prompt and every other key exactly where they were, so a routine resumed
 * later is the same routine rather than a new one that looks like it.
 */
function handleSetRoutinePaused(ctx, ws, msg) {
  setRoutineFlag(ctx, ws, msg, {
    field: 'paused',
    replyType: 'routine_paused',
    verb: (on) => (on ? 'paused' : 'resumed'),
  });
}

/**
 * set_routine_enabled: answer the question an upgrade left open.
 *
 * WHY THIS IS NOT set_routine_paused WITH A DIFFERENT ARGUMENT, even though
 * both now go through one setter. Pausing is a decision the reader already
 * took about a routine that was running, and can take back. `enabled` is the
 * answer to a question nobody had asked them: a routine whose file never
 * carried the key was written by hand before this product could run one, and
 * reads as not enabled until somebody says otherwise. One FIELD for both would
 * make resuming a paused routine and consenting to run a routine that predates
 * the scheduler the same act, and the file would then have no way to say which
 * of the two happened. Sharing the write path costs nothing; sharing the field
 * would lose the distinction.
 */
function handleSetRoutineEnabled(ctx, ws, msg) {
  setRoutineFlag(ctx, ws, msg, {
    field: 'enabled',
    replyType: 'routine_enabled',
    verb: (on) => (on ? 'turned on' : 'turned off'),
  });
}

/**
 * approve_routine_plan: record the one tap that lets a plan run unattended.
 *
 * THE HASH IS COMPUTED HERE, FROM THE FILE, AT THIS MOMENT. The client sends
 * only which routine it means; a hash it supplied would let a window that has
 * not heard about an edit approve the plan that existed when its page was
 * drawn. Reading the block fresh and hashing what is actually on disk means
 * the approval always covers the plan the tick will read, or lands as a
 * mismatch the row immediately re-asks about, which is the safe failure.
 *
 * TWO FIELDS IN ONE WRITE: the hash that was approved, and when. The moment
 * is display material; the hash is the record. Both ride the same read-back
 * guard the other routine writers use, through the same block writer.
 */
function handleApproveRoutinePlan(ctx, ws, msg) {
  const fail = routineActionRefusal(ws, msg);
  const found = locateRoutineFile(ctx, msg, fail);
  if (!found) return;

  const block = readRoutineBlock(fs.readFileSync(found.filePath, 'utf-8'), found.name, found.occurrence);
  if (!block) {
    fail(`Routine "${found.name}" could not be approved.`);
    return;
  }
  const approvedHash = computePlanHash(normalizeRoutine(block));
  writeRoutineField(ctx, ws, found, {
    fields: { planApprovedHash: approvedHash, planApprovedAt: new Date().toISOString() },
    refuse: () => fail(`Routine "${found.name}" could not be approved.`),
    reply: { type: 'routine_plan_approved', agentId: found.target.id, name: found.name },
    said: 'plan approved',
  });
}

/**
 * set_routine_schedule: change WHEN a saved routine runs, and nothing else.
 *
 * WHY THIS IS NOT save_routine WITH THE SAME NAME. That path APPENDS: it makes
 * a block the file does not have. Sent for an edit it would leave the routine's
 * old schedule firing beside its new one, under one name, which is worse than
 * either. This edits the block that is already there, in place, so the routine
 * keeps its position in the file and every key on it that this message does not
 * name.
 *
 * WHY IT REFUSES ON THE SAVE ROAD AND NOT THE ROW'S. The two refusal types in
 * this file are not two spellings of one thing: `routine_error` is handed to the
 * editor's save-failure callback, and `routine_action_error` is drawn on the
 * routines list. A schedule edit is made in the editor, with the reader looking
 * at the sentence builder and a save in flight, exactly as on the create road.
 * So the refusal goes where they are looking. Sending it to the list would put
 * the only answer on a screen they left.
 *
 * THE SCHEDULE IS THE ONLY FIELD IT WILL WRITE. Where a routine runs and which
 * skill it runs are edits of their own: the first has one supported value in
 * this release and nothing to choose between, and changing the second makes a
 * different routine, for which delete and recreate is the honest path.
 */
function handleSetRoutineSchedule(ctx, ws, msg) {
  const fail = (message) => ws.send(JSON.stringify({ type: 'routine_error', message }));
  const found = locateRoutineFile(ctx, msg, fail);
  if (!found) return;

  // TRIMMED BEFORE ANYTHING ELSE SEES IT, because the parser trims on the way
  // back out. Written with the caller's own spacing, the read-back below would
  // compare a padded string against an unpadded one and refuse a schedule that
  // had in fact landed correctly.
  const schedule = typeof msg.schedule === 'string' ? msg.schedule.trim() : null;
  if (!schedule) {
    fail('A schedule is required.');
    return;
  }

  writeRoutineField(ctx, ws, found, {
    field: 'schedule',
    value: schedule,
    // The writer's own words when it has any: it knows which of several things
    // was wrong with the value, and a sentence naming the schedule is worth
    // more to the reader than one saying a schedule was refused.
    refuse: (why) => fail(why || `Routine "${found.name}" could not be rescheduled.`),
    reply: { type: 'routine_rescheduled', agentId: found.target.id, name: found.name, schedule },
    said: 'rescheduled',
  });
}

// save_skill: upsert (create or update) a skill's SKILL.md file.
function handleSaveSkill(ctx, ws, msg) {
  const name = msg.name;
  if (!ctx.agents.validateAgentSlug(name)) {
    ws.send(JSON.stringify({ type: 'skill_error', message: 'Invalid skill name. Use lowercase letters, numbers, and hyphens only.' }));
  } else {
    const skillDir = path.join(getWorkspace(), '.claude', 'skills', name);
    if (!ctx.workspace.isInsideWorkspace(skillDir)) {
      ws.send(JSON.stringify({ type: 'skill_error', message: 'Invalid path.' }));
    } else {
      if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
      const filePath = path.join(skillDir, 'SKILL.md');
      const existed = fs.existsSync(filePath);
      fs.writeFileSync(filePath, msg.content, 'utf-8');
      console.log(`[Skill] ${existed ? 'Updated' : 'Created'}: ${name}`);
      ws.send(JSON.stringify({ type: 'skill_saved', skillId: name, updated: existed }));
      ctx.agents.invalidateAgentCache(); // before discovery so the skills broadcast is fresh
      const updatedAgents = discoverAgents();
      ws.send(JSON.stringify({ type: 'skills', skills: ctx.agents.discoverSkills(updatedAgents) }));
      ctx.agents.flagRosterRefresh();
    }
  }
}

function handleDeleteSkill(ctx, ws, msg) {
  const name = msg.name;
  if (!ctx.agents.validateAgentSlug(name)) {
    ws.send(JSON.stringify({ type: 'skill_error', message: 'Invalid skill name.' }));
  } else {
    const skillDir = path.join(getWorkspace(), '.claude', 'skills', name);
    if (!ctx.workspace.isInsideWorkspace(skillDir) || !fs.existsSync(skillDir)) {
      ws.send(JSON.stringify({ type: 'skill_error', message: `Skill "${name}" not found.` }));
    } else {
      fs.rmSync(skillDir, { recursive: true });
      console.log(`[Skill] Deleted: ${name}`);
      ws.send(JSON.stringify({ type: 'skill_deleted', skillId: name }));
      ctx.agents.invalidateAgentCache(); // before discovery so the skills broadcast is fresh
      const updatedAgents = discoverAgents();
      ws.send(JSON.stringify({ type: 'skills', skills: ctx.agents.discoverSkills(updatedAgents) }));
      ctx.agents.flagRosterRefresh();
    }
  }
}

module.exports = { handleGetAgents, handleGetRuntimeStatus, handleGetSkills, handleAddToTeam, handleSaveAgent, handleDeleteAgent, handleSaveSkill, handleDeleteSkill, handleSaveRoutine, handleDeleteRoutine, handleSetRoutinePaused, handleSetRoutineEnabled, handleSetRoutineSchedule, handleApproveRoutinePlan };
