'use strict';
// Controls the existing primary Cursor GUI over localhost CDP; never activates an OS window.
// All results must be checked against visible, exact UI states. No agent submit here.
const MODELS={
 'GPT-6 Astra':{id:'model-item-gpt-6-astra',contexts:['272K','1M'],efforts:['None','Low','Medium','High','Extra High','Max'],effortHeader:'Reasoning'},
 'Claude Opus 5.5':{id:'model-item-claude-opus-5-5',contexts:['300K','1M'],efforts:['Low','Medium','High','Extra High','Max'],effortHeader:'Effort'}
};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function checkProfile(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).sort().join(',')!=='context,fast,model,reasoning')
  throw Error('MODEL_PROFILE_SHAPE_INVALID');
 const m=MODELS[p.model];
 if(!m||!m.contexts.includes(p.context)||!m.efforts.includes(p.reasoning)||typeof p.fast!=='boolean')
  throw Error('MODEL_PROFILE_UNSUPPORTED');
 return p;
}
function label(p){
 checkProfile(p);
 const m=MODELS[p.model];
 return p.model+(p.context===m.contexts[0]?'':' '+p.context)+' '+p.reasoning+(p.fast?' Fast':'');
}
class CursorModelProfileController{
 constructor(driver){this.driver=driver;}
 async state(){
  const p=await this.driver.getPage();
  return p.evaluate(()=>({
   model:[...document.querySelectorAll('button')].filter(x=>x.querySelector('.vscode-model-picker__trigger-text')).map(x=>(x.querySelector('.vscode-model-picker__trigger-text')?.innerText||'').trim()),
   editors:[...document.querySelectorAll('.aislash-editor-input')].map(x=>(x.innerText||'').trim()),
   busy:!!document.querySelector('[aria-label="Stop generating"],[title="Stop generating"],[aria-label="Stop"]')
  }));
 }
 async safe(){
  this.driver.osGuard();
  const s=await this.state();
  if(s.model.length!==1||s.editors.length!==1||s.editors[0]!==''||s.busy)
   throw Error('MODEL_PROFILE_COMPOSER_NOT_SAFE:'+JSON.stringify(s));
  return s;
 }
 async menu(){
  const p=await this.driver.getPage();
  const isRow=()=>p.evaluate(()=>{const r=document.querySelector('li[data-testid="model-item-gpt-6-astra"]');return !!r&&r.getBoundingClientRect().width>0;});
  if(!await isRow()){
   await p.evaluate(()=>{
    const b=[...document.querySelectorAll('button')].filter(x=>x.querySelector('.vscode-model-picker__trigger-text'));
    if(b.length!==1)throw Error('MODEL_BUTTON_NOT_UNIQUE');
    b[0].click();
   });
   await wait(280);
  }
  if(!await isRow())throw Error('MODEL_MENU_UNAVAILABLE');
 }
 async edit(profile){
  checkProfile(profile);
  const p=await this.driver.getPage();
  let last;
  for(let attempt=0;attempt<3;attempt++){
   // Cursor may destroy nested popovers between consecutive clicks.
   await this.close();await wait(160);
   try{
    await this.menu();
    await p.evaluate(id=>{
     const row=document.querySelector('li[data-testid="'+id+'"]');
     if(!row||row.getBoundingClientRect().width===0)throw Error('TARGET_MODEL_ROW_ABSENT');
     const edit=[...row.querySelectorAll('button')].filter(x=>x.innerText.trim()==='Edit');
     if(edit.length!==1)throw Error('MODEL_EDIT_NOT_UNIQUE');
     edit[0].click();
    },MODELS[profile.model].id);
    await wait(300);
    return await this.readMenu(profile);
   }catch(e){last=e;await this.close();}
  }
  throw Error('MODEL_EDIT_RETRIES_EXHAUSTED:'+String(last?.message||last));
 }
 async readMenu(profile){
  const p=await this.driver.getPage();
  return p.evaluate(h=>{
   const ms=[...document.querySelectorAll('[role="menu"]')].filter(x=>x.getBoundingClientRect().width>0&&x.innerText.includes('Context')&&x.innerText.includes(h));
   const m=ms.at(-1);
   if(!m)throw Error('MODEL_PARAMETER_MENU_NOT_VISIBLE');
   const selected=[...m.querySelectorAll('li[role="menuitem"]')].filter(x=>x.querySelector('.ui-model-picker__param-check')).map(x=>x.innerText.trim());
   const fast=[...m.querySelectorAll('li[role="menuitemcheckbox"]')].filter(x=>x.innerText.trim()==='Fast');
   if(fast.length!==1)throw Error('FAST_CHECKBOX_NOT_UNIQUE');
   return {selected,fast:fast[0].getAttribute('aria-checked')};
  },MODELS[profile.model].effortHeader);
 }
 async close(){
  const p=await this.driver.getPage();
  await p.keyboard.press('Escape');
  await p.keyboard.press('Escape');
 }
 async setParameter(profile,parameter,wanted){
  const p=await this.driver.getPage(),menu=await this.edit(profile);
  const actual=parameter==='fast'?menu.fast==='true':menu.selected.includes(wanted);
  if(actual!== (parameter==='fast'?wanted:true)){
   await p.evaluate(({h,parameter,wanted})=>{
    const ms=[...document.querySelectorAll('[role="menu"]')].filter(x=>x.getBoundingClientRect().width>0&&x.innerText.includes('Context')&&x.innerText.includes(h));
    const m=ms.at(-1);if(!m)throw Error('PARAM_MENU_GONE');
    const rows=[...m.querySelectorAll(parameter==='fast'?'li[role="menuitemcheckbox"]':'li[role="menuitem"]')]
      .filter(x=>x.innerText.trim()===(parameter==='fast'?'Fast':wanted));
    if(rows.length!==1)throw Error('PARAM_TARGET_NOT_UNIQUE');
    rows[0].click();
   },{h:MODELS[profile.model].effortHeader,parameter,wanted});
   await wait(260);
  }
  await this.close();
 }
 async verify(profile){
  await this.edit(profile);
  const m=await this.readMenu(profile);
  await this.close();
  const c=m.selected.filter(x=>MODELS[profile.model].contexts.includes(x));
  const e=m.selected.filter(x=>MODELS[profile.model].efforts.includes(x));
  if(c.length!==1||c[0]!==profile.context||e.length!==1||e[0]!==profile.reasoning||(m.fast==='true')!==profile.fast)
    throw Error('MODEL_PROFILE_PARAMETER_VERIFY_FAILED:'+JSON.stringify(m));
  const s=await this.state();
  if(s.model.length!==1||s.model[0]!==label(profile))throw Error('MODEL_PROFILE_ACTIVE_LABEL_MISMATCH:'+JSON.stringify(s.model));
  return {label:s.model[0],context:c[0],reasoning:e[0],fast:profile.fast,verified:true};
 }
 async ensure(profile){
  checkProfile(profile);
  await this.safe();
  // Never inherit an open model popover from another CDP inspection.
  await this.close();
  await this.setParameter(profile,'context',profile.context);
  await this.setParameter(profile,'reasoning',profile.reasoning);
  await this.setParameter(profile,'fast',profile.fast);
  // Select the desired model *after* editing its settings.
  await this.menu();
  const p=await this.driver.getPage();
  await p.evaluate(id=>{
   const row=document.querySelector('li[data-testid="'+id+'"]');
   if(!row||row.getBoundingClientRect().width===0)throw Error('TARGET_MODEL_NOT_VISIBLE');
   row.click();
  },MODELS[profile.model].id);
  await wait(350);
  await this.safe();
  return this.verify(profile);
 }
}
module.exports={MODELS,checkProfile,label,CursorModelProfileController};
