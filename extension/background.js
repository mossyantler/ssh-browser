import {createController} from './core.js';
async function updateBadge(state) {
  const host=state.hosts.find(h=>h.id===state.activeHostId || h.id===state.selectedHostId);
  const text={connected:'SSH',connecting:'…',local:'LOC',error:'!',disabled:''}[state.status] || '';
  const title=state.status==='connected' ? `SSH Browser · ${host?.name || 'SSH'}로 접속 중` : state.status==='error' ? `SSH Browser · 연결 오류: ${state.error || '연결 확인 필요'}` : state.status==='local' ? 'SSH Browser · 로컬 직접 연결' : state.status==='connecting' ? 'SSH Browser · SSH 연결 중' : 'SSH Browser · 기존 프록시 설정 사용';
  try {
    await chrome.action.setBadgeText({text});
    await chrome.action.setBadgeBackgroundColor({color:state.status==='error'?'#c54c5b':state.status==='connected'?'#347e74':'#33465c'});
    await chrome.action.setTitle({title});
  } catch {}
}
const controller=createController(chrome,{onState:state=>void updateBadge(state)});
controller.ready.then(()=>updateBadge(controller.getState())).catch(()=>{});
chrome.runtime.onStartup.addListener(()=>{ void controller.ready.catch(()=>{}); });
chrome.runtime.onMessage.addListener((request,sender,sendResponse)=>{
  if (sender.id!==chrome.runtime.id || request?.type==='STATE_CHANGED') return false;
  controller.handle(request).then(sendResponse,error=>sendResponse({ok:false,error:error.message,state:controller.getState()}));
  return true;
});
