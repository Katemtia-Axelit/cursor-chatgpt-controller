'use strict';
// Normal visible Edge tab only. Never activates a tab, steals focus, or touches clipboard.
// Relay is authoritative for the exact destination; extension settings pin its project scope.
importScripts('settings.js');
const SETTINGS=self.CONTROLLER_SETTINGS;
function chatIdentity(raw){
 try{
   const u=new URL(raw);
   if(u.origin!=='https://chatgpt.com'||u.search||u.hash)return null;
   const m=/^\/g\/([^/]+)\/c\/([^/]+)$/.exec(u.pathname);
   return m?{href:u.href,project:m[1],conversation:m[2]}:null;
 }catch{return null}
}
const configuredProject=chatIdentity(SETTINGS.targetChatUrl)?.project;
let currentTarget=null;
const exactTarget=url=>typeof url==='string'&&currentTarget!==null&&url===currentTarget;
const timeout=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>
  setTimeout(()=>reject(new Error('PAGE_REPLY_TIMEOUT')),ms))]);
async function postLocal(route,body={},maxMs=7000){
 const reply=await fetch('http://127.0.0.1:37951/v1/'+route,{
   method:'POST',cache:'no-store',
   headers:{'content-type':'application/json','x-controller-key':SETTINGS.secret},
   body:JSON.stringify(body),signal:AbortSignal.timeout(maxMs)});
 if(!reply.ok)throw Error('RELAY_HTTP_'+reply.status);
 return reply.json();
}
const localHealth=()=>postLocal('health',{},3500);
async function syncTarget(){
 const state=await localHealth();
 const identity=chatIdentity(state?.target_chat_url);
 if(!state?.ok||!configuredProject||!identity||identity.project!==configuredProject){
   currentTarget=null;throw Error('RELAY_TARGET_CONFIG_INVALID');
 }
 currentTarget=identity.href;
 return state;
}
async function pingTab(tabId){
 return timeout(chrome.tabs.sendMessage(tabId,{tag:'CONTROLLER_VISIBLE_TAB_PING_V2'}),2000);
}
async function findOrInjectTarget(){
 await syncTarget();
 const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});
 const matched=tabs.filter(t=>exactTarget(t.url));
 const project_tabs=tabs.filter(t=>chatIdentity(t.url)?.project===configuredProject).length;
 const stats={matched_tabs:matched.length,project_chat_tabs:project_tabs,chatgpt_tabs:tabs.length};
 if(!matched.length)return {code:'TARGET_TAB_NOT_FOUND',...stats};
 for(const tab of matched){
   try{
     const ping=await pingTab(tab.id);
     if(ping?.ok&&exactTarget(ping.url)){
       return {code:'CONTENT_SCRIPT_CONNECTED',...stats,
         editor_present:!!ping.editor_present,diagnostics:ping.diagnostics||null,tab_background:!tab.active};
     }
   }catch{}
   try{
     await chrome.scripting.executeScript({
       target:{tabId:tab.id,allFrames:false},files:['content-script.js'],world:'ISOLATED'
     });
     const ping=await pingTab(tab.id);
     if(ping?.ok&&exactTarget(ping.url)){
       return {code:'CONTENT_SCRIPT_INJECTED',...stats,
         editor_present:!!ping.editor_present,diagnostics:ping.diagnostics||null,tab_background:!tab.active};
     }
   }catch(e){
     return {code:'INJECTION_FAILED',...stats,
       detail:String(e?.message||e).slice(0,150)};
   }
 }
 return {code:'CONTENT_SCRIPT_NO_REPLY',...stats};
}
async function bindActiveCurrentTab(){
 const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
 const chosen=chatIdentity(tab?.url);
 if(!configuredProject||!chosen||chosen.project!==configuredProject)
   return {ok:false,code:'CURRENT_TAB_OUTSIDE_CONFIGURED_PROJECT'};
 // Called only by explicit popup message; never by tab navigation or content script.
 const result=await postLocal('rebind',{url:chosen.href,consent:true});
 if(!result.ok)return result;
 let checked;
 try{checked=await findOrInjectTarget()}
 catch(e){checked={code:'TAB_QUERY_FAILED',detail:String(e?.message||e).slice(0,100)}}
 // The relay may have committed the new target even when page injection fails.
 // Report binding success separately from page readiness; never imply rollback.
 return {ok:true,code:'REBIND_OK',changed:!!result.changed,tab:checked};
}
chrome.tabs.onUpdated.addListener((tabId,change,tab)=>{
 if(change.status==='complete')
   syncTarget().then(()=>{if(exactTarget(tab.url))return findOrInjectTarget()}).catch(()=>{});
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 if(message?.tag==='CONTROLLER_VISIBLE_DIAGNOSTIC_V1'&&sender.id===chrome.runtime.id&&!sender.tab){
   (async()=>{
     let tab,relay,relay_error=null;
     try{tab=await findOrInjectTarget()}catch(e){
       tab={code:'TAB_QUERY_FAILED',detail:String(e?.message||e).slice(0,130)}}
     try{relay=await localHealth()}catch(e){relay_error=String(e?.message||e).slice(0,130)}
     respond({ok:!!relay,code:relay?'RELAY_CONNECTED':'RELAY_UNREACHABLE',
       relay:relay||null,tab,relay_error});
   })().catch(e=>respond({ok:false,code:'DIAG_ERROR',detail:String(e?.message||e).slice(0,130)}));
   return true;
 }
 if(message?.tag==='CONTROLLER_VISIBLE_REBIND_V1'&&sender.id===chrome.runtime.id&&!sender.tab){
   bindActiveCurrentTab().then(respond).catch(e=>
     respond({ok:false,code:'REBIND_FAILED',detail:String(e?.message||e).slice(0,130)}));
   return true;
 }
 if(message?.tag!=='CONTROLLER_VISIBLE_BRIDGE_V1'||
   !['health','next','intent','confirm','failure'].includes(message.route)){
   respond({ok:false,code:'UNKNOWN_REQUEST'});return false;
 }
 (async()=>{
   try{
     await syncTarget(); // Fail closed if relay is unavailable or target changed.
     if(!exactTarget(sender.url)&&!exactTarget(sender.tab?.url)){
       respond({ok:false,code:'WRONG_TAB'});return;
     }
     respond(await postLocal(message.route,message.body||{}));
   }catch(e){respond({ok:false,code:'LOCAL_RELAY_UNAVAILABLE'})}
 })();
 return true;
});
