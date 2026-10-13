import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../extension/core.js',import.meta.url),'utf8');
const {createController,socksConfig,validateHost,NativeClient}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const host=id=>({id,name:id,mode:'manual',address:'example.org',port:22,user:'dev',favorite:false,group:'',keyPath:''});
function fixture(saved={},controllerOptions={}) {
  const storage={hosts:[host('a'),host('b')],...saved}, calls=[], changes=[], live=new Set();
  let value={mode:'system'}, underlying={mode:'pac_script',pacScript:{url:'https://proxy.example/pac'}}, level='controllable_by_this_extension', instance, failure=false, waiting=null;
  const chrome={runtime:{lastError:null,sendMessage:async()=>{}},storage:{local:{
    get(keys,cb){cb(structuredClone(storage));},set(data,cb){Object.assign(storage,structuredClone(data));calls.push(['persist',data.desiredMode,data.currentPort,structuredClone(data)]);cb();}
  }},proxy:{settings:{
    set(details,cb){calls.push(['set',structuredClone(details)]);value=details.value;level='controlled_by_this_extension';for(const listener of changes)listener({value,levelOfControl:level});cb();},
    clear(details,cb){calls.push(['clear',details]);value=underlying;level='controllable_by_this_extension';cb();},
    get(details,cb){calls.push(['get',details]);cb({value,levelOfControl:level});},
    onChange:{addListener(fn){changes.push(fn);}}
  }}};
  class NativeMock {
    constructor(chrome,profileId,onLost,onEvent){this.closed=false;this.onLost=onLost;this.onEvent=onEvent;instance=this;calls.push(['native',profileId]);}
    async request(type,data){calls.push([type,structuredClone(data)]);if(type==='hello')return {protocol:1,version:'test'};
      if(type==='connect'){if(waiting)await waiting;if(failure)throw Error('connect failed');live.add('t-'+data.host.id);return {tunnelId:`t-${data.host.id}`,hostId:data.host.id,status:'ready',port:data.host.id==='a'?40101:40102};}
      if(type==='release')live.delete(data.tunnelId);
      if(type==='disconnect')live.clear();
      return {};
    }
    close(){this.closed=true;live.clear();calls.push(['close']);}
    crash(){live.clear();this.closed=true;this.onLost(Error('crash'));}
    exit(id){live.delete('t-'+id);this.onEvent({event:'tunnel-exit',tunnelId:`t-${id}`,reason:'SSH exited'});}
  }
  // Existing lifecycle tests must never leave real reconnect timers running.
  const timers={setTimeout(){return 1;},clearTimeout(){}};
  const controller=createController(chrome,{NativeClient:NativeMock,uuid:()=> 'profile-test',timers,now:()=>1700000000000,...controllerOptions});
  return {controller,storage,calls,chrome,live,get value(){return value;},get native(){return instance;},fail(){failure=true;},wait(promise){waiting=promise;},override(){level='controlled_by_other_extensions';value={mode:'direct'};for(const fn of changes)fn({value,levelOfControl:level});}};
}
test('SOCKS routes localhost too; regular scope and exactly one verification',async()=>{
  const f=fixture();await f.controller.ready;f.calls.length=0;
  const reply=await f.controller.handle({type:'CONNECT',id:'a'});
  assert.equal(reply.ok,true);assert.equal(reply.state.status,'connected');
  assert.deepEqual(f.value,socksConfig(40101));assert.deepEqual(f.value.rules.bypassList,['<-loopback>']);
  assert.equal(f.calls.filter(c=>c[0]==='get').length,1);
  assert.equal(f.calls.find(c=>c[0]==='set')[1].scope,'regular');
  assert.equal(f.storage.desiredMode,'remote');assert.equal(f.storage.currentPort,40101);assert.equal(f.storage.selectedHostId,'a');
});
test('failed switch preserves old live tunnel and proxy',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});f.calls.length=0;f.fail();
  const reply=await f.controller.handle({type:'CONNECT',id:'b'});
  assert.equal(reply.ok,false);assert.equal(reply.state.status,'connected');assert.equal(reply.state.activeHostId,'a');assert.equal(f.value.rules.singleProxy.port,40101);
  assert.equal(f.calls.some(c=>c[0]==='release'),false);
});
test('unexpected native crash installs blocker and reports reconnecting',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});f.calls.length=0;f.native.crash();
  const reply=await f.controller.handle({type:'GET_STATE'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.controller.getState().status,'reconnecting');assert.equal(reply.state.desiredMode,'remote');assert.deepEqual(f.value,socksConfig(9));
  assert.equal(f.calls.some(c=>c[0]==='clear'),false);
});
test('switch persists new route before releasing prior tunnel',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});f.calls.length=0;
  await f.controller.handle({type:'CONNECT',id:'b'});
  const release=f.calls.findIndex(c=>c[0]==='release');assert.ok(release>f.calls.findIndex(c=>c[0]==='set'));assert.ok(release>f.calls.findIndex(c=>c[0]==='persist'));
  assert.equal(f.calls[release][1].tunnelId,'t-a');assert.equal(f.value.rules.singleProxy.port,40102);
});
test('LOCAL explicitly direct; STOP restores underlying settings, not direct',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});
  const local=await f.controller.handle({type:'LOCAL'});assert.equal(local.state.status,'local');assert.deepEqual(f.value,{mode:'direct'});assert.equal(f.native.closed,true);
  const stopped=await f.controller.handle({type:'STOP'});assert.equal(stopped.state.status,'disabled');assert.equal(f.value.mode,'pac_script');assert.equal(stopped.state.proxyControlled,false);
});
test('concurrent CONNECT and LOCAL execute serially',async()=>{
  const f=fixture();await f.controller.ready;let resume;f.wait(new Promise(resolve=>resume=resolve));
  const first=f.controller.handle({type:'CONNECT',id:'a'});const second=f.controller.handle({type:'LOCAL'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.controller.getState().status,'connecting');resume();
  assert.equal((await first).ok,true);assert.equal((await second).state.status,'local');
  assert.ok(f.calls.findIndex(c=>c[0]==='connect')<f.calls.findIndex(c=>c[0]==='disconnect'));assert.equal(f.value.mode,'direct');
});
test('remote restart stays blocked without helper; never trusts saved connected',async()=>{
  const f=fixture({desiredMode:'remote',selectedHostId:'a',currentPort:40101,controllerState:{status:'connected'}});await f.controller.ready;
  const state=(await f.controller.handle({type:'GET_STATE'})).state;assert.equal(state.status,'reconnecting');assert.equal(state.activeHostId,null);assert.deepEqual(f.value,socksConfig(9));assert.equal(f.calls.some(c=>c[0]==='native'),false);
});
test('GET_STATE does not start helper for local or disabled',async()=>{
  for(const desiredMode of ['local','disabled']){const f=fixture({desiredMode});await f.controller.handle({type:'GET_STATE'});assert.equal(f.calls.some(c=>c[0]==='native'),false);}
});
test('external extension proxy control is detected without false connected',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});f.override();
  const state=(await f.controller.handle({type:'GET_STATE'})).state;assert.equal(state.status,'error');assert.equal(state.proxyControlled,false);assert.match(state.error,/controlled_by_other_extensions/);
});
test('host import is validated atomically and IDs survive; active deletion rejected',async()=>{
  const f=fixture();await f.controller.ready;
  assert.equal((await f.controller.handle({type:'IMPORT',hosts:[host('c'),{...host('d'),address:'-oProxyCommand=evil'}]})).ok,false);
  assert.equal(f.controller.getState().hosts.length,2);
  await f.controller.handle({type:'IMPORT',hosts:[host('a'),host('c')]});assert.deepEqual(f.controller.getState().hosts.map(h=>h.id),['a','b','c']);
  await f.controller.handle({type:'CONNECT',id:'a'});assert.equal((await f.controller.handle({type:'DELETE_HOST',id:'a'})).ok,false);
});
test('validation rejects options, controls, relative key paths and invalid ports',()=>{
  for(const extra of [{address:'-evil'},{user:'-root'},{name:'x\ny'},{keyPath:'relative/key'},{port:0},{port:1.5}])assert.throws(()=>validateHost({...host('x'),...extra}));
  assert.equal(validateHost({...host('x'),address:'::1'}).address,'::1');
});
test('native messages correlate out of order and timeout is bounded',async()=>{
  const listeners={},sent=[],timers=[];
  const port={onMessage:{addListener(fn){listeners.message=fn;}},onDisconnect:{addListener(fn){listeners.disconnect=fn;}},postMessage(msg){sent.push(msg);},disconnect(){}};
  const clock={setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},clearTimeout(){}};
  const chrome={runtime:{connectNative(name){assert.equal(name,'com.sshbrowser.helper');return port;}}};
  const client=new NativeClient(chrome,'profile',()=>{},()=>{},clock);
  const a=client.request('status'),b=client.request('status');listeners.message({requestId:sent[1].requestId,ok:true,result:{b:true}});listeners.message({requestId:sent[0].requestId,ok:true,result:{a:true}});
  assert.deepEqual(await a,{a:true});assert.deepEqual(await b,{b:true});
  const timeout=client.request('status',{},90000);assert.ok(timers.at(-1).ms<=30000);timers.at(-1).fn();await assert.rejects(timeout,/시간 초과/);client.close();
});
test('corrupt saved host cannot prevent startup blocking; stale port never reused',async()=>{
  const f=fixture({desiredMode:'remote',currentPort:40101,hosts:[{bad:true}]});await f.controller.ready;
  assert.equal(f.value.rules.singleProxy.port,9);assert.equal(f.storage.currentPort,9);assert.equal(f.controller.getState().status,'error');
});
test('tunnel exit installs blocker and does not imply direct mode',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});f.native.exit('a');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.controller.getState().status,'reconnecting');assert.equal(f.value.rules.singleProxy.port,9);assert.equal(f.controller.getState().desiredMode,'remote');
});
test('same-host connected selection is a no-op, not another SSH process',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});f.calls.length=0;
  await f.controller.handle({type:'CONNECT',id:'a'});assert.equal(f.calls.some(c=>c[0]==='connect'),false);
});
test('old tunnel exiting during failed switch cannot be reported connected',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});let resume;f.wait(new Promise(resolve=>resume=resolve));f.fail();
  const switching=f.controller.handle({type:'CONNECT',id:'b'});await new Promise(resolve=>setImmediate(resolve));f.native.exit('a');resume();
  const reply=await switching;assert.equal(reply.ok,false);assert.equal(reply.state.status,'error');assert.equal(reply.state.activeHostId,null);assert.equal(f.value.rules.singleProxy.port,9);
});

test('write-ahead marker is durable before first SOCKS side effect and removed on commit',async()=>{
  for(const desiredMode of ['local','disabled']) {
    const f=fixture({desiredMode});await f.controller.ready;
    const set=f.chrome.proxy.settings.set;let crashStorage;
    f.chrome.proxy.settings.set=(details,cb)=>{
      if(details.value.mode==='fixed_servers'){
        assert.equal(f.storage.desiredMode,desiredMode);
        assert.deepEqual(f.storage.pendingRemote,{hostId:'a',tunnelId:'t-a',port:40101});
        crashStorage=structuredClone(f.storage);
      }
      set(details,cb);
    };
    assert.equal((await f.controller.handle({type:'CONNECT',id:'a'})).ok,true);
    assert.equal(f.storage.pendingRemote,null);assert.equal(f.storage.desiredMode,'remote');
    const recovered=fixture(crashStorage);await recovered.controller.ready;
    assert.deepEqual(recovered.value,socksConfig(9));assert.equal(recovered.storage.currentPort,9);
    assert.equal(recovered.storage.desiredMode,'remote');assert.equal(recovered.controller.getState().status,'error');
    assert.equal(recovered.controller.getState().activeHostId,null);assert.ok(recovered.storage.pendingRemote);
    assert.equal(recovered.calls.some(c=>c[0]==='clear'||c[0]==='native'||(c[0]==='set'&&c[1].value.mode==='direct')),false);
  }
});
test('pending-marker storage failure prevents all candidate proxy side effects',async()=>{
  const f=fixture({desiredMode:'local'});await f.controller.ready;f.calls.length=0;
  const set=f.chrome.storage.local.set;f.chrome.storage.local.set=(data,cb)=>{if(data.pendingRemote)throw Error('disk failed');set(data,cb);};
  const reply=await f.controller.handle({type:'CONNECT',id:'a'});
  assert.equal(reply.ok,false);assert.equal(f.value.mode,'direct');assert.equal(f.live.size,0);
  assert.equal(f.calls.some(c=>c[0]==='set'),false);assert.equal(f.storage.pendingRemote,null);
});
function failVerificationAndRollback(f) {
  const set=f.chrome.proxy.settings.set;
  f.chrome.proxy.settings.set=(details,cb)=>{if(details.value.rules?.singleProxy.port===40101)throw Error('rollback blocked');set(details,cb);};
  f.chrome.proxy.settings.get=(details,cb)=>cb({value:f.value,levelOfControl:'controlled_by_other_extensions'});
}
test('failed verification and rollback retain candidate identity, release it, and stay uncertain',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});f.calls.length=0;failVerificationAndRollback(f);
  const reply=await f.controller.handle({type:'CONNECT',id:'b'});
  assert.equal(reply.ok,false);assert.equal(reply.state.status,'error');assert.equal(reply.state.activeHostId,null);
  assert.equal(reply.state.proxyControlled,false);assert.equal(reply.state.currentPort,40102);
  assert.deepEqual(reply.state.pendingRemote,{hostId:'b',tunnelId:'t-b',port:40102});
  assert.match(reply.state.error,/복구 실패/);assert.equal(f.storage.pendingRemote.tunnelId,'t-b');
  assert.equal(f.value.rules.singleProxy.port,40102);assert.equal(f.live.has('t-b'),false);assert.equal(f.live.has('t-a'),true);
  assert.ok(f.calls.some(c=>c[0]==='release'&&c[1].tunnelId==='t-b'));
  const recovered=fixture(structuredClone(f.storage));await recovered.controller.ready;assert.deepEqual(recovered.value,socksConfig(9));
});
test('candidate cleanup still runs if uncertain-state persistence fails',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});failVerificationAndRollback(f);
  const set=f.chrome.storage.local.set;f.chrome.storage.local.set=(data,cb)=>{if(data.pendingRemote&&data.controllerState.status==='error')throw Error('persist failed');set(data,cb);};
  assert.equal((await f.controller.handle({type:'CONNECT',id:'b'})).ok,false);
  assert.equal(f.live.has('t-b'),false);assert.equal(f.storage.pendingRemote.tunnelId,'t-b');assert.equal(f.controller.getState().status,'error');
});
test('unacknowledged candidate release closes native port, leaving no live leaked proxy',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});failVerificationAndRollback(f);
  const request=f.native.request.bind(f.native);f.native.request=async(type,data)=>{if(type==='release')throw Error('release timeout');return request(type,data);};
  const reply=await f.controller.handle({type:'CONNECT',id:'b'});
  assert.equal(reply.ok,false);assert.equal(reply.state.status,'error');assert.equal(reply.state.activeHostId,null);
  assert.equal(f.native.closed,true);assert.equal(f.live.size,0);assert.equal(f.storage.pendingRemote.tunnelId,'t-b');
});
test('verified rollback clears only the new marker and preserves old live tunnel',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});
  const get=f.chrome.proxy.settings.get;let first=true;
  f.chrome.proxy.settings.get=(details,cb)=>{if(first){first=false;cb({value:f.value,levelOfControl:'controlled_by_other_extensions'});}else get(details,cb);};
  const reply=await f.controller.handle({type:'CONNECT',id:'b'});
  assert.equal(reply.ok,false);assert.equal(reply.state.status,'connected');assert.equal(reply.state.activeHostId,'a');
  assert.equal(f.storage.pendingRemote,null);assert.deepEqual(f.value,socksConfig(40101));assert.deepEqual([...f.live],['t-a']);
});
test('candidate exit during commit returns failure, not a stale connected reply',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});
  const set=f.chrome.storage.local.set;let exited=false;
  f.chrome.storage.local.set=(data,cb)=>{
    if(!exited && data.selectedHostId==='b' && data.controllerState.status==='connected' && data.pendingRemote===null){exited=true;f.native.exit('b');}
    set(data,cb);
  };
  const reply=await f.controller.handle({type:'CONNECT',id:'b'});
  assert.equal(reply.ok,false);assert.equal(reply.state.status,'error');assert.equal(reply.state.activeHostId,null);
  assert.deepEqual(f.value,socksConfig(9));assert.equal(f.live.has('t-b'),false);assert.equal(f.storage.desiredMode,'remote');
});
test('candidate exit during old release never restores the now-dead old tunnel',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});f.calls.length=0;
  const request=f.native.request.bind(f.native);
  f.native.request=async(type,data)=>{const result=await request(type,data);if(type==='release'&&data.tunnelId==='t-a')f.native.exit('b');return result;};
  const reply=await f.controller.handle({type:'CONNECT',id:'b'});
  assert.equal(reply.ok,false);assert.equal(reply.state.status,'error');assert.equal(reply.state.activeHostId,null);assert.equal(f.live.size,0);
  assert.deepEqual(f.value,socksConfig(9));assert.equal(f.calls.some(c=>c[0]==='set'&&c[1].value.rules?.singleProxy.port===40101),false);
});
test('old tunnel exit during new commit does not invalidate the live candidate',async()=>{
  const f=fixture();await f.controller.handle({type:'CONNECT',id:'a'});
  const set=f.chrome.storage.local.set;f.chrome.storage.local.set=(data,cb)=>{if(data.selectedHostId==='b'&&data.controllerState.status==='connected')f.native.exit('a');set(data,cb);};
  const reply=await f.controller.handle({type:'CONNECT',id:'b'});assert.equal(reply.ok,true);assert.equal(reply.state.status,'connected');assert.equal(reply.state.activeHostId,'b');assert.deepEqual([...f.live],['t-b']);
});
test('parent onState hook and empty manual SSH user support are preserved',async()=>{
  const states=[];const f=fixture({}, {onState:state=>states.push(state)});
  assert.equal(validateHost({...host('x'),user:''}).user,'');await f.controller.handle({type:'CONNECT',id:'a'});
  assert.ok(states.some(state=>state.status==='connected'));
});
