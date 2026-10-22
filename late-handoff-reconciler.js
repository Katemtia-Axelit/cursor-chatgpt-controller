#!/usr/bin/env node
'use strict';
// Controller-only lifecycle reconciliation. Transport timeout != job failure.
// Never resubmit a token, fabricate a dispatch receipt, or alter source data.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),cp=require('child_process');
const ROOT=path.join(os.homedir(),'.cursor','controller-loop');
const TRACE=path.join(os.homedir(),'.cursor','agent-traces');
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}};
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase();
const safe=t=>/^[A-Za-z0-9_.-]{8,}$/.test(t);
const iso=d=>Number.isFinite(d)?new Date(d).toISOString():null;
const stableWrite=(f,o)=>{
  fs.mkdirSync(path.dirname(f),{recursive:true});
  const tmp=f+'.'+process.pid+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(o,null,2)+'\n','utf8');
  fs.renameSync(tmp,f);
};
function findFinal(root,traceRoot,token,journal,env){
  const intent=Date.parse(journal.submit_intent_at||'');
  if(!Number.isFinite(intent)||!env?.workspace)return {code:'INVALID_SUBMIT_INTENT'};
  const project=path.win32.basename(env.workspace.replace(/[\\/]+$/,''));
  const traceDir=path.join(traceRoot,project);
  if(!fs.existsSync(traceDir))return {code:'NOT_YET_COMPLETED'};
  const found=[],misplaced=[];
  for(const ent of fs.readdirSync(traceDir,{withFileTypes:true})){
    if(!ent.isDirectory()||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ent.name))continue;
    // A confirmed CDP submission pins the producer conversation, not just a quoted token.
    if(journal.evidence?.conversation_id&&ent.name!==journal.evidence.conversation_id)continue;
    const dir=path.join(traceDir,ent.name),rp=path.join(dir,'responses.jsonl');
    if(!fs.existsSync(rp)||fs.statSync(rp).mtimeMs<intent-120000)continue;
    let responses;
    try{responses=fs.readFileSync(rp,'utf8').split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x))}
    catch{continue}
    const exact=responses.filter(x=>{
      if(x.conversation_id!==ent.name||typeof x.text!=='string')return false;
      const last=x.text.trim().split(/\r?\n/).at(-1).trim();
      // Cursor can use inline Markdown or echo our "End exactly:" cue as
      // a terminal-line prefix. Allow ONLY those two full-line spellings;
      // any extra prose, suffix, or wrong token remains untrusted.
      const normalized=/^`([^`]+)`$/.test(last)?last.slice(1,-1):last;
      const terminalOk=normalized==='TASK_TOKEN: '+token||
        normalized==='End exactly: TASK_TOKEN: '+token;
      return terminalOk&&Number.isFinite(Date.parse(x.timestamp))&&
        Date.parse(x.timestamp)>=intent;
    });
    const directory=path.join(dir,'handoffs');
    const handoffs=[path.join(dir,'LATEST_HANDOFF.md')];
    if(fs.existsSync(directory))for(const name of fs.readdirSync(directory)){
      if(name.endsWith('.md'))handoffs.push(path.join(directory,name));
    }
    if(exact.length===0){
      // Never auto-collect a nonterminal token. Only surface the proven,
      // fully-ended, uniquely bound case for independent Controller decision.
      for(const response of responses){
        if(response.conversation_id!==ent.name||typeof response.text!=='string'||
           !response.text.includes('TASK_TOKEN: '+token)||
           !Number.isFinite(Date.parse(response.timestamp))||
           Date.parse(response.timestamp)<intent||!response.transcript_path)continue;
        let ended=false;
        try{
          const last=JSON.parse(fs.readFileSync(response.transcript_path,'utf8')
            .trim().split(/\r?\n/).at(-1));
          ended=last.type==='turn_ended'&&last.status==='success';
        }catch{}
        if(!ended)continue;
        const bound=handoffs.some(p=>{
          try{const md=fs.readFileSync(p,'utf8');
            return md.includes('TASK_TOKEN: '+token)&&
              md.includes('| Conversation ID | '+ent.name+' |')&&
              md.includes('| Generation ID | '+response.generation_id+' |');
          }catch{return false}
        });
        if(bound)misplaced.push({conversation_id:ent.name,generation_id:response.generation_id,
          completed_at:response.timestamp});
      }
      continue;
    }
    for(const response of exact){
      const hits=handoffs.filter(p=>{
        try{const md=fs.readFileSync(p,'utf8');
          return md.includes('TASK_TOKEN: '+token)&&md.includes(response.generation_id)&&
            md.includes('| Conversation ID | '+ent.name+' |');
        }catch{return false}
      });
      if(hits.length)found.push({
        conversation_id:ent.name,generation_id:response.generation_id,
        completed_at:response.timestamp,handoff_path:hits[0],handoff_sha256:sha(hits[0]),
        terminal_token_format:response.text.trim().split(/\r?\n/).at(-1).includes('End exactly: TASK_TOKEN: ')
          ?'PREFIXED_END_EXACTLY':'CANONICAL'
      });
    }
  }
  const ids=new Set(found.map(x=>x.conversation_id+'|'+x.generation_id));
  if(ids.size>1)return {code:'AMBIGUOUS_COMPLETION_REQUIRES_INVESTIGATION',matches:ids.size};
  if(found[0])return {code:'UNIQUE_FINAL_HANDOFF',...found[0]};
  const badIds=new Set(misplaced.map(x=>x.conversation_id+'|'+x.generation_id));
  return badIds.size===1?{code:'FINAL_RESPONSE_TOKEN_NOT_TERMINAL',...misplaced[0]}:
    {code:'NOT_YET_COMPLETED'};
}
function inspect(root=ROOT,traceRoot=TRACE){
  const dir=path.join(root,'state','cursor-focus-free');
  if(!fs.existsSync(dir))return [];
  const items=[];
  for(const filename of fs.readdirSync(dir).filter(n=>n.endsWith('.json'))){
    const token=filename.slice(0,-5);if(!safe(token))continue;
    const journal=read(path.join(dir,filename));
    if(journal?.task_token!==token||
       !['AMBIGUOUS_NO_RETRY','CONFIRMED'].includes(journal.state))continue;
    // Normal tasks are tracked after UI submission confirmation; older final-Handoff
    // confirmations are already terminal and must not be recollected.
    if(journal.state==='CONFIRMED'&&!['UNIQUE_CHAT_TOKEN_VISIBLE','CURSOR_USER_TRANSCRIPT_CONFIRMED'].includes(journal.confirmation))continue;
    const env=read(path.join(root,'tasks',filename));
    if(env?.task_token!==token)continue;
    const state=read(path.join(root,'state',filename));
    const resultPath=path.join(root,'state','late-completions',filename);
    if(fs.existsSync(resultPath))continue;
    const collection=read(path.join(root,'collections',filename));
    let handoff=null;
    if(collection?.task_token===token&&collection.identity?.conversation_id&&
       collection.response_evidence?.token_present===true&&
       collection.identity.generation_id===collection.response_evidence.generation_id){
      const completedAt=collection.response_evidence.timestamp;
      if(Date.parse(completedAt)>=Date.parse(journal.submit_intent_at)){
        handoff={code:'UNIQUE_FINAL_HANDOFF',conversation_id:collection.identity.conversation_id,
          generation_id:collection.identity.generation_id,completed_at:completedAt,
          handoff_path:collection.historical_handoff.path,
          handoff_sha256:collection.historical_handoff.sha256};
      }
    }
    if(!handoff)handoff=findFinal(root,traceRoot,token,journal,env);
    if(handoff.code==='NOT_YET_COMPLETED'&&['CONTROLLER_READY'].includes(state?.state))
      handoff={code:'INVESTIGATE_MISSING_MATCHED_FINAL'};
    items.push({token,journal,state:state?.state||null,collection:!!collection,
      handoff,reported_at:resultPath});
  }
  return items;
}
function cycle({root=ROOT,traceRoot=TRACE,dryRun=false,collectFn=null,alertFn=null}={}){
  const candidates=inspect(root,traceRoot),processed=[];
  for(const item of candidates){
    const {token,journal,handoff}=item;
    if(handoff.code==='FINAL_RESPONSE_TOKEN_NOT_TERMINAL'){
      // Alert without collection, approval, token replay, or overriding another question.
      if(item.state==='NEEDS_CONTROLLER_DECISION'){
        processed.push({task_token:token,status:'CONTROLLER_DECISION_ALREADY_PENDING',changed:false});continue;
      }
      if(dryRun){
        processed.push({task_token:token,status:'WOULD_ALERT_NONTERMINAL_FINAL',changed:false});continue;
      }
      const detail={reason:'CURSOR_FINAL_RESPONSE_TOKEN_NOT_TERMINAL',
        conversation_id:handoff.conversation_id,generation_id:handoff.generation_id,
        completed_at:handoff.completed_at,no_retry:true,manual_review_required:true,
        collection_not_accepted:true};
      try{
        const result=alertFn?alertFn(token,detail):JSON.parse(cp.execFileSync(
          process.execPath,[path.join(root,'controller-loop.js'),'mark',token,
            'NEEDS_CONTROLLER_DECISION',JSON.stringify(detail)],
          {encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024}));
        if(!result?.ok)throw Error('CONTROLLER_ALERT_FAILED');
        processed.push({task_token:token,status:'CONTROLLER_DECISION_EVENT_EMITTED',changed:true});
      }catch(e){
        processed.push({task_token:token,status:'CONTROLLER_ALERT_FAILED',
          reason:String(e.message||e).slice(0,160),changed:false});
      }
      continue;
    }
    if(handoff.code!=='UNIQUE_FINAL_HANDOFF'){
      processed.push({task_token:token,status:handoff.code,changed:false});continue;
    }
    const wasTimedOut=journal.state==='AMBIGUOUS_NO_RETRY';
    const outcome=wasTimedOut?'TIMED_OUT_THEN_COMPLETED_INVESTIGATE':'COMPLETED_AFTER_SUBMISSION';
    const out={schema_version:1,task_token:token,
      status:outcome,
      execution_outcome:'CURSOR_FINAL_RESPONSE_CONFIRMED',
      delivery_outcome:item.collection?'COLLECTED':'HANDOFF_OBSERVED_PENDING_COLLECTION',
      timeout_investigation:wasTimedOut?{
        reason:'CONFIRM_WINDOW_EXPIRED_BEFORE_CURSOR_FINAL_RESPONSE',
        dispatch_intent_at:journal.submit_intent_at,
        transport_timed_out_at:journal.updated_at,
        cursor_completed_at:handoff.completed_at,
        dispatch_to_timeout_seconds:Math.round((Date.parse(journal.updated_at)-Date.parse(journal.submit_intent_at))/1000),
        timeout_to_completion_seconds:Math.round((Date.parse(handoff.completed_at)-Date.parse(journal.updated_at))/1000),
        root_cause:'Synchronous dispatcher waited for final Handoff instead of recording submission and monitoring execution independently'
      }:null,
      evidence:{conversation_id:handoff.conversation_id,generation_id:handoff.generation_id,
        handoff_path:handoff.handoff_path,handoff_sha256:handoff.handoff_sha256,
        terminal_token_format:handoff.terminal_token_format||'CANONICAL'},
      previous_controller_state:item.state,original_transport_journal_preserved:true,
      no_token_replay:true,recorded_at:new Date().toISOString()};
    if(!item.collection){
      if(dryRun){processed.push({task_token:token,status:'WOULD_COLLECT_LATE_HANDOFF',changed:false});continue}
      try{
        const result=collectFn?collectFn(token):JSON.parse(cp.execFileSync(process.execPath,
          [path.join(root,'controller-loop.js'),'collect',token],
          {encoding:'utf8',timeout:90000,maxBuffer:3*1024*1024}));
        if(!result?.ok||result?.code!=='CONTROLLER_READY')throw Error('COLLECTION_FAILED');
        out.delivery_outcome='COLLECTED';
      }catch(e){
        processed.push({task_token:token,status:'LATE_COLLECTION_FAILED',reason:String(e.message).slice(0,220),changed:false});
        continue;
      }
    }
    out.review_outcome=read(path.join(root,'reviews',token+'.json'))?.decision||'PENDING_INDEPENDENT_REVIEW';
    if(!dryRun)stableWrite(item.reported_at,out);
    processed.push({task_token:token,status:out.status,delivery:out.delivery_outcome,
      review:out.review_outcome,changed:!dryRun,report:item.reported_at});
  }
  return {ok:true,code:'LATE_HANDOFF_RECONCILIATION',dry_run:dryRun,checked_at:new Date().toISOString(),
    investigated:processed.length,completed:processed.filter(x=>['TIMED_OUT_THEN_COMPLETED_INVESTIGATE','COMPLETED_AFTER_SUBMISSION'].includes(x.status)).length,items:processed};
}
if(require.main===module){
 const run=()=>{try{
   const result=cycle({dryRun:process.argv.includes('--dry-run')});
   if(!process.argv.includes('--serve')||result.items.length)console.log(JSON.stringify(result));
 }catch(e){console.error(String(e.stack||e));process.exitCode=1}};
 run();
 if(process.argv.includes('--serve'))setInterval(run,30000);
}
module.exports={findFinal,inspect,cycle};
