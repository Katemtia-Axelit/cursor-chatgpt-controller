'use strict';
/**
 * Focus-free ChatGPT transport. A separately profiled, headless Edge process
 * controlled through the Chromium DevTools Protocol pipe.
 * No OS focus/keyboard/mouse calls, no reading browser cookies, no CAPTCHA bypass.
 * The legacy bridge stays active until an explicit verified cutover.
 */
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const ROOT=path.join(os.homedir(),'.cursor','controller-loop');
const EDGE='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE=path.join(ROOT,'dedicated-chatgpt-profile');
const READINESS_SELECTORS=['#prompt-textarea','[data-testid="prompt-textarea"]','[contenteditable="true"][data-lexical-editor="true"]'];
const clean=s=>String(s||'').replace(/\s+/g,'');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function findPuppeteer(){
  const cache=path.join(os.homedir(),'AppData','Local','npm-cache','_npx');
  if(!fs.existsSync(cache))throw new Error('PUPPETEER_NOT_INSTALLED');
  const hits=fs.readdirSync(cache).map(x=>path.join(cache,x,'node_modules','puppeteer-core'))
    .filter(x=>fs.existsSync(path.join(x,'package.json')));
  if(hits.length!==1)throw new Error('PUPPETEER_RESOLUTION_AMBIGUOUS_'+hits.length);
  return require(hits[0]);
}
function validateTarget(url){
  const u=new URL(url);
  if(u.protocol!=='https:'||u.hostname!=='chatgpt.com'||!/^\/g\/.+\/c\/[\w-]+$/.test(u.pathname)||u.search||u.hash)
    throw new Error('INVALID_EXPLICIT_CHAT_URL');
  return u;
}
function inside(root,child){
  const rel=path.relative(path.resolve(root),path.resolve(child));
  return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));
}
function ensurePrivateProfile(root=ROOT,profile=PROFILE){
  if(!inside(root,profile)||path.resolve(root)===path.resolve(profile))throw new Error('PROFILE_PATH_INVALID');
  if(fs.existsSync(profile)&&fs.lstatSync(profile).isSymbolicLink())throw new Error('PROFILE_SYMLINK');
  fs.mkdirSync(profile,{recursive:true});
  return profile;
}
async function openBrowser({profile=PROFILE,headless=true}={}){
  if(!fs.existsSync(EDGE))throw new Error('EDGE_NOT_INSTALLED');
  ensurePrivateProfile(ROOT,profile);
  const puppeteer=findPuppeteer();
  return puppeteer.launch({executablePath:EDGE,headless,pipe:true,userDataDir:profile,
    defaultViewport:{width:1200,height:900},
    args:['--no-first-run','--no-default-browser-check','--disable-background-networking']});
}
function atomicJson(file,obj){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(obj,null,2)+'\n','utf8');
  fs.renameSync(temp,file);
}
async function getEditor(page){
  const hits=[];
  for(const css of READINESS_SELECTORS){
    try{if(await page.$(css)){hits.push(css)}}catch{}
  }
  if(!hits.length)return null;
  return hits[0];
}
async function viewStatus(page,target){
  const url=page.url();
  const same=url===target.href||url===target.href.replace(/\/$/,'');
  const editor=same?await getEditor(page):null;
  return {url_match:same,editor_available:!!editor,code:!same?'LOGIN_OR_NAVIGATION_REQUIRED':editor?'READY':'EDITOR_UNAVAILABLE'};
}
function eventLabel(e,file){
  return String(e.event_id||path.basename(file).replace(/\.json$/,'')).trim();
}
function messageFor(e,file){
  const id=eventLabel(e,file),batch=e.batch_id||'',task=e.task_token||'';
  const lines=['【系统提示｜本地 Controller Loop 自动通知（非 ChatGPT 平台系统消息）】'];
  const desc={
    BATCH_CONTROLLER_REVIEW_REQUIRED:'Cursor 工作批次已完成当前执行阶段，等待 Controller 验收。',
    TASK_CONTROLLER_READY:'Cursor 任务已完成，待 Controller 审查结果。',
    BATCH_CONTROLLER_DECISION_REQUIRED:'Cursor 批次需要 Controller 作出决定；先读取阻塞问题。',
    TASK_NEEDS_CONTROLLER_DECISION:'Cursor 任务遇到需要 Controller 决策的问题；先读取问题并回复。',
    BATCH_REVIEW_NOT_ACCEPTED:'上一轮验收未通过；检查 review 后继续修正流程。',
    BATCH_TERMINAL:'本地调度批次进入终态；核实 ACCEPTED 或 FAILED，不要自行假定成功。'
  };
  lines.push(desc[e.event_type]||'本地自动化发生状态变化，需 Controller 继续处理。');
  if(e.event_type==='BATCH_CONTROLLER_REVIEW_REQUIRED'&&Array.isArray(e.detail?.review_tokens))
    lines.push('待验收任务：'+e.detail.review_tokens.join(', '));
  if(e.event_type==='BATCH_LONG_RUNNING_REVIEW_REQUIRED'){
    lines.push('任务仍在运行，本通知不会自动终止 Cursor，也不是超时失败。');
    lines.push('待检查任务：'+String(e.detail?.task_token||''));
    lines.push('已运行约 '+String(e.detail?.elapsed_minutes||'?')+' 分钟；检查阈值 '+String(e.detail?.threshold_minutes||'?')+' 分钟。');
  }
  lines.push('CONTROLLER_BRIDGE_EVENT_V1','EVENT_TYPE: '+e.event_type,'EVENT_ID: '+id);
  if(batch)lines.push('BATCH_ID: '+batch);
  if(task)lines.push('TASK_TOKEN: '+task);
  lines.push('EVENT_FILE: '+file,'',
    '请读取本机事件文件、对应的 state/collection 和总 Batch ledger；先独立审查证据，再继续当前批次。此消息是唤醒通知，不代表任务已经验收通过。');
  return lines.join('\n');
}
async function messageVisible(page,id){
  if(!id)return false;
  return page.evaluate(id=>{
    const nodes=Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
    return nodes.some(n=>(n.innerText||'').includes('CONTROLLER_BRIDGE_EVENT_V1')&&(n.innerText||'').includes('EVENT_ID: '+id));
  },id);
}
async function sendOnce({page,chatUrl,event,file,journalFile}){
  const target=validateTarget(chatUrl);
  if(page.url()!==target.href)throw new Error('WRONG_CHAT_PAGE');
  const id=eventLabel(event,file),content=messageFor(event,file),contentHash=hash(content);
  let existing=null;try{existing=JSON.parse(fs.readFileSync(journalFile,'utf8'))}catch{}
  if(existing&&existing.content_hash!==contentHash)throw new Error('EVENT_HASH_CONFLICT');
  if(existing?.status==='CONFIRMED')return {code:'CONFIRMED_FROM_JOURNAL',event_id:id};
  if(await messageVisible(page,id)){
    atomicJson(journalFile,{event_id:id,content_hash:contentHash,status:'CONFIRMED',confirmed_at:new Date().toISOString()});
    return {code:'ALREADY_VISIBLE',event_id:id};
  }
  if(existing?.status==='SUBMITTING'||existing?.status==='AMBIGUOUS')throw new Error('AMBIGUOUS_SUBMISSION_NO_RETRY');
  const editor=await getEditor(page);
  if(!editor)throw new Error('AUTH_OR_COMPOSER_NOT_READY');
  const before=await page.$eval(editor,e=>e.innerText||e.textContent||'');
  if(clean(before))throw new Error('EDITOR_NOT_EMPTY');
  await page.locator(editor).fill(content);
  const entered=await page.$eval(editor,e=>e.innerText||e.textContent||'');
  if(clean(entered)!==clean(content))throw new Error('PASTE_VERIFY_FAILED');
  atomicJson(journalFile,{event_id:id,content_hash:contentHash,status:'SUBMITTING',started_at:new Date().toISOString()});
  await page.$eval(editor,e=>e.focus());
  await page.keyboard.press('Enter');
  try{
    await page.waitForFunction(id=>{
      const nodes=Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      return nodes.some(n=>(n.innerText||'').includes('CONTROLLER_BRIDGE_EVENT_V1')&&(n.innerText||'').includes('EVENT_ID: '+id));
    },{timeout:12000},id);
  }catch{throw new Error('SUBMISSION_UNCONFIRMED_NO_RETRY')}
  atomicJson(journalFile,{event_id:id,content_hash:contentHash,status:'CONFIRMED',confirmed_at:new Date().toISOString()});
  return {code:'CONFIRMED',event_id:id};
}
module.exports={ROOT,PROFILE,EDGE,findPuppeteer,validateTarget,inside,ensurePrivateProfile,
 openBrowser,getEditor,viewStatus,messageFor,messageVisible,sendOnce,atomicJson,hash,clean};
