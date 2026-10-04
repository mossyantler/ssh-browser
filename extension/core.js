const HOST_NAME = 'com.sshbrowser.helper';
const clone = value => JSON.parse(JSON.stringify(value));
const messageOf = error => error?.message || String(error);
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
      else entry.reject(new Error(msg.error?.message || '네이티브 헬퍼 요청 실패'));
    });
    this.port.onDisconnect.addListener(() => {
      const detail=chrome.runtime.lastError?.message;
      this.fail(new Error(detail || 'SSH 헬퍼 연결이 종료되었습니다.'));
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
    if (this.closed) return Promise.reject(new Error('SSH 헬퍼가 연결되어 있지 않습니다.'));
    const requestId=`r${++this.sequence}`;
    return new Promise((resolve,reject) => {
      const timer=this.timers.setTimeout(() => {
        this.pending.delete(requestId); reject(new Error(`SSH 헬퍼 응답 시간 초과: ${type}`));
      }, Math.min(timeout,25000));
      this.pending.set(requestId,{resolve,reject,timer});
      try { this.port.postMessage({requestId,type,...fields}); }
      catch (error) { this.pending.delete(requestId); this.timers.clearTimeout(timer); reject(error); }
    });
  }
  close() { this.intentional=true; this.fail(new Error('SSH 헬퍼 연결 해제')); try { this.port.disconnect(); } catch {} }
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
  let state={hosts:[],profileId:null,status:'disabled',activeHostId:null,error:null,helperVersion:null,proxyControlled:false,desiredMode:'disabled',selectedHostId:null,currentPort:null,tunnelId:null,pendingRemote:null};
  let client=null, expected=null, changing=false, observedProxy=null, queue=Promise.resolve();
  const exitedTunnels=new Set();
  const enqueue = fn => { const task=queue.then(fn); queue=task.catch(()=>{}); return task; };
  const persist = () => api(chrome.storage.local,'set',{hosts:state.hosts,profileId:state.profileId,desiredMode:state.desiredMode,selectedHostId:state.selectedHostId,currentPort:state.currentPort,pendingRemote:clone(state.pendingRemote),controllerState:clone(state)});
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
    if (!state.proxyControlled) throw new Error(`프록시를 제어할 수 없습니다 (${details?.levelOfControl || 'unknown'}). 정책 또는 다른 확장 프로그램을 확인하세요.`);
  };
  const failClosed = error => {
    state.status='error'; state.error=messageOf(error); state.activeHostId=null; state.tunnelId=null;
    // Never clear or replace the dead SOCKS route with DIRECT here.
    notify(); enqueue(async()=>{await persist();}).catch(()=>{});
  };
  const native = async () => {
    if (client && !client.closed) return client;
    const created=new Native(chrome,state.profileId,error=>{
      if (client===created && state.desiredMode==='remote') failClosed(error);
    },event=>{
      if (client===created && event.event==='tunnel-exit') {
        exitedTunnels.add(event.tunnelId);
        if(event.tunnelId===state.tunnelId && state.desiredMode==='remote') failClosed(new Error(event.reason || 'SSH 터널이 종료되었습니다.'));
      }
    },options.timers);
    client=created; exitedTunnels.clear();
    try {
      const hello=await created.request('hello',{protocol:1,profileId:state.profileId},3000);
      if (hello?.protocol!==1) throw new Error('SSH 헬퍼 프로토콜이 호환되지 않습니다.');
      state.helperVersion=hello.version || null;
      return created;
    } catch(error) { created.close(); if(client===created) client=null; throw error; }
  };
  const initialized=enqueue(async()=>{
    const saved=await api(chrome.storage.local,'get',['hosts','profileId','desiredMode','selectedHostId','currentPort','pendingRemote']);
    const seen=new Set();
    state.hosts=[];
    for(const raw of (Array.isArray(saved.hosts)?saved.hosts:[])) {
      try { const host=validateHost(raw,id); if(!seen.has(host.id)){seen.add(host.id);state.hosts.push(host);} } catch { /* A corrupt host must not prevent installing the fail-closed route. */ }
    }
    state.profileId=typeof saved.profileId==='string' && saved.profileId ? saved.profileId : id();
    state.desiredMode=['remote','local','disabled'].includes(saved.desiredMode)?saved.desiredMode:'disabled';
    state.selectedHostId=saved.selectedHostId || null;
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
        state.status='error'; state.error='브라우저가 다시 시작되어 원격 경로를 차단 중입니다. 서버를 다시 연결하세요.';
      } else if (state.desiredMode==='local') { await setProxy({mode:'direct'}); await verify(); state.status='local'; }
      else { expected=null; await api(chrome.proxy.settings,'clear',{scope:'regular'}); state.status='disabled'; }
    } catch(error) {state.status='error'; state.error=messageOf(error);}
    finally { changing=false; }
    await persist();
  });
  initialized.catch(()=>{});
  const reconcileProxy = details => {
    if (!details || state.desiredMode==='disabled') return;
    if (!matches(details)) {
      state.proxyControlled=false; state.status='error'; state.error=`프록시 설정이 변경되었습니다 (${details.levelOfControl || 'unknown'}). 정책 또는 다른 확장 프로그램을 확인하세요.`;
      notify(); enqueue(persist).catch(()=>{});
    }
  };
  chrome.proxy.settings.onChange?.addListener(details=>{
    observedProxy=details;
    if(!changing) reconcileProxy(details);
  });
  const connect = async hostId => {
    const host=state.hosts.find(h=>h.id===hostId);
    if (!host) throw new Error('호스트를 찾을 수 없습니다.');
    validateHost(host,id);
    if(state.status==='connected' && state.activeHostId===host.id && client && !client.closed) return;
    const prior=clone(state), priorExpected=expected;
    let next=null, connection=null, proxyAttempted=false, committed=false, succeeded=false;
    let candidateMarker=null;
    const candidateAlive=()=>connection && !connection.closed && !exitedTunnels.has(next?.tunnelId);
    state.status='connecting'; state.error=null; notify(); changing=true;
    try {
      connection=await native();
      next=await connection.request('connect',{host});
      if (!next || next.status!=='ready' || typeof next.tunnelId!=='string' || !next.tunnelId || next.hostId!==host.id || !Number.isInteger(next.port) || next.port<1 || next.port>65535 || !candidateAlive()) throw new Error('SSH 헬퍼가 잘못된 터널 응답을 보냈습니다.');
      candidateMarker={hostId:host.id,tunnelId:next.tunnelId,port:next.port};
      state.pendingRemote=candidateMarker;
      // Write-ahead safety: a crash after any proxy side effect must restart blocked.
      await persist();
      if(!candidateAlive()) throw new Error('SSH 헬퍼 또는 터널 연결이 종료되었습니다.');
      proxyAttempted=true;
      await setProxy(socksConfig(next.port)); await verify();
      if(!candidateAlive()) throw new Error('SSH 헬퍼 또는 터널 연결이 종료되었습니다.');
      Object.assign(state,{desiredMode:'remote',selectedHostId:host.id,currentPort:next.port,tunnelId:next.tunnelId,activeHostId:host.id,status:'connected',error:null,proxyControlled:true,pendingRemote:null});
      // desiredMode/port and marker removal are one durable commit.
      await persist(); committed=true;
      if(!candidateAlive() || state.status!=='connected' || !matches(observedProxy)) throw new Error('연결 확인 중 SSH 터널 또는 프록시 제어가 종료되었습니다.');
      if (prior.tunnelId && prior.tunnelId!==next.tunnelId && !connection.closed) {
        try { await connection.request('release',{tunnelId:prior.tunnelId},2000); } catch { /* owned by helper until disconnect */ }
      }
      if(!candidateAlive() || state.status!=='connected' || !matches(observedProxy)) throw new Error('연결 확인 중 SSH 터널 또는 프록시 제어가 종료되었습니다.');
      succeeded=true;
    } catch(error) {
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
      } else if (committed) {
        // The old tunnel may already be released: do not roll back a committed switch.
        Object.assign(state,{status:'error',activeHostId:null,tunnelId:null,error:messageOf(error),proxyControlled:matches(observedProxy)});
      } else {
        expected=priorExpected;
        Object.assign(state,prior);
        if((connection?.closed || exitedTunnels.has(prior.tunnelId)) && prior.desiredMode==='remote') Object.assign(state,{status:'error',activeHostId:null,tunnelId:null});
        state.error=messageOf(error);
        if (prior.status!=='connected') state.status='error';
        // Marker is cleared only after no proxy change or a verified rollback.
      }
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
  const end = async local => {
    changing=true;
    try {
      if (local) {await setProxy({mode:'direct'});await verify();}
      else {expected=null;await api(chrome.proxy.settings,'clear',{scope:'regular'});state.proxyControlled=false;}
      Object.assign(state,{desiredMode:local?'local':'disabled',status:local?'local':'disabled',activeHostId:null,tunnelId:null,currentPort:null,error:null,pendingRemote:null});
      await persist();
      if (client) {const closing=client; client=null; try {await closing.request('disconnect',{},2000);} catch {} finally {closing.close();}}
    } catch(error) { state.status='error'; state.error=messageOf(error); throw error; }
    finally {changing=false;reconcileProxy(observedProxy);notify();}
  };
  const mutate = async request => {
    switch(request.type) {
      case 'CONNECT': await connect(request.id); break;
      case 'LOCAL': await end(true); break;
      case 'STOP': await end(false); break;
      case 'SAVE_HOST': {
        const host=validateHost(request.host,id), index=state.hosts.findIndex(h=>h.id===host.id);
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
        const merged=new Map(state.hosts.map(h=>[h.id,h])); for(const host of imported) merged.set(host.id,host);
        state.hosts=[...merged.values()]; await persist();break;
      }
      default: throw new Error('알 수 없는 요청입니다.');
    }
    notify();
  };
  return {
    ready:initialized,
    getState:()=>clone(state),
    async handle(request) {
      try {
        await initialized;
        if(!request || typeof request.type!=='string') throw new Error('잘못된 요청입니다.');
        if(request.type!=='GET_STATE') await enqueue(()=>mutate(request));
        return {ok:true,state:clone(state)};
      } catch(error) { return {ok:false,error:messageOf(error),state:clone(state)}; }
    }
  };
}
