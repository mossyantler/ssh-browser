import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const arch=process.arch==='arm64'?'arm64':'amd64';
const binary=path.join(root,'bin','ssh-browser-helper-darwin-'+arch);
// Opt-in only: unsigned native execution may be blocked by Gatekeeper.
const supportedMac=process.platform==='darwin'&&fs.existsSync(binary);
const supported=process.env.SSH_BROWSER_NATIVE_TESTS==='1'&&supportedMac;
function frame(obj){const b=Buffer.from(JSON.stringify(obj));const h=Buffer.alloc(4);if(os.endianness()==='LE')h.writeUInt32LE(b.length);else h.writeUInt32BE(b.length);return Buffer.concat([h,b]);}
function run(messages,{chunked=false}={}){return new Promise((resolve,reject)=>{const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});let bytes=Buffer.alloc(0),err='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('native smoke timeout'));},5000);child.stdout.on('data',d=>bytes=Buffer.concat([bytes,d]));child.stderr.on('data',d=>err+=d.toString());child.on('error',reject);child.on('close',code=>{clearTimeout(timer);const replies=[];while(bytes.length){assert.ok(bytes.length>=4,'stdout has no unframed text');const n=os.endianness()==='LE'?bytes.readUInt32LE(0):bytes.readUInt32BE(0);assert.ok(n<1048576&&bytes.length>=4+n);replies.push(JSON.parse(bytes.subarray(4,4+n)));bytes=bytes.subarray(4+n);}resolve({code,replies,err});});for(const message of messages){const b=frame(message);if(chunked){for(let i=0;i<b.length;i++)child.stdin.write(b.subarray(i,i+1));}else child.stdin.write(b);}child.stdin.end();});}
test('native hello, status and disconnect with fragmented input',{skip:!supported},async()=>{const out=await run([{type:'hello',requestId:'1',profileId:'test-profile',protocol:1},{type:'status',requestId:'2'},{type:'disconnect',requestId:'3'}],{chunked:true});assert.equal(out.code,0);for(const id of ['1','2','3'])assert.equal(out.replies.find(r=>r.requestId===id)?.ok,true);assert.equal(out.replies.find(r=>r.requestId==='1').result.protocol,1);assert.deepEqual(out.replies.find(r=>r.requestId==='2').result.tunnels,[]);});
test('native rejects malicious host without launching SSH',{skip:!supported},async()=>{const out=await run([{type:'hello',requestId:'1',profileId:'test-profile',protocol:1},{type:'connect',requestId:'2',host:{id:'evil',name:'Invalid',mode:'alias',alias:'-oProxyCommand=touch /tmp/nope'}}]);assert.equal(out.replies.find(r=>r.requestId==='2')?.ok,false);});
// Installation tests use fake binaries and temporary HOME in install-macos.mjs.
