'use strict';
// Read-only evidence binding for Cursor Plan mode: empty afterAgentResponse + separate .plan.md.
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const root=path.join(os.homedir(),'.cursor','controller-loop');
const traceRoot=path.join(os.homedir(),'.cursor','agent-traces');
const plansDir=path.join(os.homedir(),'.cursor','plans');
function json(p){try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}}
function rows(p){try{return fs.readFileSync(p,'utf8').split(/\r?\n/).filter(Boolean).map(s=>{try{return JSON.parse(s.replace(/^\uFEFF/,''))}catch{return null}}).filter(Boolean)}catch{return[]}}
function hash(p){return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').toUpperCase()}
function table(md,field){const m=md.match(new RegExp('^\\|\\s*'+field+'\\s*\\|\\s*(.*?)\\s*\\|\\s*$','mi'));return m?.[1]?.trim()||null}
function probe(token,transcriptPath){
  if(!/^[A-Za-z0-9_.:-]{8,}$/.test(token||'')||!transcriptPath)return null;
  const task=json(path.join(root,'tasks',token+'.json'));
  const dispatch=json(path.join(root,'dispatches',token+'.json'));
  if(task?.mode!=='Plan'||dispatch?.status!=='SUBMITTED'||
     dispatch?.task_token!==token||dispatch?.verified_mode!=='Plan'||
     dispatch?.requested_mode!=='Plan'||!task.workspace)return null;
  const tx=rows(transcriptPath),last=tx[tx.length-1];
  if(last?.type!=='turn_ended'||last?.status!=='success')return null;
  if(!tx.some(x=>x?.role==='user'&&JSON.stringify(x.message||{}).includes(token)))return null;
  const conv=path.basename(path.dirname(transcriptPath));
  if(!/^[0-9a-f-]{36}$/.test(conv))return null;
  const project=path.win32.basename(task.workspace);
  const traceDir=path.join(traceRoot,project,conv);
  const responses=rows(path.join(traceDir,'responses.jsonl'));
  const sent=Date.parse(dispatch.updated_at||'');
  if(!Number.isFinite(sent))return null;
  const eligible=responses.filter(x=>x?.conversation_id===conv&&x.text===''&&Date.parse(x.timestamp||'')>=sent);
  if(eligible.length!==1)return null;
  const response=eligible[0];
  const respTime=Date.parse(response.timestamp||'');
  if(!Number.isFinite(respTime)||!response.generation_id)return null;
  if(!response.transcript_path||
     path.win32.normalize(response.transcript_path).toLowerCase()!==path.win32.normalize(transcriptPath).toLowerCase())return null;
  const handoffDir=path.join(traceDir,'handoffs');
  let handoffs=[];try{handoffs=fs.readdirSync(handoffDir).filter(n=>n.endsWith('.md')).map(n=>path.join(handoffDir,n))}catch{return null}
  const hs=handoffs.filter(p=>{
    try{const md=fs.readFileSync(p,'utf8');return table(md,'Conversation ID')===conv&&
      table(md,'Generation ID')===response.generation_id &&
      !md.includes('TASK_TOKEN: '+token)}catch{return false}
  });
  if(hs.length!==1)return null;
  let plans=[];try{plans=fs.readdirSync(plansDir).filter(n=>n.endsWith('.plan.md')).map(n=>path.join(plansDir,n))}catch{return null}
  const valid=plans.filter(p=>{
    try{
      const m=fs.statSync(p).mtimeMs;
      if(m<sent||m>respTime+60000)return false;
      const md=fs.readFileSync(p,'utf8');
      return md.includes(token)&&md.includes('isProject: false');
    }catch{return false}
  });
  if(valid.length!==1)return null;
  const plan=valid[0];
  return {type:'CURSOR_PLAN_ARTIFACT',task_token:token,
    conversation_id:conv,generation_id:response.generation_id,project,
    workspace:task.workspace,transcript_path:transcriptPath,
    response_path:path.join(traceDir,'responses.jsonl'),
    response_time:response.timestamp,response_sha256:crypto.createHash('sha256').update('').digest('hex').toUpperCase(),
    handoff_path:hs[0],handoff_sha256:hash(hs[0]),
    plan_path:plan,plan_sha256:hash(plan),plan_bytes:fs.statSync(plan).size,
    verified_mode:'Plan',token_in_plan:true,final_response_empty:true};
}
module.exports={probe};
