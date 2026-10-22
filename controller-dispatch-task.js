#!/usr/bin/env node
'use strict';
/*
 * Cursor Controller: parameterized, single-command task submission.
 *
 * Inputs: dispatch-plans/<TOKEN>.json + dispatch-prompts/<TOKEN>.md.
 * Never replaces the official primary task runner; it only invokes
 * its existing validate / preflight / send commands.
 *
 * CLI:
 *   node controller-dispatch-task.js plan TOKEN
 *   node controller-dispatch-task.js prepare TOKEN
 *   node controller-dispatch-task.js preflight TOKEN
 *   node controller-dispatch-task.js run TOKEN
 *
 * run = prepare -> validate -> preflight -> durable SEND_INTENT -> send.
 * A failed or uncertain SEND must NEVER be automatically replayed.
 */
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const ROOT=__dirname;
const {validateTask,WORKSPACE}=require('./cursor-primary-task-runner.js');
const {checkProfile}=require('./cursor-model-profile.js');
const TOKEN=/^[A-Z0-9_]{12,110}$/;
const BATCH=/^[A-Z0-9_]{10,110}$/;
const ACTIONS=new Set(['plan','prepare','preflight','run']);
const MANIFEST_FIELDS=new Set(['schema_version','task_token','task_id','batch_id','batch_title',
  'create_batch_if_missing','purpose','model_profile','allowed_write_files','deliverables',
  'mutation','max_tool_calls','max_debug_cycles']);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex').toUpperCase();
const shaFile=f=>sha(fs.readFileSync(f));
function fail(code){throw Error(code)}
function assert(b,code){if(!b)fail(code)}
function filename(dir,token,ext){
 assert(TOKEN.test(token),'INVALID_TOKEN');
 return path.join(ROOT,dir,token+ext);
}
function readLocal(dir,token,ext,maxBytes){
 const f=filename(dir,token,ext);
 const stat=fs.lstatSync(f);
 assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=maxBytes,
  'INPUT_NOT_REGULAR_BOUNDED_FILE');
 return fs.readFileSync(f,'utf8');
}
function parseManifest(raw,token){
 const m=JSON.parse(raw);
 assert(m&&typeof m==='object'&&!Array.isArray(m),'INVALID_MANIFEST');
 for(const k of Object.keys(m))assert(MANIFEST_FIELDS.has(k),'UNKNOWN_MANIFEST_KEY:'+k);
 assert(m.schema_version===1&&m.task_token===token,'MANIFEST_IDENTITY_MISMATCH');
 assert(typeof m.task_id==='string'&&/^[A-Z0-9-]{10,110}$/.test(m.task_id),'INVALID_TASK_ID');
 assert(typeof m.batch_id==='string'&&BATCH.test(m.batch_id),'INVALID_BATCH_ID');
 assert(typeof m.purpose==='string'&&m.purpose.trim().length>=12,'PURPOSE_REQUIRED');
 assert(m.create_batch_if_missing===undefined||typeof m.create_batch_if_missing==='boolean',
  'INVALID_CREATE_BATCH_FLAG');
 if(m.create_batch_if_missing){
  assert(typeof m.batch_title==='string'&&m.batch_title.length>=12&&m.batch_title.length<=200,
    'BATCH_TITLE_REQUIRED');
 }
 assert(m.mutation==='ALLOW'||m.mutation==='READ_ONLY','INVALID_MUTATION');
 assert(Array.isArray(m.allowed_write_files),'WRITE_FILE_LIST_REQUIRED');
 assert(Array.isArray(m.deliverables),'DELIVERABLES_REQUIRED');
 assert(Number.isInteger(m.max_tool_calls)&&Number.isInteger(m.max_debug_cycles),
  'BUDGETS_MUST_BE_INTEGERS');
 checkProfile(m.model_profile);
 return m;
}
function contract(m,body){
 assert(typeof body==='string'&&body.trim().length>=160,'PROMPT_BODY_TOO_SHORT');
 assert(!body.includes('TASK_TOKEN: '+m.task_token),'BODY_MUST_NOT_CONTAIN_TASK_TOKEN_MARKER');
 const scope=m.allowed_write_files;
 const footer='TASK_TOKEN: '+m.task_token;
 const protectedNotice=[
  '任务执行硬约束：仅允许写入以下文件：'+JSON.stringify(scope)+'。',
  '除此以外全部只读，尤其不得修改 src/notes/**、data/**、config/config.json、凭据、',
  '历史任务/Batch证据或 Controller 工具链。不得使用 git reset/clean。',
  '不得调用内部子代理。测试尽量使用 synthetic/tempfile，严格报告 PASS/FAIL/SKIP。',
  '最终 Historical Handoff 必须列出实际修改文件、测试证据、工具调用数、',
  '未完成事项与风险；最后一行严格写原始 TASK_TOKEN。'
 ].join('\n');
 const prompt='TASK_TOKEN: '+m.task_token+'\nTASK_ID: '+m.task_id+'\n\n'+
  protectedNotice+'\n\n'+body.trim()+'\n\n'+footer;
 const e={
  schema_version:1,contract_version:3,task_id:m.task_id,task_token:m.task_token,
  workspace:WORKSPACE,mode:'Agent',chat:'NEW',mutation:m.mutation,
  subagent_policy:'DENY_INTERNAL',handoff_policy:'HISTORICAL_BY_TASK_TOKEN',
  batch_id:m.batch_id,purpose:m.purpose,model_profile:m.model_profile,
  deliverables:m.deliverables,write_scope:scope,
  execution_budget:{max_tool_calls:m.max_tool_calls,max_debug_cycles:m.max_debug_cycles},
  prompt
 };
 const issues=validateTask(e);
 assert(!issues.length,'INVALID_CONTRACT:'+issues.join(','));
 return e;
}
function load(token){
 const m=parseManifest(readLocal('dispatch-plans',token,'.json',18000),token);
 const p=readLocal('dispatch-prompts',token,'.md',18000);
 return {m,e:contract(m,p)};
}
function jsonFile(dir,token){
 return filename(dir,token,'.json');
}
function readMaybe(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}
 catch(err){if(err.code==='ENOENT')return null;throw err}}
function readBatch(id){
 const f=path.join(ROOT,'batch-ledgers',id+'.json');
 return readMaybe(f);
}
function guardUnused(token){
 for(const d of ['tasks','state','dispatches','collections','reviews','state/cursor-focus-free']){
  assert(!fs.existsSync(jsonFile(d,token)),'TOKEN_ALREADY_USED_NO_RETRY:'+d);
 }
 const intent=jsonFile('state/dispatch-auto',token);
 assert(!fs.existsSync(intent),'AUTOMATOR_SEND_INTENT_EXISTS_NO_RETRY');
}
function checkBatch(m,allowAbsent){
 const batch=readBatch(m.batch_id);
 if(!batch){
  assert(allowAbsent&&m.create_batch_if_missing===true,'BATCH_NOT_FOUND');
  return {needsCreate:true,taskRegistered:false};
 }
 assert(batch.batch_id===m.batch_id&&batch.status==='OPEN','BATCH_NOT_OPEN');
 const tasks=batch.tasks||[];
 const own=tasks.filter(x=>x.task_token===m.task_token);
 assert(own.length<=1,'TASK_BATCH_DUPLICATE');
 assert(tasks.every(x=>x.task_token===m.task_token||!!x.resolution),
  'OTHER_BATCH_TASK_UNRESOLVED');
 if(own.length)assert(own[0].task_id===m.task_id&&!own[0].resolution&&
  tasks.at(-1)?.task_token===m.task_token,'TASK_BATCH_CONFLICT');
 return {needsCreate:false,taskRegistered:own.length===1};
}
function invoke(script,args){
 const child=cp.spawnSync(process.execPath,[path.join(ROOT,script),...args],{
  encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024,
  cwd:ROOT,env:process.env
 });
 assert(!child.error,'CHILD_FAILED:'+String(child.error?.message));
 assert(child.status===0,'CHILD_NONZERO:'+script+':'+String(child.stdout||child.stderr).slice(0,850));
 let result;
 try{result=JSON.parse(child.stdout)}catch{fail('CHILD_JSON_INVALID:'+script)}
 assert(result.ok===true,'CHILD_NOT_OK:'+script+':'+JSON.stringify(result).slice(0,650));
 return result;
}
function ensureEnvelope(e){
 const f=jsonFile('envelopes',e.task_token);
 const canonical=JSON.stringify(e,null,2)+'\n';
 if(fs.existsSync(f)){
  const s=fs.lstatSync(f);
  assert(s.isFile()&&!s.isSymbolicLink(),'ENVELOPE_NOT_REGULAR');
  assert(fs.readFileSync(f,'utf8')===canonical,'ENVELOPE_EXISTS_DIFFERENT_NO_OVERWRITE');
  return {file:f,created:false};
 }
 fs.mkdirSync(path.dirname(f),{recursive:true});
 fs.writeFileSync(f,canonical,{encoding:'utf8',flag:'wx'});
 return {file:f,created:true};
}
function prepare(m,e){
 guardUnused(m.task_token);
 let gate=checkBatch(m,true);
 if(gate.needsCreate){
  invoke('batch-supervisor.js',['open',m.batch_id,m.batch_title]);
  gate=checkBatch(m,false);
 }
 const file=ensureEnvelope(e);
 if(!gate.taskRegistered){
  invoke('batch-supervisor.js',['add',m.batch_id,m.task_token,m.task_id,m.purpose]);
 }
 const ok=invoke('cursor-primary-task-runner.js',['validate',m.task_token]);
 assert(ok.stage==='VALIDATED','VALIDATION_STAGE_MISMATCH');
 assert(ok.sha256===shaFile(file.file),'ENVELOPE_HASH_MISMATCH');
 return {stage:'VALIDATED',envelope:file.file,envelope_created:file.created,sha256:ok.sha256};
}
function preflight(m,e){
 const stage=prepare(m,e);
 const r=invoke('cursor-primary-task-runner.js',['preflight',m.task_token]);
 assert(r.stage==='PREFLIGHT'&&r.code==='READY_FOR_FOCUS_FREE_DISPATCH',
  'PREFLIGHT_NOT_READY');
 assert(r.sha256===stage.sha256,'PREFLIGHT_CONTRACT_CHANGED');
 return {...stage,stage:'PREFLIGHT',report:r.report};
}
function run(m,e){
 const ready=preflight(m,e);
 // Persist intent BEFORE the official primary runner can alter the GUI.
 const intent=jsonFile('state/dispatch-auto',m.task_token);
 fs.mkdirSync(path.dirname(intent),{recursive:true});
 fs.writeFileSync(intent,JSON.stringify({
  schema_version:1,task_token:m.task_token,task_id:m.task_id,
  envelope_sha256:ready.sha256,requested_model_profile:m.model_profile,
  status:'SEND_INTENT_NO_AUTO_RETRY',created_at:new Date().toISOString()
 },null,2)+'\n',{encoding:'utf8',flag:'wx'});
 const r=invoke('cursor-primary-task-runner.js',['send',m.task_token]);
 assert(r.code==='PRIMARY_DISPATCH_CONFIRMED'&&r.task_token===m.task_token,
  'SEND_NOT_PROVEN_NO_RETRY');
 return {stage:'SUBMITTED',code:r.code,receipt:r.receipt,no_retry:true,token:m.task_token};
}
function main(argv){
 const [action,token]=argv;
 assert(ACTIONS.has(action)&&TOKEN.test(token)&&argv.length===2,
  'USAGE: node controller-dispatch-task.js plan|prepare|preflight|run TOKEN');
 const {m,e}=load(token);
 if(action==='plan'){
  const state=checkBatch(m,true);
  return {ok:true,stage:'PLAN_ONLY_NO_MUTATIONS',token,model_profile:m.model_profile,
   contract_sha256:sha(JSON.stringify(e,null,2)+'\n'),batch:m.batch_id,
   batch_state:state,write_scope:e.write_scope,deliverables:e.deliverables,
   tool_budget:e.execution_budget,prompt_chars:e.prompt.length};
 }
 guardUnused(token);
 const outcome=action==='prepare'?prepare(m,e):
  action==='preflight'?preflight(m,e):run(m,e);
 return {ok:true,token,...outcome};
}
if(require.main===module){
 try{console.log(JSON.stringify(main(process.argv.slice(2)),null,2))}
 catch(err){console.error(JSON.stringify({ok:false,error:String(err.message||err).slice(0,1250),
  no_retry:process.argv[2]==='run'}));process.exitCode=1}
}
module.exports={parseManifest,contract,load,checkBatch,main};
