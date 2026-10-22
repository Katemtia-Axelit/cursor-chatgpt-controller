'use strict';
const path=require('path'),cp=require('child_process');
const {CursorIsolatedCDPDriver}=require('./cursor-cdp-isolated-driver.js');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const EXPECTED_MODEL='GPT-6 Astra Medium';
const {label,CursorModelProfileController}=require('./cursor-model-profile.js');
class PrimaryCursorCDPDriver extends CursorIsolatedCDPDriver{
 constructor({workspace,root,modelProfile=null}){
  super({workspace,root,port:Number(process.env.CURSOR_CDP_PORT||41383),profilePath:path.join(process.env.APPDATA||'', 'Cursor')});
  this.primary=true;
  this.modelProfile=modelProfile;
  this.expectedModel=modelProfile?label(modelProfile):EXPECTED_MODEL;
 }
 async configureModelProfile(){
  if(!this.modelProfile)return null;
  return new CursorModelProfileController(this).ensure(this.modelProfile);
 }
 osGuard(){
  const script=path.join(__dirname,'cursor-primary-cdp-cutover.ps1');
  const s=cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive',
   '-ExecutionPolicy','Bypass','-File',script,'-Stage','Verify'],{
     encoding:'utf8',timeout:18000,windowsHide:true});
  const d=JSON.parse(s.trim());
  if(d.ok!==true||d.cdp_owner_matches!==true||d.loopback_only!==true||
      d.profile_arg_matches_original!==true||d.original_settings_exists!==true)
   throw Error('ORIGINAL_PRIMARY_PROFILE_AND_CDP_NOT_VERIFIED');
  const id=d.pid+':'+d.process_started_at;
  if(!d.process_started_at)throw Error('PRIMARY_START_TIME_NOT_DETERMINED');
  if(this.boundInstance!==null&&this.boundInstance!==id)
    throw Error('ORIGINAL_CURSOR_RESTARTED_MID_TASK_NO_RETRY');
  this.boundInstance=id;this.pid=d.pid;
  return d;
 }
 // CDP dispatch never activates the OS window. Visibility is informational only:
 // do not require a minimized or background Cursor window to submit safely.
 // Always keep the process/profile/loopback CDP identity checks in osGuard().
 assertStealthWindow(){
  return this.osGuard();
 }
 async selectMode(mode){
  this.assertStealthWindow();
  return super.selectMode(mode);
 }
 async auditModel(){
  const page=await this.getPage();
  return page.evaluate(()=>{
   const buttons=[...document.querySelectorAll('button')].filter(b=>
      b.querySelector('.vscode-model-picker__trigger-text') &&
      b.getBoundingClientRect().height>0);
   const names=buttons.map(x=>(x.querySelector('.vscode-model-picker__trigger-text')?.innerText||'').trim());
   return {count:buttons.length,names,unique:new Set(names).size===1,
     mode:document.querySelector('.composer-unified-dropdown')?.getAttribute('data-mode')};
  });
 }
 async guardModel(){
  const m=await this.auditModel();
  if(m.count<1||m.count>3||m.unique!==true||m.names[0]!==this.expectedModel)
    throw Error('CURSORFREE_HIGH_END_MODEL_NOT_SELECTED');
  return m.names[0];
 }
 async inspect(workspace){
  if(path.resolve(workspace)!==path.resolve(this.workspace))throw Error('PRIMARY_WORKSPACE_MISMATCH');
  const windowState=this.osGuard(); // window visibility is not a dispatch condition
  await this.guardModel();
  const page=await this.getPage();
  const view=await page.evaluate(()=>{
   // Monaco may keep a previous prompt's editable node in the conversation
   // above the live empty composer. The minimized window has stale off-viewport
   // geometry: do NOT rely on innerWidth/innerHeight or arbitrary first node.
   const allEditors=[...document.querySelectorAll('.aislash-editor-input')];
   const editor=allEditors.length===1?allEditors:(allEditors.length===2&&
     !!(allEditors[0].innerText||'').trim()&&!(allEditors[1].innerText||'').trim()&&
     allEditors[0].getBoundingClientRect().top<allEditors[1].getBoundingClientRect().top
       ?[allEditors[1]]:[]);
   const newAgent=[...document.querySelectorAll('a[role="button"],button,[role="button"]')].filter(e=>
      (e.getAttribute('aria-label')||'').startsWith('New Agent (Ctrl+N)') &&
      e.getBoundingClientRect().width>0);
   const allDropdowns=[...document.querySelectorAll('.composer-unified-dropdown[data-mode]')];
   const dropdown=allDropdowns.length===1?allDropdowns:(allDropdowns.length===2&&editor.length===1&&
     allDropdowns[0].getBoundingClientRect().top<allDropdowns[1].getBoundingClientRect().top
       ?[allDropdowns[1]]:[]);
   const busy=!!document.querySelector('[aria-label="Stop generating"],[title="Stop generating"],[aria-label="Stop"]');
   return {
    editor_count:editor.length,
    input_empty:editor.length===1&&!(editor[0].innerText||'').trim(),
    new_agent_invokable:newAgent.length===1,
    mode_dropdown_invokable:dropdown.length===1,
    assistant_busy:busy,selected_mode:dropdown[0]?.getAttribute('data-mode')||'UNKNOWN'};
  });
  return {...view,no_focus_capability:true,workspace_matches:1,original_profile:true,
    high_end_model_verified:true,window_visibility_independent:true,
    main_minimized:windowState.main_minimized,main_is_foreground:windowState.main_is_foreground};
 }
 async newChat(){
  this.assertStealthWindow();await this.guardModel();
  const page=await this.getPage();
  const res=await page.evaluate(()=>{
   const els=[...document.querySelectorAll('a[role="button"],button,[role="button"]')].filter(e=>
      (e.getAttribute('aria-label')||'').startsWith('New Agent (Ctrl+N)') &&
      e.getBoundingClientRect().width>0);
   if(els.length!==1)throw Error('PRIMARY_NEW_AGENT_BUTTON_NOT_UNIQUE');
   const all=[...document.querySelectorAll('.aislash-editor-input')];
   const editor=all.length===1?all:(all.length===2&&
     !!(all[0].innerText||'').trim()&&!(all[1].innerText||'').trim()&&
     all[0].getBoundingClientRect().top<all[1].getBoundingClientRect().top?[all[1]]:[]);
   if(editor.length!==1||(editor[0].innerText||'').trim())throw Error('EXISTING_COMPOSER_DRAFT');
   els[0].click();return true;
  });
  await wait(700);
  this.osGuard();
  // Cursor may reset Context/Reasoning/Fast when a new Agent chat opens.
  // Re-apply the exact profile and verify it before inserting any prompt.
  // Fail closed if the UI still does not match; never silently downgrade.
  if(this.modelProfile)await this.configureModelProfile();
  await this.guardModel();
  const post=await page.evaluate(()=>{
   const input=document.querySelectorAll('.aislash-editor-input');
   return input.length===1&&!(input[0].innerText||'').trim();
  });
  this.created=!!res&&!!post;
  return {created:this.created,unique:this.created};
 }
 async writePrompt(value){
  this.assertStealthWindow();await this.guardModel();
  return super.writePrompt(value);
 }
 async submit(e){
  this.assertStealthWindow();await this.guardModel();
  return super.submit(e);
 }
}
module.exports={PrimaryCursorCDPDriver,EXPECTED_MODEL};
