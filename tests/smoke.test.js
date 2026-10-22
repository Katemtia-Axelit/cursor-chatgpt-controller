'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
process.env.CONTROLLER_WORKSPACE=process.env.CONTROLLER_WORKSPACE||'C:\\synthetic-workspace';
const {load,main,parseManifest}=require('../controller-dispatch-task.js');
test('manifest is safe and read-only plan has no side effects',()=>{
 const {m,e}=load('EXAMPLE_CONTROLLER_TASK_0001');
 assert.equal(e.mode,'Agent');
 assert.equal(m.model_profile.model,'Claude Opus 5.5');
 const result=main(['plan','EXAMPLE_CONTROLLER_TASK_0001']);
 assert.equal(result.stage,'PLAN_ONLY_NO_MUTATIONS');
 assert.equal(result.batch_state.needsCreate,true);
});
test('rejects reused identity in parsed manifest',()=>{
 const {m}=load('EXAMPLE_CONTROLLER_TASK_0001');
 assert.throws(()=>parseManifest(JSON.stringify({...m,task_token:'ANOTHER_EXAMPLE_TOKEN'}),'EXAMPLE_CONTROLLER_TASK_0001'),/MANIFEST_IDENTITY_MISMATCH/);
});
