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
const { discoverAgents, parseAgentFrontmatter } = require('../../agents/discovery.js');
const { appendRoutineBlock, removeRoutineBlock, updateRoutineBlock } = require('../../agents/routines.js');

function handleGetAgents(ctx, ws, msg) {
  if (!getWorkspace()) { ws.send(JSON.stringify({ type: 'needs_workspace' })); return; }
  let agentList = [];
  try { agentList = discoverAgents(); } catch (e) { console.warn('  Agent discovery failed:', e.message); }
  ws.send(JSON.stringify({ type: 'agents', agents: agentList }));
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
    ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));
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
      ws.send(JSON.stringify({ type: 'agents', agents: updatedAgents }));
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
      ws.send(JSON.stringify({ type: 'agents', agents: updatedAgents }));
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
  // The roster is parsed from the file in file order, so the nth routine of
  // that name here is the nth block there. Checked BEFORE anything is read or
  // written, so that "no such routine" is answered as itself rather than
  // inferred later from a write that changed no bytes.
  const namesakes = (target.routines || []).filter(r => r.name === name);
  if (!namesakes[occurrence]) { fail(`Routine "${name}" is not in that agent.`); return null; }
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
  ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));
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
  const fail = (message) => ws.send(JSON.stringify({ type: 'routine_error', message }));
  const found = locateRoutineFile(ctx, msg, fail);
  if (!found) return;

  const before = fs.readFileSync(found.filePath, 'utf-8');
  const next = removeRoutineBlock(before, found.name, found.occurrence);
  if (next === before) { fail(`Routine "${found.name}" is not in that agent.`); return; }
  fs.writeFileSync(found.filePath, next, 'utf-8');
  console.log(`[Routine] Deleted from ${found.target.id}: ${found.name}`);

  announceRoutineChange(ctx, ws, { type: 'routine_deleted', agentId: found.target.id, name: found.name });
}

/**
 * set_routine_paused: stop a routine happening, or start it again.
 *
 * PAUSING IS NOT RESCHEDULING. It writes one field and leaves the schedule,
 * the prompt and every other key exactly where they were, so a routine resumed
 * later is the same routine rather than a new one that looks like it.
 */
function handleSetRoutinePaused(ctx, ws, msg) {
  const fail = (message) => ws.send(JSON.stringify({ type: 'routine_error', message }));
  const found = locateRoutineFile(ctx, msg, fail);
  if (!found) return;

  const paused = !!(msg && msg.paused);
  const before = fs.readFileSync(found.filePath, 'utf-8');
  const next = updateRoutineBlock(before, found.name, { paused }, found.occurrence);
  // The routine was found on the roster above, so identical bytes here mean
  // the field already held this value: a second press of Pause, or two clients
  // asking at once. Nothing to write, and nothing to complain about, because
  // the state the caller asked for is the state it is in.
  if (next === before) {
    announceRoutineChange(ctx, ws, {
      type: 'routine_paused', agentId: found.target.id, name: found.name, paused,
    });
    return;
  }
  fs.writeFileSync(found.filePath, next, 'utf-8');
  console.log(`[Routine] ${paused ? 'Paused' : 'Resumed'} on ${found.target.id}: ${found.name}`);

  announceRoutineChange(ctx, ws, {
    type: 'routine_paused', agentId: found.target.id, name: found.name, paused,
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

module.exports = { handleGetAgents, handleGetRuntimeStatus, handleGetSkills, handleAddToTeam, handleSaveAgent, handleDeleteAgent, handleSaveSkill, handleDeleteSkill, handleSaveRoutine, handleDeleteRoutine, handleSetRoutinePaused };
