import { PREPARE_WORKDIR_JS } from '../src/workdir.js';
import { PREPARE_HANDDIR_JS } from '../src/directory-owner.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, rmdirSync, lstatSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SpawnerActions } from '../src/actions.js';
import { parseCommand } from '../src/commands.js';
import { HAND_PROCESSES_JS } from '../src/delete-hand.js';
import { LocalHost } from '../src/host.js';
import { Registry } from '../src/registry.js';
import { testConfig, tmp } from './helpers.js';

// Adapted from the reviewer's real-filesystem probes. Legacy fixtures strip
// attestations to model persisted pre-upgrade records, without old source imports.
function fixture() {
 const dir=tmp('rv-probe-'), config=testConfig(dir,{ownerUserId:1});
 mkdirSync(config.handsDir,{recursive:true}); mkdirSync(join(dir,'hands'));
 const registry=new Registry(join(dir,'registry.json')), local=new LocalHost();
 const host=new LocalHost();
 host.exec=async(cmd,args,opts)=>args[1]===HAND_PROCESSES_JS?{stdout:'false'}:local.exec(cmd,args,opts);
 const sessions=new Set<string>();
 const tmux={hasSession:async(s: string)=>sessions.has(s),killSession:async(s: string)=>sessions.delete(s)};
 const provisioner={ensure:async(_full: string,short: string)=>({bot:{userId:100,email:short+'@offline'},created:true}),subscribe:async()=>{},rename:async()=>{},deactivate:async()=>{},credsFor:()=>({email:'fake@offline',key:'fake',site:'https://offline'})};
 const launcher={launch:async(r: any)=>{sessions.add(r.tmuxSession); return {};}};
 const watcher={transcriptPath:(id: string)=>join(dir,'transcripts',id)};
 const actions=new SpawnerActions({config,registry,host,tmux,provisioner,launcher,watcher,notifier:{},groupCheck:async()=>false,realm:'offline'} as any);
 const run=async(body: string,topic='t')=>{const r=await actions.run({body,cmd:parseCommand(body),where:{kind:'stream',streamName:'cc-hands',streamId:7,topic},invoker:{kind:'user',userId:1,name:'Tester'}}); console.log(body+' => '+r.content);return r.content;};
 return {dir,config,registry,host,tmux,provisioner,actions,run};
}

for (const ready of [undefined, true]) test('legacy reaped records cannot infer either directory ownership: ' + ready, async () => {
 const f=fixture(); await f.run('spawn opus-5-5 name=old'); await f.run('stop old');
 const e=f.registry.all()[0];
 delete e.handDirIdentity; delete e.workDirIdentity;
 e.handDirReady=ready; e.workDirReady=ready; f.registry.save();
 for(const dir of [e.handDir,e.workDir!]) writeFileSync(join(dir,'precious'),'not yours');
 assert.match(await f.run('delete old confirm'),/kept: not created by this hand/);
 for(const dir of [e.handDir,e.workDir!]) assert.equal(readFileSync(join(dir,'precious'),'utf8'),'not yours');
});

test('legacy failed spawn before hand files: workspace readiness cannot attest handDir', async () => {
 const f=fixture(), foreign=join(f.config.handsDir,'cx-old');
 mkdirSync(foreign); writeFileSync(join(foreign,'precious'),'not yours');
 assert.match(await f.run('spawn gpt-5 name=old'),/failed/);
 const e=f.registry.all()[0]; assert.equal(e.workDirReady,true);
 delete e.handDirReady; delete e.handDirIdentity; delete e.workDirIdentity; f.registry.save();
 assert.deepEqual(readdirSync(foreign),['precious']);
 assert.match(await f.run('delete old confirm'),/kept: not created/);
 assert.equal(readFileSync(join(foreign,'precious'),'utf8'),'not yours');
});

test('upgrade rename revive rehome never attests existing legacy handDir', async () => {
 const f=fixture(); await f.run('spawn opus-5-5 name=old'); await f.run('stop old');
 const e=f.registry.all()[0]; delete e.handDirIdentity; delete e.workDirIdentity;
 delete e.handDirReady; f.registry.save();
 writeFileSync(join(e.handDir,'precious'),'not yours');
 await f.run('rename old Explorer');
 assert.match(await f.run('spawn opus-5-5 name=Explorer','rehome'),/Refusing to adopt/);
 // A legacy hand without a workspace can still revive; existing handDir must
 // remain explicitly unattested through successful revival and rehome too.
 for(const record of f.registry.all()) { delete record.workDir; delete record.workDirReady; }
 f.registry.save();
 assert.match(await f.run('spawn opus-5-5 name=Explorer','rehome'),/Spawned/);
 const revived=f.registry.all().at(-1)!;
 assert.equal(revived.handDirReady,false); assert.equal(revived.handDirIdentity,undefined);
 assert.equal(revived.topic,'rehome');
 await f.run('stop Explorer'); assert.match(await f.run('delete Explorer confirm'),/kept: not created/);
 assert.equal(readFileSync(join(e.handDir,'precious'),'utf8'),'not yours');
});

for(const kind of ['workDir','handDir'] as const) for(const revive of [false,true])
test('move aside and replace '+kind+', revival='+revive, async () => {
 const f=fixture(); await f.run('spawn opus-5-5 name=scout'); await f.run('stop scout');
 const first=f.registry.all()[0], original=first[kind]!;
 writeFileSync(join(original,'precious'),'original');
 renameSync(original,original+'.retired'); mkdirSync(original);
 writeFileSync(join(original,'precious'),'foreign replacement');
 await f.run('rename scout Explorer');
 if(revive) {
   assert.match(await f.run('spawn opus-5-5 name=Explorer','new-home'),kind==='workDir'?/Refusing to adopt/:/Spawned/);
   const current=f.registry.all().at(-1)!;
   assert.equal(Boolean(current[kind==='workDir'?'workDirReady':'handDirReady']),false);
   await f.run('stop Explorer');
 }
 assert.match(await f.run('delete Explorer confirm'),/kept: not created/);
 assert.equal(readFileSync(join(original,'precious'),'utf8'),'foreign replacement');
 assert.equal(readFileSync(join(original+'.retired','precious'),'utf8'),'original');
});


for (const kind of ['workDir', 'handDir'] as const) test('creation swap never attests pre-existing precious: ' + kind, async () => {
 const f=fixture(), root=kind==='handDir'?f.config.handsDir:join(f.dir,'hands');
 const p=join(root,'cc-scout'), foreign=join(root,'preexisting-foreign');
 mkdirSync(foreign); writeFileSync(join(foreign,'precious'),'foreign');
 const exec=f.host.exec.bind(f.host); let injected=false;
 f.host.exec=async(cmd,args,opts)=>{
  if (!injected && args[1]===(kind==='workDir'?PREPARE_WORKDIR_JS:PREPARE_HANDDIR_JS)) {
   injected=true;
   const hook=`const C=require('node:child_process'), F=require('node:fs'), move=C.execFileSync;C.execFileSync=function(...args){F.renameSync(${JSON.stringify(foreign)},${JSON.stringify(p)});return move.apply(this,args);};\n`;
   return exec(cmd,['-e',hook+args[1],...args.slice(2)],opts);
  }
  return exec(cmd,args,opts);
 };
 assert.match(await f.run('spawn opus-5-5 name=scout'),/failed/);
 assert.ok(injected);
 const e=f.registry.all()[0];
 assert.equal(e[kind==='handDir'?'handDirIdentity':'workDirIdentity'],undefined);
 assert.equal(existsSync(join(root,'.cc-spawner-staging')),true);
 assert.deepEqual(readdirSync(join(root,'.cc-spawner-staging')),[]);
 assert.match(await f.run('delete scout confirm'),/kept: not created/);
 assert.equal(readFileSync(join(p,'precious'),'utf8'),'foreign');
 assert.equal(existsSync(join(p,'.cc-spawner-owner')),false);
});

for (const kind of ['workDir', 'handDir'] as const) test('inode reuse cannot authorize precious without nonce: ' + kind, async (t) => {
 const f=fixture(); await f.run('spawn opus-5-5 name=scout'); await f.run('stop scout');
 const e=f.registry.all()[0], p=e[kind]!, key=kind==='handDir'?'handDirIdentity':'workDirIdentity', id=e[key]!;
 rmSync(p,{recursive:true});
 let reused=false;
 for(let i=0;i<2000;i++) {
  mkdirSync(p); const st=lstatSync(p);
  if(st.ino===id.ino && st.dev===id.dev) { reused=true; break; }
  rmdirSync(p);
 }
 if(!existsSync(p)) mkdirSync(p);
 if(!reused) {
  // Deterministic collision model on filesystems whose allocator avoids reuse.
  const {dev,ino}=lstatSync(p); f.registry.update(e,{[key]:{...id,dev,ino}});
 }
 t.diagnostic(reused?'real inode reuse':'allocator did not reuse; modeled dev/ino collision');
 writeFileSync(join(p,'precious'),'foreign');
 assert.match(await f.run('delete scout confirm'),/kept: not created/);
 assert.equal(readFileSync(join(p,'precious'),'utf8'),'foreign');
});

for (const kind of ['workDir', 'handDir'] as const) for(const marker of ['missing','wrong'])
test('revival and cleanup require marker: '+kind+' '+marker, async () => {
 const f=fixture(); await f.run('spawn opus-5-5 name=scout'); await f.run('stop scout');
 const e=f.registry.all()[0], p=e[kind]!;
 if(marker==='missing') rmSync(join(p,'.cc-spawner-owner'));
 else writeFileSync(join(p,'.cc-spawner-owner'),'0'.repeat(64));
 writeFileSync(join(p,'precious'),'foreign');
 assert.match(await f.run('spawn opus-5-5 name=scout'),kind==='workDir'?/Refusing to adopt/:/Spawned/);
 await f.run('stop scout');
 assert.match(await f.run('delete scout confirm'),/kept: not created/);
 assert.equal(readFileSync(join(p,'precious'),'utf8'),'foreign');
});

test('marker leaves workspace usable and ordinary lifecycle deletes both folders', async () => {
 const f=fixture(); assert.match(await f.run('spawn opus-5-5 name=scout'),/Spawned/);
 const e=f.registry.all()[0];
 for(const p of [e.workDir!,e.handDir]) assert.match(readFileSync(join(p,'.cc-spawner-owner'),'utf8'),/^[a-f0-9]{64}$/);
 writeFileSync(join(e.workDir!,'project.txt'),'normal workspace use');
 await f.run('stop scout'); assert.match(await f.run('spawn opus-5-5 name=scout'),/Spawned|Revived/);
 assert.equal(readFileSync(join(e.workDir!,'project.txt'),'utf8'),'normal workspace use');
 await f.run('stop scout'); assert.match(await f.run('delete scout confirm'),/Deleted/);
 assert.equal(existsSync(e.workDir!),false); assert.equal(existsSync(e.handDir),false);
});

// Real empty foreign folders and pre-existing files, not forged identity/nonce.
// The former mkdir-at-final gap is now a competing arrival during private mkdir.
for (const kind of ['workDir','handDir'] as const)
for (const arrival of ['after-spawn','after-empty-check'] as const)
test('empty replacement preserves preexisting-precious: '+kind+' '+arrival, async () => {
 const f=fixture(), root=kind==='handDir'?f.config.handsDir:join(f.dir,'hands');
 const p=join(root,'cc-scout'), foreign=join(root,'preexisting-empty');
 mkdirSync(foreign);
 const held=openSync(foreign,'r'), original=lstatSync(foreign);
 const source=join(root,'preexisting-precious'); writeFileSync(source,'foreign before spawn');
 const exec=f.host.exec.bind(f.host); let injected=false;
 f.host.exec=async(cmd,args,opts)=>{
  if (!injected && args[1]===(kind==='workDir'?PREPARE_WORKDIR_JS:PREPARE_HANDDIR_JS)) {
   injected=true;
   const hook=`const F=require('node:fs'), mkdir=F.mkdirSync, read=F.readdirSync;
let staged;
F.mkdirSync=function(x,...rest){const result=mkdir.call(this,x,...rest);
 if(typeof x==='string' && /^\\/proc\\/self\\/fd\\/\\d+\\/[a-f0-9]{64}$/.test(x)) {
  staged=F.realpathSync(x);F.renameSync(${JSON.stringify(foreign)},${JSON.stringify(p)});
 }return result;};
F.readdirSync=function(x,...rest){const result=read.call(this,x,...rest);
 if(${JSON.stringify(arrival)}==='after-empty-check' && staged && F.realpathSync(x)===staged && result.length===0)
  F.renameSync(${JSON.stringify(source)},${JSON.stringify(join(p,'preexisting-precious'))});
 return result;};\n`;
   return exec(cmd,['-e',hook+args[1],...args.slice(2)],opts);
  }
  return exec(cmd,args,opts);
 };
 try {
  assert.match(await f.run('spawn opus-5-5 name=scout'),/failed/); assert.ok(injected);
  assert.equal(lstatSync(p).ino,original.ino);
  assert.equal(f.registry.all()[0][kind==='workDir'?'workDirIdentity':'handDirIdentity'],undefined);
  assert.equal(existsSync(join(p,'.cc-spawner-owner')),false);
  if(arrival==='after-spawn') renameSync(source,'/proc/self/fd/'+held+'/preexisting-precious');
  await f.run('stop scout'); await f.run('delete scout confirm');
  assert.equal(readFileSync(join(p,'preexisting-precious'),'utf8'),'foreign before spawn');
  assert.deepEqual(readdirSync(join(root,'.cc-spawner-staging')),[]);
 } finally { closeSync(held); }
});

for (const kind of ['workDir','handDir'] as const)
for (const failure of ['helper','post-move-swap','staging-mode','staging-device'] as const)
test('private publication fails closed: '+kind+' '+failure, () => {
 const root=tmp('staging-failure-'), p=join(root,'new-hand');
 const stage=join(root,'.cc-spawner-staging');
 if(failure==='staging-mode') mkdirSync(stage,{mode:0o755});
 const hook=failure==='helper' ?
  `require('node:child_process').execFileSync=function(){throw Error('helper unavailable');};` :
 failure==='post-move-swap' ?
  `const C=require('node:child_process'), F=require('node:fs'), move=C.execFileSync;
C.execFileSync=function(...args){const result=move.apply(this,args);F.renameSync(${JSON.stringify(p)},${JSON.stringify(p+'.retired')});F.mkdirSync(${JSON.stringify(p)});F.writeFileSync(${JSON.stringify(join(p,'preexisting-precious'))},'foreign');return result;};` :
 failure==='staging-device' ?
  `const F=require('node:fs'), stat=F.fstatSync;F.fstatSync=function(fd){const result=stat.call(this,fd);if(F.realpathSync('/proc/self/fd/'+fd)===${JSON.stringify(stage)})result.dev++;return result;};` : '';
 const args=kind==='workDir' ? [PREPARE_WORKDIR_JS,p,join(root,'claude.json'),'yes','no-trust','null'] : [PREPARE_HANDDIR_JS,p,'null'];
 assert.throws(()=>execFileSync(process.execPath,['-e',hook+args[0],...args.slice(1)],{stdio:'pipe'}));
 assert.deepEqual(readdirSync(stage),[]);
 if(failure==='post-move-swap') {
  assert.equal(readFileSync(join(p,'preexisting-precious'),'utf8'),'foreign');
  assert.equal(existsSync(join(p,'.cc-spawner-owner')),false);
 } else assert.equal(existsSync(p),false);
});
