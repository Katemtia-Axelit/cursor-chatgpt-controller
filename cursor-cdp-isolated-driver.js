'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),cp=require('child_process');
const {findPuppeteer}=require('./focus-free-transport.js');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const matchesDiagnosticReply=(txt,token)=>{
 if(typeof txt!=='string'||typeof token!=='string')return false;
 const lines=txt.trim().split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 const resultLine='RESULT: OK',tokenLine='TASK_TOKEN: '+token;
 return lines.length>=2&&lines.length<=3&&
   lines.filter(x=>x===resultLine).length===1&&
   lines.filter(x=>x===tokenLine).length>=1&&
   lines.every(x=>x===resultLine||x===tokenLine);
};
class CursorIsolatedCDPDriver{
 constructor({workspace,root,port=41381,profilePath}){
  this.workspace=path.resolve(workspace);this.root=root;this.port=port;
  this.profilePath=profilePath||path.join(root,'cursor-cdp-isolated-profile');
  this.boundInstance=null;this.mode='Agent';
  this.browser=null;this.page=null;this.created=false;
 }
 osGuard(){
  const script=path.join(__dirname,'cursor-cdp-os-guard.ps1');
  const v=cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive',
    '-ExecutionPolicy','Bypass','-File',script,'-Workspace',this.workspace,
    '-ProfilePath',this.profilePath,'-Port',String(this.port)],
   {encoding:'utf8',timeout:18000,windowsHide:true});
  const d=JSON.parse(v.trim());
  if(d.ok!==true)throw Error('CURSOR_NOT_MINIMIZED_OR_WRONG_PROCESS_'+d.code);
  const identity=d.process_id+':'+d.process_started_at;
  if(this.boundInstance!==null&&this.boundInstance!==identity)
    throw Error('CURSOR_PROCESS_RESTARTED_MID_TASK_NO_RETRY');
  this.boundInstance=identity;this.pid=d.process_id;
  return d;
 }
 async getPage(){
  if(!this.browser)this.browser=await findPuppeteer().connect({browserURL:'http://127.0.0.1:'+this.port});
  if(!this.page){
   const pages=await this.browser.pages();
   if(pages.length!==1||!pages[0].url().startsWith('vscode-file://'))throw Error('CURSOR_TARGET_NOT_UNIQUE');
   if(!(await pages[0].title()).includes(path.basename(this.workspace)))throw Error('WRONG_WORKSPACE_TITLE');
   this.page=pages[0];
  }
  return this.page;
 }
 async inspect(workspace){
  if(path.resolve(workspace)!==path.resolve(this.workspace))throw Error('WORKSPACE_DIFFERENT');
  this.osGuard();
  const p=await this.getPage();
  const status=await p.evaluate(()=>{
   const ed=document.querySelectorAll('.aislash-editor-input');
   const named=[...document.querySelectorAll('button,[role=button]')].filter(b=>
      (b.getAttribute('aria-label')||b.getAttribute('title')||b.innerText||'').trim()==='New Agent');
   return {editor_count:ed.length,input_empty:ed.length===1&&!(ed[0].innerText||'').trim(),
     new_agent_invokable:named.length===1,
     mode_dropdown_invokable:document.querySelectorAll('.composer-unified-dropdown[data-mode]').length===1,
     assistant_busy:!!document.querySelector('[aria-label="Stop generating"],[aria-label="Stop"],[title="Stop generating"]')};
  });
  return {...status,no_focus_capability:true,workspace_matches:1,isolated_cdp:true};
 }
 async newChat(){
  this.osGuard();const p=await this.getPage();
  const result=await p.evaluate(()=>{
   const named=[...document.querySelectorAll('button,[role=button]')].filter(b=>
    (b.getAttribute('aria-label')||b.getAttribute('title')||b.innerText||'').trim()==='New Agent');
   if(named.length!==1)throw Error('NEW_AGENT_AMBIGUOUS');
   named[0].click();return true;
  });
  await wait(500);
  this.osGuard();
  const v=await p.evaluate(()=>{
   const editors=document.querySelectorAll('.aislash-editor-input');
   return editors.length===1&&!(editors[0].innerText||'').trim();
  });
  this.created=result&&v;
  return {created:!!result,unique:!!v};
 }
 async selectMode(mode){
  const suffix={Agent:'agent',Ask:'chat',Plan:'plan',Debug:'debug'}[mode];
  if(!suffix)throw Error('MODE_UNSUPPORTED_FAIL_CLOSED');
  this.osGuard();
  const actual=await this.readMode();
  if(actual===mode){this.mode=mode;return}
  const p=await this.getPage();
  await p.evaluate(target=>{
   const opts=document.querySelectorAll('.composer-unified-dropdown[data-mode]');
   if(opts.length!==1)throw Error('MODE_DROPDOWN_NOT_UNIQUE');
   opts[0].click();
   const found=[...document.querySelectorAll('[id^="composer-mode-"]')]
      .filter(el=>el.id.endsWith('unifieddropdown-'+target));
   if(found.length!==1)throw Error('MODE_OPTION_NOT_UNIQUE');
   found[0].click();
  },suffix);
  await wait(400);
  this.osGuard();
  if(await this.readMode()!==mode)throw Error('MODE_VERIFY_FAILED');
  this.mode=mode;
 }
 async readMode(){
  const p=await this.getPage();
  return await p.evaluate(()=>{
   const q=document.querySelectorAll('.composer-unified-dropdown[data-mode]');
   if(q.length!==1)return 'UNKNOWN';
   return {agent:'Agent',chat:'Ask',plan:'Plan',debug:'Debug'}[q[0].getAttribute('data-mode')]||'UNKNOWN';
  });
 }
 async writePrompt(value){
  this.osGuard();const p=await this.getPage();
  if((await this.readPrompt()).trim())throw Error('UNEXPECTED_USER_DRAFT');
  const r=await p.evaluate(text=>{
   const e=document.querySelector('.aislash-editor-input');
   if(!e)throw Error('EDITOR_UNAVAILABLE');
   e.focus({preventScroll:true});
   return document.execCommand('insertText',false,text);
  },value);
  if(!r)throw Error('DOM_INSERT_RETURNED_FALSE');
  await wait(450);this.osGuard();
 }
 async readPrompt(){
  const p=await this.getPage();
  return p.evaluate(()=>document.querySelector('.aislash-editor-input')?.innerText||'');
 }
 async submit(e){
  this.osGuard();
  const page=await this.getPage();
  const suffix={Agent:'agent',Ask:'chat',Plan:'plan',Debug:'debug'}[e.mode];
  if(!suffix||await this.readMode()!==e.mode)throw Error('PRE_SUBMIT_MODE_MISMATCH');
  await page.evaluate(({token,mode})=>{
   const inputs=document.querySelectorAll('.aislash-editor-input');
   const buttons=[...document.querySelectorAll('.send-with-mode > .anysphere-icon-button[data-mode]')]
      .filter(b=>b.getAttribute('data-mode')===mode);
   if(inputs.length!==1||buttons.length!==1||!(inputs[0].innerText||'').includes(token))
     throw Error('SUBMIT_TARGET_CHANGED');
   const send=buttons[0];
   if(send.className.includes('disabled')||send.getAttribute('aria-disabled')==='true' ||
     !!send.querySelector('.codicon-mic'))
     throw Error('SEND_NOT_READY');
   send.click();
  },{token:e.task_token,mode:suffix});
  this.osGuard();
 }
 async confirm(token){
  if(!this.created)throw Error('NEW_CHAT_NOT_RECORDED');
  const stateFile=path.join(this.root,'state','cursor-focus-free',token.replace(/:/g,'_')+'.json');
  const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
  if(state.state!=='SUBMITTING'||!state.submit_intent_at)throw Error('SUBMIT_INTENT_MISSING');
  const started=Date.parse(state.submit_intent_at);
  const leaf=path.basename(this.workspace);
  const traceRoot=path.join(os.homedir(),'.cursor','agent-traces',leaf);
  for(let attempts=0;attempts<54;attempts++){
   this.osGuard();
   const matches=[];
   if(fs.existsSync(traceRoot)){
    for(const name of fs.readdirSync(traceRoot)){
     const dir=path.join(traceRoot,name);
     if(!fs.statSync(dir).isDirectory())continue;
     const handoff=path.join(dir,'LATEST_HANDOFF.md'),response=path.join(dir,'responses.jsonl');
     if(!fs.existsSync(handoff)||!fs.existsSync(response))continue;
     const md=fs.readFileSync(handoff,'utf8');
     if(!md.includes('TASK_TOKEN: '+token)||!md.includes('| Project | '+leaf+' |'))continue;
     const workspacePath=this.workspace.replace(/\\/g,'/').toLowerCase();
     if(!md.toLowerCase().replace(/\\/g,'/').includes(workspacePath))continue;
     const rows=fs.readFileSync(response,'utf8').split(/\r?\n/).filter(Boolean).flatMap(x=>{try{return [JSON.parse(x)]}catch{return []}});
     const found=rows.filter(x=>
       matchesDiagnosticReply(x.text,token) &&
       x.conversation_id===name && md.includes(x.generation_id) &&
       Date.parse(x.timestamp)>=started);
     if(found.length!==1)continue;
     matches.push({conversation_id:name,generation_id:found[0].generation_id,
       response_timestamp:found[0].timestamp,
       handoff_sha256:crypto.createHash('sha256').update(md).digest('hex'),
       handoff_path:handoff});
    }
   }
   if(matches.length>1)throw Error('MULTIPLE_HANDOFF_MATCHES');
   if(matches.length===1)return {verified_handoff:true,new_chat:true,unique_visible_token:false,evidence:matches[0]};
   await wait(1500);
  }
  throw Error('HANDOFF_TIMEOUT_UNCONFIRMED');
 }
 async close(){if(this.browser){this.browser.disconnect();this.browser=null;this.page=null}}
}
module.exports={CursorIsolatedCDPDriver,matchesDiagnosticReply};
