'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http');
const ROOT=path.join(os.homedir(),'.cursor','controller-loop');
const maybe=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}};
const isAlive=pid=>{try{process.kill(pid,0);return true}catch(e){return e.code==='EPERM'}};
const pidState=name=>{
  const p=path.join(ROOT,name+'.pid');
  const pid=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8').trim()):0;
  return {running:Number.isSafeInteger(pid)&&pid>0&&isAlive(pid)};
};
const evtDir=path.join(ROOT,'events');
const countFiles=folder=>{
  try{return fs.readdirSync(path.join(evtDir,folder),{withFileTypes:true})
     .filter(e=>e.isFile()&&e.name.endsWith('.json')).length}catch{return 0};
};
const config=maybe(path.join(ROOT,'transport-mode.json'))||{mode:'unknown'};
const heartbeat=maybe(path.join(ROOT,'state','visible-extension','last-tab-observed.json'));
const since=heartbeat?.observed_at?Date.now()-Date.parse(heartbeat.observed_at):null;
const extensionFresh=Number.isFinite(since)&&since>=0&&since<120000;
const activeLegacy=pidState('chatgpt-bridge').running;
const relayActive=pidState('visible-tab-relay').running;
const actualBlockers=[];
if(config.mode!=='visible-extension')actualBlockers.push('WRONG_TRANSPORT_MODE');
if(!relayActive)actualBlockers.push('RELAY_NOT_RUNNING');
if(!extensionFresh)actualBlockers.push('TARGET_HEARTBEAT_NOT_FRESH');
if(heartbeat?.target_matched!==true)actualBlockers.push('TARGET_NOT_MATCHED');
if(heartbeat?.editor_present!==true)actualBlockers.push('EDITOR_NOT_FOUND');
if(heartbeat?.editor_empty!==true)actualBlockers.push('EDITOR_NOT_EMPTY');
if(heartbeat?.assistant_busy===true)actualBlockers.push('ASSISTANT_BUSY');
if(heartbeat?.assistant_stable!==true)actualBlockers.push('ASSISTANT_NOT_STABLY_IDLE');
const extManifest=maybe(path.join(ROOT,'edge-visible-extension','manifest.json'));
if(heartbeat?.bridge_version!==extManifest?.version)actualBlockers.push('EXTENSION_VERSION_MISMATCH');const status={
  ok:true,
  mode:config.mode,
  legacy_running:activeLegacy,
  relay_running:relayActive,
  watcher_running:pidState('long-running-watch').running,
  late_handoff_watcher_running:pidState('late-handoff-watch').running,
  target_tab_heartbeat:extensionFresh?'FRESH':heartbeat?'STALE':'NOT_SEEN',
  safe_to_cutover:!!(relayActive&&extensionFresh&&countFiles('inflight')===0&&config.mode==='legacy'),
  inflight_events:countFiles('inflight'),
  pending_events:countFiles('.'),
  delivery_ready:actualBlockers.length===0,
  delivery_blockers:actualBlockers,
  extension_folder:path.join(ROOT,'edge-visible-extension'),
  next_step:extensionFresh?
    (config.mode==='visible-extension'?'Inspect editor readiness; real ChatGPT delivery not yet accepted':'Review cutover prerequisites; do not switch automatically'):
    (config.mode==='visible-extension'?'Reload the installed Edge extension, open the successor chat in the same project, and explicitly bind it in the extension popup; then inspect heartbeat':'Install unpacked extension in current Edge and refresh the exact Controller ChatGPT tab')
};
console.log(JSON.stringify(status,null,2));
