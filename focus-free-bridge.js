#!/usr/bin/env node
'use strict';
/* Background event dispatcher. Defaults to safe inspection. Does not send
 * unless transport-mode.json opts in and old foreground bridge is stopped.
 * No direct network API, cookie transfers, OS input or focus operations.
 */
const fs=require('fs'),path=require('path');
const t=require('./focus-free-transport.js');
const ROOT=t.ROOT;
const loc=n=>path.join(ROOT,n);
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}};
const modeFile=loc('transport-mode.json');
const configFile=loc('bridge-config.json');
const eventRoot=loc('events');
const statuses={
 BATCH_TERMINAL:new Set(['ACCEPTED','FAILED']),
 BATCH_CONTROLLER_REVIEW_REQUIRED:new Set(['WAITING_CONTROLLER']),
 BATCH_REVIEW_NOT_ACCEPTED:new Set(['WAITING_CONTROLLER_FOLLOWUP']),
 BATCH_CONTROLLER_DECISION_REQUIRED:new Set(['WAITING_CONTROLLER']),
 BATCH_TIMEOUT:new Set(['TIMEOUT'])
};
function validateMode(){
  const mode=read(modeFile);
  if(mode?.mode!=='focus-free'||mode?.schema_version!==1)throw new Error('FOCUS_FREE_NOT_ACTIVATED');
  const oldPidFile=loc('chatgpt-bridge.pid');
  if(fs.existsSync(oldPidFile)){
    const pid=Number(fs.readFileSync(oldPidFile,'utf8').trim());
    if(pid>0){try{process.kill(pid,0);throw new Error('FOREGROUND_BRIDGE_STILL_RUNNING')}catch(e){
      if(e.message==='FOREGROUND_BRIDGE_STILL_RUNNING'||e.code==='EPERM')throw e;
      if(e.code!=='ESRCH')throw e;
    }}
  }
  return read(configFile);
}
function actionability(e,root=ROOT){
  if(!e||typeof e.event_type!=='string')return {code:'INVALID'};
  const statesRoot=path.join(root,'state'),batchesRoot=path.join(root,'batches');
  if(statuses[e.event_type]){
    if(!e.batch_id||!/^[\w.-]+$/.test(e.batch_id))return {code:'INVALID_BATCH_ID'};
    const b=read(path.join(batchesRoot,e.batch_id+'.json'));
    if(!b)return {code:'MISSING_BATCH'};
    if(e.event_type==='BATCH_CONTROLLER_REVIEW_REQUIRED'&&
      b.wait_reason!=='CONTROLLER_REVIEW_REQUIRED')return {code:'STALE'};
    if(e.event_type==='BATCH_CONTROLLER_DECISION_REQUIRED'&&
      b.wait_reason!=='TASK_NEEDS_CONTROLLER_DECISION')return {code:'STALE'};
    return statuses[e.event_type].has(b.status)?{code:'ACTIONABLE'}:{code:'STALE'};
  }
  if(e.event_type==='BATCH_LONG_RUNNING_REVIEW_REQUIRED'){
    const b=read(path.join(batchesRoot,e.batch_id+'.json'));
    if(!b)return {code:'MISSING_BATCH'};
    if(b.status!=='RUNNING')return {code:'STALE'};
    const matches=(b.workers||[]).filter(w=>w.task_token===e.detail?.task_token);
    if(matches.length!==1)return {code:'STALE'};
    const work=read(path.join(statesRoot,e.detail.task_token+'.json'));
    return work&&['RUNNING','DISPATCHED','HANDOFF_FOUND'].includes(work.state)?
      {code:'ACTIONABLE'}:{code:'STALE'};
  }
  if(!e.task_token||!/^[\w.-]+$/.test(e.task_token))return {code:'UNSUPPORTED_EVENT'};
  const s=read(path.join(statesRoot,e.task_token+'.json'));
  if(!s)return {code:'MISSING_WORKER_STATE'};
  const allowed=e.event_type==='TASK_CONTROLLER_READY'?'CONTROLLER_READY':
    e.event_type==='TASK_NEEDS_CONTROLLER_DECISION'?'NEEDS_CONTROLLER_DECISION':
    e.event_type==='TASK_TIMEOUT'?'TIMEOUT':null;
  if(!allowed)return {code:'UNSUPPORTED_EVENT'};
  if(s.state!==allowed)return {code:'STALE'};
  if(e.event_type==='TASK_CONTROLLER_READY'&&fs.existsSync(batchesRoot)){
    const now=Date.now();
    for(const filename of fs.readdirSync(batchesRoot).filter(s=>s.endsWith('.json'))){
      const b=read(path.join(batchesRoot,filename));
      if(!b?.workers?.some(w=>w.task_token===e.task_token))continue;
      if(b.status==='WAITING_CONTROLLER'||b.status==='WAITING_CONTROLLER_FOLLOWUP')return {code:'BATCH_OWNED'};
      if(b.status==='RUNNING'&&Date.parse(b.updated_at)>now-60000)return {code:'WAIT_BATCH_AGGREGATION'};
    }
  }
  return {code:'ACTIONABLE'};
}
function nextEvent(root=ROOT){
  const eventRoot=path.join(root,'events');
  fs.mkdirSync(eventRoot,{recursive:true});
  for(const n of fs.readdirSync(eventRoot).filter(n=>n.endsWith('.json')).sort()){
    const full=path.join(eventRoot,n),ev=read(full);
    if(ev&&actionability(ev,root).code==='ACTIONABLE')return {file:full,event:ev};
  }
  return null;
}
function assertNoInflight(root=ROOT){
  const dir=path.join(root,'events','inflight');
  const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')):[];
  if(files.length)throw new Error('INFLIGHT_REQUIRES_RECONCILIATION_'+files.length);
}
function claim(file,root=ROOT){
  const dst=path.join(root,'events','inflight',path.basename(file));
  fs.mkdirSync(path.dirname(dst),{recursive:true});
  if(fs.existsSync(dst))throw new Error('DUPLICATE_CLAIM');
  fs.renameSync(file,dst);
  return dst;
}
async function withTarget(fn,{headless=true}={}){
  const c=read(configFile);if(!c?.chat_url)throw new Error('NO_CHAT_URL');
  const target=t.validateTarget(c.chat_url);
  const browser=await t.openBrowser({headless});
  try{
    const pages=await browser.pages(),page=pages[0]||await browser.newPage();
    await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:30000});
    return await fn({page,target,config:c});
  }finally{await browser.close()}
}
async function authProbe(){
  return withTarget(async({page,target})=>{
    await new Promise(r=>setTimeout(r,1400));
    const s=await t.viewStatus(page,target);
    return {ok:true,code:s.code,editor_available:s.editor_available,url_match:s.url_match,
      foreground_untouched:true,no_messages_sent:true,
      login_help:s.code!=='READY'?'One-time login needed in the dedicated browser profile':undefined};
  });
}
async function processOnce(){
  const config=validateMode();if(!config?.enabled)throw new Error('BRIDGE_DISABLED');
  assertNoInflight();
  const picked=nextEvent();
  if(!picked)return {ok:true,code:'NO_ACTIONABLE_EVENTS'};
  return withTarget(async({page,target})=>{
    const status=await t.viewStatus(page,target);
    if(status.code!=='READY')return {ok:false,code:status.code};
    const selector=await t.getEditor(page);
    if(!selector)return {ok:false,code:'EDITOR_NOT_FOUND'};
    const editorText=await page.$eval(selector,e=>e.innerText||e.textContent||'');
    if(t.clean(editorText))return {ok:false,code:'EDITOR_HAS_DRAFT'};
    if(await page.$('[data-testid="stop-button"],button[aria-label="Stop generating"]'))
      return {ok:false,code:'CHATGPT_BUSY'};
    // Claim only after target, authentication, idle and empty composer all confirmed.
    const claimed=claim(picked.file);
    const journal=loc(path.join('state','focus-free',path.basename(claimed)+'.json'));
    try{
      const result=await t.sendOnce({page,chatUrl:config.chat_url,event:picked.event,file:claimed,journalFile:journal});
      fs.mkdirSync(path.join(eventRoot,'sent'),{recursive:true});
      fs.renameSync(claimed,path.join(eventRoot,'sent',path.basename(claimed,'.json')+'.sent.json'));
      return {ok:true,code:result.code,event_type:picked.event.event_type};
    }catch(e){
      // Inflight + journal are retained. Never automatically resend unknown submissions.
      return {ok:false,code:e.message,claimed,requires_manual_reconcile:true};
    }
  });
}
async function main(){
  const action=process.argv[2]||'doctor';
  if(action==='doctor'){
    const m=read(modeFile)||{mode:'legacy'};
    const c=read(configFile)||{};
    return {ok:true,code:'DOCTOR',mode:m.mode,profile_exists:fs.existsSync(t.PROFILE),
      edge_exists:fs.existsSync(t.EDGE),puppeteer_available:!!t.findPuppeteer(),
      target_valid:!!t.validateTarget(c.chat_url),event_queue_files:fs.existsSync(eventRoot)?
        fs.readdirSync(eventRoot).filter(x=>x.endsWith('.json')).length:0};
  }
  if(action==='auth-probe')return authProbe();
  if(action==='once')return processOnce();
  if(action==='serve'){
    validateMode(); // fail before entering poll loop if old foreground Bridge is alive
    let previous='';
    while(true){
      let result;
      try{result=await processOnce()}
      catch(e){result={ok:false,code:String(e.message||e)}}
      const current=JSON.stringify(result);
      if(current!==previous&&result.code!=='NO_ACTIONABLE_EVENTS')
        process.stdout.write(new Date().toISOString()+' '+current+'\\n');
      previous=current;
      // Never retry ambiguous inflight, just report until reconciled.
      await new Promise(resolve=>setTimeout(resolve,3500));
    }
  }
  throw new Error('USAGE: doctor | auth-probe | once | serve');
}
if(require.main===module)main().then(x=>console.log(JSON.stringify(x))).catch(e=>{
  console.error(JSON.stringify({ok:false,code:String(e.message||e)}));process.exitCode=1;
});
module.exports={actionability,nextEvent,assertNoInflight,validateMode,claim};
