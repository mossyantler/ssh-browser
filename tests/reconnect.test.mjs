import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../extension/core.js',import.meta.url),'utf8');
const {createController,NativeClient,socksConfig}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const host=id=>({id,name:id,mode:'manual',alias:'',address:`${id}.example.org`,port:22,user:'dev',keyPath:'',group:'',favorite:false});
const coded=(code,message=code)=>Object.assign(new Error(message),{code});
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function settle(){for(let i=0;i<5;i++)await turn();}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

function fakeClock(start=1700000000000){
  let time=start,sequence=0;
  const jobs=new Map(),history=[];
  return {
    now:()=>time,jobs,history,
    setTimeout(fn,ms){const id=++sequence,job={id,fn,at:time+ms};jobs.set(id,job);history.push(job);return id;},
    clearTimeout(id){jobs.delete(id);},
    async advanceTo(at){
      assert.ok(at>=time,'fake clock cannot move backwards');time=at;
      const due=[...jobs.values()].filter(job=>job.at<=time).sort((a,b)=>a.at-b.at);
      for(const job of due){if(!jobs.delete(job.id))continue;job.fn();await settle();}
      await settle();
    },
  };
}

function fixture({saved={},clock=fakeClock(),storage,alarms=false,alarmStore=new Map(),nativeClass}={}){
  storage??={hosts:[host('a'),host('b')],...structuredClone(saved)};
  const calls=[],instances=[],changes=[],alarmListeners=[],connectOutcomes=[],helloOutcomes=[],live=new Map();
  let value={mode:'system'},level='controllable_by_this_extension',sequence=0;
  const chrome={runtime:{lastError:null,sendMessage:async()=>{}},storage:{local:{
    get(keys,cb){cb(structuredClone(storage));},
    set(data,cb){calls.push({type:'persist',data:structuredClone(data)});Object.assign(storage,structuredClone(data));cb();},
  }},proxy:{settings:{
    set(details,cb){
      if(level==='controlled_by_other_extensions')throw Error('external proxy control');
      calls.push({type:'proxy-set',details:structuredClone(details)});value=structuredClone(details.value);level='controlled_by_this_extension';
      for(const fn of changes)fn({value:structuredClone(value),levelOfControl:level});cb();
    },
    clear(details,cb){calls.push({type:'proxy-clear',details});value={mode:'system'};level='controllable_by_this_extension';cb();},
    get(details,cb){calls.push({type:'proxy-get'});cb({value:structuredClone(value),levelOfControl:level});},
    onChange:{addListener(fn){changes.push(fn);}},
  }}};
  if(alarms)chrome.alarms={
    create(name,info,cb){calls.push({type:'alarm-create',name,info:structuredClone(info)});alarmStore.set(name,structuredClone(info));cb?.();},
    clear(name,cb){calls.push({type:'alarm-clear',name});const removed=alarmStore.delete(name);cb?.(removed);return Promise.resolve(removed);},
    onAlarm:{addListener(fn){alarmListeners.push(fn);}},
  };
  class NativeMock{
    constructor(_chrome,profileId,onLost,onEvent){this.closed=false;this.onLost=onLost;this.onEvent=onEvent;this.id=instances.length+1;instances.push(this);calls.push({type:'native',profileId,instance:this.id});}
    async request(type,data){
      calls.push({type,data:structuredClone(data),instance:this.id,reconnect:structuredClone(storage.reconnect)});
      if(type==='hello'){
        const result=helloOutcomes.shift();if(result instanceof Error)throw result;
        return result??{protocol:1,version:'fake-helper'};
      }
      if(type==='connect'){
        const outcome=connectOutcomes.shift();if(outcome instanceof Error)throw outcome;
        if(typeof outcome==='function')await outcome(this,data);
        const result={tunnelId:`t-${++sequence}`,hostId:data.host.id,status:'ready',port:40100+sequence,connectMs:420};
        if(!this.closed)live.set(result.tunnelId,this.id);this.lastTunnel=result;return result;
      }
      if(type==='release')live.delete(data.tunnelId);
      if(type==='disconnect')for(const [tunnel,owner]of live)if(owner===this.id)live.delete(tunnel);
      return {};
    }
    close(){this.closed=true;for(const [tunnel,owner]of live)if(owner===this.id)live.delete(tunnel);calls.push({type:'close',instance:this.id});}
    lose(error=coded('NATIVE_LOST')){this.close();this.onLost(error);}
    network(online){this.onEvent({event:'network-change',online});}
    exit(reason='SSH_EXIT',code=255){live.delete(this.lastTunnel?.tunnelId);this.onEvent({event:'tunnel-exit',tunnelId:this.lastTunnel?.tunnelId,code,reason});}
  }
  const controller=createController(chrome,{NativeClient:nativeClass??NativeMock,timers:clock,now:clock.now,uuid:()=> 'profile-test'});
  const f={controller,storage,clock,calls,instances,connectOutcomes,helloOutcomes,live,chrome,alarmStore,
    get value(){return structuredClone(value);},get native(){return instances.at(-1);},
    override(){value={mode:'direct'};level='controlled_by_other_extensions';for(const fn of changes)fn({value:structuredClone(value),levelOfControl:level});},
    async fireAlarm(name,scheduledTime=clock.now()){
      alarmStore.delete(name);for(const fn of alarmListeners)fn({name,scheduledTime});await settle();
    },
  };
  return f;
}
const connects=f=>f.calls.filter(call=>call.type==='connect');
async function connected(f,id='a'){
  const reply=await f.controller.handle({type:'CONNECT',id});assert.equal(reply.ok,true,reply.error);assert.equal(reply.state.status,'connected');return reply.state;
}
function blocked(f){
  const state=f.controller.getState();assert.equal(state.desiredMode,'remote');assert.equal(state.activeHostId,null);assert.equal(state.tunnelId,null);
  assert.deepEqual(f.value,socksConfig(9));assert.equal(f.storage.currentPort,9);
}
async function lose(f,event=false){
  const start=f.calls.length;if(event)f.native.exit();else f.native.lose();await settle();
  const effects=f.calls.slice(start).filter(call=>call.type.startsWith('proxy-'));
  assert.equal(effects.some(call=>call.type==='proxy-clear'||call.details?.value.mode==='direct'),false,'loss must never fall back to DIRECT');
  assert.equal(f.controller.getState().status,'reconnecting');blocked(f);
  assert.equal(f.controller.getState().retryAttempt,0);assert.equal(f.controller.getState().retryLimit,3);
  const retry=f.storage.reconnect;assert.equal(retry.hostId,'a');assert.equal(retry.attempt,0);assert.equal(retry.blocked,false);
  assert.ok(Number.isInteger(retry.generation));assert.ok(retry.nextRetryAt>f.clock.now());
}
async function nextRetry(f){
  const at=f.storage.reconnect?.nextRetryAt;assert.ok(Number.isFinite(at)&&at>=f.clock.now(),'durable retry deadline');await f.clock.advanceTo(at);
}

test('helper availability and classified-error state start unknown',async()=>{
  const f=fixture();const initial=f.controller.getState();
  assert.equal(initial.helperAvailable,null);assert.equal(initial.setupErrorCode,null);assert.equal(initial.errorCode,null);
  await f.controller.ready;assert.equal(f.controller.getState().helperAvailable,null);assert.equal(f.instances.length,0);
});

for(const desiredMode of ['local','disabled'])for(const code of ['AUTH','TIMEOUT'])test(`first explicit CONNECT ${code} from ${desiredMode} fails without proxy changes or automatic retries`,async()=>{
  const f=fixture({saved:{desiredMode}});await f.controller.ready;const route=f.value,start=f.calls.length;
  f.connectOutcomes.push(coded(code));const reply=await f.controller.handle({type:'CONNECT',id:'a'});
  assert.equal(reply.ok,false);assert.equal(reply.errorCode,code);assert.equal(reply.state.errorCode,code);
  assert.equal(reply.state.desiredMode,desiredMode);assert.equal(reply.state.activeHostId,null);assert.deepEqual(f.value,route);
  assert.equal(f.calls.slice(start).some(call=>call.type.startsWith('proxy-')),false);assert.equal(f.clock.jobs.size,0);
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(connects(f).length,1);assert.equal(f.storage.reconnect,null);
});

test('failed switch to B preserves live A and does not disable A loss recovery',async()=>{
  const f=fixture();await connected(f);f.connectOutcomes.push(coded('TIMEOUT'));
  const failed=await f.controller.handle({type:'CONNECT',id:'b'});assert.equal(failed.ok,false);
  assert.equal(failed.state.status,'connected');assert.equal(failed.state.activeHostId,'a');assert.deepEqual(f.value,socksConfig(40101));
  await lose(f);await nextRetry(f);assert.equal(f.controller.getState().status,'connected');assert.equal(f.controller.getState().activeHostId,'a');
  assert.equal(connects(f).at(-1).data.host.id,'a');assert.equal(f.storage.reconnect.attempt,1);
});

test('automatic hello missing helper is a terminal setup failure without repeated wakes',async()=>{
  const f=fixture({alarms:true});await connected(f);await lose(f);f.helloOutcomes.push(coded('NATIVE_UNAVAILABLE','helper is not registered'));
  await nextRetry(f);const state=f.controller.getState();assert.equal(state.status,'error');assert.equal(state.helperAvailable,false);
  assert.equal(state.setupErrorCode,'NATIVE_UNAVAILABLE');assert.equal(state.errorCode,'NATIVE_UNAVAILABLE');assert.equal(state.retryAttempt,1);
  assert.equal(f.native.closed,true);assert.equal(connects(f).length,1);assert.equal(f.storage.reconnect.blocked,true);
  assert.equal(f.clock.jobs.size,0);assert.equal(f.alarmStore.size,0);blocked(f);
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(f.instances.length,2);assert.equal(connects(f).length,1);
});

for(const desiredMode of ['local','disabled'])test(`first CONNECT from ${desiredMode} lost during durable commit receives bounded recovery`,async()=>{
  const f=fixture({saved:{desiredMode}});await f.controller.ready;const set=f.chrome.storage.local.set;let exited=false;
  f.chrome.storage.local.set=(data,cb)=>{
    if(!exited&&data.desiredMode==='remote'&&data.controllerState.status==='connected'&&data.pendingRemote===null){exited=true;f.native.exit();}
    set(data,cb);
  };
  const reply=await f.controller.handle({type:'CONNECT',id:'a'});assert.equal(reply.ok,false);assert.equal(reply.state.activeHostId,null);
  await settle();assert.equal(exited,true);assert.equal(f.controller.getState().status,'reconnecting');blocked(f);
  assert.equal(f.storage.reconnect.attempt,0);assert.equal(f.storage.reconnect.blocked,false);assert.equal(f.storage.pendingRemote,null);
  await nextRetry(f);assert.equal(f.controller.getState().status,'connected');assert.equal(f.controller.getState().activeHostId,'a');
  assert.equal(f.storage.reconnect.attempt,1);assert.equal(connects(f).length,2);
});

test('bare native loss is normalized while unknown classified failures are not retried',async()=>{
  const f=fixture();await connected(f);f.native.lose(new Error('transport EOF'));await settle();
  assert.equal(f.controller.getState().status,'reconnecting');assert.equal(f.controller.getState().errorCode,'NATIVE_LOST');
  await nextRetry(f);f.native.lose(coded('UNKNOWN','unexpected failure'));await settle();
  assert.equal(f.controller.getState().status,'error');assert.equal(f.storage.reconnect.blocked,true);assert.equal(f.clock.jobs.size,0);
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(connects(f).length,2);
});

for(const event of [false,true])test(`${event?'numeric SSH exit':'native loss'} blocks port 9 then reconnects only at the durable deadline`,async()=>{
  const f=fixture();const old=await connected(f);await lose(f,event);const count=connects(f).length;
  await f.clock.advanceTo(f.storage.reconnect.nextRetryAt-1);assert.equal(connects(f).length,count);
  await nextRetry(f);const state=f.controller.getState();assert.equal(state.status,'connected');assert.equal(state.activeHostId,'a');
  assert.notEqual(state.tunnelId,old.tunnelId);assert.deepEqual(f.value,socksConfig(state.currentPort));assert.notEqual(state.currentPort,9);
  assert.equal(state.errorCode,null);assert.equal(state.helperAvailable,true);
  assert.equal(f.storage.reconnect.attempt,1);assert.equal(f.storage.reconnect.nextRetryAt,null);assert.equal(f.storage.reconnect.blocked,false);
  const retry=connects(f).at(-1);assert.equal(retry.reconnect.attempt,1,'attempt must be durable before native connect');
  assert.equal(connects(f).length,2);assert.equal(f.clock.jobs.size,0);
});

test('exactly three transient attempts exhaust without direct fallback or further retries',async()=>{
  const f=fixture();await connected(f);await lose(f);f.connectOutcomes.push(...Array.from({length:3},()=>coded('TIMEOUT')));
  for(let attempt=1;attempt<=3;attempt++){
    await nextRetry(f);assert.equal(connects(f).length,1+attempt);assert.equal(f.controller.getState().retryAttempt,attempt);
    assert.equal(f.storage.reconnect.attempt,attempt);blocked(f);
    assert.equal(f.controller.getState().status,attempt===3?'error':'reconnecting');
  }
  assert.equal(f.storage.reconnect.blocked,true);assert.equal(f.storage.reconnect.nextRetryAt,null);assert.equal(f.clock.jobs.size,0);
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(connects(f).length,4);blocked(f);
});

test('a delayed transient failure receives the full next backoff after the failed native request',async()=>{
  const f=fixture();await connected(f);await lose(f);const gate=deferred(),entered=deferred();
  f.connectOutcomes.push(async()=>{entered.resolve();await gate.promise;});
  const running=nextRetry(f);await entered.promise;const began=f.clock.now();
  await f.clock.advanceTo(began+20000);gate.reject(coded('TIMEOUT'));await running;await settle();
  assert.equal(f.controller.getState().status,'reconnecting');assert.equal(f.controller.getState().retryAttempt,1);blocked(f);
  assert.equal(f.storage.reconnect.nextRetryAt,f.clock.now()+3000,'backoff starts after failure, not at request reservation');
  await f.clock.advanceTo(f.storage.reconnect.nextRetryAt-1);assert.equal(connects(f).length,2);
  await nextRetry(f);assert.equal(connects(f).length,3);assert.equal(f.controller.getState().status,'connected');
});

for(const code of ['AUTH','HOST_KEY','INVALID_HOST','PROTOCOL'])test(`fatal ${code} stops the retry budget after one native attempt`,async()=>{
  const f=fixture();await connected(f);await lose(f);f.connectOutcomes.push(coded(code));await nextRetry(f);
  assert.equal(f.controller.getState().status,'error');assert.equal(f.controller.getState().errorCode,code);assert.equal(f.storage.reconnect.blocked,true);
  assert.equal(f.clock.jobs.size,0);blocked(f);await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(connects(f).length,2);
});

for(const reason of ['AUTH','HOST_KEY'])test(`numeric exit code classifies fatal reason ${reason}`,async()=>{
  const f=fixture();await connected(f);f.native.exit(reason,255);await settle();
  assert.equal(f.controller.getState().status,'error');assert.equal(f.controller.getState().errorCode,reason);
  assert.equal(f.storage.reconnect.blocked,true);assert.equal(f.clock.jobs.size,0);blocked(f);
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(connects(f).length,1);
});

for(const reason of ['AUTH: Permission denied','HOST_KEY: verification failed'])test(`numeric exit code preserves fatal classification in reason ${reason}`,async()=>{
  const f=fixture();await connected(f);f.native.exit(reason,255);await settle();
  assert.equal(f.controller.getState().status,'error');assert.equal(f.controller.getState().errorCode,reason.split(':')[0]);
  assert.equal(f.storage.reconnect.blocked,true);assert.equal(f.clock.jobs.size,0);blocked(f);
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(connects(f).length,1);
});

test('TIMEOUT reason with numeric OS code remains transient',async()=>{
  const f=fixture();await connected(f);f.native.exit('TIMEOUT',255);await settle();
  assert.equal(f.controller.getState().status,'reconnecting');assert.equal(f.controller.getState().errorCode,'TIMEOUT');blocked(f);
  await nextRetry(f);assert.equal(f.controller.getState().status,'connected');
});

test('external proxy ownership cancels the scheduled retry and ignores stale timer',async()=>{
  const f=fixture();await connected(f);await lose(f);const oldTimer=f.clock.history.at(-1);f.override();await settle();
  assert.equal(f.controller.getState().status,'error');assert.equal(f.controller.getState().proxyControlled,false);assert.equal(f.storage.reconnect.blocked,true);
  assert.equal(f.clock.jobs.size,0);const calls=connects(f).length;oldTimer.fn();await settle();
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(connects(f).length,calls);assert.deepEqual(f.value,{mode:'direct'});
});

test('external DIRECT during reconnect persistence is reconciled before any automatic retry can run',async()=>{
  const f=fixture({alarms:true});await connected(f);const set=f.chrome.storage.local.set;let injected=false;
  f.chrome.storage.local.set=(data,cb)=>{
    if(!injected&&data.controllerState.status==='reconnecting'){
      injected=true;f.override();
    }
    set(data,cb);
  };
  f.native.lose();await settle();assert.equal(injected,true);
  const state=f.controller.getState();assert.equal(state.proxyControlled,false);assert.equal(state.status,'error');
  assert.equal(state.errorCode,'PROXY_CONTROL');assert.equal(state.activeHostId,null);assert.deepEqual(f.value,{mode:'direct'});
  assert.equal(f.storage.reconnect.blocked,true);assert.equal(f.storage.reconnect.nextRetryAt,null);
  assert.equal(f.clock.jobs.size,0);assert.equal(f.alarmStore.size,0);assert.equal(connects(f).length,1);
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(connects(f).length,1);assert.equal(f.instances.length,1);
  assert.equal(f.controller.getState().proxyControlled,false);assert.equal(f.controller.getState().status,'error');
  assert.deepEqual(f.value,{mode:'direct'});
});

test('uncertain pending marker blocks recovery despite a durable unblocked retry',async()=>{
  const f=fixture({saved:{desiredMode:'local',selectedHostId:'a',currentPort:40101,
    pendingRemote:{hostId:'a',tunnelId:'old',port:40101},
    reconnect:{hostId:'a',attempt:1,nextRetryAt:1700000000100,blocked:false,generation:7}}});
  await f.controller.ready;assert.equal(f.controller.getState().status,'error');assert.ok(f.storage.pendingRemote);blocked(f);
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(connects(f).length,0);assert.equal(f.instances.length,0);
});

for(const action of ['LOCAL','STOP'])test(`${action} cancels backoff and stale timers, native callbacks and alarms`,async()=>{
  const f=fixture({alarms:true});await connected(f);const oldNative=f.native;await lose(f);
  const oldTimer=f.clock.history.at(-1),oldAlarm=f.calls.findLast(call=>call.type==='alarm-create');
  const reply=await f.controller.handle({type:action});assert.equal(reply.ok,true);assert.equal(reply.state.status,action==='LOCAL'?'local':'disabled');
  assert.equal(f.storage.reconnect,null);assert.equal(f.clock.jobs.size,0);assert.equal(f.alarmStore.size,0);
  const snapshot=structuredClone(f.storage),count=connects(f).length;
  oldTimer.fn();oldNative.onLost(coded('SSH_EXIT'));oldNative.onEvent({event:'tunnel-exit',tunnelId:oldNative.lastTunnel.tunnelId,code:255,reason:'SSH_EXIT'});
  if(oldAlarm)await f.fireAlarm(oldAlarm.name);await settle();await f.clock.advanceTo(f.clock.now()+86400000);
  assert.equal(connects(f).length,count);assert.deepEqual(f.storage,snapshot);assert.equal(f.value.mode,action==='LOCAL'?'direct':'system');
});

for(const action of ['LOCAL','STOP'])test(`${action} cancellation persistence failure still blocks subsequent native loss without restarting recovery`,async()=>{
  const f=fixture({alarms:true});await connected(f);const active=f.native,set=f.chrome.storage.local.set,start=f.calls.length;
  let rejected=false;
  f.chrome.storage.local.set=(data,cb)=>{
    if(!rejected){rejected=true;throw Error('one-shot cancellation persistence failure');}
    set(data,cb);
  };
  const reply=await f.controller.handle({type:action});assert.equal(reply.ok,false);assert.match(reply.error,/cancellation persistence failure/);
  assert.equal(rejected,true);assert.equal(reply.state.desiredMode,'remote');assert.equal(reply.state.activeHostId,'a');
  assert.equal(active.closed,false);assert.equal(f.live.size,1);assert.deepEqual(f.value,socksConfig(40101));
  assert.equal(f.calls.slice(start).some(call=>call.type==='proxy-set'||call.type==='proxy-clear'||call.type==='disconnect'),false);
  active.lose();await settle();blocked(f);assert.equal(f.controller.getState().status,'error');assert.equal(f.live.size,0);
  assert.equal(f.storage.reconnect.blocked,true);assert.equal(f.storage.reconnect.nextRetryAt,null);
  assert.equal(f.clock.jobs.size,0);assert.equal(f.alarmStore.size,0);
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(connects(f).length,1);assert.equal(f.instances.length,1);blocked(f);
});

test('manual CONNECT replaces the backoff generation and ignores its stale callback',async()=>{
  const f=fixture({alarms:true});await connected(f);const oldNative=f.native;await lose(f);
  const stale=f.clock.history.at(-1),alarm=f.calls.findLast(call=>call.type==='alarm-create');await connected(f,'b');
  const route=f.value,count=connects(f).length;assert.equal(f.storage.reconnect.hostId,'b');assert.equal(f.storage.reconnect.attempt,0);assert.equal(f.storage.reconnect.nextRetryAt,null);
  stale.fn();oldNative.onLost(coded('TIMEOUT'));oldNative.onEvent({event:'tunnel-exit',tunnelId:oldNative.lastTunnel.tunnelId,code:255,reason:'SSH_EXIT'});
  if(alarm)await f.fireAlarm(alarm.name);await settle();await f.clock.advanceTo(f.clock.now()+86400000);
  assert.equal(connects(f).length,count);assert.equal(f.controller.getState().activeHostId,'b');assert.deepEqual(f.value,route);
});

for(const action of ['LOCAL','STOP','CONNECT'])test(`${action} during an in-flight retry invalidates its late native success`,async()=>{
  const f=fixture();await connected(f);await lose(f);const gate=deferred(),entered=deferred();
  f.connectOutcomes.push(async()=>{entered.resolve();await gate.promise;});const retry=nextRetry(f);await entered.promise;
  const intent=f.controller.handle({type:action,...(action==='CONNECT'?{id:'b'}:{})});await turn();gate.resolve();await retry;
  const reply=await intent;await settle();assert.equal(reply.ok,true,reply.error);
  assert.equal(f.controller.getState().status,action==='LOCAL'?'local':action==='STOP'?'disabled':'connected');
  assert.equal(f.controller.getState().activeHostId,action==='CONNECT'?'b':null);
  if(action==='CONNECT'){assert.equal(f.storage.reconnect.hostId,'b');assert.equal(f.storage.reconnect.attempt,0);assert.equal(f.storage.reconnect.nextRetryAt,null);}
  else assert.equal(f.storage.reconnect,null);
  const latePorts=f.calls.filter(call=>call.type==='proxy-set'&&call.details.value.rules?.singleProxy.port===40102);
  assert.equal(latePorts.length,0,'cancelled retry must not install its late candidate proxy');
  assert.equal(f.live.size,action==='CONNECT'?1:0);
});

test('worker startup never trusts the saved tunnel and consumes only the remaining durable budget',async()=>{
  const clock=fakeClock(),saved={desiredMode:'remote',selectedHostId:'a',currentPort:44444,
    controllerState:{status:'connected',activeHostId:'a',tunnelId:'stale'},
    reconnect:{hostId:'a',attempt:2,nextRetryAt:clock.now()+10000,blocked:false,generation:9}};
  const f=fixture({saved,clock});f.connectOutcomes.push(coded('TIMEOUT'));await f.controller.ready;
  blocked(f);assert.equal(f.controller.getState().status,'reconnecting');assert.equal(f.controller.getState().retryAttempt,2);assert.equal(f.instances.length,0);
  await clock.advanceTo(saved.reconnect.nextRetryAt-1);assert.equal(connects(f).length,0);
  await nextRetry(f);assert.equal(connects(f).length,1);assert.equal(connects(f)[0].reconnect.attempt,3);
  assert.equal(f.controller.getState().status,'error');assert.equal(f.storage.reconnect.blocked,true);
  const restarted=fixture({storage:f.storage,clock:fakeClock(clock.now())});await restarted.controller.ready;
  await restarted.clock.advanceTo(clock.now()+86400000);blocked(restarted);assert.equal(connects(restarted).length,0);
});

test('retry reservation persistence failure prevents native work and terminates the automatic schedule',async()=>{
  const f=fixture();await connected(f);await lose(f);const set=f.chrome.storage.local.set;
  f.chrome.storage.local.set=(data,cb)=>{
    if(data.reconnect?.attempt===1&&data.reconnect.blocked===false)throw Error('durable storage failed');
    set(data,cb);
  };
  await nextRetry(f);assert.equal(connects(f).length,1);assert.equal(f.instances.length,1);
  assert.equal(f.controller.getState().status,'error');assert.equal(f.storage.reconnect.blocked,true);assert.equal(f.clock.jobs.size,0);blocked(f);
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(connects(f).length,1);
});

test('loss-state persistence failure cannot prevent replacing the dead port with blocker 9',async()=>{
  const f=fixture();await connected(f);const set=f.chrome.storage.local.set;let failed=false;
  f.chrome.storage.local.set=(data,cb)=>{
    if(!failed&&data.controllerState.activeHostId===null&&data.desiredMode==='remote'){
      failed=true;throw Error('one-shot loss-state storage failure');
    }
    set(data,cb);
  };
  f.native.lose();await settle();assert.equal(failed,true);assert.deepEqual(f.value,socksConfig(9));
  assert.equal(f.controller.getState().activeHostId,null);assert.equal(connects(f).length,1);
  assert.equal(f.calls.some(call=>call.type==='proxy-set'&&call.details.value.mode==='direct'),false);
  const restarted=fixture({storage:structuredClone(f.storage),clock:fakeClock(f.clock.now())});await restarted.controller.ready;blocked(restarted);
});

test('repeated worker deaths preserve deadline and count attempts before starting native work',async()=>{
  let storage={hosts:[host('a'),host('b')],desiredMode:'remote',selectedHostId:'a'},time=1700000000000;
  for(let attempt=1;attempt<=3;attempt++){
    const f=fixture({storage,clock:fakeClock(time)});const gate=deferred(),entered=deferred();
    f.connectOutcomes.push(async()=>{entered.resolve();await gate.promise;});await f.controller.ready;
    assert.equal(f.controller.getState().retryAttempt,attempt-1);blocked(f);
    const next=f.storage.reconnect.nextRetryAt;
    // Restart while waiting must not reset this deadline or budget.
    const waiting=fixture({storage:structuredClone(storage),clock:fakeClock(time)});await waiting.controller.ready;
    assert.equal(waiting.storage.reconnect.nextRetryAt,next);assert.equal(waiting.storage.reconnect.attempt,attempt-1);assert.equal(connects(waiting).length,0);
    const running=nextRetry(f);await entered.promise;
    assert.equal(storage.reconnect.attempt,attempt);assert.equal(connects(f).at(-1).reconnect.attempt,attempt);
    // Snapshot durable state while the worker is killed mid-request, then let
    // the abandoned mock settle without changing the replacement worker's data.
    storage=structuredClone(storage);time=f.clock.now();gate.resolve();await running;
  }
  const final=fixture({storage,clock:fakeClock(time)});await final.controller.ready;
  assert.equal(final.controller.getState().status,'error');assert.equal(final.controller.getState().retryAttempt,3);
  assert.equal(final.storage.reconnect.blocked,true);await final.clock.advanceTo(time+86400000);assert.equal(connects(final).length,0);blocked(final);
});

test('successful recovery and worker restarts never replenish the consumed automatic budget',async()=>{
  let f=fixture();await connected(f);await lose(f);await nextRetry(f);
  assert.equal(f.storage.reconnect.attempt,1);assert.equal(f.controller.getState().status,'connected');
  for(let attempt=2;attempt<=3;attempt++){
    f=fixture({storage:structuredClone(f.storage),clock:fakeClock(f.clock.now())});await f.controller.ready;
    blocked(f);assert.equal(f.controller.getState().retryAttempt,attempt-1);assert.equal(f.controller.getState().status,'reconnecting');
    await nextRetry(f);assert.equal(f.controller.getState().status,'connected');assert.equal(f.storage.reconnect.attempt,attempt);
    assert.equal(connects(f).length,1);assert.equal(connects(f)[0].reconnect.attempt,attempt);
  }
  const exhausted=fixture({storage:structuredClone(f.storage),clock:fakeClock(f.clock.now())});await exhausted.controller.ready;
  assert.equal(exhausted.controller.getState().status,'error');assert.equal(exhausted.controller.getState().retryAttempt,3);blocked(exhausted);
  await exhausted.clock.advanceTo(exhausted.clock.now()+86400000);assert.equal(connects(exhausted).length,0);
  await connected(exhausted);assert.equal(exhausted.storage.reconnect.attempt,0,'explicit CONNECT starts a new user-authorized budget');
});

test('malformed persisted retry count cannot escape the maximum three-attempt budget',async()=>{
  for(const attempt of [-1,1.5,100,'2']){
    const f=fixture({saved:{desiredMode:'remote',selectedHostId:'a',reconnect:{hostId:'a',attempt,nextRetryAt:1700000000000,blocked:false,generation:1}}});
    f.connectOutcomes.push(...Array.from({length:4},()=>coded('TIMEOUT')));await f.controller.ready;
    for(let i=0;i<4&&f.controller.getState().status==='reconnecting';i++)await nextRetry(f);
    assert.ok(connects(f).length<=3,`invalid attempt ${attempt} must be bounded`);assert.equal(f.controller.getState().status,'error');blocked(f);
  }
});

const malformedReconnectFields=[
  ['blocked string true','blocked','true'],['blocked string false','blocked','false'],
  ['blocked number','blocked',1],['blocked null','blocked',null],['blocked missing','blocked',undefined],
  ['generation invalid string','generation','invalid'],['generation numeric string','generation','2'],
  ['generation negative','generation',-1],['generation fractional','generation',0.5],
  ['generation infinite','generation',Infinity],['generation NaN','generation',NaN],
  ['generation unsafe integer','generation',Number.MAX_SAFE_INTEGER+1],['generation missing','generation',undefined],
  ['deadline negative','nextRetryAt',-100],['deadline zero','nextRetryAt',0],
  ['deadline string','nextRetryAt','1700000001000'],['deadline infinite','nextRetryAt',Infinity],
  ['deadline negative infinity','nextRetryAt',-Infinity],['deadline NaN','nextRetryAt',NaN],
  ['deadline missing','nextRetryAt',undefined],
  ['host mismatch','hostId','b'],['host empty','hostId',''],['host wrong type','hostId',7],['host missing','hostId',undefined],
  ['attempt negative','attempt',-1],['attempt fractional','attempt',0.5],['attempt string','attempt','1'],
  ['attempt over limit','attempt',4],['attempt NaN','attempt',NaN],['attempt infinite','attempt',Infinity],
  ['attempt missing','attempt',undefined],
];
for(const [label,field,value]of malformedReconnectFields)test(`malformed saved reconnect ${label} blocks the full record without native work or wakes`,async()=>{
  const clock=fakeClock(),record={hostId:'a',attempt:1,nextRetryAt:clock.now()+1000,blocked:false,generation:2,[field]:value};
  const f=fixture({alarms:true,clock,saved:{desiredMode:'remote',selectedHostId:'a',currentPort:40101,reconnect:record}});
  await f.controller.ready;const state=f.controller.getState();assert.equal(state.status,'error',label);blocked(f);
  assert.equal(f.storage.reconnect.blocked,true);assert.equal(f.storage.reconnect.nextRetryAt,null);
  assert.equal(f.clock.jobs.size,0);assert.equal(f.alarmStore.size,0);assert.equal(f.instances.length,0);
  assert.equal(f.calls.some(call=>call.type==='alarm-create'),false);
  await f.clock.advanceTo(clock.now()+86400000);assert.equal(connects(f).length,0);assert.equal(f.instances.length,0);
  const restarted=fixture({alarms:true,storage:structuredClone(f.storage),clock:fakeClock(clock.now())});await restarted.controller.ready;
  assert.equal(restarted.controller.getState().status,'error');assert.equal(restarted.clock.jobs.size,0);assert.equal(restarted.alarmStore.size,0);
  await restarted.clock.advanceTo(restarted.clock.now()+86400000);assert.equal(connects(restarted).length,0);blocked(restarted);
});

for(const record of [false,0,''])test(`malformed primitive reconnect ${typeof record} is corrupt rather than a legacy absent record`,async()=>{
  const f=fixture({alarms:true,saved:{desiredMode:'remote',selectedHostId:'a',reconnect:record}});await f.controller.ready;
  assert.equal(f.controller.getState().status,'error');blocked(f);assert.equal(f.storage.reconnect.blocked,true);
  assert.equal(f.storage.reconnect.nextRetryAt,null);assert.equal(f.clock.jobs.size,0);assert.equal(f.alarmStore.size,0);
  await f.clock.advanceTo(f.clock.now()+86400000);assert.equal(f.instances.length,0);assert.equal(connects(f).length,0);
});

test('valid saved reconnect permits a null deadline and preserves the remaining attempt budget',async()=>{
  const clock=fakeClock(),f=fixture({alarms:true,clock,saved:{desiredMode:'remote',selectedHostId:'a',
    reconnect:{hostId:'a',attempt:1,nextRetryAt:null,blocked:false,generation:0}}});
  await f.controller.ready;assert.equal(f.controller.getState().status,'reconnecting');blocked(f);
  assert.equal(f.storage.reconnect.attempt,1);assert.equal(f.storage.reconnect.nextRetryAt,clock.now()+3000);
  assert.equal(f.storage.reconnect.generation,0);assert.equal(f.clock.jobs.size,1);assert.equal(f.alarmStore.size,1);
  await nextRetry(f);assert.equal(f.controller.getState().status,'connected');assert.equal(connects(f).length,1);
  assert.equal(connects(f)[0].reconnect.attempt,2);
});

for(const reconnect of [undefined,null])test(`legacy remote storage with ${reconnect===null?'null':'absent'} reconnect starts a new bounded budget`,async()=>{
  const f=fixture({alarms:true,saved:{desiredMode:'remote',selectedHostId:'a',currentPort:40101,reconnect}});await f.controller.ready;
  assert.equal(f.controller.getState().status,'reconnecting');blocked(f);assert.equal(f.storage.reconnect.attempt,0);
  assert.equal(f.storage.reconnect.blocked,false);assert.equal(f.storage.reconnect.nextRetryAt,f.clock.now()+1000);
  assert.equal(f.instances.length,0);await nextRetry(f);assert.equal(f.controller.getState().status,'connected');
  assert.equal(connects(f).length,1);assert.equal(connects(f)[0].reconnect.attempt,1);
});

test('alarm wakes a suspended worker, shares timer budget and ignores repeated delivery',async()=>{
  const f=fixture({alarms:true});await connected(f);await lose(f);const alarm=f.calls.findLast(call=>call.type==='alarm-create');assert.ok(alarm);
  assert.equal(alarm.info.when,f.storage.reconnect.nextRetryAt);const timer=f.clock.history.at(-1);
  // Do not run JS timers: this models a service worker suspended until onAlarm.
  const clock=f.clock,deadline=f.storage.reconnect.nextRetryAt;
  clock.jobs.clear();await clock.advanceTo(deadline);await f.fireAlarm(alarm.name,deadline);
  assert.equal(f.controller.getState().status,'connected');assert.equal(connects(f).length,2);
  timer.fn();await f.fireAlarm(alarm.name,deadline);await settle();assert.equal(connects(f).length,2);
  assert.equal(f.storage.reconnect.attempt,1);assert.equal(f.storage.reconnect.nextRetryAt,null);
});

test('early or unrelated alarms cannot spend a retry attempt',async()=>{
  const f=fixture({alarms:true});await connected(f);await lose(f);const deadline=f.storage.reconnect.nextRetryAt;
  const name=f.calls.findLast(call=>call.type==='alarm-create').name;
  await f.fireAlarm('unrelated-alarm');await f.fireAlarm(name);
  assert.equal(connects(f).length,1);assert.equal(f.storage.reconnect.attempt,0);assert.equal(f.storage.reconnect.nextRetryAt,deadline);
  await nextRetry(f);assert.equal(connects(f).length,2);assert.equal(f.storage.reconnect.attempt,1);
});

test('alarms resume the same saved deadline after worker restart without resetting attempts',async()=>{
  const clock=fakeClock(),f=fixture({alarms:true,clock});await connected(f);await lose(f);
  const durable=structuredClone(f.storage),alarms=new Map(f.alarmStore);
  const restarted=fixture({storage:durable,alarms:true,alarmStore:alarms,clock:fakeClock(clock.now())});await restarted.controller.ready;
  assert.equal(restarted.storage.reconnect.nextRetryAt,f.storage.reconnect.nextRetryAt);assert.equal(restarted.storage.reconnect.attempt,0);blocked(restarted);
  const alarm=restarted.calls.findLast(call=>call.type==='alarm-create');assert.ok(alarm);
  restarted.clock.jobs.clear();await restarted.clock.advanceTo(durable.reconnect.nextRetryAt);await restarted.fireAlarm(alarm.name);
  assert.equal(connects(restarted).length,1);assert.equal(connects(restarted)[0].reconnect.attempt,1);assert.equal(restarted.controller.getState().status,'connected');
});

for(const type of ['SAVE_HOST','IMPORT'])test(`${type} protects all active connection fields and atomically permits display metadata`,async()=>{
  const f=fixture();await connected(f);const original=f.controller.getState().hosts.find(h=>h.id==='a');
  for(const extra of [{mode:'alias',alias:'oracle'},{address:'other.example.org'},{port:2222},{user:'other'},{keyPath:'/tmp/other-key'}]){
    const changed={...original,...extra},before=structuredClone(f.storage);
    const request=type==='SAVE_HOST'?{type,host:changed}:{type,hosts:[host('c'),changed]};
    assert.equal((await f.controller.handle(request)).ok,false,`active ${Object.keys(extra).join(',')} must be protected`);
    assert.deepEqual(f.storage,before,'rejection must be atomic');assert.equal(f.controller.getState().hosts.some(h=>h.id==='c'),false);
  }
  const metadata={...original,name:'renamed',group:'work',favorite:true};
  assert.equal((await f.controller.handle(type==='SAVE_HOST'?{type,host:metadata}:{type,hosts:[metadata]})).ok,true);
  assert.deepEqual(f.controller.getState().hosts.find(h=>h.id==='a'),metadata);assert.equal(f.controller.getState().activeHostId,'a');assert.equal(connects(f).length,1);
  await f.controller.handle({type:'LOCAL'});const changed={...metadata,address:'now-allowed.example.org'};
  assert.equal((await f.controller.handle(type==='SAVE_HOST'?{type,host:changed}:{type,hosts:[changed]})).ok,true);
});

for(const type of ['SAVE_HOST','IMPORT'])test(`${type} protects alias/mode and allows connection-irrelevant fields of the active host`,async()=>{
  const f=fixture({saved:{hosts:[{...host('a'),mode:'alias',alias:'oracle'},host('b')]}});await connected(f);
  const original=f.controller.getState().hosts.find(h=>h.id==='a');
  for(const extra of [{alias:'other'},{mode:'manual'}]){
    const candidate={...original,...extra},before=structuredClone(f.storage);
    const reply=await f.controller.handle(type==='SAVE_HOST'?{type,host:candidate}:{type,hosts:[host('c'),candidate]});
    assert.equal(reply.ok,false);assert.equal(reply.errorCode,'HOST_IN_USE');assert.deepEqual(f.storage,before);
  }
  const irrelevant={...original,address:'unused.example.org',port:2222,user:'unused',keyPath:'/tmp/unused',name:'friendly',group:'servers',favorite:true};
  assert.equal((await f.controller.handle(type==='SAVE_HOST'?{type,host:irrelevant}:{type,hosts:[irrelevant]})).ok,true);
  assert.equal(f.controller.getState().activeHostId,'a');assert.equal(connects(f).length,1);
  const manual=fixture();await connected(manual);const edited={...manual.controller.getState().hosts.find(h=>h.id==='a'),alias:'unused'};
  assert.equal((await manual.controller.handle(type==='SAVE_HOST'?{type,host:edited}:{type,hosts:[edited]})).ok,true);
});

test('selected reconnecting host also protects connection fields',async()=>{
  const f=fixture();await connected(f);await lose(f);const selected=f.controller.getState().hosts.find(h=>h.id==='a');
  for(const type of ['SAVE_HOST','IMPORT']){
    const changed={...selected,address:'changed.example.org'};
    assert.equal((await f.controller.handle(type==='SAVE_HOST'?{type,host:changed}:{type,hosts:[changed]})).ok,false);
  }
  await nextRetry(f);assert.equal(connects(f).at(-1).data.host.address,selected.address);
});

test('CHECK_HELPER creates a hello-only native session then closes without proxy or routing changes',async()=>{
  const f=fixture();await f.controller.ready;const start=f.calls.length,route=f.value;
  const reply=await f.controller.handle({type:'CHECK_HELPER'});assert.equal(reply.ok,true,reply.error);
  assert.equal(reply.state.helperAvailable,true);assert.equal(reply.state.setupErrorCode,null);assert.equal(reply.state.helperVersion,'fake-helper');
  assert.equal(reply.state.status,'disabled');assert.equal(f.native.closed,true);
  assert.deepEqual(f.calls.slice(start).filter(call=>['hello','connect','status','disconnect'].includes(call.type)).map(call=>call.type),['hello']);
  assert.equal(f.calls.slice(start).some(call=>call.type.startsWith('proxy-')),false);assert.deepEqual(f.value,route);assert.equal(f.live.size,0);
});

test('CHECK_HELPER on an active session uses its cached hello without disconnecting or rehello',async()=>{
  const f=fixture();await connected(f);const native=f.native,start=f.calls.length,state=f.controller.getState();
  const reply=await f.controller.handle({type:'CHECK_HELPER'});assert.equal(reply.ok,true);assert.equal(reply.state.helperAvailable,true);
  assert.equal(reply.state.status,'connected');assert.equal(reply.state.tunnelId,state.tunnelId);assert.equal(f.native,native);assert.equal(native.closed,false);
  assert.equal(f.calls.slice(start).some(call=>['native','hello','connect','disconnect','close'].includes(call.type)),false);
});

for(const code of ['NATIVE_UNAVAILABLE','PROTOCOL'])test(`CHECK_HELPER hello failure preserves ${code} in the reply and setup state`,async()=>{
  const f=fixture();await f.controller.ready;f.helloOutcomes.push(coded(code,'setup unavailable'));const route=f.value;
  const reply=await f.controller.handle({type:'CHECK_HELPER'});assert.equal(reply.ok,false);assert.equal(reply.error,'setup unavailable');assert.equal(reply.errorCode,code);
  assert.equal(reply.state.helperAvailable,false);assert.equal(reply.state.setupErrorCode,code);assert.equal(f.native.closed,true);
  assert.equal(connects(f).length,0);assert.equal(reply.state.status,'disabled');assert.deepEqual(f.value,route);
});

test('incompatible hello protocol is classified without ever opening an SSH tunnel',async()=>{
  const f=fixture();await f.controller.ready;f.helloOutcomes.push({protocol:99,version:'incompatible'});
  const reply=await f.controller.handle({type:'CHECK_HELPER'});assert.equal(reply.ok,false);assert.equal(reply.errorCode,'PROTOCOL');
  assert.equal(reply.state.setupErrorCode,'PROTOCOL');assert.equal(reply.state.helperAvailable,false);assert.equal(f.native.closed,true);assert.equal(connects(f).length,0);
});

test('CHECK_HELPER can recover setup availability without changing the routing error state',async()=>{
  const f=fixture();await f.controller.ready;f.helloOutcomes.push(coded('NATIVE_UNAVAILABLE','helper missing'));
  const failed=await f.controller.handle({type:'CHECK_HELPER'});assert.equal(failed.ok,false);assert.equal(failed.state.setupErrorCode,'NATIVE_UNAVAILABLE');
  const recovered=await f.controller.handle({type:'CHECK_HELPER'});assert.equal(recovered.ok,true);assert.equal(recovered.state.helperAvailable,true);
  assert.equal(recovered.state.setupErrorCode,null);assert.equal(recovered.state.errorCode,null);assert.equal(recovered.state.status,'disabled');
  assert.equal(f.instances.every(instance=>instance.closed),true);assert.equal(connects(f).length,0);
});

test('cold NativeClient registration failure becomes NATIVE_UNAVAILABLE setup guidance',async()=>{
  const f=fixture({nativeClass:NativeClient});await f.controller.ready;const listeners={},sent=[];let closed=false;
  f.chrome.runtime.connectNative=name=>{
    assert.equal(name,'com.sshbrowser.helper');return {
      onMessage:{addListener(fn){listeners.message=fn;}},onDisconnect:{addListener(fn){listeners.disconnect=fn;}},
      postMessage(msg){sent.push(msg);},disconnect(){closed=true;},
    };
  };
  const probe=f.controller.handle({type:'CHECK_HELPER'});await turn();assert.equal(sent.length,1);assert.equal(sent[0].type,'hello');
  f.chrome.runtime.lastError={message:'Specified native messaging host not found.'};listeners.disconnect();
  const reply=await probe;f.chrome.runtime.lastError=null;
  assert.equal(reply.ok,false);assert.equal(reply.errorCode,'NATIVE_UNAVAILABLE');assert.match(reply.error,/native messaging host not found/);
  assert.equal(reply.state.helperAvailable,false);assert.equal(reply.state.setupErrorCode,'NATIVE_UNAVAILABLE');assert.equal(reply.state.status,'disabled');
  assert.equal(closed,true);assert.equal(f.clock.jobs.size,0);assert.equal(sent.some(msg=>msg.type==='connect'),false);
});

test('NativeClient preserves native error.code and ignores late replies after close',async()=>{
  const clock=fakeClock(),listeners={},sent=[],losses=[];
  const port={onMessage:{addListener(fn){listeners.message=fn;}},onDisconnect:{addListener(fn){listeners.disconnect=fn;}},postMessage(msg){sent.push(msg);},disconnect(){}};
  const chrome={runtime:{lastError:null,connectNative(){return port;}}};
  const client=new NativeClient(chrome,'profile',error=>losses.push(error),()=>{},clock);
  const pending=client.request('connect',{host:host('a')});const rejection=assert.rejects(pending,error=>error.code==='AUTH'&&error.message==='denied');
  listeners.message({requestId:sent[0].requestId,ok:false,error:{code:'AUTH',message:'denied'}});await rejection;assert.equal(clock.jobs.size,0);
  const late=client.request('status'),closed=assert.rejects(late);client.close();await closed;
  listeners.message({requestId:sent[1].requestId,ok:true,result:{status:'ready'}});listeners.disconnect();
  assert.equal(losses.length,0);assert.equal(clock.jobs.size,0);
});

for(const code of ['SSH_CONNECT','NETWORK'])test(`${code} retry failures use the full backoff budget`,async()=>{
  const f=fixture();await connected(f);await lose(f);f.connectOutcomes.push(...Array.from({length:3},()=>coded(code)));
  for(let attempt=1;attempt<=3;attempt++){
    await nextRetry(f);assert.equal(connects(f).length,1+attempt);blocked(f);
    assert.equal(f.controller.getState().status,attempt===3?'error':'reconnecting');
  }
  assert.equal(f.controller.getState().errorCode,'RETRY_EXHAUSTED');assert.equal(f.storage.reconnect.blocked,true);
});

test('NETWORK tunnel-exit reason is transient',async()=>{
  const f=fixture();await connected(f);f.native.exit('NETWORK',255);await settle();
  assert.equal(f.controller.getState().status,'reconnecting');assert.equal(f.controller.getState().errorCode,'NETWORK');blocked(f);
  await nextRetry(f);assert.equal(f.controller.getState().status,'connected');
});

test('native loss after a successful hello is not reported as a setup failure',async()=>{
  const f=fixture();await connected(f);await lose(f);
  const state=f.controller.getState();assert.equal(state.helperAvailable,true);assert.equal(state.setupErrorCode,null);
});

test('an SSH-level retry failure keeps the healthy helper and the verified blocker',async()=>{
  const f=fixture();await connected(f);await lose(f);f.connectOutcomes.push(coded('TIMEOUT'));
  await nextRetry(f);const helpers=f.instances.length,start=f.calls.length;
  assert.equal(f.native.closed,false);assert.equal(f.controller.getState().status,'reconnecting');blocked(f);
  await nextRetry(f);assert.equal(f.controller.getState().status,'connected');assert.equal(f.instances.length,helpers);
  assert.equal(f.calls.slice(start).filter(call=>call.type==='hello').length,0);
});

test('a failed LOCAL switch keeps automatic recovery for the live remote route',async()=>{
  const f=fixture();await connected(f);const set=f.chrome.proxy.settings.set;
  f.chrome.proxy.settings.set=(details,cb)=>{if(details.value.mode==='direct')throw Error('policy blocks DIRECT');set(details,cb);};
  const reply=await f.controller.handle({type:'LOCAL'});assert.equal(reply.ok,false);assert.equal(reply.state.desiredMode,'remote');
  f.chrome.proxy.settings.set=set;f.native.exit();await settle();
  assert.equal(f.controller.getState().status,'reconnecting');blocked(f);
  await nextRetry(f);assert.equal(f.controller.getState().status,'connected');
});

test('GET_STATE does not wait for an in-flight CONNECT',async()=>{
  const f=fixture();await f.controller.ready;const gate=deferred(),entered=deferred();
  f.connectOutcomes.push(async()=>{entered.resolve();await gate.promise;});
  const connecting=f.controller.handle({type:'CONNECT',id:'a'});await entered.promise;
  const reply=await f.controller.handle({type:'GET_STATE'});assert.equal(reply.ok,true);assert.equal(reply.state.status,'connecting');
  gate.resolve();assert.equal((await connecting).state.status,'connected');
});

test('NativeClient codes postMessage and intentional-close failures as NATIVE_LOST',async()=>{
  const port={onMessage:{addListener(){}},onDisconnect:{addListener(){}},postMessage(){throw new Error('Attempting to use a disconnected port object');},disconnect(){}};
  const chrome={runtime:{connectNative:()=>port,lastError:null}};
  const clock=fakeClock();const native=new NativeClient(chrome,'p',()=>{},()=>{},clock);
  await assert.rejects(native.request('hello'),{code:'NATIVE_LOST'});
  port.postMessage=()=>{};const pending=native.request('connect');native.close();
  await assert.rejects(pending,{code:'NATIVE_LOST'});
});

test('connect timing from the helper is kept only while connected',async()=>{
  const f=fixture();const state=await connected(f);assert.equal(state.connectionDurationMs,420);
  const reply=await f.controller.handle({type:'LOCAL'});assert.equal(reply.state.connectionDurationMs,null);
});

test('network restoration pulls the pending retry forward without extra budget',async()=>{
  const f=fixture();await connected(f);await lose(f,true);const due=f.storage.reconnect.nextRetryAt;
  f.native.network(true);await settle();assert.ok(f.storage.reconnect.nextRetryAt<due);
  await f.clock.advanceTo(f.clock.now());
  assert.equal(f.controller.getState().status,'connected');assert.equal(connects(f).length,2);assert.equal(f.storage.reconnect.attempt,1);
});

test('offline retries wait without consuming attempts and resume when the network returns',async()=>{
  const f=fixture();await connected(f);await lose(f,true);f.native.network(false);await settle();
  assert.equal(f.controller.getState().networkOnline,false);
  for(let i=0;i<3;i++){await nextRetry(f);assert.equal(connects(f).length,1);assert.equal(f.storage.reconnect.attempt,0);blocked(f);}
  assert.equal(f.controller.getState().status,'reconnecting');
  f.native.network(true);await settle();await f.clock.advanceTo(f.clock.now());
  assert.equal(f.controller.getState().status,'connected');assert.equal(f.storage.reconnect.attempt,1);
});

test('network changes while connected leave the route alone',async()=>{
  const f=fixture();const before=await connected(f);const start=f.calls.length;
  f.native.network(false);f.native.network(true);await settle();
  const state=f.controller.getState();assert.equal(state.status,'connected');assert.equal(state.tunnelId,before.tunnelId);
  assert.equal(f.calls.slice(start).filter(call=>call.type==='connect'||call.type.startsWith('proxy-')).length,0);
});

test('a lost helper forgets its offline report so normal backoff resumes',async()=>{
  const f=fixture();await connected(f);f.native.network(false);await settle();
  await lose(f);assert.equal(f.controller.getState().networkOnline,null);
  await nextRetry(f);assert.equal(f.controller.getState().status,'connected');assert.equal(connects(f).length,2);
});
