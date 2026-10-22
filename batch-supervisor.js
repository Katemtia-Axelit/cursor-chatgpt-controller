#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const ROOT=path.join(os.homedir(),'.cursor','controller-loop'),DIR=path.join(ROOT,'batch-ledgers');
fs.mkdirSync(DIR,{recursive:true});
const terminal=new Set(['CONTROLLER_READY','DISPATCH_FAILED','NO_HANDOFF','DUPLICATE_HANDOFF','TOKEN_MISMATCH','POLICY_VIOLATION_INTERNAL_SUBAGENT','TIMEOUT','DISPATCH_EVIDENCE_MISMATCH']);
const safe=s=>String(s).replace(/[^A-Za-z0-9_.-]+/g,'_'), now=()=>new Date().toISOString();
const lp=id=>path.join(DIR,safe(id)+'.json'), sp=t=>path.join(ROOT,'state',safe(t)+'.json'), rp=t=>path.join(ROOT,'reviews',safe(t)+'.json');
function read(p){return JSON.parse(fs.readFileSync(p,'utf8'))} function maybe(p){try{return read(p)}catch{return null}}
function write(p,o){const q=p+'.'+process.pid+'.tmp';fs.writeFileSync(q,JSON.stringify(o,null,2)+'\n');try{fs.renameSync(q,p)}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;fs.copyFileSync(q,p);fs.unlinkSync(q)}}
function digest(o){return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').toUpperCase()}
function load(id){const p=lp(id);if(!fs.existsSync(p))throw Error('UNKNOWN_BATCH');return read(p)}
function save(x){x.updated_at=now();write(lp(x.batch_id),x)}
function snapshot(x){return x.tasks.map(t=>{const s=maybe(sp(t.task_token)),r=maybe(rp(t.task_token));return {...t,state:s?.state||null,review:r?.decision||null}})}
function open(id,title){if(fs.existsSync(lp(id)))throw Error('BATCH_EXISTS');const x={schema_version:1,batch_id:id,title:title||id,status:'OPEN',opened_at:now(),updated_at:now(),tasks:[],actions:[],closed_at:null};save(x);return x}
function add(id,token,task,purpose,parent){const x=load(id);if(x.status!=='OPEN')throw Error('BATCH_CLOSED');if(x.tasks.some(t=>t.task_token===token))return x;x.tasks.push({sequence:x.tasks.length+1,task_token:token,task_id:task||token,purpose:purpose||'',parent_token:parent||null,resolution:null,resolution_note:null});save(x);return x}
function resolve(id,token,res,note){const x=load(id),t=x.tasks.find(t=>t.task_token===token);if(!t)throw Error('TASK_NOT_IN_BATCH');const s=maybe(sp(token)),r=maybe(rp(token));if(!s||!terminal.has(s.state))throw Error('TASK_NOT_TERMINAL:'+String(s?.state));if(res==='ACCEPTED'&&r?.decision!=='ACCEPTED')throw Error('ACCEPTED_REQUIRES_REVIEW');t.resolution=res;t.resolution_note=note||'';t.resolved_at=now();save(x);return x}
function action(id,label,note){const x=load(id);x.actions.push({sequence:x.actions.length+1,label,note:note||'',at:now()});save(x);return x}
function check(id){const x=load(id),rows=snapshot(x);const unresolved=rows.filter(t=>!t.resolution),active=rows.filter(t=>!terminal.has(t.state));return {batch:x,rows,unresolved,active,closable:x.status==='OPEN'&&!unresolved.length&&!active.length}}
function close(id){const c=check(id);if(!c.closable)return c;const x=c.batch;x.status='CLOSED';x.closed_at=now();x.closure_snapshot=c.rows;x.closure_digest=digest(c.rows);save(x);return check(id)}
function listOpen(){let files=[];try{files=fs.readdirSync(DIR).filter(x=>x.endsWith('.json'))}catch{}const batches=[];for(const f of files){const b=maybe(path.join(DIR,f));if(b?.status==='OPEN'){const c=check(b.batch_id);batches.push({batch_id:b.batch_id,title:b.title,opened_at:b.opened_at,updated_at:b.updated_at,active:c.active.length,unresolved:c.unresolved.length})}}return {batches}}
const a=process.argv.slice(2);let out;
try{if(a[0]==='open')out=open(a[1],a.slice(2).join(' '));else if(a[0]==='add')out=add(a[1],a[2],a[3],a[4],a[5]);else if(a[0]==='resolve')out=resolve(a[1],a[2],a[3],a.slice(4).join(' '));else if(a[0]==='action')out=action(a[1],a[2],a.slice(3).join(' '));else if(a[0]==='check')out=check(a[1]);else if(a[0]==='close')out=close(a[1]);else if(a[0]==='list-open')out=listOpen();else throw Error('USAGE');console.log(JSON.stringify({ok:true,...out},null,2))}catch(e){console.log(JSON.stringify({ok:false,error:e.message},null,2));process.exitCode=1}
