#!/usr/bin/env node
'use strict';
const fs=require('fs'), path=require('path'), os=require('os');
const ROOT=path.join(os.homedir(),'.cursor','controller-loop');
const TERMINAL=new Set(['CONTROLLER_READY','DISPATCH_FAILED','DISPATCH_EVIDENCE_MISMATCH','NO_HANDOFF','DUPLICATE_HANDOFF','TOKEN_MISMATCH','POLICY_VIOLATION_INTERNAL_SUBAGENT','TIMEOUT']);
const safe=s=>String(s).replace(/[^A-Za-z0-9_.-]+/g,'_');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const maybe=p=>{try{return read(p)}catch(_){return null}};
const ledgerPath=process.argv[2];
if(!ledgerPath){console.error('usage: node batch-gate.js <ledger.json>');process.exit(2)}
const ledger=read(path.resolve(ledgerPath));
const rows=[]; let ok=true;
for(const t of ledger.tasks||[]){
  const st=maybe(path.join(ROOT,'state',safe(t.task_token)+'.json'));
  const rv=maybe(path.join(ROOT,'reviews',safe(t.task_token)+'.json'));
  const terminal=!!(st&&TERMINAL.has(st.state));
  const resolved=!!t.resolution;
  const quiet=t.quiescence_confirmed===true;
  const acceptedOk=t.resolution!=='ACCEPTED'||!!(rv&&rv.decision==='ACCEPTED');
  if(!terminal||!resolved||!quiet||!acceptedOk) ok=false;
  rows.push({sequence:t.sequence,task_id:t.task_id,task_token:t.task_token,purpose:t.purpose,resolution:t.resolution||null,state:st?st.state:null,review:rv?rv.decision:null,terminal,resolved,quiescence_confirmed:quiet,accepted_review_ok:acceptedOk});
}
const result={ok,code:ok?'BATCH_CLOSABLE':'BATCH_OPEN',batch_id:ledger.batch_id,tasks:rows};
console.log(JSON.stringify(result,null,2));
const lines=['# Batch Gate Summary — '+ledger.batch_id,''];
for(const r of rows){lines.push('## '+r.sequence+'. '+r.task_id,'','- TASK_TOKEN: `'+r.task_token+'`','- Purpose: '+(r.purpose||''),'- State: '+r.state,'- Review: '+(r.review||'none'),'- Resolution: '+(r.resolution||'OPEN'),'');}
const out=path.resolve(path.dirname(ledgerPath),safe(ledger.batch_id)+'.gate-summary.md');
fs.writeFileSync(out,lines.join('\n')+'\n','utf8');
process.exit(ok?0:1);