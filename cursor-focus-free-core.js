'use strict';
/**
 * Focus-free Cursor dispatch contract and crash-safe state machine.
 *
 * This is a transport-independent core. A real Cursor driver must separately
 * prove its no-focus behavior before enablement. No CLI, UIA SetFocus, SendKeys,
 * global clipboard, window activation or Browser profile copying here.
 *
 * A partial UI mutation is ambiguous: NEVER automatically replay this token.
 */
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {acquireSharedCursorLock}=require('./cursor-shared-lock.js');
const normalize=s=>String(s||'').replace(/\s+/g,'');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const tokenRe=/^[A-Za-z0-9_.:-]{8,}$/;
const fields=['schema_version','task_id','task_token','workspace','mode','chat','mutation',
 'subagent_policy','handoff_policy','prompt'];
const allowedModes=new Set(['Agent','Ask','Plan','Debug']);
function validateEnvelope(e){
 const issues=[];
 if(!e||typeof e!=='object'||Array.isArray(e))return ['INVALID_ENVELOPE'];
 for(const f of fields)if(e[f]===undefined||e[f]===null)issues.push('MISSING_'+f.toUpperCase());
 if(e.schema_version!==1)issues.push('INVALID_SCHEMA_VERSION');
 if(typeof e.task_id!=='string'||!e.task_id.trim())issues.push('INVALID_TASK_ID');
 if(typeof e.task_token!=='string'||!tokenRe.test(e.task_token))issues.push('INVALID_TASK_TOKEN');
 if(typeof e.workspace!=='string'||!path.win32.isAbsolute(e.workspace)&&!path.isAbsolute(e.workspace))
   issues.push('INVALID_WORKSPACE');
 if(!allowedModes.has(e.mode))issues.push('UNSUPPORTED_MODE');
 if(e.chat!=='NEW')issues.push('REQUIRES_NEW_TOP_LEVEL_CHAT');
 if(!['READ_ONLY','ALLOW'].includes(e.mutation))issues.push('INVALID_MUTATION');
 if(e.subagent_policy!=='DENY_INTERNAL')issues.push('SUBAGENTS_FORBIDDEN');
 if(e.handoff_policy!=='HISTORICAL_BY_TASK_TOKEN')issues.push('HANDOFF_POLICY_INVALID');
 if(typeof e.prompt!=='string'||!e.prompt.trim()||
    typeof e.task_token!=='string'||!e.prompt.includes(e.task_token))
   issues.push('PROMPT_TASK_TOKEN_MISSING');
 return [...new Set(issues)];
}
function atomicJson(file,obj){
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const tmp=file+'.'+process.pid+'.'+crypto.randomBytes(4).toString('hex')+'.tmp';
 fs.writeFileSync(tmp,JSON.stringify(obj,null,2)+'\n','utf8');
 fs.renameSync(tmp,file);
}
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
function requireReady(report){
 if(!report||report.no_focus_capability!==true)throw Error('NO_FOCUS_TRANSPORT_UNPROVEN');
 if(report.workspace_matches!==1)throw Error('WORKSPACE_WINDOW_NOT_UNIQUE');
 if(report.editor_count!==1||report.input_empty!==true)throw Error('COMPOSER_NOT_UNIQUELY_EMPTY');
 if(report.new_agent_invokable!==true||report.mode_dropdown_invokable!==true)
   throw Error('NEW_CHAT_OR_MODE_UNAVAILABLE');
 if(report.assistant_busy===true)throw Error('CURSOR_AGENT_BUSY');
}
class OneShotDispatcher{
 constructor({root,driver}){
  if(!root||!driver)throw Error('ROOT_AND_DRIVER_REQUIRED');
  this.root=root;this.driver=driver;
 }
 journalFile(token){
  if(!tokenRe.test(token))throw Error('INVALID_TASK_TOKEN');
  return path.join(this.root,'state','cursor-focus-free',token.replace(/:/g,'_')+'.json');
 }
 async preflight(e){
  const errors=validateEnvelope(e);
  if(errors.length)return {ok:false,code:'INVALID_ENVELOPE',errors};
  if(!fs.existsSync(e.workspace))return {ok:false,code:'WORKSPACE_NOT_FOUND'};
  const journal=this.journalFile(e.task_token);
  if(fs.existsSync(journal))return {ok:false,code:'TOKEN_ALREADY_ATTEMPTED_NO_RETRY',state:read(journal)?.state};
  const report=await this.driver.inspect(e.workspace);
  try{requireReady(report)}catch(err){return {ok:false,code:err.message,report}}
  return {ok:true,code:'READY_FOR_FOCUS_FREE_DISPATCH',mode:e.mode,
    token:e.task_token,prompt_hash:sha(e.prompt),report};
 }
 async dispatch(e){
  const check=await this.preflight(e);
  if(!check.ok)return check;
  const file=this.journalFile(e.task_token);
  // The original dispatch.ps1 holds the SAME dispatch-ui.lock with FileShare.None.
  // A Windows FileStream lease is released by the OS on process crash.
  let sharedLock;
  try{sharedLock=await acquireSharedCursorLock(this.root,e.task_token,{waitMs:800})}
  catch{return {ok:false,code:'CURSOR_DISPATCH_LOCKED'}}
  // Recheck after entering the *shared* lock: the UI may have changed while waiting.
  try{requireReady(await this.driver.inspect(e.workspace))}
  catch(err){await sharedLock.release();return {ok:false,code:'LOCKED_PREFLIGHT_'+String(err.message||err)}}
  const progress={schema_version:1,task_token:e.task_token,task_id:e.task_id,
   requested_mode:e.mode,prompt_hash:sha(e.prompt),transport:'CURSOR_FOCUS_FREE_EXPERIMENT',
   state:'PREPARE_INTENT',started_at:new Date().toISOString()};
  // Intent written before *any* UI mutation. A crash is never auto-replayed.
  try{
   fs.mkdirSync(path.dirname(file),{recursive:true});
   const fd=fs.openSync(file,'wx');fs.closeSync(fd);
  }catch(err){await sharedLock.release();return {ok:false,code:'TOKEN_ALREADY_ATTEMPTED_NO_RETRY'}}
  const persist=(state,fields={})=>{
   Object.assign(progress,fields,{state,updated_at:new Date().toISOString()});
   atomicJson(file,progress);
  };
  try{
   persist('NEW_CHAT_INTENT');
   const created=await this.driver.newChat(e);
   if(created?.created!==true||created?.unique!==true)throw Error('NEW_CHAT_NOT_UNIQUELY_PROVEN');
   persist('NEW_CHAT_VERIFIED');
   persist('MODE_CHANGE_INTENT');
   await this.driver.selectMode(e.mode);
   if(await this.driver.readMode()!==e.mode)throw Error('MODE_VERIFY_FAILED');
   persist('MODE_VERIFIED');
   persist('COMPOSER_WRITE_INTENT');
   await this.driver.writePrompt(e.prompt);
   const actual=await this.driver.readPrompt();
   if(normalize(actual)!==normalize(e.prompt))throw Error('PROMPT_VERIFY_FAILED');
   persist('PREPARED',{prepared_at:new Date().toISOString()});
   const state=await this.driver.inspect(e.workspace);
   if(state?.no_focus_capability!==true||state?.assistant_busy===true)
     throw Error('PRE_SUBMIT_GUARD_FAILED');
   if(normalize(await this.driver.readPrompt())!==normalize(e.prompt))
     throw Error('PRE_SUBMIT_EDITOR_CHANGED');
   // Durable intent precedes the *only* submit call, even if the UI times out.
   persist('SUBMITTING',{submit_intent_at:new Date().toISOString()});
   await this.driver.submit(e);
   // The UI composer is free once click completed; waiting for the model/Handoff
   // must not serialize unrelated Cursor top-level Agent conversations.
   await sharedLock.release();sharedLock=null;
   const proof=await this.driver.confirm(e.task_token);
   if(proof?.new_chat!==true||
      (proof?.unique_visible_token!==true&&proof?.verified_handoff!==true&&
       proof?.verified_submission_transcript!==true))
     throw Error('SUBMISSION_NOT_PROVEN');
   const confirmation=proof?.verified_handoff===true?'EXACT_RESPONSE_AND_HISTORICAL_HANDOFF':
     proof?.verified_submission_transcript===true?'CURSOR_USER_TRANSCRIPT_CONFIRMED':'UNIQUE_CHAT_TOKEN_VISIBLE';
   persist('CONFIRMED',{confirmed_at:new Date().toISOString(),confirmation,
     evidence:proof?.evidence||null});
   return {ok:true,code:'CONFIRMED',task_token:e.task_token,journal:file};
  }catch(err){
   const former=progress.state;
   const state=former==='SUBMITTING'?'AMBIGUOUS_NO_RETRY':'PAUSED_NO_RETRY';
   persist(state,{failed_from:former,failure_code:String(err.message||err).slice(0,100)});
   return {ok:false,code:state,reason:progress.failure_code,task_token:e.task_token,journal:file};
  }finally{
   // Both dispatchers release the same native Windows file-share lease.
   if(sharedLock)await sharedLock.release();
  }
 }
}
module.exports={OneShotDispatcher,validateEnvelope,requireReady,normalize,sha,atomicJson,read};
