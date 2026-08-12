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
      // Add order after the type field, or after description
      content = content.replace(/^(type:\s.*)/m, `$1\norder: ${nextOrder}`);
      if (!content.match(/^order:/m)) {
        content = content.replace(/^(description:[\s\S]*?)(\n\w)/m, `$1\norder: ${nextOrder}$2`);
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

module.exports = { handleGetAgents, handleGetRuntimeStatus, handleGetSkills, handleAddToTeam, handleSaveAgent, handleDeleteAgent, handleSaveSkill, handleDeleteSkill };
