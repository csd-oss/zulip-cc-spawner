import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
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
