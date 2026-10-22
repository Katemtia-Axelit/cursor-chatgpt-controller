'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
const SCRIPT=path.join(__dirname,'cursor-shared-lock-holder.ps1');
async function acquireSharedCursorLock(root,token,{waitMs=7000,handshakeMs=11000}={}){
 if(process.platform!=='win32')throw Error('WINDOWS_FILESHARE_LOCK_REQUIRED');
 if(typeof token!=='string'||!/^[a-zA-Z0-9_.:-]{8,}$/.test(token))throw Error('INVALID_LOCK_TOKEN');
 const file=path.join(root,'dispatch-ui.lock');
 const child=cp.spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
 '-File',SCRIPT,'-LockPath',file,'-TaskToken',token,'-WaitMs',String(waitMs)],
 {stdio:['pipe','pipe','pipe'],windowsHide:true});
 let released=false;
 const acquired=await new Promise((resolve,reject)=>{
  let output='',errors='',done=false;
  const fail=e=>{if(done)return;done=true;child.kill();reject(e)};
  const timer=setTimeout(()=>fail(Error('SHARED_LOCK_HANDSHAKE_TIMEOUT')),handshakeMs);
  const settle=ok=>{if(done)return;done=true;clearTimeout(timer);if(ok)resolve(true);else reject(Error('SHARED_CURSOR_UI_LOCK_UNAVAILABLE'))};
  child.stdout.on('data',chunk=>{
   output+=chunk.toString('utf8');
   if(output.includes('LOCK_ACQUIRED'))settle(true);
   if(output.includes('LOCK_UNAVAILABLE'))settle(false);
  });
  child.stderr.on('data',chunk=>{errors+=chunk.toString('utf8').slice(0,2048)});
  child.on('error',fail);
  child.on('exit',()=>{if(!done)settle(false)});
 });
 const release=async()=>{
  if(released)return;released=true;
  await new Promise(resolve=>{
   let done=false;const finish=()=>{if(done)return;done=true;resolve()};
   child.once('exit',finish);
   try{child.stdin.end('RELEASE\n')}catch{finish()}
   setTimeout(()=>{try{child.kill()}catch{}finish()},2000).unref?.();
  });
 };
 return {lockPath:file,release,pid:child.pid,acquired};
}
module.exports={acquireSharedCursorLock};
