const HOST_NAME = 'com.sshbrowser.helper';
const clone = value => JSON.parse(JSON.stringify(value));
const messageOf = error => error?.message || String(error);
const codedError = (code, message) => Object.assign(new Error(message), {code});
const RETRY_DELAYS = [1000, 3000, 8000];
const RETRY_ALARM = 'ssh-browser-reconnect';
const OFFLINE_RECHECK = 60000;
const transient = error => ['NATIVE_LOST','NATIVE_TIMEOUT','TIMEOUT','SSH_EXIT','SSH_CONNECT','NETWORK'].includes(error?.code);
const connectionFields = host => host.mode==='alias' ? [host.mode,host.alias] : [host.mode,host.address,host.port,host.user,host.keyPath];
// retryAttempt counts started attempts, so a pending backoff is waiting for the next one.
export const retryLabel = state => {
  if(state.networkOnline===false) return '네트워크 연결 대기 중';
  const limit=state.retryLimit || RETRY_DELAYS.length, attempt=state.retryAttempt || 0;
  return state.reconnect?.nextRetryAt ? `${Math.min(attempt+1,limit)}/${limit}회째 대기` : `${attempt}/${limit}회째 시도`;
};
export const socksConfig = port => ({mode:'fixed_servers', rules:{singleProxy:{scheme:'socks5',host:'127.0.0.1',port},bypassList:['<-loopback>']}});
export function validateHost(input, createId = () => crypto.randomUUID()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('호스트 형식이 올바르지 않습니다.');
  const str = (key, max = 256) => {
    const value = input[key] ?? '';
    if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`잘못된 호스트 필드: ${key}`);
    return value.trim();
  };
  const id = str('id',128) || createId();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('잘못된 호스트 ID');
  const mode = input.mode;
  if (!['alias','manual'].includes(mode)) throw new Error('연결 방식을 선택하세요.');
  const host = {id,name:str('name'),group:str('group'),favorite:input.favorite === true,mode,alias:str('alias'),address:str('address'),port:input.port == null || input.port === '' ? 22 : Number(input.port),user:str('user'),keyPath:str('keyPath',4096)};
  if (!host.name) throw new Error('호스트 이름을 입력하세요.');
  if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw new Error('SSH 포트는 1~65535여야 합니다.');
  if (mode === 'alias' && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host.alias)) throw new Error('안전한 SSH 별칭을 입력하세요.');
  if (mode === 'manual') {
    if (!host.address || host.address.startsWith('-') || !/^[A-Za-z0-9_.:%-]+$/.test(host.address)) throw new Error('유효한 호스트 주소를 입력하세요.');
    if (host.user && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\$?$/.test(host.user)) throw new Error('유효한 SSH 사용자 이름을 입력하세요.');
    if (host.keyPath && !host.keyPath.startsWith('/')) throw new Error('키 파일은 절대 경로여야 합니다.');
  }
  return host;
}

export class NativeClient {
  constructor(chrome, profileId, onLost, onEvent, timers = globalThis) {
    this.chrome=chrome; this.profileId=profileId; this.onLost=onLost; this.onEvent=onEvent; this.timers=timers;
    this.pending=new Map(); this.sequence=0; this.closed=false; this.intentional=false;
    this.port=chrome.runtime.connectNative(HOST_NAME);
    this.port.onMessage.addListener(msg => {
      if (msg?.event) { this.onEvent(msg); return; }
      const entry=this.pending.get(msg?.requestId);
      if (!entry) return;
      this.pending.delete(msg.requestId); this.timers.clearTimeout(entry.timer);
      if (msg.ok === true) entry.resolve(msg.result);
      else entry.reject(codedError(msg.error?.code || 'PROTOCOL', msg.error?.message || '네이티브 헬퍼 요청 실패'));
    });
    this.port.onDisconnect.addListener(() => {
      const detail=chrome.runtime.lastError?.message;
      const unavailable=/not found|not registered|forbidden|access|specified native messaging host|failed to start/i.test(detail || '');
      this.fail(codedError(unavailable ? 'NATIVE_UNAVAILABLE' : 'NATIVE_LOST', detail || 'SSH 헬퍼 연결이 종료되었습니다.'));
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed=true;
    for (const entry of this.pending.values()) { this.timers.clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    if (!this.intentional) this.onLost(error);
  }
  request(type, fields={}, timeout=22000) {
    if (this.closed) return Promise.reject(codedError('NATIVE_LOST','SSH 헬퍼가 연결되어 있지 않습니다.'));
    const requestId=`r${++this.sequence}`;
    return new Promise((resolve,reject) => {
      const timer=this.timers.setTimeout(() => {
        this.pending.delete(requestId); reject(codedError('NATIVE_TIMEOUT',`SSH 헬퍼 응답 시간 초과: ${type}`));
      }, Math.min(timeout,25000));
      this.pending.set(requestId,{resolve,reject,timer});
      try { this.port.postMessage({requestId,type,...fields}); }
      catch (error) { this.pending.delete(requestId); this.timers.clearTimeout(timer); reject(error?.code ? error : codedError('NATIVE_LOST',messageOf(error))); }
    });
  }
  close() { this.intentional=true; this.fail(codedError('NATIVE_LOST','SSH 헬퍼 연결 해제')); try { this.port.disconnect(); } catch {} }
}

export function createController(chrome, options={}) {
  const id = options.uuid || (() => crypto.randomUUID());
  const Native = options.NativeClient || NativeClient;
  const api = (object, method, ...args) => new Promise((resolve,reject) => {
    try { object[method](...args, result => {
      const error=chrome.runtime.lastError;
      error ? reject(new Error(error.message)) : resolve(result);
    }); } catch(error) { reject(error); }
  });
  let state={hosts:[],profileId:null,status:'disabled',activeHostId:null,error:null,errorCode:null,helperVersion:null,helperAvailable:null,setupErrorCode:null,proxyControlled:false,desiredMode:'disabled',selectedHostId:null,currentPort:null,tunnelId:null,pendingRemote:null,reconnecting:false,retryAttempt:0,retryLimit:RETRY_DELAYS.length,reconnect:null,networkOnline:null,connectionDurationMs:null};
  let client=null, expected=null, changing=false, observedProxy=null, queue=Promise.resolve();
  const timers=options.timers || globalThis, now=options.now || Date.now;
  let generation=0, retryTimer=null, recoveryAllowed=true;
  const exitedTunnels=new Set();
  const enqueue = fn => { const task=queue.then(fn); queue=task.catch(()=>{}); return task; };
  const persist = () => api(chrome.storage.local,'set',{hosts:state.hosts,profileId:state.profileId,desiredMode:state.desiredMode,selectedHostId:state.selectedHostId,currentPort:state.currentPort,pendingRemote:clone(state.pendingRemote),reconnect:clone(state.reconnect),controllerState:clone(state)});
  const notify = () => {
    try { options.onState?.(clone(state)); } catch {}
    try { const result=chrome.runtime.sendMessage?.({type:'STATE_CHANGED',state:clone(state)}); result?.catch?.(()=>{}); } catch {}
  };
  const setProxy = async value => { expected=value; await api(chrome.proxy.settings,'set',{value,scope:'regular'}); };
  const matches = (details,value=expected) => {
    if (!value || details?.levelOfControl !== 'controlled_by_this_extension') return false;
    if (value.mode === 'direct') return details.value?.mode === 'direct';
    const p=details.value?.rules?.singleProxy, q=value.rules?.singleProxy;
    return details.value?.mode==='fixed_servers' && p?.scheme==='socks5' && p?.host===q?.host && p?.port===q?.port && JSON.stringify(details.value.rules.bypassList)===JSON.stringify(['<-loopback>']);
  };
  const verify = async () => {
    const details=await api(chrome.proxy.settings,'get',{incognito:false});
    observedProxy=details;
    state.proxyControlled=matches(details);
    if (!state.proxyControlled) throw codedError('PROXY_CONTROL',`프록시를 제어할 수 없습니다 (${details?.levelOfControl || 'unknown'}). 정책 또는 다른 확장 프로그램을 확인하세요.`);
  };
  const clearWake = () => {
    if(retryTimer!==null) timers.clearTimeout(retryTimer);
    retryTimer=null;
    try { chrome.alarms?.clear(RETRY_ALARM)?.catch?.(()=>{}); } catch {}
  };
  const cancelRetry = () => {
    generation++; recoveryAllowed=false; clearWake();
    if(state.reconnect) Object.assign(state.reconnect,{blocked:state.status==='connected' ? state.reconnect.blocked : true,nextRetryAt:null,generation});
    state.reconnecting=false;
    if(state.status==='reconnecting') {state.status='error';state.errorCode='RETRY_CANCELLED';state.error='자동 재연결을 취소했습니다.';}
  };
  const retryEligible = token => token===generation && recoveryAllowed && state.desiredMode==='remote' && !state.pendingRemote && !state.reconnect?.blocked;
  const wake = () => {
    const token=generation;
    if(!retryEligible(token) || !state.reconnect?.nextRetryAt) return;
    const due=state.reconnect.nextRetryAt;
    const timer=timers.setTimeout(()=>{retryTimer=null;enqueue(()=>retry(token)).catch(()=>{});},Math.max(0,due-now()));
    retryTimer=timer; timer?.unref?.();
    // Alarms survive MV3 suspension; the short timer provides eager backoff while awake.
    try { chrome.alarms?.create(RETRY_ALARM,{when:due})?.catch?.(()=>{}); } catch {}
  };
  const blockRetry = async error => {
    clearWake();
    state.reconnect={...(state.reconnect || {hostId:state.selectedHostId,attempt:state.retryAttempt,generation}),blocked:true,nextRetryAt:null};
    Object.assign(state,{status:'error',reconnecting:false,error:messageOf(error),errorCode:error.code || 'UNKNOWN'});
    await persist(); notify();
  };
  const prepareRetry = async (error,token) => {
    // Blocking a dead remote route is mandatory even after an explicit intent cancelled recovery.
    // Only scheduling/connecting depends on the retry generation and allowance.
    if(state.desiredMode!=='remote') return;
    if(state.status==='connected' && client && !client.closed && !exitedTunnels.has(state.tunnelId)) return;
    if(state.pendingRemote || error.code==='PROXY_CONTROL' || (observedProxy && !matches(observedProxy))) {
      await blockRetry(state.pendingRemote ? codedError('UNCERTAIN_REMOTE',state.error || messageOf(error)) : codedError('PROXY_CONTROL','프록시 설정이 외부에서 변경되어 자동 복구를 중단했습니다.')); return;
    }
    if(!state.reconnect) state.reconnect={hostId:state.selectedHostId,attempt:0,nextRetryAt:null,blocked:false,generation};
    clearWake(); changing=true;
    try {
      // Do not reuse a dead port, which another local process could acquire.
      // A still-verified blocker from the previous attempt needs no proxy write.
      if(state.currentPort===9 && matches(observedProxy,socksConfig(9))) {expected=socksConfig(9);state.proxyControlled=true;}
      else {state.currentPort=9; await setProxy(socksConfig(9)); await verify();}
      state.activeHostId=null; state.tunnelId=null;
      state.retryAttempt=state.reconnect.attempt;
      if(!retryEligible(token)) {await blockRetry(error);return;}
      if(state.reconnect.hostId!==state.selectedHostId || !state.hosts.some(h=>h.id===state.selectedHostId)) {await blockRetry(codedError('INVALID_HOST','재연결할 호스트를 찾을 수 없습니다.'));return;}
      if(!transient(error)) {await blockRetry(error);return;}
      if(state.retryAttempt>=RETRY_DELAYS.length) {await blockRetry(codedError('RETRY_EXHAUSTED','자동 재연결 3회에 실패했습니다. 서버를 직접 다시 연결하세요.'));return;}
      Object.assign(state,{status:'reconnecting',reconnecting:true,error:messageOf(error),errorCode:error.code});
      state.reconnect.nextRetryAt=state.reconnect.nextRetryAt || now()+RETRY_DELAYS[state.retryAttempt];
      await persist(); notify(); wake();
    } catch(failure) {await blockRetry(failure);}
    finally {
      changing=false;
      // onChange can arrive during persistence after verify, while changing suppresses it.
      // Reconcile before a queued timer/alarm can start another native connection.
      if(!state.pendingRemote) reconcileProxy(observedProxy);
    }
  };
  const routeAlive = () => Boolean(state.tunnelId && client && !client.closed && !exitedTunnels.has(state.tunnelId));
  const failClosed = error => {
    state.status='error'; state.error=messageOf(error); state.errorCode=error.code || 'UNKNOWN'; state.activeHostId=null; state.tunnelId=null;
    // Never clear or replace the dead SOCKS route with DIRECT here.
    const token=generation;
    // Installing the blocker must not depend on a successful error-state storage write.
    notify(); enqueue(async()=>{try {await prepareRetry(error,token);} finally {await persist();}}).catch(()=>{});
  };
  const markUnavailable = error => {
    state.helperAvailable=false;state.setupErrorCode=error.code || 'NATIVE_UNAVAILABLE';
    return error.code ? error : codedError('NATIVE_UNAVAILABLE',messageOf(error));
  };
  const handshake = async connection => {
    const hello=await connection.request('hello',{protocol:1,profileId:state.profileId},3000);
    if (hello?.protocol!==1) throw codedError('PROTOCOL','SSH 헬퍼 프로토콜이 호환되지 않습니다.');
    state.helperVersion=hello.version || null; state.helperAvailable=true; state.setupErrorCode=null;
  };
  const onNetwork = online => {
    state.networkOnline=online;
    // A restored network makes the remaining backoff pointless. The budget is unchanged:
    // retry() still reserves the attempt, and an in-flight attempt re-arms its own deadline.
    if(online && state.status==='reconnecting' && retryEligible(generation) && state.reconnect?.nextRetryAt>now()) {
      state.reconnect.nextRetryAt=now(); clearWake(); wake(); enqueue(persist).catch(()=>{});
    }
    notify();
  };
  const native = async () => {
    if (client && !client.closed) return client;
    let created;
    try {created=new Native(chrome,state.profileId,error=>{
      // A dropped port after a successful hello is not a setup problem; the next hello decides availability.
      if(client===created && error.code==='NATIVE_UNAVAILABLE') markUnavailable(error);
      if(client===created) state.networkOnline=null;
      if (client===created && state.desiredMode==='remote') failClosed(error.code ? error : codedError('NATIVE_LOST',messageOf(error)));
    },event=>{
      if (client===created && event.event==='network-change' && typeof event.online==='boolean') onNetwork(event.online);
      if (client===created && event.event==='tunnel-exit') {
        exitedTunnels.add(event.tunnelId);
        if(event.tunnelId===state.tunnelId && state.desiredMode==='remote') {
          const reasonCode=event.reason?.split(':')[0];
          const code=typeof event.code==='string' ? event.code : ['AUTH','HOST_KEY','TIMEOUT','NETWORK','SSH_EXIT'].includes(reasonCode) ? reasonCode : 'SSH_EXIT';
          failClosed(codedError(code,event.reason || 'SSH 터널이 종료되었습니다.'));
        }
      }
    },options.timers);} catch(error) { throw markUnavailable(error); }
    // Only the live helper's watcher may describe the network; it reports again after hello.
    client=created; exitedTunnels.clear(); state.networkOnline=null;
    try { await handshake(created); return created; }
    catch(error) { created.close(); if(client===created) client=null; throw markUnavailable(error); }
  };
  const initialized=enqueue(async()=>{
    const saved=await api(chrome.storage.local,'get',['hosts','profileId','desiredMode','selectedHostId','currentPort','pendingRemote','reconnect']);
    const seen=new Set();
    state.hosts=[];
    for(const raw of (Array.isArray(saved.hosts)?saved.hosts:[])) {
      try { const host=validateHost(raw,id); if(!seen.has(host.id)){seen.add(host.id);state.hosts.push(host);} } catch { /* A corrupt host must not prevent installing the fail-closed route. */ }
    }
    state.profileId=typeof saved.profileId==='string' && saved.profileId ? saved.profileId : id();
    state.desiredMode=['remote','local','disabled'].includes(saved.desiredMode)?saved.desiredMode:'disabled';
    state.selectedHostId=saved.selectedHostId || null;
    if(saved.reconnect !== undefined && saved.reconnect !== null) {
      const r=saved.reconnect;
      const record=typeof r==='object' && !Array.isArray(r);
      const valid=record && typeof r.hostId==='string' && r.hostId===state.selectedHostId
        && Number.isInteger(r.attempt) && r.attempt>=0 && r.attempt<=RETRY_DELAYS.length
        && typeof r.blocked==='boolean' && Number.isSafeInteger(r.generation) && r.generation>=0
        && (r.nextRetryAt===null || (Number.isSafeInteger(r.nextRetryAt) && r.nextRetryAt>0));
      // A partially valid record must not manufacture a fresh budget or authorize a wake.
      state.reconnect=valid ? {hostId:r.hostId,attempt:r.attempt,nextRetryAt:r.nextRetryAt,blocked:r.blocked,generation:r.generation}
        : {hostId:state.selectedHostId,attempt:RETRY_DELAYS.length,nextRetryAt:null,blocked:true,generation:0};
      generation=state.reconnect.generation;state.retryAttempt=state.reconnect.attempt;
    }
    // A write-ahead marker overrides even an older local/disabled preference.
    // Store only tunnel routing metadata, never the helper response or credentials.
    if (saved.pendingRemote) {
      const pending=saved.pendingRemote;
      state.pendingRemote={interrupted:true};
      if (typeof pending.hostId==='string') state.pendingRemote.hostId=pending.hostId;
      if (typeof pending.tunnelId==='string') state.pendingRemote.tunnelId=pending.tunnelId;
      if (Number.isInteger(pending.port) && pending.port>0 && pending.port<=65535) state.pendingRemote.port=pending.port;
      state.desiredMode='remote';
      state.selectedHostId=state.pendingRemote.hostId || state.selectedHostId;
    }
    changing=true;
    try {
      if (state.desiredMode==='remote') {
        // Never trust a stored port after worker restart: another process could own it.
        state.currentPort=9;
        await setProxy(socksConfig(state.currentPort)); await verify();
        state.status='error'; state.error='브라우저가 다시 시작되어 원격 경로를 차단 중입니다.';state.errorCode='NATIVE_LOST';
      } else if (state.desiredMode==='local') { await setProxy({mode:'direct'}); await verify(); state.status='local'; }
      else { expected=null; await api(chrome.proxy.settings,'clear',{scope:'regular'}); state.status='disabled'; }
    } catch(error) {state.status='error'; state.error=messageOf(error);state.errorCode=error.code || 'PROXY_CONTROL';}
    finally { changing=false; }
    await persist();
    if(state.desiredMode==='remote') {
      if(state.pendingRemote) await blockRetry(codedError('UNCERTAIN_REMOTE','중단된 프록시 변경을 확인해야 합니다. 서버를 직접 다시 연결하세요.'));
      else if(!state.proxyControlled) await blockRetry(codedError('PROXY_CONTROL',state.error));
      else await prepareRetry(codedError('NATIVE_LOST',state.error),generation);
    } else clearWake();
  });
  initialized.catch(()=>{});
  const reconcileProxy = details => {
    if (!details || state.desiredMode==='disabled') return;
    if (!matches(details)) {
      state.proxyControlled=false; state.status='error'; state.error=`프록시 설정이 변경되었습니다 (${details.levelOfControl || 'unknown'}). 정책 또는 다른 확장 프로그램을 확인하세요.`;
      state.errorCode='PROXY_CONTROL';state.reconnecting=false;clearWake();
      if(state.reconnect) Object.assign(state.reconnect,{blocked:true,nextRetryAt:null});
      notify(); enqueue(persist).catch(()=>{});
    }
  };
  chrome.proxy.settings.onChange?.addListener(details=>{
    observedProxy=details;
    if(!changing) reconcileProxy(details);
  });
  const connect = async (hostId,retryToken=null) => {
    const host=state.hosts.find(h=>h.id===hostId);
    if (!host) throw codedError('INVALID_HOST','호스트를 찾을 수 없습니다.');
    validateHost(host,id);
    if(state.status==='connected' && state.activeHostId===host.id && client && !client.closed) {
      // An explicit CONNECT to the live host still resets a budget consumed by automatic recovery.
      if(retryToken===null && (state.reconnect?.blocked || state.retryAttempt!==0)) {state.reconnect={hostId:host.id,attempt:0,nextRetryAt:null,blocked:false,generation};state.retryAttempt=0;await persist();}
      return;
    }
    const prior=clone(state), priorExpected=expected, connectGeneration=generation;
    let next=null, connection=null, proxyAttempted=false, committed=false, succeeded=false;
    let candidateMarker=null;
    const checkIntent=()=>{if(retryToken!==null && (retryToken!==generation || !recoveryAllowed || state.reconnect?.blocked)) throw codedError('RETRY_CANCELLED','자동 재연결을 취소했습니다.');};
    const candidateAlive=()=>connection && !connection.closed && !exitedTunnels.has(next?.tunnelId);
    state.status=retryToken===null?'connecting':'reconnecting'; state.reconnecting=retryToken!==null;state.error=null;state.errorCode=null; notify(); changing=true;
    try {
      checkIntent();
      connection=await native();
      checkIntent();
      next=await connection.request('connect',{host});
      checkIntent();
      if (!next || next.status!=='ready' || typeof next.tunnelId!=='string' || !next.tunnelId || next.hostId!==host.id || !Number.isInteger(next.port) || next.port<1 || next.port>65535) throw codedError('PROTOCOL','SSH 헬퍼가 잘못된 터널 응답을 보냈습니다.');
      if(!candidateAlive()) throw codedError('NATIVE_LOST','SSH 헬퍼 또는 터널 연결이 종료되었습니다.');
      candidateMarker={hostId:host.id,tunnelId:next.tunnelId,port:next.port};
      state.pendingRemote=candidateMarker;
      // Write-ahead safety: a crash after any proxy side effect must restart blocked.
      await persist();
      checkIntent();
      if(!candidateAlive()) throw codedError('NATIVE_LOST','SSH 헬퍼 또는 터널 연결이 종료되었습니다.');
      proxyAttempted=true;
      await setProxy(socksConfig(next.port)); await verify();
      checkIntent();
      if(!candidateAlive()) throw codedError('NATIVE_LOST','SSH 헬퍼 또는 터널 연결이 종료되었습니다.');
      const reconnect=retryToken===null ? {hostId:host.id,attempt:0,nextRetryAt:null,blocked:false,generation} : {...state.reconnect,nextRetryAt:null};
      Object.assign(state,{desiredMode:'remote',selectedHostId:host.id,currentPort:next.port,tunnelId:next.tunnelId,activeHostId:host.id,status:'connected',reconnecting:false,error:null,errorCode:null,proxyControlled:true,pendingRemote:null,reconnect,retryAttempt:reconnect.attempt,connectionDurationMs:Number.isSafeInteger(next.connectMs) && next.connectMs>=0 ? next.connectMs : null});
      // desiredMode/port and marker removal are one durable commit.
      await persist(); committed=true;
      // Loss after durable remote commit is recoverable even before CONNECT returns.
      if(retryToken===null && connectGeneration===generation) recoveryAllowed=true;
      checkIntent();
      if(!candidateAlive() || state.status!=='connected' || !matches(observedProxy)) throw codedError(!matches(observedProxy)?'PROXY_CONTROL':'NATIVE_LOST','연결 확인 중 SSH 터널 또는 프록시 제어가 종료되었습니다.');
      if (prior.tunnelId && prior.tunnelId!==next.tunnelId && !connection.closed) {
        try { await connection.request('release',{tunnelId:prior.tunnelId},2000); } catch { /* owned by helper until disconnect */ }
      }
      checkIntent();
      if(!candidateAlive() || state.status!=='connected' || !matches(observedProxy)) throw codedError(!matches(observedProxy)?'PROXY_CONTROL':'NATIVE_LOST','연결 확인 중 SSH 터널 또는 프록시 제어가 종료되었습니다.');
      succeeded=true;
      if(retryToken===null) recoveryAllowed=true;
    } catch(error) {
      const helperState={helperAvailable:state.helperAvailable,helperVersion:state.helperVersion,setupErrorCode:state.setupErrorCode};
      let rollbackError=null;
      if (!committed && proxyAttempted) {
        try {
          if(priorExpected) { await setProxy(priorExpected); await verify(); }
          else {
            expected=null; await api(chrome.proxy.settings,'clear',{scope:'regular'});
            observedProxy=await api(chrome.proxy.settings,'get',{incognito:false});
            if(observedProxy.levelOfControl==='controlled_by_this_extension') throw new Error('이전 프록시 해제를 확인할 수 없습니다.');
          }
        } catch(failure) { rollbackError=failure; }
      }
      if (rollbackError) {
        // Actual routing is uncertain. Never pretend the old live route was restored.
        // Retain candidate identity durably even after releasing its process below.
        expected=socksConfig(next.port);
        Object.assign(state,{desiredMode:'remote',selectedHostId:host.id,currentPort:next.port,tunnelId:next.tunnelId,activeHostId:null,status:'error',proxyControlled:false,pendingRemote:candidateMarker,error:messageOf(error)+'; 이전 프록시 복구 실패: '+messageOf(rollbackError)});
        state.errorCode='UNCERTAIN_REMOTE';
      } else if (committed) {
        // The old tunnel may already be released: do not roll back a committed switch.
        Object.assign(state,{status:'error',activeHostId:null,tunnelId:null,error:messageOf(error),proxyControlled:matches(observedProxy)});
      } else {
        expected=priorExpected;
        Object.assign(state,prior);
        Object.assign(state,helperState);
        if((connection?.closed || exitedTunnels.has(prior.tunnelId)) && prior.desiredMode==='remote') Object.assign(state,{status:'error',activeHostId:null,tunnelId:null});
        state.error=messageOf(error);
        if (prior.status!=='connected') state.status='error';
        // Marker is cleared only after no proxy change or a verified rollback.
      }
      state.reconnecting=false;
      if(!rollbackError) state.errorCode=error.code || 'UNKNOWN';
      if(retryToken!==null && retryToken!==generation && state.reconnect) Object.assign(state.reconnect,{blocked:true,nextRetryAt:null,generation});
      // Cleanup is in finally so even this storage write failing cannot leak a candidate.
      await persist(); throw error;
    } finally {
      if (!succeeded && next?.tunnelId && connection && !connection.closed) {
        try { await connection.request('release',{tunnelId:next.tunnelId},2000); }
        catch {
          // Without release acknowledgment, EOF is the only guaranteed helper cleanup.
          connection.close(); if(client===connection) client=null;
          if(state.desiredMode==='remote') Object.assign(state,{status:'error',activeHostId:null,tunnelId:null,error:state.error || 'SSH 헬퍼 정리 실패로 연결을 종료했습니다.'});
          try { await persist(); } catch {}
        }
      }
      changing=false;
      // Keep an uncertain rollback error instead of replacing it with a generic change.
      if(state.pendingRemote && state.status==='error') state.proxyControlled=false;
      else reconcileProxy(observedProxy);
      notify();
    }
  };
  const retry = async token => {
    if(!retryEligible(token) || !state.reconnect?.nextRetryAt) return;
    if(now()<state.reconnect.nextRetryAt) {clearWake();wake();return;}
    if(state.reconnect.attempt>=RETRY_DELAYS.length) {await blockRetry(codedError('RETRY_EXHAUSTED','자동 재연결 횟수를 모두 사용했습니다.'));return;}
    clearWake();
    if(state.networkOnline===false && client && !client.closed) {
      // Attempts without any usable network only burn the budget. Wait for the online hint,
      // re-checking periodically in case the event is lost.
      state.reconnect.nextRetryAt=now()+OFFLINE_RECHECK; await persist(); notify(); wake(); return;
    }
    // Reserve this attempt durably before hello/connect. Restart consumes the remaining budget.
    state.reconnect.attempt++;state.retryAttempt=state.reconnect.attempt;
    state.reconnect.nextRetryAt=state.retryAttempt<RETRY_DELAYS.length ? now()+RETRY_DELAYS[state.retryAttempt] : null;
    try {
      await persist();notify();
      await connect(state.reconnect.hostId,token);
    } catch(error) {
      if(token!==generation || !recoveryAllowed) return;
      if(state.pendingRemote || !transient(error) || error.code==='PROXY_CONTROL') {await blockRetry(state.pendingRemote ? codedError('UNCERTAIN_REMOTE',state.error || messageOf(error)) : error);return;}
      if(error.code?.startsWith('NATIVE_') && client && !client.closed) {const old=client;client=null;old.close();}
      state.reconnect.nextRetryAt=null;
      await prepareRetry(error,token);
    }
  };
  chrome.alarms?.onAlarm?.addListener(alarm=>{
    if(alarm?.name===RETRY_ALARM) {const token=generation;enqueue(()=>retry(token)).catch(()=>{});}
  });
  const checkHelper = async () => {
    if(client && !client.closed && state.helperAvailable===true) return;
    let probe;
    try {
      probe=new Native(chrome,state.profileId,()=>{},()=>{},options.timers);
      await handshake(probe);
    } catch(error) { throw markUnavailable(error); }
    finally {probe?.close();notify();}
  };
  const end = async local => {
    const priorExpected=expected;
    changing=true;
    try {
      if (local) {await setProxy({mode:'direct'});await verify();}
      else {expected=null;await api(chrome.proxy.settings,'clear',{scope:'regular'});state.proxyControlled=false;}
      Object.assign(state,{desiredMode:local?'local':'disabled',status:local?'local':'disabled',activeHostId:null,tunnelId:null,currentPort:null,error:null,errorCode:null,pendingRemote:null,reconnect:null,reconnecting:false,retryAttempt:0,connectionDurationMs:null});
      await persist();
      if (client) {const closing=client; client=null; try {await closing.request('disconnect',{},2000);} catch {} finally {closing.close();}}
    } catch(error) {
      // A failed switch keeps the remote intent, so reconcile against the remote route, not the attempted one.
      if(state.desiredMode==='remote') expected=priorExpected;
      state.status='error'; state.error=messageOf(error); throw error;
    }
    finally {changing=false;reconcileProxy(observedProxy);notify();}
  };
  const mutate = async request => {
    switch(request.type) {
      case 'CONNECT': {
        // Persist cancellation even if the explicit connection fails validation or hello.
        const hadLiveRoute=state.status==='connected';
        if(state.desiredMode==='remote' && !hadLiveRoute) state.reconnect={...(state.reconnect || {hostId:state.selectedHostId,attempt:state.retryAttempt}),blocked:true,nextRetryAt:null,generation};
        await persist();
        try {await connect(request.id);} finally {if(hadLiveRoute && !state.pendingRemote && !state.reconnect?.blocked) recoveryAllowed=true;}
        if(state.status==='connected') recoveryAllowed=true;
        break;
      }
      case 'LOCAL':
      case 'STOP':
        await persist();
        // cancelRetry ran before queueing; a failed switch must not leave a live remote route unrecoverable.
        try {await end(request.type==='LOCAL');}
        catch(error) {if(state.desiredMode==='remote' && routeAlive() && !state.pendingRemote && !state.reconnect?.blocked) recoveryAllowed=true; throw error;}
        break;
      case 'CHECK_HELPER': await checkHelper();break;
      case 'SAVE_HOST': {
        const host=validateHost(request.host,id), index=state.hosts.findIndex(h=>h.id===host.id);
        protectHost(host);
        if(index<0) state.hosts.push(host); else state.hosts[index]=host;
        await persist();break;
      }
      case 'DELETE_HOST':
        if(request.id===state.activeHostId || (state.desiredMode==='remote' && request.id===state.selectedHostId)) throw new Error('사용 중인 서버는 삭제할 수 없습니다. 먼저 로컬 또는 중지를 선택하세요.');
        state.hosts=state.hosts.filter(h=>h.id!==request.id); await persist();break;
      case 'IMPORT': {
        if(!Array.isArray(request.hosts) || request.hosts.length>1000) throw new Error('가져오기는 최대 1000개 호스트 배열이어야 합니다.');
        const imported=request.hosts.map(h=>validateHost(h,id));
        if(new Set(imported.map(h=>h.id)).size!==imported.length) throw new Error('가져오기 파일에 중복 ID가 있습니다.');
        for(const host of imported) protectHost(host);
        const merged=new Map(state.hosts.map(h=>[h.id,h])); for(const host of imported) merged.set(host.id,host);
        state.hosts=[...merged.values()]; await persist();break;
      }
      default: throw new Error('알 수 없는 요청입니다.');
    }
    notify();
  };
  const protectHost = host => {
    const original=state.hosts.find(h=>h.id===host.id);
    const inUse=host.id===state.activeHostId || (state.desiredMode==='remote' && host.id===state.selectedHostId);
    if(original && inUse && JSON.stringify(connectionFields(original))!==JSON.stringify(connectionFields(host))) throw codedError('HOST_IN_USE','사용 중인 서버의 연결 설정은 변경할 수 없습니다. 먼저 로컬 또는 중지를 선택하세요.');
  };
  return {
    ready:initialized,
    getState:()=>clone(state),
    async handle(request) {
      try {
        // Cancel pending/in-flight automatic recovery as soon as intent arrives, before queueing.
        if(['CONNECT','LOCAL','STOP'].includes(request?.type)) cancelRetry();
        await initialized;
        if(!request || typeof request.type!=='string') throw new Error('잘못된 요청입니다.');
        // GET_STATE answers with the live snapshot; later changes arrive through STATE_CHANGED.
        if(request.type!=='GET_STATE') await enqueue(()=>mutate(request));
        return {ok:true,state:clone(state)};
      } catch(error) { return {ok:false,error:messageOf(error),errorCode:error.code || 'UNKNOWN',state:clone(state)}; }
    }
  };
}
