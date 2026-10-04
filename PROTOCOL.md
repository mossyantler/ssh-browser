# SSH Browser development protocol v1

Native host: com.sshbrowser.helper. Messages are UTF-8 JSON with native-endian uint32 framing. requestId correlates replies. Replies: {requestId,ok:true,result:{...}} or {requestId,ok:false,error:{code,message}}. No secrets in messages or logs.

Host: {id,name,group,favorite,mode:'alias'|'manual',alias,address,port:22,user,keyPath:''}. For alias use existing SSH config. Manual uses optional absolute keyPath. No password or key data.

Native requests: hello {protocol:1,profileId}, connect {host}, release {tunnelId}, disconnect {}, status {}. hello returns {version:'0.1.0',protocol:1}. connect starts new tunnel without stopping existing one; returns {tunnelId,hostId,port,status:'ready'}. release stops one tunnel. disconnect stops all. status returns {tunnels:[{tunnelId,hostId,port,status}]}. Event: {event:'tunnel-exit',tunnelId,hostId,reason,code}. EOF cleans all owned SSH child process groups.

Extension UI messages: {type:'GET_STATE'}, {type:'SAVE_HOST',host}, {type:'DELETE_HOST',id}, {type:'CONNECT',id}, {type:'LOCAL'}, {type:'STOP'}, {type:'IMPORT',hosts}. UI replies: {ok:true,state} or {ok:false,error:string,state?}. CONNECT/LOCAL/STOP must serialize.

State: {hosts:[],profileId,status:'local'|'connecting'|'connected'|'error'|'disabled',activeHostId:null,error:null,helperVersion:null,proxyControlled:false}. local means explicit direct mode. disabled means extension proxy override cleared; underlying OS/policy/other-extension setting applies. storage.local persists hosts/profileId/desiredMode/selectedHostId; no sync. On restart desired remote must NOT silently go DIRECT; reconnect with bounded attempts or remain blocked. Native port held by service worker, not popup.

UI normal extension uses chrome.runtime.sendMessage; preview uses localStorage and is visibly labelled UI preview, no real SSH. No fabricated live-connection claims. Default preview no hosts. Popup rapid select; options host CRUD/group/search/favorite + selected status. Korean interface. Permissions: storage,proxy,nativeMessaging,alarms only as used. incognito:not_allowed. No host_permissions or content scripts.

## Crash-safe switching (implemented)

Before any candidate SOCKS proxy change, persist pendingRemote:{hostId,tunnelId,port}. Startup treats any valid marker as remote-required even if the previous desiredMode was local/disabled, and installs SOCKS 127.0.0.1:9 as a blocker. Commit desiredMode/selectedHostId/currentPort and marker removal in one storage write. A failed rollback retains uncertain candidate metadata and cleanup always releases the candidate or closes the native port; never report old/connected without a confirmed live route. No automatic reconnection in v0.1.

Native helper disables OpenSSH master multiplexing (-S none, ControlMaster=no, ControlPersist=no) and ForkAfterAuthentication so it owns the tunnel process. Explicit LOCAL means DIRECT; STOP clears our override only. Toolbar badges: SSH / LOC / ! / connecting indicator, with current host in action title. Host deletion uses a DOM dialog, not a system confirm box.
