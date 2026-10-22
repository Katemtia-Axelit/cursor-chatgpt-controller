'use strict';
// Page-local DOM control: no Windows focus, clipboard, tab activation, or SendKeys.
(()=>{
if(globalThis.__controller_visible_bridge_v2_started__)return;
globalThis.__controller_visible_bridge_v2_started__=true;
chrome.runtime.onMessage.addListener((m,_sender,respond)=>{
 if(m?.tag==='CONTROLLER_VISIBLE_TAB_PING_V2'){
   respond({ok:true,code:'CONTENT_SCRIPT_PRESENT',url:location.href,
     editor_present:!!editor(),diagnostics:editorDiagnostics()});
 }
});
const TAG='CONTROLLER_VISIBLE_BRIDGE_V1',POLL_MS=4500;
// Only claim after the page stops generating and its rendered output settles.
const QUIET_MS=14000;
const EDITORS=['#prompt-textarea','[data-testid="prompt-textarea"]','.ProseMirror[contenteditable="true"]','[contenteditable="true"][role="textbox"]','[contenteditable="true"][data-lexical-editor="true"]'];
const SEND=['button[data-testid="send-button"]','button[aria-label="Send message"]','button[data-testid="composer-submit-button"]','button[aria-label="发送消息"]'];
function editorForm(){return editor()?.closest('form')||null}
function composerButtons(){const form=editorForm();return form?[...form.querySelectorAll('button')]:[]}
function submitCandidates(){
 const form=editorForm(),scope=form||document;
 const named=[...scope.querySelectorAll(SEND.join(','))];
 if(named.length!==0)return named.length===1?named:[];
 if(!form)return [];
 const explicit=[...form.querySelectorAll('button[type="submit"]')];
 if(explicit.length)return explicit.length===1?explicit:[];
 const implicit=composerButtons().filter(b=>b.type==='submit');
 if(implicit.length)return implicit.length===1?implicit:[];
 // Match the same accessible button name used by the focused UIA bridge.
 // Scope to this composer only; fail closed on multiple or unnamed candidates.
 const semantic=composerButtons().filter(b=>{
   if(!visibleButton(b))return false;
   const name=(b.getAttribute('aria-label')||b.getAttribute('title')||b.innerText||'').trim();
   return /^(send|send message|submit|发送|发送消息|發送|提交)$/i.test(name);
 });
 return semantic.length===1?semantic:[];
}
function diagnosticButtonAttributes(){
 return composerButtons().slice(0,12).map(b=>{
   const tid=b.getAttribute('data-testid')||'';
   const aria=(b.getAttribute('aria-label')||'').toLowerCase();
   return {type:['submit','button','reset'].includes(b.type)?b.type:'unknown',
     testid:/^[a-zA-Z0-9_-]{1,60}$/.test(tid)?tid:null,
     aria_send:/send|发送|發送|submit/i.test(aria),
     aria_stop:/stop|停止/i.test(aria),disabled:!!b.disabled};
 });
}
function editorDiagnostics(){
 // Read-only counts only: never capture drafts, messages, titles, or URLs.
 const count=selector=>document.querySelectorAll(selector).length;
 return {ready_state:document.readyState,visibility_state:document.visibilityState,
   prompt_id:!!document.querySelector('#prompt-textarea'),
   prose_mirror:!!document.querySelector('.ProseMirror'),
   textareas:count('textarea'),role_textboxes:count('[role="textbox"]'),
   contenteditables:count('[contenteditable="true"],[contenteditable="plaintext-only"]'),
   forms:count('form'),main_present:!!document.querySelector('main'),
   send_button_candidates:count(SEND.join(',')),
   enabled_send_buttons:[...document.querySelectorAll(SEND.join(','))].filter(e=>!e.disabled).length,
   assistant_stable:assistantQuiet(),
   idle_gate:idleGateDiagnostics(),
   editor_form_present:!!editorForm(),composer_buttons:composerButtons().length,
   composer_submit_buttons:composerButtons().filter(b=>b.type==='submit').length,
   composer_enabled_submit_buttons:composerButtons().filter(b=>b.type==='submit'&&!b.disabled).length,
   composer_button_structure:diagnosticButtonAttributes()};
}
let inProgress=false;
let lastHealth='';
const clean=s=>String(s||'').replace(/\s+/g,'');
const request=(route,body={})=>new Promise(resolve=>{
 try{chrome.runtime.sendMessage({tag:TAG,route,body},r=>{
   if(chrome.runtime.lastError){resolve({ok:false,code:'EXTENSION_RUNTIME_ERROR'});return}
   resolve(r||{ok:false,code:'NO_REPLY'});
 })}
 catch{resolve({ok:false,code:'EXTENSION_DISCONNECTED'})}
});
function editor(){for(const s of EDITORS){const e=document.querySelector(s);if(e)return e}return null}
function getText(e){return e?.innerText||e?.textContent||''}
// Mirror the proven focused Bridge's accessible Stop-button check.
// No dependency on ChatGPT's optional message-role DOM attributes.
function visibleButton(button){
 if(!button?.isConnected)return false;
 const style=getComputedStyle(button);
 return style.display!=='none'&&style.visibility!=='hidden'&&
   button.getClientRects().length>0;
}
function stopControls(){
 const exact=/^(stop|stop generating|stop response|stop generating response|停止|停止生成|停止回答|停止回应)$/i;
 return [...document.querySelectorAll('button,[role="button"]')].filter(button=>{
   if(!visibleButton(button))return false;
   if(button.matches('[data-testid="stop-button"]'))return true;
   const name=(button.getAttribute('aria-label')||
     button.getAttribute('title')||button.innerText||'').trim();
   return exact.test(name);
 });
}
function busy(){
 if(stopControls().length)return true;
 return !!document.querySelector('[aria-busy="true"][data-message-author-role="assistant"]');
}
// Stream the *non-editable conversation display* instead of querying role-tagged
// message nodes. Exclude the composer and controls so our own draft never
// invalidates the quiet interval between insertion and the submit-intent gate.
function displaySegments(scope){
 const root=scope||document.querySelector('main')||document.body;
 if(!root)return [];
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
 const items=[];
 let node;
 while((node=walker.nextNode())){
   const p=node.parentElement;
   if(!p||p.closest('form,[contenteditable="true"],[contenteditable="plaintext-only"],textarea,script,style,button,nav,header,footer,aside,[aria-hidden="true"]'))
     continue;
   const value=node.nodeValue||'';
   if(!value.trim())continue;
   items.push(value);
   if(items.length>500)items.shift();
 }
 return items;
}
function displayFingerprint(){
 const nodes=displaySegments();
 let h=2166136261,chars=0;
 // Only last ~40k displayed characters matter for recent stream changes.
 const tail=nodes.join(' ').slice(-40000);
 for(let i=0;i<tail.length;i++)h=Math.imul(h^tail.charCodeAt(i),16777619);
 chars=tail.length;
 return {signature:chars+':'+(h>>>0),text_node_count:nodes.length};
}
let conversationSignature=null,lastConversationChange=Date.now();
let idleGateReason='STARTING';
let displayNodesLast=0;
function assistantQuiet(){
 const snapshot=displayFingerprint();
 displayNodesLast=snapshot.text_node_count;
 if(snapshot.signature!==conversationSignature){
   conversationSignature=snapshot.signature;
   lastConversationChange=Date.now();
 }
 if(busy()){idleGateReason='GENERATING_CONTROL_VISIBLE';return false}
 if(document.visibilityState==='prerender'){idleGateReason='PAGE_PRERENDER';return false}
 if(Date.now()-lastConversationChange<QUIET_MS){
   idleGateReason='CONVERSATION_SETTLING';return false;
 }
 idleGateReason='IDLE_STABLE';
 return true;
}
function idleGateDiagnostics(){
 return {
   reason:idleGateReason,
   display_text_nodes:displayNodesLast,
   visible_stop_controls:stopControls().length,
   stable_for_seconds:Math.max(0,Math.min(3600,Math.floor((Date.now()-lastConversationChange)/1000)))
 };
}
function sendButton(){const candidates=submitCandidates();return candidates.length===1&&!candidates[0].disabled&&visibleButton(candidates[0])?candidates[0]:null}
function messageExists(id){
 // Match a unique event ID in the rendered conversation, excluding the draft.
 // Works even when ChatGPT no longer provides data-message-author-role nodes.
 const displayed=displaySegments(document.body).join(' ');
 return displayed.includes('CONTROLLER_BRIDGE_EVENT_V1')&&
   /^[A-Za-z0-9_-]{1,100}$/.test(id)&&new RegExp('EVENT_ID\\s*:\\s*'+id).test(displayed);
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function pulse(){
 if(!location.href.startsWith('https://chatgpt.com/g/')||!location.pathname.includes('/c/'))return;
 const e=editor();
 const result=await request('health',{
   url:location.href,editor_present:!!e,editor_empty:!!e&&!clean(getText(e)),assistant_busy:busy(),
   assistant_stable:assistantQuiet(),bridge_version:chrome.runtime.getManifest().version,
   diagnostics:editorDiagnostics()
 });
 if(result.code!==lastHealth){lastHealth=result.code;console.info('[Controller Visible Bridge] heartbeat:',result.code)}
}
async function poll(){
 if(inProgress||!location.href.startsWith('https://chatgpt.com/g/')||!location.pathname.includes('/c/'))return;
 const e=editor();
 if(!e||clean(getText(e))||busy()||!assistantQuiet())return;
 inProgress=true;
 try{
   const r=await request('next',{url:location.href,editor_empty:true,assistant_busy:false,
     assistant_stable:assistantQuiet()});
   if(!r.ok||r.code!=='JOB'||!r.id||!r.message)return;
   if(messageExists(r.id))return; // claim remains for explicit reconciliation
   e.focus({preventScroll:true});
   const inserted=document.execCommand('insertText',false,r.message);
   if(!inserted||clean(getText(e))!==clean(r.message)){
     const reason=!inserted?'INSERT_RETURNED_FALSE':'INSERT_TEXT_MISMATCH';
     await request('failure',{id:r.id,hash:r.hash,reason});
     console.warn('[Controller Bridge] Insert check failed:',reason,'event retained.');return;
   }
   // React/Lexical commonly updates submit availability on a later render.
   // Wait at most 1.8 s; never enter SUBMITTING without a valid, enabled button.
   let send=null;
   for(let i=0;i<12;i++){
     send=sendButton();
     if(send)break;
     await sleep(150);
   }
   if(!send){
     await request('failure',{id:r.id,hash:r.hash,reason:'SEND_BUTTON_UNAVAILABLE'});
     console.warn('[Controller Bridge] Submit button unavailable; event retained.');return;
   }
   if(clean(getText(e))!==clean(r.message)){
     await request('failure',{id:r.id,hash:r.hash,reason:'EDITOR_CHANGED_BEFORE_INTENT'});
     console.warn('[Controller Bridge] Editor changed before send; event retained.');return;
   }
   if(busy()||!assistantQuiet()){
     await request('failure',{id:r.id,hash:r.hash,reason:'ASSISTANT_BUSY_BEFORE_INTENT'});
     console.warn('[Controller Bridge] Assistant became busy; event retained.');return;
   }
   const intent=await request('intent',{id:r.id,hash:r.hash});
   if(intent.code!=='SUBMIT_ALLOWED')return;
   send.click();
   for(let i=0;i<32;i++){
     if(messageExists(r.id)){
       const ack=await request('confirm',{id:r.id,hash:r.hash,visible:true});
       if(ack.ok)console.info('[Controller Bridge] confirmed',r.id);
       return;
     }
     await sleep(500);
   }
   console.warn('[Controller Bridge] Delivery unconfirmed; no automatic retry.');
 }catch(e){console.warn('[Controller Bridge] stopped:',String(e))}
 finally{inProgress=false}
}
setTimeout(pulse,900);
setInterval(pulse,6000);
setTimeout(poll,1200);
setInterval(poll,POLL_MS);
})();
