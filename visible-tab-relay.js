'use strict';
// Visible-tab relay for a separately installed Edge extension.
// Never uses Windows focus, SendKeys, clipboard, cookies or browser windows.
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {actionability,nextEvent,claim,assertNoInflight}=require('./focus-free-bridge.js');
const {messageFor,hash,atomicJson}=require('./focus-free-transport.js');
const ROOT=__dirname;
const PORT=37951,MAX_BODY=16000;
const read=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return null}};
function sameUrl(a,b){try{const x=new URL(a),y=new URL(b);return x.href===y.href&&x.protocol==='https:'&&x.hostname==='chatgpt.com'}catch{return false}}
function chatIdentity(raw){
 try{
   const url=new URL(raw);
   if(url.origin!=='https://chatgpt.com'||url.search||url.hash)return null;
   const match=/^\/g\/([^/]+)\/c\/([^/]+)$/.exec(url.pathname);
   if(!match)return null;
   return {href:url.href,project:match[1],conversation:match[2]};
 }catch{return null}
}
function alive(pid){try{process.kill(pid,0);return true}catch(e){return e.code==='EPERM'}}
class Relay{
 constructor({root=ROOT,secret,activeMode='visible-extension'}={}){
   this.root=root;this.secret=secret;this.activeMode=activeMode;this.active=null;this.lastSeen=0;
 }
 config(){return read(path.join(this.root,'bridge-config.json'))}
 mode(){return read(path.join(this.root,'transport-mode.json'))?.mode||'legacy'}
 enabled(){
   if(this.mode()!==this.activeMode)return {ok:false,code:'MODE_LEGACY'};
   const cfg=this.config();if(!cfg?.enabled||!cfg.chat_url)return {ok:false,code:'CONFIG_DISABLED'};
   const pidFile=path.join(this.root,'chatgpt-bridge.pid');
   if(fs.existsSync(pidFile)){const pid=Number(fs.readFileSync(pidFile,'utf8').trim());if(pid>0&&alive(pid))return {ok:false,code:'OLD_BRIDGE_RUNNING'}}
   return {ok:true,code:'READY'};
 }
 journalFor(file){return path.join(this.root,'state','visible-extension',path.basename(file)+'.json')}
 probeFile(){return path.join(this.root,'state','visible-extension','diagnostic-probe.json')}
 probeMessage(id){
   return [
     '【本地 Controller Loop Bridge 连通性测试｜不是 ChatGPT 平台系统消息】',
     '这是一条经用户授权启动的桥接投递验收通知；不是 Cursor 任务完成报告。',
     'CONTROLLER_BRIDGE_EVENT_V1',
     'EVENT_TYPE: BRIDGE_DIAGNOSTIC',
     'EVENT_ID: '+id,
     '无需派发新任务。请只核对本机 diagnostic-probe.json 与对应 journal 的 CONFIRMED 状态。',
     '测试期间不会修改学习工具的数据或原有 Batch ledger。'
   ].join('\n');
 }
 rebind(data){
   if(data?.consent!==true)return {ok:false,code:'EXPLICIT_CONSENT_REQUIRED'};
   const gate=this.enabled();if(!gate.ok)return gate;
   if(this.active)return {ok:false,code:'EVENT_IN_PROGRESS'};
   const old=this.config(),from=chatIdentity(old?.chat_url),to=chatIdentity(data?.url);
   if(!from||!to||from.project!==to.project)
     return {ok:false,code:'OUTSIDE_CONFIGURED_PROJECT'};
   const countEvents=dir=>{
     try{return fs.readdirSync(path.join(this.root,dir),{withFileTypes:true})
       .filter(entry=>entry.isFile()&&entry.name.endsWith('.json')).length}
     catch(e){if(e.code==='ENOENT')return 0;throw e}
   };
   if(countEvents('events')||countEvents(path.join('events','inflight')))
     return {ok:false,code:'QUEUE_NOT_EMPTY'};
   const changed=from.href!==to.href;
   if(changed){
     atomicJson(path.join(this.root,'bridge-config.json'),{...old,chat_url:to.href});
     this.lastSeen=0;
     const hbFile=path.join(this.root,'state','visible-extension','last-tab-observed.json');
     atomicJson(hbFile,{target_matched:false,assistant_stable:false,signal:'rebind_pending_new_heartbeat'});
   }
   return {ok:true,code:'REBIND_OK',changed,same_project:true};
 }
 observe(data){
   // Only the content-script health pulse has the full editor state.
   // /next polling is sparse and must NEVER overwrite verified DOM diagnostics.
   if(!data?.diagnostics||typeof data.diagnostics!=='object'||
      typeof data.editor_present!=='boolean'||
      typeof data.editor_empty!=='boolean'||
      typeof data.assistant_busy!=='boolean'||
      typeof data.assistant_stable!=='boolean')return;
   const cfg=this.config();if(!sameUrl(data?.url,cfg?.chat_url))return;
   const now=Date.now();if(now-this.lastSeen<15000)return;
   this.lastSeen=now;
   // Persist whitelisted DOM counts only. Never persist editor text or arbitrary page fields.
   const d=data?.diagnostics&&typeof data.diagnostics==='object'?data.diagnostics:{};
   const count=k=>Number.isSafeInteger(d[k])&&d[k]>=0&&d[k]<=9999?d[k]:null;
   const diagnostics={
     ready_state:['loading','interactive','complete'].includes(d.ready_state)?d.ready_state:'unknown',
     visibility_state:['visible','hidden','prerender'].includes(d.visibility_state)?d.visibility_state:'unknown',
     prompt_id:d.prompt_id===true,prose_mirror:d.prose_mirror===true,
     textareas:count('textareas'),role_textboxes:count('role_textboxes'),
     contenteditables:count('contenteditables'),forms:count('forms'),
     send_button_candidates:count('send_button_candidates'),
     enabled_send_buttons:count('enabled_send_buttons'),
     editor_form_present:d.editor_form_present===true,
     composer_buttons:count('composer_buttons'),
     composer_submit_buttons:count('composer_submit_buttons'),
     composer_enabled_submit_buttons:count('composer_enabled_submit_buttons'),
     composer_button_structure:Array.isArray(d.composer_button_structure)?d.composer_button_structure.slice(0,12).map(b=>({
       type:['submit','button','reset','unknown'].includes(b?.type)?b.type:'unknown',
       testid:typeof b?.testid==='string'&&/^[a-zA-Z0-9_-]{1,60}$/.test(b.testid)?b.testid:null,
       aria_send:b?.aria_send===true,aria_stop:b?.aria_stop===true,disabled:b?.disabled===true
     })):[],
     idle_gate:{
       reason:['STARTING','GENERATING_CONTROL_VISIBLE','PAGE_PRERENDER','CONVERSATION_SETTLING','IDLE_STABLE'].includes(d.idle_gate?.reason)?d.idle_gate.reason:'UNKNOWN',
       display_text_nodes:Number.isSafeInteger(d.idle_gate?.display_text_nodes)?d.idle_gate.display_text_nodes:null,
       visible_stop_controls:Number.isSafeInteger(d.idle_gate?.visible_stop_controls)?d.idle_gate.visible_stop_controls:null,
       stable_for_seconds:Number.isSafeInteger(d.idle_gate?.stable_for_seconds)?d.idle_gate.stable_for_seconds:null
     },
     main_present:d.main_present===true
   };
   atomicJson(path.join(this.root,'state','visible-extension','last-tab-observed.json'),{
     observed_at:new Date(now).toISOString(),target_matched:true,
     editor_present:!!data?.editor_present,
     editor_empty:!!data?.editor_empty,assistant_busy:!!data?.assistant_busy,
     assistant_stable:data.assistant_stable===true,
     bridge_version:/^\d+\.\d+\.\d+$/.test(data.bridge_version)?data.bridge_version:null,
     diagnostics,signal:'verified_extension_origin'});
 }
 pending(){
   const root=this.root;
   assertNoInflight(root);
   return nextEvent(root);
 }
 next(data){
   this.observe(data); // passive heartbeat, even while the legacy Bridge owns the queue
   const state=this.enabled();if(!state.ok)return state;
   const cfg=this.config();
   if(!sameUrl(data?.url,cfg.chat_url)||!data?.editor_empty||data?.assistant_busy)
     return {ok:false,code:'TAB_NOT_READY'};
   if(this.active)return {ok:false,code:'EVENT_IN_PROGRESS'};
   // Verify the sender's current full DOM pulse, not just its sparse poll claims.
   const hb=read(path.join(this.root,'state','visible-extension','last-tab-observed.json'));
   const version=read(path.join(this.root,'edge-visible-extension','manifest.json'))?.version;
   const age=Date.now()-Date.parse(hb?.observed_at);
   if(!data.assistant_stable||!hb?.assistant_stable||hb?.assistant_busy||
      !hb?.editor_present||!hb?.editor_empty||hb?.signal!=='verified_extension_origin'||
      !Number.isFinite(age)||age<0||age>45000||!version||hb.bridge_version!==version)
     return {ok:false,code:'ASSISTANT_NOT_STABLY_IDLE'};
   const found=this.pending();
   if(!found){
     const p=read(this.probeFile());
     if(!p||p.status!=='PENDING')return {ok:true,code:'EMPTY'};
     const created=Date.parse(p.created_at);
     const ttl=p.defer_until_assistant_idle===true?30*60*1000:15*60*1000;
     if(!Number.isFinite(created)||Date.now()-created>ttl||created>Date.now()+15000)
       return {ok:false,code:'PROBE_EXPIRED_NO_RETRY'};
     // A background-only probe cannot be claimed until the target tab is actually hidden.
     if(p.require_hidden_tab===true&&hb.diagnostics?.visibility_state!=='hidden')
       return {ok:false,code:'DIAGNOSTIC_WAITING_HIDDEN_TAB'};
     if(p.require_edge_minimized===true){
       const w=read(path.join(this.root,'state','visible-extension','window-witness',p.id+'.latest.json'));
       const witnessAge=Date.now()-Date.parse(w?.observed_at);
       if(!Number.isFinite(witnessAge)||witnessAge<0||witnessAge>6000||
          w?.foreground_is_edge!==false||!Number.isSafeInteger(w?.edge_minimized_windows)||
          w.edge_minimized_windows<1)
         return {ok:false,code:'DIAGNOSTIC_WAITING_EDGE_MINIMIZED'};
     }
     if(typeof p.id!=='string'||!/^LIVE_BRIDGE_PROBE_[A-Za-z0-9_-]{12,64}$/.test(p.id))
       return {ok:false,code:'INVALID_PROBE_ID'};
     const files=fs.readdirSync(path.join(this.root,'events')).filter(n=>n.endsWith('.json'));
     if(files.length)return {ok:false,code:'PRODUCTION_QUEUE_NOT_EMPTY'};
     const message=this.probeMessage(p.id),digest=hash(message);
     const journal=this.journalFor(p.id+'.probe');
     atomicJson(journal,{id:p.id,hash:digest,state:'CLAIMED',kind:'DIAGNOSTIC',at:new Date().toISOString()});
     atomicJson(this.probeFile(),{...p,status:'CLAIMED',claimed_at:new Date().toISOString()});
     this.active={kind:'probe',journal,id:p.id,hash:digest,message};
     return {ok:true,code:'JOB',id:p.id,hash:digest,message};
   }
   const file=claim(found.file,this.root),event=found.event;
   const id=path.basename(file,'.json');
   const message=messageFor(event,file);
   const digest=hash(message),journal=this.journalFor(file);
   atomicJson(journal,{id,hash:digest,state:'CLAIMED',at:new Date().toISOString()});
   this.active={file,journal,id,hash:digest,message,event};
   return {ok:true,code:'JOB',id,hash:digest,message};
 }
 failure(d){
   // Persist a finite, content-free diagnostic. Never clear a CLAIMED event or auto-retry.
   const reasons=new Set(['INSERT_RETURNED_FALSE','INSERT_TEXT_MISMATCH',
     'SEND_BUTTON_UNAVAILABLE','EDITOR_CHANGED_BEFORE_INTENT','ASSISTANT_BUSY_BEFORE_INTENT']);
   if(!this.active||d?.id!==this.active.id||d?.hash!==this.active.hash)
     return {ok:false,code:'JOB_MISMATCH'};
   if(!reasons.has(d?.reason))return {ok:false,code:'INVALID_FAILURE_REASON'};
   const j=read(this.active.journal);
   if(j?.state!=='CLAIMED')return {ok:false,code:'WRONG_JOURNAL_STATE'};
   const note={failure_reason:d.reason,failure_seen_at:new Date().toISOString()};
   atomicJson(this.active.journal,{...j,...note});
   if(this.active.kind==='probe'){
     const p=read(this.probeFile());
     if(p?.id===this.active.id&&p.status==='CLAIMED')
       atomicJson(this.probeFile(),{...p,...note});
   }
   return {ok:true,code:'FAILURE_RECORDED_NO_RETRY'};
 }
 intent(d){
   const ownership=this.enabled();if(!ownership.ok)return ownership;
   if(!this.active||d.id!==this.active.id||d.hash!==this.active.hash)return {ok:false,code:'JOB_MISMATCH'};
   const j=read(this.active.journal);
   if(j?.state!=='CLAIMED')return {ok:false,code:'NOT_CLAIMED'};
   // Persist uncertainty before the UI click. Never send twice after a crash.
   atomicJson(this.active.journal,{...j,state:'SUBMITTING',at:new Date().toISOString()});
   if(this.active.kind==='probe'){
     const p=read(this.probeFile());
     if(p?.id!==this.active.id||p.status!=='CLAIMED')
       return {ok:false,code:'PROBE_JOURNAL_CONFLICT'};
     atomicJson(this.probeFile(),{...p,status:'SUBMITTING',submit_intent_at:new Date().toISOString()});
   }
   return {ok:true,code:'SUBMIT_ALLOWED'};
 }
 confirm(d){
   if(!this.active||d.id!==this.active.id||d.hash!==this.active.hash||d.visible!==true)
     return {ok:false,code:'CONFIRMATION_MISMATCH'};
   const j=read(this.active.journal);
   if(j?.state!=='SUBMITTING')return {ok:false,code:'NOT_SUBMITTING'};
   if(this.active.kind==='probe'){
     const p=read(this.probeFile());
     if(p?.id!==this.active.id||p.status!=='SUBMITTING')
       return {ok:false,code:'PROBE_JOURNAL_CONFLICT'};
     atomicJson(this.active.journal,{...j,state:'CONFIRMED',confirmed_at:new Date().toISOString()});
     atomicJson(this.probeFile(),{...p,status:'CONFIRMED',confirmed_at:new Date().toISOString()});
     this.active=null;
     return {ok:true,code:'EVENT_SENT',diagnostic_only:true};
   }
   const sent=path.join(this.root,'events','sent',this.active.id+'.sent.json');
   fs.mkdirSync(path.dirname(sent),{recursive:true});
   if(fs.existsSync(sent))return {ok:false,code:'ALREADY_SENT_RECORD'};
   atomicJson(this.active.journal,{...j,state:'CONFIRMED',confirmed_at:new Date().toISOString()});
   fs.renameSync(this.active.file,sent);
   this.active=null;
   return {ok:true,code:'EVENT_SENT'};
 }
 health(){const seen=read(path.join(this.root,'state','visible-extension','last-tab-observed.json'));
   return {ok:true,code:'HEALTH',mode:this.mode(),transport:'visible-tab',foreground_required:false,
     active:!!this.active,last_tab_seen_at:seen?.observed_at||null,
     target_chat_url:chatIdentity(this.config()?.chat_url)?.href||null}}

 async handle(req,res){
   const origin=String(req.headers.origin||'');
   const allowedOrigin=/^chrome-extension:\/\/[a-p]{32}$/.test(origin);
   res.setHeader('Content-Type','application/json; charset=utf-8');
   res.setHeader('Cache-Control','no-store');
   if(allowedOrigin)res.setHeader('Access-Control-Allow-Origin',origin);
   res.setHeader('Vary','Origin');
   res.setHeader('Access-Control-Allow-Headers','content-type,x-controller-key');
   res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
   const end=(status,data)=>{res.statusCode=status;res.end(JSON.stringify(data))};
   if(req.method==='OPTIONS')return end(204,{});
   if(req.headers['x-controller-key']!==this.secret)return end(403,{ok:false,code:'FORBIDDEN'});
   if(req.url!=='/v1/health'&&!allowedOrigin)return end(403,{ok:false,code:'EXTENSION_ORIGIN_REQUIRED'});
   if(req.method!=='POST')return end(405,{ok:false,code:'METHOD'});
   let body='';
   for await(const chunk of req){body+=chunk;if(body.length>MAX_BODY)return end(413,{ok:false,code:'BODY_TOO_LARGE'})}
   let data;try{data=JSON.parse(body)}catch{return end(400,{ok:false,code:'INVALID_JSON'})}
   let result;
   try{
     switch(req.url){
       case '/v1/health':
         if(allowedOrigin)this.observe(data);
         result=this.health();break;
       case '/v1/rebind':result=this.rebind(data);break;
       case '/v1/failure':result=this.failure(data);break;
       case '/v1/next':result=this.next(data);break;
       case '/v1/intent':result=this.intent(data);break;
       case '/v1/confirm':result=this.confirm(data);break;
       default:return end(404,{ok:false,code:'NOT_FOUND'});
     }
     return end(200,result);
   }catch(e){return end(409,{ok:false,code:String(e.message||e)})}
 }
 listen(port=PORT){return new Promise((resolve,reject)=>{
   const server=http.createServer((req,res)=>this.handle(req,res));
   server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server));
 })}
}
if(require.main===module){
 const file=path.join(ROOT,'visible-tab-secret.json'),obj=read(file);
 if(!obj?.key||!/^[-_a-f0-9]{40,128}$/.test(obj.key))throw Error('MISSING_VISIBLE_TAB_SECRET');
 const relay=new Relay({secret:obj.key});
 relay.listen().then(()=>console.log(JSON.stringify({ok:true,code:'VISIBLE_RELAY_LISTENING',port:PORT,mode:relay.mode()}))).catch(e=>{console.error(String(e));process.exitCode=1});
}
module.exports={Relay,sameUrl,chatIdentity,PORT};
