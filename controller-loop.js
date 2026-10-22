#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { probe: probePlanArtifact } = require('./plan-artifact-proof.js');

const HOME = os.homedir();
const ROOT = __dirname;
const TASKS_DIR = path.join(ROOT, 'tasks');
const COLLECTIONS_DIR = path.join(ROOT, 'collections');
const STATE_DIR = path.join(ROOT, 'state');
const DISPATCHES_DIR = path.join(ROOT, 'dispatches');
const REVIEWS_DIR = path.join(ROOT, 'reviews');
const EVENTS_DIR = path.join(ROOT, 'events');
const TRACE_ROOT = path.join(HOME, '.cursor', 'agent-traces');
const PROJECTS_ROOT = path.join(HOME, '.cursor', 'projects');

for (const p of [ROOT, TASKS_DIR, COLLECTIONS_DIR, STATE_DIR, DISPATCHES_DIR, REVIEWS_DIR, EVENTS_DIR]) {
  fs.mkdirSync(p, { recursive: true });
}

function fail(code, message, extra) {
  const out = Object.assign({ ok: false, code, message }, extra || {});
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exitCode = 1;
}

function ok(payload) {
  process.stdout.write(JSON.stringify(Object.assign({ ok: true }, payload || {}), null, 2) + '\n');
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex').toUpperCase();
}

function atomicWriteJson(target, obj) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
  fs.copyFileSync(tmp, target);
  fs.unlinkSync(tmp);
}

function emitEvent(type, token, detail) {
  const safeToken = token ? String(token).replace(/[^A-Za-z0-9_.:-]+/g, '_') : 'NO_TOKEN';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = stamp + '_' + process.pid + '_' + crypto.randomBytes(4).toString('hex');
  const target = path.join(EVENTS_DIR, id + '.json');
  atomicWriteJson(target, {
    schema_version: 1,
    event_id: id,
    event_type: type,
    task_token: token || null,
    emitted_at: nowIso(),
    detail: detail || null
  });
  return target;
}

function sanitizeToken(token) {
  if (!/^[A-Za-z0-9_.:-]{8,}$/.test(token || '')) {
    throw new Error('invalid task_token');
  }
  return token.replace(/[:]/g, '_');
}

function statePath(token) {
  return path.join(STATE_DIR, sanitizeToken(token) + '.json');
}

function taskPath(token) {
  return path.join(TASKS_DIR, sanitizeToken(token) + '.json');
}

function collectionPath(token) {
  return path.join(COLLECTIONS_DIR, sanitizeToken(token) + '.json');
}

function dispatchPath(token) {
  return path.join(DISPATCHES_DIR, sanitizeToken(token) + '.json');
}

function reviewPath(token) {
  return path.join(REVIEWS_DIR, sanitizeToken(token) + '.json');
}

function nowIso() {
  return new Date().toISOString();
}

function readStateIfExists(token) {
  const p = statePath(token);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeState(token, state, detail) {
  const p = statePath(token);
  const prior = readStateIfExists(token);
  const obj = {
    schema_version: 1,
    task_token: token,
    state,
    updated_at: nowIso(),
    prior_state: prior ? prior.state : null,
    detail: detail || null
  };
  atomicWriteJson(p, obj);
  return obj;
}

function validateEnvelope(e) {
  const errors = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return ['envelope must be an object'];
  if (e.schema_version !== 1) errors.push('schema_version must be 1');
  if (!e.task_id || typeof e.task_id !== 'string') errors.push('task_id required');
  try { sanitizeToken(e.task_token); } catch (_) { errors.push('task_token invalid'); }
  if (!e.workspace || typeof e.workspace !== 'string') errors.push('workspace required');
  if (!['Agent', 'Ask', 'Plan', 'Debug'].includes(e.mode)) errors.push('mode invalid');
  if (e.chat !== 'NEW') errors.push('chat must be NEW');
  if (!['ALLOW', 'READ_ONLY'].includes(e.mutation)) errors.push('mutation invalid');
  if (e.subagent_policy !== 'DENY_INTERNAL') errors.push('subagent_policy must be DENY_INTERNAL');
  if (e.handoff_policy !== 'HISTORICAL_BY_TASK_TOKEN') errors.push('handoff_policy must be HISTORICAL_BY_TASK_TOKEN');
  if (!e.prompt || typeof e.prompt !== 'string') errors.push('prompt required');
  if (typeof e.prompt === 'string' && e.task_token && !e.prompt.includes(e.task_token)) {
    errors.push('prompt must contain exact task_token');
  }
  return errors;
}

function registerEnvelope(filePath) {
  const absolute = path.resolve(filePath);
  const env = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  const errors = validateEnvelope(env);
  if (errors.length) return fail('INVALID_ENVELOPE', 'task envelope validation failed', { errors });
  const target = taskPath(env.task_token);
  const normalized = Object.assign({}, env, { created_at: env.created_at || nowIso() });
  if (fs.existsSync(target)) {
    const prior = JSON.parse(fs.readFileSync(target, 'utf8'));
    const a = Object.assign({}, prior);
    const b = Object.assign({}, normalized);
    delete a.created_at;
    delete b.created_at;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return fail('TOKEN_COLLISION', 'task_token already registered with different envelope', { target });
    }

    const existingState = readStateIfExists(env.task_token);
    if (existingState) {
      return ok({
        code: 'ALREADY_REGISTERED',
        task_token: env.task_token,
        envelope: target,
        state: existingState,
        note: 'existing task state preserved; register is idempotent and never redispatches by resetting state'
      });
    }
  } else {
    atomicWriteJson(target, normalized);
  }
  const state = writeState(env.task_token, 'READY', { envelope: target });
  ok({ code: 'REGISTERED', task_token: env.task_token, envelope: target, state });
}

function walkHistoricalHandoffs(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
      } else if (
        ent.isFile() &&
        ent.name.toLowerCase().endsWith('.md') &&
        path.basename(path.dirname(p)).toLowerCase() === 'handoffs'
      ) {
        out.push(p);
      }
    }
  }
  return out;
}

function metadataField(md, field) {
  const escaped = field.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const re = new RegExp('^\\|\\s*' + escaped + '\\s*\\|\\s*(.*?)\\s*\\|\\s*$', 'mi');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

function parseJsonl(filePath) {
  const rows = [];
  let text = '';
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) { return rows; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line.replace(/^\uFEFF/, ''))); } catch (_) {}
  }
  return rows;
}

function transcriptToolUses(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const rows = parseJsonl(filePath);
  const out = [];
  for (const row of rows) {
    if (!row || row.role !== 'assistant' || !row.message || !Array.isArray(row.message.content)) continue;
    for (const item of row.message.content) {
      if (!item || item.type !== 'tool_use' || !item.name) continue;
      out.push({
        tool_name: item.name,
        tool_input: item.input || null
      });
    }
  }
  return out;
}

function walkTaskTranscripts(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.toLowerCase() === 'subagents') continue;
        stack.push(p);
        continue;
      }
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.jsonl')) continue;
      if (!p.includes(path.sep + 'agent-transcripts' + path.sep)) continue;
      out.push(p);
    }
  }
  return out;
}

function fileContainsTokenNearStart(filePath, token) {
  let fd = null;
  try {
    const st = fs.statSync(filePath);
    const max = Math.min(st.size, 256 * 1024);
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8').includes(token);
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function findTaskTranscript(token) {
  const files = walkTaskTranscripts(PROJECTS_ROOT);
  const matches = [];
  for (const p of files) {
    if (!fileContainsTokenNearStart(p, token)) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(p).mtimeMs; } catch (_) {}
    matches.push({ path: p, mtime_ms: mtimeMs });
  }
  matches.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return {
    path: matches.length ? matches[0].path : null,
    count: matches.length,
    matches
  };
}

function detectPendingAskQuestion(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let text = '';
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line.replace(/^\uFEFF/, ''))); } catch (_) {}
  }

  let lastAsk = null;
  let lastAskIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.role !== 'assistant' || !row.message || !Array.isArray(row.message.content)) continue;
    for (const item of row.message.content) {
      if (!item || item.type !== 'tool_use' || item.name !== 'AskQuestion') continue;
      lastAsk = item.input || {};
      lastAskIndex = i;
    }
  }
  if (!lastAsk) return null;

  let progressedAfterAsk = false;
  for (let i = lastAskIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    if (row.role === 'assistant' || row.role === 'user') {
      progressedAfterAsk = true;
      break;
    }
  }

  return {
    pending: !progressedAfterAsk,
    input: lastAsk,
    transcript_path: filePath,
    transcript_mtime_ms: (() => {
      try { return fs.statSync(filePath).mtimeMs; } catch (_) { return null; }
    })()
  };
}

// Detect a completed Cursor turn whose response cannot be bound to its task token.
// Fail closed: never accept this response as a valid Handoff.
function diagnoseUnboundCompletedTurn(token, transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const dispatchFile = path.join(DISPATCHES_DIR, sanitizeToken(token) + '.json');
  const dispatch = (() => { try { return JSON.parse(fs.readFileSync(dispatchFile, 'utf8')); } catch { return null; } })();
  if (!dispatch || dispatch.task_token !== token || dispatch.status !== 'SUBMITTED') return null;
  const rows = parseJsonl(transcriptPath);
  const end = rows[rows.length - 1];
  if (!end || end.type !== 'turn_ended' || end.status !== 'success') return null;
  const assistantRows = rows.filter(r => r && r.role === 'assistant' && Array.isArray(r.message?.content));
  const final = assistantRows[assistantRows.length - 1];
  const responseText = final?.message.content.filter(c => c?.type === 'text').map(c => c.text || '').join('') || '';
  if (!responseText || responseText.includes(token)) return null;
  const convId = path.basename(path.dirname(transcriptPath));
  const envelope = (() => { try { return JSON.parse(fs.readFileSync(taskPath(token), 'utf8')); } catch { return null; } })();
  const projectDir = envelope?.workspace ? path.win32.basename(envelope.workspace) : null;
  if (!projectDir) return null;
  const responses = parseJsonl(path.join(TRACE_ROOT, projectDir, convId, 'responses.jsonl'));
  const dispatchTime = Date.parse(dispatch.updated_at || '');
  const matchingResponse = responses.find(r =>
    r?.conversation_id === convId && r.text === responseText &&
    Number.isFinite(dispatchTime) && Date.parse(r.timestamp || '') >= dispatchTime);
  if (!matchingResponse) return null;
  return {
    reason: 'CURSOR_TURN_ENDED_BUT_FINAL_RESPONSE_MISSING_TASK_TOKEN',
    conversation_id: convId,
    generation_id: matchingResponse.generation_id || null,
    response_chars: responseText.length,
    transcript_path: transcriptPath,
    no_engineering_acceptance: true
  };
}

function findHandoffMatches(token) {
  const files = walkHistoricalHandoffs(TRACE_ROOT);
  const matches = [];
  for (const p of files) {
    let md = '';
    try { md = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
    if (!md.includes(token)) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(p).mtimeMs; } catch (_) {}
    matches.push({
      path: p,
      sha256: sha256File(p),
      conversation_id: metadataField(md, 'Conversation ID'),
      generation_id: metadataField(md, 'Generation ID'),
      project: metadataField(md, 'Project'),
      workspace: metadataField(md, 'Workspace'),
      final_response_time: metadataField(md, 'Final Response'),
      mtime_ms: mtimeMs
    });
  }
  return matches;
}

function resolveResponseAndTranscript(match, token) {
  const convDir = path.dirname(path.dirname(match.path));
  const responsesPath = path.join(convDir, 'responses.jsonl');
  const responses = parseJsonl(responsesPath);
  let response = null;
  if (match.generation_id) {
    response = responses.find(r => r && r.generation_id === match.generation_id) || null;
  }
  if (!response) {
    response = responses.find(r => r && typeof r.text === 'string' && r.text.includes(token)) || null;
  }

  const transcriptPath = response && response.transcript_path ? response.transcript_path : null;
  const transcriptExists = !!(transcriptPath && fs.existsSync(transcriptPath));
  const subagents = [];
  if (transcriptExists) {
    const subDir = path.join(path.dirname(transcriptPath), 'subagents');
    try {
      for (const ent of fs.readdirSync(subDir, { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.jsonl')) continue;
        const p = path.join(subDir, ent.name);
        subagents.push({ path: p, sha256: sha256File(p), bytes: fs.statSync(p).size });
      }
    } catch (_) {}
  }

  const transcriptTools = transcriptToolUses(transcriptPath);
  const toolsPath = path.join(convDir, 'tools.jsonl');
  const allTools = parseJsonl(toolsPath);
  const generationTools = allTools.filter(r =>
    r && (!match.generation_id || r.generation_id === match.generation_id)
  );
  const toolNames = [...new Set(generationTools.map(r => r.tool_name).filter(Boolean))];
  const toolRecords = generationTools.map(r => ({
    timestamp: r.timestamp || null,
    tool_use_id: r.tool_use_id || null,
    tool_name: r.tool_name || null,
    hook_event_name: r.hook_event_name || null,
    tool_input: r.tool_input || null,
    input_command: r.input_command || null
  }));

  const responseText = response && typeof response.text === 'string' ? response.text : null;
  const responseTextSha = responseText === null ? null :
    crypto.createHash('sha256').update(responseText, 'utf8').digest('hex').toUpperCase();

  return {
    conv_dir: convDir,
    responses_path: fs.existsSync(responsesPath) ? responsesPath : null,
    response: response ? {
      timestamp: response.timestamp || null,
      conversation_id: response.conversation_id || null,
      generation_id: response.generation_id || null,
      cursor_version: response.cursor_version || null,
      model: response.model || null,
      workspace_root: response.workspace_root || null,
      token_present: responseText !== null && responseText.includes(token),
      final_response_text: responseText,
      final_response_sha256: responseTextSha,
      final_response_chars: responseText === null ? null : responseText.length
    } : null,
    tools: {
      path: fs.existsSync(toolsPath) ? toolsPath : null,
      sha256: fs.existsSync(toolsPath) ? sha256File(toolsPath) : null,
      count: generationTools.length,
      tool_names: toolNames,
      records: toolRecords,
      caveat: 'postToolUse-derived trace can omit blocked tools and may undercount successful/parallel tool calls'
    },
    transcript_tools: {
      count: transcriptTools.length,
      tool_names: [...new Set(transcriptTools.map(r => r.tool_name).filter(Boolean))],
      records: transcriptTools,
      source: 'raw parent transcript assistant tool_use blocks'
    },
    transcript: {
      path: transcriptPath,
      exists: transcriptExists,
      sha256: transcriptExists ? sha256File(transcriptPath) : null,
      bytes: transcriptExists ? fs.statSync(transcriptPath).size : null
    },
    subagents
  };
}

// Plan-mode completion is an artifact path, not necessarily response text.
// Require unique transcript, terminal success, actual CreatePlan call, its matching
// on-disk artifact after dispatch, and matching empty/text hook response.
function findCompletedPlanArtifact(token) {
  const envelope = (() => { try { return JSON.parse(fs.readFileSync(taskPath(token),'utf8')); } catch { return null; } })();
  const dispatchFile = dispatchPath(token);
  const dispatch = (() => { try { return JSON.parse(fs.readFileSync(dispatchFile,'utf8')); } catch { return null; } })();
  if (envelope?.mode !== 'Plan' || !dispatch ||
      dispatch.status !== 'SUBMITTED' || dispatch.task_token !== token ||
      dispatch.requested_mode !== 'Plan' || dispatch.verified_mode !== 'Plan') return null;
  const located = findTaskTranscript(token);
  // Later review chats can quote the token; require the original Plan producer.
  const proofs = located.matches.map(m => probePlanArtifact(token, m.path)).filter(Boolean);
  if (proofs.length !== 1) return null;
  const proof = proofs[0];
  const transcriptPath = proof.transcript_path;
  const rows = parseJsonl(transcriptPath);
  const last = rows[rows.length-1];
  if (last?.type !== 'turn_ended' || last.status !== 'success') return null;
  const toolUses = transcriptToolUses(transcriptPath);
  const plans = toolUses.filter(t => t.tool_name === 'CreatePlan' &&
    typeof t.tool_input?.plan === 'string' && t.tool_input.plan.includes(token));
  if (plans.length !== 1) return null;
  const convId = path.basename(path.dirname(transcriptPath));
  const projectSegment = path.win32.basename(envelope.workspace || '');
  if (!projectSegment) return null;
  const convDir = path.join(TRACE_ROOT, projectSegment, convId);
  const responsesPath = path.join(convDir, 'responses.jsonl');
  const dispatchedAt = Date.parse(dispatch.updated_at || '');
  if (!Number.isFinite(dispatchedAt)) return null;
  const responses = parseJsonl(responsesPath).filter(r => r?.conversation_id === convId &&
    Date.parse(r.timestamp || '') >= dispatchedAt);
  if (responses.length !== 1) return null;
  const response = responses[0];
  const planDir = path.join(HOME, '.cursor', 'plans');
  const artifacts = [];
  for (const name of fs.readdirSync(planDir).filter(n => n.endsWith('.plan.md'))) {
    const full = path.join(planDir, name);
    const st = fs.statSync(full);
    if (st.mtimeMs < dispatchedAt) continue;
    const content = fs.readFileSync(full, 'utf8');
    if (!content.includes(token)) continue;
    if (!content.includes('name: ' + String(plans[0].tool_input.name || ''))) continue;
    artifacts.push({ path: full, sha256: sha256File(full), bytes: st.size, mtime_ms: st.mtimeMs });
  }
  if (artifacts.length !== 1) return null;
  const subDir = path.join(path.dirname(transcriptPath),'subagents');
  let subagents = [];
  try { subagents = fs.readdirSync(subDir).filter(n => n.endsWith('.jsonl')); } catch {}
  return { envelope, dispatch, dispatchFile, response, transcriptPath, convId,
    responsesPath, artifact: artifacts[0], toolUses, subagents, proof };
}

function collectPlan(token) {
  const info = findCompletedPlanArtifact(token);
  if (!info) return fail('PLAN_EVIDENCE_MISSING', 'No uniquely bound successful Plan artifact', { task_token:token });
  return collectPlanArtifact(token, info.proof);
}

function collectPlanArtifact(token, proposedProof) {
  sanitizeToken(token);
  const located = findTaskTranscript(token);
  const proofs = located.matches.map(m => probePlanArtifact(token, m.path)).filter(Boolean);
  const proof = proofs.length === 1 ? proofs[0] : null;
  if (!proof || (proposedProof && proof.plan_sha256 !== proposedProof.plan_sha256)) {
    return fail('PLAN_ARTIFACT_UNVERIFIED', 'Plan file could not be uniquely bound to this completed Cursor turn', { task_token: token });
  }
  const prior = readStateIfExists(token);
  if (prior && ['DISPATCH_FAILED','NO_HANDOFF','DUPLICATE_HANDOFF','TOKEN_MISMATCH','TIMEOUT'].includes(prior.state)) {
    return fail('TERMINAL_STATE_LOCKED', 'cannot collect an already-terminal task', { task_token: token, state: prior.state });
  }
  if (prior?.state === 'CONTROLLER_READY') return ok({ code:'ALREADY_READY', task_token:token, collection:collectionPath(token) });
  const taskFile = taskPath(token), dispatchFile = dispatchPath(token);
  const task = JSON.parse(fs.readFileSync(taskFile,'utf8'));
  const dispatch = JSON.parse(fs.readFileSync(dispatchFile,'utf8'));
  if (task.mode !== 'Plan' || dispatch.verified_mode !== 'Plan' || dispatch.status !== 'SUBMITTED') {
    return fail('DISPATCH_EVIDENCE_MISMATCH','Plan mode evidence mismatch',{task_token:token});
  }
  const match = {
    path:proof.handoff_path, sha256:proof.handoff_sha256,
    conversation_id:proof.conversation_id, generation_id:proof.generation_id,
    project:proof.project, workspace:proof.workspace, final_response_time:proof.response_time
  };
  const evidence = resolveResponseAndTranscript(match, token);
  if (!evidence.response || evidence.response.final_response_text !== '' ||
      evidence.response.conversation_id !== proof.conversation_id ||
      evidence.response.generation_id !== proof.generation_id ||
      !evidence.transcript.exists) {
    return fail('PLAN_RESPONSE_EVIDENCE_MISMATCH','the Plan artifact is not supported by empty final-response evidence',{task_token:token});
  }
  if (task.subagent_policy === 'DENY_INTERNAL' && evidence.subagents.length) {
    const state=writeState(token,'POLICY_VIOLATION_INTERNAL_SUBAGENT',{count:evidence.subagents.length});
    return fail('POLICY_VIOLATION_INTERNAL_SUBAGENT','Plan called internal subagents',{task_token:token,state});
  }
  const collection={
    schema_version:1,task_token:token,collected_at:nowIso(),
    identity:{project:proof.project,workspace:proof.workspace,conversation_id:proof.conversation_id,generation_id:proof.generation_id},
    historical_handoff:{path:proof.handoff_path,sha256:proof.handoff_sha256,final_response_time:proof.response_time,same_conversation_intermediate_handoffs:[]},
    response_evidence:{...evidence.response,artifact_identity_source:'CURSOR_PLAN_FILE',token_in_plan_artifact:true},
    plan_artifact:{path:proof.plan_path,sha256:proof.plan_sha256,bytes:proof.plan_bytes,token_verified:true,final_response_empty:true,mode:'Plan'},
    tools_evidence:evidence.tools,
    transcript:evidence.transcript,internal_subagents_detected:evidence.subagents.length,internal_subagents:evidence.subagents,
    dispatch:{path:dispatchFile,...dispatch},
    envelope:{path:taskFile,task_id:task.task_id,mode:task.mode,workspace:task.workspace,mutation:task.mutation,subagent_policy:task.subagent_policy},
    collection_policy:'PLAN_ARTIFACT_IDENTIFIED_NOT_ACCEPTED',
    review_required:true
  };
  const output=collectionPath(token);
  atomicWriteJson(output,collection);
  writeState(token,'HANDOFF_FOUND',{plan_artifact:proof.plan_path,conversation_id:proof.conversation_id});
  const state=writeState(token,'CONTROLLER_READY',{collection:output,plan_artifact:proof.plan_path});
  const event=emitEvent('TASK_CONTROLLER_READY',token,{collection:output,artifact_type:'CURSOR_PLAN_FILE',review_required:true});
  return ok({code:'CONTROLLER_READY',collection:output,state,event,plan_artifact:collection.plan_artifact});
}

function collect(token) {
  sanitizeToken(token);
  const priorState = readStateIfExists(token);
  if (priorState && priorState.state === 'DISPATCH_FAILED') {
    return fail('TERMINAL_STATE_LOCKED', 'DISPATCH_FAILED is Controller-terminal and cannot be overwritten by a late handoff', {
      task_token: token,
      state: priorState
    });
  }
  writeState(token, 'RUNNING', { operation: 'collect' });
  const matches = findHandoffMatches(token);

  if (matches.length === 0) {
    const state = writeState(token, 'NO_HANDOFF', { historical_matches: 0 });
    return fail('NO_HANDOFF', 'no historical handoff contains the exact task token', { task_token: token, state });
  }
  let match = null;
  let intermediateHandoffs = [];
  if (matches.length === 1) {
    match = matches[0];
  } else {
    const conversationIds = [...new Set(matches.map(m => m.conversation_id).filter(Boolean))];
    const hasMissingConversation = matches.some(m => !m.conversation_id);
    if (conversationIds.length === 1 && !hasMissingConversation) {
      const ordered = matches.slice().sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
      match = ordered[0];
      intermediateHandoffs = ordered.slice(1).map(m => ({
        path: m.path,
        sha256: m.sha256,
        conversation_id: m.conversation_id,
        generation_id: m.generation_id,
        final_response_time: m.final_response_time,
        mtime_ms: m.mtime_ms
      }));
    } else {
      const state = writeState(token, 'DUPLICATE_HANDOFF', {
        historical_matches: matches.length,
        conversation_ids: conversationIds,
        paths: matches.map(m => m.path)
      });
      return fail('DUPLICATE_HANDOFF', 'task token maps to multiple Cursor conversations; token identity is ambiguous', {
        task_token: token,
        matches: matches.map(m => ({ path: m.path, conversation_id: m.conversation_id, generation_id: m.generation_id })),
        state
      });
    }
  }
  if (!match.conversation_id || !match.generation_id) {
    const state = writeState(token, 'TOKEN_MISMATCH', { reason: 'missing conversation/generation metadata' });
    return fail('TOKEN_MISMATCH', 'historical handoff lacks identity metadata', { task_token: token, match, state });
  }

  const evidence = resolveResponseAndTranscript(match, token);
  if (!evidence.response || !evidence.response.token_present) {
    const state = writeState(token, 'TOKEN_MISMATCH', { reason: 'token not present in matching response record' });
    return fail('TOKEN_MISMATCH', 'handoff token was not confirmed in responses.jsonl', { task_token: token, state });
  }
  if (
    evidence.response.conversation_id !== match.conversation_id ||
    evidence.response.generation_id !== match.generation_id
  ) {
    const state = writeState(token, 'TOKEN_MISMATCH', { reason: 'handoff and response identity disagree' });
    return fail('TOKEN_MISMATCH', 'handoff identity does not match response identity', { task_token: token, state });
  }

  const envelopeFile = taskPath(token);
  let envelope = null;
  try { envelope = JSON.parse(fs.readFileSync(envelopeFile, 'utf8')); } catch (_) {}

  const dispatchFile = dispatchPath(token);
  let dispatch = null;
  try { dispatch = JSON.parse(fs.readFileSync(dispatchFile, 'utf8')); } catch (_) {}

  if (dispatch) {
    const problems = [];
    if (dispatch.task_token !== token) problems.push('dispatch task_token mismatch');
    if (dispatch.status !== 'SUBMITTED') problems.push('dispatch status is not SUBMITTED');
    if (envelope && dispatch.requested_mode !== envelope.mode) problems.push('requested_mode differs from envelope mode');
    if (envelope && dispatch.verified_mode !== envelope.mode) problems.push('verified_mode differs from envelope mode');
    if (problems.length) {
      const state = writeState(token, 'DISPATCH_EVIDENCE_MISMATCH', { problems, dispatch: dispatchFile });
      return fail('DISPATCH_EVIDENCE_MISMATCH', 'dispatch receipt does not agree with the registered task envelope', {
        task_token: token,
        problems,
        state
      });
    }
  }

  if (envelope && envelope.subagent_policy === 'DENY_INTERNAL' && evidence.subagents.length > 0) {
    const state = writeState(token, 'POLICY_VIOLATION_INTERNAL_SUBAGENT', {
      count: evidence.subagents.length,
      paths: evidence.subagents.map(x => x.path)
    });
    return fail('POLICY_VIOLATION_INTERNAL_SUBAGENT', 'internal Cursor subagent transcript detected for a DENY_INTERNAL task', {
      task_token: token,
      state
    });
  }

  const collection = {
    schema_version: 1,
    task_token: token,
    collected_at: nowIso(),
    identity: {
      project: match.project,
      workspace: match.workspace,
      conversation_id: match.conversation_id,
      generation_id: match.generation_id
    },
    historical_handoff: {
      path: match.path,
      sha256: match.sha256,
      final_response_time: match.final_response_time,
      same_conversation_intermediate_handoffs: intermediateHandoffs
    },
    response_evidence: evidence.response,
    tools_evidence: evidence.tools,
    transcript: evidence.transcript,
    internal_subagents_detected: evidence.subagents.length,
    internal_subagents: evidence.subagents,
    dispatch: dispatch ? Object.assign({ path: dispatchFile }, dispatch) : null,
    envelope: envelope ? {
      path: envelopeFile,
      task_id: envelope.task_id,
      mode: envelope.mode,
      workspace: envelope.workspace,
      mutation: envelope.mutation,
      subagent_policy: envelope.subagent_policy
    } : null
  };

  const outPath = collectionPath(token);
  atomicWriteJson(outPath, collection);
  writeState(token, 'HANDOFF_FOUND', {
    conversation_id: match.conversation_id,
    generation_id: match.generation_id,
    handoff: match.path
  });
  const state = writeState(token, 'CONTROLLER_READY', { collection: outPath });
  const eventPath = emitEvent('TASK_CONTROLLER_READY', token, {
    collection: outPath,
    conversation_id: match.conversation_id,
    generation_id: match.generation_id
  });
  ok({ code: 'CONTROLLER_READY', collection: outPath, state, event: eventPath, evidence: collection });
}

function showStatus(token) {
  sanitizeToken(token);
  const p = statePath(token);
  if (!fs.existsSync(p)) return fail('UNKNOWN_TASK', 'no state exists for task token', { task_token: token });
  const state = JSON.parse(fs.readFileSync(p, 'utf8'));
  let collection = null;
  const cp = collectionPath(token);
  if (fs.existsSync(cp)) collection = JSON.parse(fs.readFileSync(cp, 'utf8'));
  const lateFile = path.join(STATE_DIR, 'late-completions', sanitizeToken(token) + '.json');
  const lateCompletion = fs.existsSync(lateFile) ? JSON.parse(fs.readFileSync(lateFile, 'utf8')) : null;
  const reviewFile=reviewPath(token);
  const review=fs.existsSync(reviewFile)?JSON.parse(fs.readFileSync(reviewFile,'utf8')):null;
  const reviewCurrent=!!(review&&fs.existsSync(cp)&&review.collection_sha256===sha256File(cp));
  ok({ code: 'STATUS', state, collection, late_completion: lateCompletion,
    latest_review: reviewCurrent?{decision:review.decision,reviewed_at:review.reviewed_at}:null });
}

function reviewTask(token, decision, noteText) {
  sanitizeToken(token);
  const allowed = new Set(['ACCEPTED', 'REJECTED', 'NEEDS_FOLLOWUP']);
  if (!allowed.has(decision)) {
    return fail('INVALID_REVIEW_DECISION', 'review decision must be ACCEPTED, REJECTED, or NEEDS_FOLLOWUP', { decision });
  }

  const sp = statePath(token);
  if (!fs.existsSync(sp)) return fail('UNKNOWN_TASK', 'no state exists for task token', { task_token: token });
  const state = JSON.parse(fs.readFileSync(sp, 'utf8'));
  if (state.state !== 'CONTROLLER_READY') {
    return fail('REVIEW_NOT_READY', 'task must be CONTROLLER_READY before review', { task_token: token, state: state.state });
  }

  const cp = collectionPath(token);
  if (!fs.existsSync(cp)) return fail('COLLECTION_MISSING', 'CONTROLLER_READY task has no collection file', { task_token: token });

  const receipt = {
    schema_version: 1,
    task_token: token,
    decision,
    reviewed_at: nowIso(),
    collection_path: cp,
    collection_sha256: sha256File(cp),
    note: noteText || null
  };
  const rp = reviewPath(token);
  atomicWriteJson(rp, receipt);
  ok({ code: 'TASK_REVIEWED', review: Object.assign({ path: rp }, receipt) });
}

function reviewStatus(token) {
  sanitizeToken(token);
  const rp = reviewPath(token);
  if (!fs.existsSync(rp)) return ok({ code: 'REVIEW_STATUS', task_token: token, review: null, current: false });
  const review = JSON.parse(fs.readFileSync(rp, 'utf8'));
  const cp = collectionPath(token);
  const current = fs.existsSync(cp) && review.collection_sha256 === sha256File(cp);
  ok({ code: 'REVIEW_STATUS', task_token: token, review, current });
}

function pendingReviews() {
  const pending = [];
  let entries = [];
  try { entries = fs.readdirSync(STATE_DIR, { withFileTypes: true }); } catch (_) {}
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.json')) continue;
    const sp = path.join(STATE_DIR, ent.name);
    let state = null;
    try { state = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (_) { continue; }
    if (!state || state.state !== 'CONTROLLER_READY' || !state.task_token) continue;

    const token = state.task_token;
    const cp = collectionPath(token);
    if (!fs.existsSync(cp)) {
      pending.push({ task_token: token, reason: 'COLLECTION_MISSING', state_path: sp });
      continue;
    }

    const collectionSha = sha256File(cp);
    const rp = reviewPath(token);
    let review = null;
    try { review = JSON.parse(fs.readFileSync(rp, 'utf8')); } catch (_) {}
    if (review && review.collection_sha256 === collectionSha) continue;

    let collection = null;
    try { collection = JSON.parse(fs.readFileSync(cp, 'utf8')); } catch (_) {}
    const finalText = collection && collection.response_evidence && typeof collection.response_evidence.final_response_text === 'string'
      ? collection.response_evidence.final_response_text
      : null;

    pending.push({
      task_token: token,
      reason: review ? 'COLLECTION_CHANGED_AFTER_REVIEW' : 'UNREVIEWED',
      collection: cp,
      collection_sha256: collectionSha,
      conversation_id: collection && collection.identity ? collection.identity.conversation_id : null,
      generation_id: collection && collection.identity ? collection.identity.generation_id : null,
      mode: collection && collection.envelope ? collection.envelope.mode : null,
      final_response_excerpt: finalText ? finalText.slice(0, 800) : null
    });
  }
  ok({ code: 'PENDING_REVIEWS', count: pending.length, pending });
}

function markState(token, state, detailText) {
  sanitizeToken(token);
  const allowed = new Set([
    'DISPATCHED',
    'DISPATCH_FAILED',
    'RUNNING',
    'NEEDS_CONTROLLER_DECISION',
    'TIMEOUT'
  ]);
  if (!allowed.has(state)) return fail('INVALID_STATE', 'mark only accepts dispatcher/runtime states', { state });
  let detail = null;
  if (detailText) {
    try { detail = JSON.parse(detailText); } catch (_) { detail = { note: detailText }; }
  }
  const written = writeState(token, state, detail);
  if (state === 'NEEDS_CONTROLLER_DECISION') {
    emitEvent('TASK_NEEDS_CONTROLLER_DECISION', token, detail || {});
  }
  ok({ code: 'STATE_UPDATED', state: written });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function watch(token, timeoutSecText, intervalSecText) {
  sanitizeToken(token);
  const timeoutSec = Math.max(1, Number(timeoutSecText || 7200));
  const intervalSec = Math.max(1, Number(intervalSecText || 5));
  const settleMs = Math.max(3000, intervalSec * 2000);
  let activeRemainingMs = timeoutSec * 1000;
  let lastTick = Date.now();
  let wasBlocked = false;
  let transcriptPath = null;
  let handoffStableSince = null;
  let planStableSince = null;
  let unboundStableSince = null;
  let lastTranscriptMtime = null;

  const terminalStates = new Set([
    'DISPATCH_FAILED',
    'NO_HANDOFF',
    'DUPLICATE_HANDOFF',
    'TOKEN_MISMATCH',
    'POLICY_VIOLATION_INTERNAL_SUBAGENT',
    'TIMEOUT'
  ]);

  const initialState = readStateIfExists(token);
  if (initialState && terminalStates.has(initialState.state)) {
    return fail('WATCH_STOPPED_TERMINAL', 'task is already terminal; watcher will not restart it', {
      task_token: token,
      state: initialState
    });
  }

  writeState(token, 'RUNNING', {
    operation: 'watch',
    timeout_sec: timeoutSec,
    interval_sec: intervalSec,
    handoff_settle_ms: settleMs
  });

  while (activeRemainingMs > 0) {
    const now = Date.now();
    const elapsed = now - lastTick;
    lastTick = now;
    if (!wasBlocked) activeRemainingMs -= elapsed;

    const currentState = readStateIfExists(token);
    if (currentState && terminalStates.has(currentState.state)) {
      return fail('WATCH_STOPPED_TERMINAL', 'task became terminal; watcher stopped', {
        task_token: token,
        state: currentState
      });
    }

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      const located = findTaskTranscript(token);
      transcriptPath = located.path;
    }

    let transcriptMtime = null;
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      try { transcriptMtime = fs.statSync(transcriptPath).mtimeMs; } catch (_) {}
    }

    const question = transcriptPath ? detectPendingAskQuestion(transcriptPath) : null;
    const blocked = !!(question && question.pending);

    if (blocked) {
      const detail = {
        reason: 'CURSOR_ASK_QUESTION',
        transcript_path: transcriptPath,
        question: question.input || null,
        active_timeout_remaining_sec: Math.max(0, Math.ceil(activeRemainingMs / 1000))
      };
      if (!currentState || currentState.state !== 'NEEDS_CONTROLLER_DECISION') {
        writeState(token, 'NEEDS_CONTROLLER_DECISION', detail);
        emitEvent('TASK_NEEDS_CONTROLLER_DECISION', token, detail);
      }
      wasBlocked = true;
      handoffStableSince = null;
      sleepMs(intervalSec * 1000);
      continue;
    }

    if (wasBlocked) {
      writeState(token, 'RUNNING', {
        operation: 'watch',
        resumed_after_controller_decision: true,
        transcript_path: transcriptPath,
        active_timeout_remaining_sec: Math.max(0, Math.ceil(activeRemainingMs / 1000))
      });
      emitEvent('TASK_RESUMED_AFTER_DECISION', token, { transcript_path: transcriptPath });
      wasBlocked = false;
      lastTick = Date.now();
    }

    const matches = findHandoffMatches(token);
    if (matches.length > 0) {
      if (lastTranscriptMtime !== null && transcriptMtime !== null && transcriptMtime !== lastTranscriptMtime) {
        handoffStableSince = Date.now();
      } else if (handoffStableSince === null) {
        handoffStableSince = Date.now();
      }

      if (Date.now() - handoffStableSince >= settleMs) {
        return collect(token);
      }
    } else {
      handoffStableSince = null;
      const planEvidence = findCompletedPlanArtifact(token);
      if (planEvidence && transcriptMtime !== null &&
          (lastTranscriptMtime === null || transcriptMtime === lastTranscriptMtime)) {
        if (planStableSince === null) planStableSince = Date.now();
        if (Date.now() - planStableSince >= settleMs) return collectPlan(token);
      } else {
        planStableSince = null;
      }
      // A successful Cursor turn with no exact TASK_TOKEN is a failed transport,
      // not an indefinitely running worker. Require a unique bound transcript,
      // matching afterAgentResponse, and a settled transcript before failing.
      const located = transcriptPath ? findTaskTranscript(token) : null;
      const unbound = located?.count === 1
        ? diagnoseUnboundCompletedTurn(token, transcriptPath)
        : null;
      if (unbound && transcriptMtime !== null &&
          (lastTranscriptMtime === null || transcriptMtime === lastTranscriptMtime)) {
        if (unboundStableSince === null) unboundStableSince = Date.now();
        if (Date.now() - unboundStableSince >= settleMs) {
          const state = writeState(token, 'NO_HANDOFF', unbound);
          return fail('NO_HANDOFF', 'Cursor completed, but final response lacks the exact task token', {
            task_token: token, state
          });
        }
      } else {
        unboundStableSince = null;
      }
    }

    lastTranscriptMtime = transcriptMtime;
    sleepMs(intervalSec * 1000);
  }

  const state = writeState(token, 'TIMEOUT', {
    timeout_sec: timeoutSec,
    note: 'active execution timeout excludes periods waiting for Controller decision'
  });
  emitEvent('TASK_TIMEOUT', token, state.detail);
  return fail('TIMEOUT', 'watch active-execution timeout elapsed before stable completion', { task_token: token, state });
}

function usage() {
  process.stdout.write([
    'Cursor Controller Loop v0',
    '',
    'Usage:',
    '  node controller-loop.js register <task-envelope.json>',
    '  node controller-loop.js collect <TASK_TOKEN>',
    '  node controller-loop.js watch <TASK_TOKEN> [timeoutSec] [intervalSec]',
    '  node controller-loop.js mark <TASK_TOKEN> <STATE> [detail-json]',
    '  node controller-loop.js status <TASK_TOKEN>',
    '  node controller-loop.js review <TASK_TOKEN> <ACCEPTED|REJECTED|NEEDS_FOLLOWUP> [note]',
    '  node controller-loop.js review-status <TASK_TOKEN>',
    '  node controller-loop.js pending',
    ''
  ].join('\n'));
}

const args = process.argv.slice(2);
const command = args[0];
try {
  if (command === 'register' && args[1]) registerEnvelope(args[1]);
  else if (command === 'collect' && args[1]) collect(args[1]);
  else if (command === 'collect-plan' && args[1]) collectPlan(args[1]);
  else if (command === 'watch' && args[1]) watch(args[1], args[2], args[3]);
  else if (command === 'mark' && args[1] && args[2]) markState(args[1], args[2], args[3]);
  else if (command === 'status' && args[1]) showStatus(args[1]);
  else if (command === 'diagnose-unbound' && args[1]) {
    const located = findTaskTranscript(args[1]);
    ok({
      code: 'UNBOUND_TURN_DIAGNOSIS',
      task_token: args[1],
      transcript_matches: located.count,
      diagnosis: located.count === 1 ? diagnoseUnboundCompletedTurn(args[1], located.path) : null
    });
  }
  else if (command === 'review' && args[1] && args[2]) reviewTask(args[1], args[2], args.slice(3).join(' ') || null);
  else if (command === 'review-status' && args[1]) reviewStatus(args[1]);
  else if (command === 'pending') pendingReviews();
  else usage();
} catch (e) {
  fail('UNCAUGHT', e && e.stack ? e.stack : String(e));
}
