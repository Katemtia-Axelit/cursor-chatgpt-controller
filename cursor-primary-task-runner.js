#!/usr/bin/env node
'use strict';
// Fixed, reviewable dispatcher for one task envelope JSON.
// No alternate transport, automatic retry, or edits to prior task records.
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const {OneShotDispatcher,validateEnvelope}=require('./cursor-focus-free-core.js');
const {PrimaryCursorCDPDriver}=require('./cursor-primary-cdp-driver.js');
const {checkProfile,label}=require('./cursor-model-profile.js');
const {acquireSharedCursorLock}=require('./cursor-shared-lock.js');
const ROOT=__dirname;
const WORKSPACE=process.env.CONTROLLER_WORKSPACE||'';
const INPUT_ROOT=path.join(ROOT,'envelopes');
const TOKEN=/^[A-Z0-9_]{12,110}$/;
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
const exists=(dir,token)=>fs.existsSync(path.join(ROOT,dir,token+'.json'));
function check(ok,code){if(!ok)throw Error(code)}
function boundedFile(p){
 check(typeof p==='string'&&p.length>0&&p.length<=190,'INVALID_WRITE_SCOPE');
 check(!p.includes('\\')&&!p.includes(':')&&!p.includes('*')&&!p.startsWith('/')&&!p.endsWith('/'),'UNSAFE_SCOPE_SYNTAX');
 const parts=p.split('/');
 check(parts.every(x=>x!==''&&x!=='.'&&x!=='..'&&!x.startsWith('.')),'UNSAFE_SCOPE_TRAVERSAL');
 check(!/^(data|config|src\/notes|\.cursor|\.git|static\/vendor)(\/|$)/i.test(p),'PROTECTED_SCOPE');
 return p;
}
function validateTask(e){
 const problems=validateEnvelope(e);
 const fail=code=>problems.push(code);
 if(e?.contract_version!==3)fail('CONTRACT_VERSION_3_REQUIRED');
 if(e?.model_profile!==undefined)try{checkProfile(e.model_profile)}catch(err){fail(err.message)}
 if(!TOKEN.test(e?.task_token||''))fail('SAFE_TOKEN_REQUIRED');
 if(e?.mode!=='Agent'||e?.chat!=='NEW')fail('NEW_AGENT_REQUIRED');
 if(path.win32.normalize(e?.workspace||'').toLowerCase()!==path.win32.normalize(WORKSPACE).toLowerCase())fail('WRONG_WORKSPACE');
 if(!/^[A-Z0-9_]{10,110}$/.test(e?.batch_id||''))fail('BATCH_REQUIRED');
 if(!['ALLOW','READ_ONLY'].includes(e?.mutation))fail('MUTATION_INVALID');
 const scope=e?.write_scope;
 if(!Array.isArray(scope)||scope.length>8)fail('WRITE_SCOPE_INVALID');
 else {
  if(e.mutation==='ALLOW'&&scope.length===0)fail('MUTATION_SCOPE_EMPTY');
  if(e.mutation==='READ_ONLY'&&scope.length)fail('READONLY_SCOPE_NOT_EMPTY');
  for(const name of scope)try{boundedFile(name)}catch(err){fail(err.message)}
  if(new Set(scope).size!==scope.length)fail('DUPLICATE_WRITE_SCOPE');
 }
 const items=e?.deliverables;
 if(!Array.isArray(items)||!items.length||items.length>8||items.some(x=>typeof x!=='string'))fail('DELIVERABLES_REQUIRED');
 else if(e.mutation==='ALLOW'&&items.some(x=>!scope?.includes(x)))fail('DELIVERABLE_NOT_IN_SCOPE');
 const budget=e?.execution_budget||{};
 if(!Number.isInteger(budget.max_tool_calls)||budget.max_tool_calls<5||budget.max_tool_calls>80)fail('TOOL_BUDGET_INVALID');
 if(!Number.isInteger(budget.max_debug_cycles)||budget.max_debug_cycles<0||budget.max_debug_cycles>5)fail('DEBUG_BUDGET_INVALID');
 if(typeof e?.purpose!=='string'||e.purpose.length<12||e.purpose.length>350)fail('PURPOSE_INVALID');
 if(typeof e?.prompt!=='string'||e.prompt.length<300||e.prompt.length>9500)fail('PROMPT_INVALID');
 else {
  if(!e.prompt.startsWith('TASK_TOKEN: '+e.task_token+'\nTASK_ID: '+e.task_id+'\n'))fail('PROMPT_HEADER_INVALID');
  if(e.prompt.trimEnd().split(/\r?\n/).at(-1)!=='TASK_TOKEN: '+e.task_token)fail('PROMPT_TERMINAL_TOKEN_INVALID');
 }
 return [...new Set(problems)];
}
function inputFile(token){
 check(TOKEN.test(token),'BAD_TOKEN');
 return path.join(INPUT_ROOT,token+'.json');
}
function readInput(token){
 const file=inputFile(token);
 const s=fs.lstatSync(file);
 check(s.isFile()&&!s.isSymbolicLink()&&s.size<=35000,'INVALID_INPUT_FILE');
 const e=JSON.parse(fs.readFileSync(file,'utf8'));
 check(e.task_token===token,'TOKEN_FILE_MISMATCH');
 const issues=validateTask(e);
 check(!issues.length,'INVALID_ENVELOPE:'+issues.join(','));
 return {file,e,digest:sha(file)};
}
function gateBatch(e){
 const filename=path.join(ROOT,'batch-ledgers',e.batch_id+'.json');
 const b=JSON.parse(fs.readFileSync(filename,'utf8'));
 check(b.batch_id===e.batch_id&&b.status==='OPEN','BATCH_NOT_OPEN');
 const rows=b.tasks||[],matching=rows.filter(x=>x.task_token===e.task_token);
 check(matching.length===1&&matching[0].task_id===e.task_id&&!matching[0].resolution,'TASK_NOT_UNIQUELY_REGISTERED');
 check(rows.every(x=>x.task_token===e.task_token||!!x.resolution),'OTHER_TASK_UNRESOLVED');
 check(rows.at(-1)?.task_token===e.task_token,'TOKEN_NOT_BATCH_TAIL');
 return {batch_id:b.batch_id,sequence:matching[0].sequence};
}
function noReuse(token){
 for(const dir of ['tasks','state','dispatches','collections','reviews','state/cursor-focus-free'])
  check(!exists(dir,token),'TOKEN_PREVIOUSLY_USED_NO_RETRY:'+dir);
}
function controller(...args){
 const r=cp.spawnSync('node.exe',[path.join(ROOT,'controller-loop.js'),...args],
  {encoding:'utf8',timeout:50000,windowsHide:true,maxBuffer:1024*1024});
 check(!r.error&&r.status===0,'CONTROLLER_'+args[0]+'_FAILED');
 const o=JSON.parse(r.stdout);
 check(o.ok===true,'CONTROLLER_'+args[0]+'_REFUSED');
 return o;
}
function writeOnce(file,content){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify(content,null,2)+'\n',{flag:'wx'});
}
// Cursor's editor may flatten newline boundaries and wrap the user message in
// <timestamp>/<user_query>. Require the COMPLETE original prompt after
// whitespace normalization, not merely the presence of a token or task ID.
const compact=s=>String(s||'').replace(/\s+/g,'');
function userQueryMatches(body,prompt){
 if(typeof body!=='string'||typeof prompt!=='string'||!prompt)return false;
 const wrapped=body.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
 const actual=wrapped?wrapped[1]:body;
 return compact(actual)===compact(prompt);
}
function userTranscript(token,taskId,since,expectedPrompt){
 const dir=process.env.CURSOR_AGENT_TRANSCRIPTS_DIR||path.join(process.env.USERPROFILE||process.env.HOME||'', '.cursor','projects',process.env.CONTROLLER_PROJECT_SLUG||'PROJECT_SLUG_REQUIRED','agent-transcripts');
 check(typeof expectedPrompt==='string'&&expectedPrompt.startsWith('TASK_TOKEN: '+token+'\nTASK_ID: '+taskId+'\n'),'EXPECTED_PROMPT_IDENTITY_INVALID');
 if(!fs.existsSync(dir))return null;
 const matches=[];
 for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
  if(!ent.isDirectory()||!/^[0-9a-f-]{36}$/i.test(ent.name))continue;
  const f=path.join(dir,ent.name,ent.name+'.jsonl');
  if(!fs.existsSync(f)||fs.statSync(f).mtimeMs<since-30000)continue;
  for(const line of fs.readFileSync(f,'utf8').split(/\r?\n/).filter(Boolean)){
   let obj;try{obj=JSON.parse(line)}catch{continue}
   if(obj.role!=='user')continue;
   const body=(obj.message?.content||[]).filter(x=>x?.type==='text').map(x=>x.text).join('');
   if(userQueryMatches(body,expectedPrompt))
    matches.push({conversation_id:ent.name,transcript_path:f,proof_format:'NORMALIZED_EXACT_FULL_USER_QUERY'});
  }
 }
 check(matches.length<=1,'MULTIPLE_USER_TRANSCRIPTS');
 return matches[0]||null;
}
class PrimaryProvenDriver extends PrimaryCursorCDPDriver{
 async confirm(token){
  check(this.created&&token===this.expectedToken,'WRONG_CONFIRMED_CHAT');
  const j=JSON.parse(fs.readFileSync(path.join(ROOT,'state','cursor-focus-free',token+'.json'),'utf8'));
  const since=Date.parse(j.submit_intent_at);
  check(Number.isFinite(since),'DURABLE_SUBMIT_INTENT_MISSING');
  for(let n=0;n<50;n++){
   this.assertStealthWindow();
   const evidence=userTranscript(token,this.expectedTaskId,since,this.expectedPrompt);
   if(evidence)return {new_chat:true,verified_submission_transcript:true,
    evidence:{kind:'CURSOR_USER_TRANSCRIPT',...evidence}};
   await new Promise(resolve=>setTimeout(resolve,700));
  }
  throw Error('SUBMISSION_TRANSCRIPT_UNCONFIRMED_NO_RETRY');
 }
}
// Shared receipt shape expected by controller-loop.js collect().
// Build only from a confirmed one-shot journal and the matching task contract.
function buildReceipt(e,j,digest,journalPath){
 check(j?.state==='CONFIRMED'&&j.confirmation==='CURSOR_USER_TRANSCRIPT_CONFIRMED'&&
  j.evidence?.kind==='CURSOR_USER_TRANSCRIPT'&&j.evidence.conversation_id,'PROOF_MISSING');
 check(j.task_token===e.task_token&&j.task_id===e.task_id&&
  j.requested_mode===e.mode,'RECEIPT_IDENTITY_OR_MODE_MISMATCH');
 return {schema_version:1,task_token:e.task_token,task_id:e.task_id,
  status:'SUBMITTED',workspace:e.workspace,chat:e.chat,
  requested_mode:e.mode,verified_mode:j.requested_mode,
  mutation:e.mutation,allowed_write_scope:e.write_scope,envelope_sha256:digest,
  conversation_id:j.evidence.conversation_id,transport_journal:journalPath,
  submission_proof:'CURSOR_USER_TRANSCRIPT_CONFIRMED',final_handoff_pending:true,no_retry:true,
  model_profile:e.model_profile||null,model_label:e.model_profile?label(e.model_profile):null,
  updated_at:new Date().toISOString()};
}
async function run(action,token){
 check(['validate','preflight','send'].includes(action),'USAGE: validate|preflight|send TASK_TOKEN');
 const {file,e,digest}=readInput(token);
 gateBatch(e);noReuse(token);
 if(action==='validate')return {ok:true,stage:'VALIDATED',task_token:token,sha256:digest};
 const driver=new PrimaryProvenDriver({root:ROOT,workspace:WORKSPACE,modelProfile:e.model_profile||null});
 driver.expectedToken=token;driver.expectedTaskId=e.task_id;driver.expectedPrompt=e.prompt;
 try {
  // Parameter selection is a verified preflight mutation under the existing shared UI lock.
  if(e.model_profile){
   const lease=await acquireSharedCursorLock(ROOT,e.task_token,{waitMs:800});
   try{await driver.configureModelProfile()}finally{await lease.release()}
  }
  const dispatcher=new OneShotDispatcher({root:ROOT,driver});
  const ready=await dispatcher.preflight(e);
  if(!ready.ok)return {ok:false,stage:'PREFLIGHT',...ready};
  if(action==='preflight')return {ok:true,stage:'PREFLIGHT',...ready,sha256:digest};
  const target=path.join(ROOT,'tasks',token+'.json');
  writeOnce(target,e);
  controller('register',target);
  const result=await dispatcher.dispatch(e);
  if(!result.ok){
   controller('mark',token,['AMBIGUOUS_NO_RETRY','PAUSED_NO_RETRY'].includes(result.code)?
    'NEEDS_CONTROLLER_DECISION':'DISPATCH_FAILED',
    JSON.stringify({reason:result.code,no_retry:true}));
   return {ok:false,stage:'SUBMISSION',...result,no_retry:true};
  }
  const j=JSON.parse(fs.readFileSync(result.journal,'utf8'));
  const receipt=path.join(ROOT,'dispatches',token+'.json');
  writeOnce(receipt,buildReceipt(e,j,digest,result.journal));
  controller('mark',token,'DISPATCHED',JSON.stringify({receipt,no_retry:true}));
  return {ok:true,code:'PRIMARY_DISPATCH_CONFIRMED',task_token:token,receipt,no_retry:true};
 }finally{await driver.close()}
}
if(require.main===module){
 run(process.argv[2],process.argv[3]).then(o=>{
  process.stdout.write(JSON.stringify(o,null,2)+'\n');if(!o.ok)process.exitCode=2;
 }).catch(err=>{
  process.stdout.write(JSON.stringify({ok:false,error:String(err.message||err).slice(0,450),no_retry:true})+'\n');
  process.exitCode=1;
 });
}
module.exports={run,buildReceipt,validateTask,boundedFile,gateBatch,noReuse,userTranscript,userQueryMatches,WORKSPACE};
