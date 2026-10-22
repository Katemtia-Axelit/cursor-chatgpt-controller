'use strict';
const out=id=>document.getElementById(id);
const label={
 CONTENT_SCRIPT_CONNECTED:'已注入并响应',
 CONTENT_SCRIPT_INJECTED:'刚刚主动注入成功',
 TARGET_TAB_NOT_FOUND:'没有找到当前绑定的聊天标签页',
 CONTENT_SCRIPT_NO_REPLY:'目标标签页存在，但脚本未响应',
 INJECTION_FAILED:'脚本注入失败',
 TAB_QUERY_FAILED:'无法读取标签页状态',
 CURRENT_TAB_OUTSIDE_CONFIGURED_PROJECT:'当前标签页不是此 Cursor 项目的 ChatGPT 对话',
 EXPLICIT_CONSENT_REQUIRED:'需要明确点击绑定操作',
 QUEUE_NOT_EMPTY:'事件队列非空，拒绝切换目标以防事件发错对话',
 EVENT_IN_PROGRESS:'有正在处理的事件，拒绝切换目标',
 OUTSIDE_CONFIGURED_PROJECT:'项目身份不一致，已拒绝切换目标',
 REBIND_FAILED:'绑定操作未完成'
};
async function run(){
 out('relay').textContent='服务：检查中…';
 out('tab').textContent='目标聊天：正在检查并尝试无焦点注入…';
 out('mode').textContent='模式：检查中…';
 try{
   const result=await chrome.runtime.sendMessage({tag:'CONTROLLER_VISIBLE_DIAGNOSTIC_V1'});
   const tab=result?.tab||{};
   out('relay').textContent=result?.ok?'服务：已连通':'服务：未连通（'+(result?.relay_error||result?.code||'NO_RESPONSE')+'）';
   out('mode').textContent='模式：'+(result?.relay?.mode||'未知');
   const editorStatus=tab.code==='CONTENT_SCRIPT_CONNECTED'||tab.code==='CONTENT_SCRIPT_INJECTED'?(tab.editor_present?'，编辑框已识别':'，尚未识别编辑框'):'';
   const d=tab.diagnostics;
   const domNote=d?'；DOM：'+d.ready_state+'/'+d.visibility_state+'，textarea '+d.textareas+'，textbox '+d.role_textboxes+'，editable '+d.contenteditables+'，ProseMirror '+(d.prose_mirror?'有':'无')+'，main '+(d.main_present?'有':'无')+'，发送按钮候选 '+(d.send_button_candidates??'?')+'，可用 '+(d.enabled_send_buttons??'?')+'，回复稳定 '+(d.assistant_stable?'是':'否')+'，空闲原因 '+(d.idle_gate?.reason||'?')+'，可见停止按钮 '+(d.idle_gate?.visible_stop_controls??'?')+'，显示文本节点 '+(d.idle_gate?.display_text_nodes??'?')+'，稳定秒数 '+(d.idle_gate?.stable_for_seconds??'?')+'，编辑表单 '+(d.editor_form_present?'有':'无')+'，表单提交按钮 '+(d.composer_submit_buttons??'?'):'';
   const tabStats=tab.code==='TARGET_TAB_NOT_FOUND'?'；已开本项目对话 '+(tab.project_chat_tabs??'?')+' 个（其他 ChatGPT 标签 '+Math.max(0,(tab.chatgpt_tabs||0)-(tab.project_chat_tabs||0))+' 个）':'';
   const note=(label[tab.code]||tab.code||'查询失败')+editorStatus+domNote+tabStats;
   const suffix=tab.detail?'（'+tab.detail+'）':'';
   if(!result?.relay?.last_tab_seen_at){
     out('tab').textContent='目标聊天：'+note+suffix+'；尚未收到页面心跳';
     return;
   }
   const age=Math.max(0,Math.round((Date.now()-Date.parse(result.relay.last_tab_seen_at))/1000));
   out('tab').textContent='目标聊天：'+note+suffix+'；心跳 '+age+' 秒前'+(age<30?'（新鲜）':'（过期）');
 }catch(e){
   out('tab').textContent='扩展诊断失败：'+String(e.message||e).slice(0,120);
 }
}
async function bindCurrent(){
 const button=out('rebind'),status=out('binding');
 button.disabled=true;
 status.textContent='正在验证当前标签页和待处理事件…';
 try{
   const result=await chrome.runtime.sendMessage({tag:'CONTROLLER_VISIBLE_REBIND_V1'});
   if(result?.ok){
     status.textContent=result.changed?'已绑定当前项目对话；没有发送消息':'当前标签页已经是目标对话；没有发送消息';
     await run();
   }else status.textContent='未绑定：'+(label[result?.code]||result?.code||'未知原因');
 }catch(e){status.textContent='绑定失败：'+String(e.message||e).slice(0,90)}
 finally{button.disabled=false}
}
out('refresh').addEventListener('click',run);
out('rebind').addEventListener('click',bindCurrent);
run();
