import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {installRequestPolicy} from '../src/pi-session.mjs';

async function fixture(t,factory=async()=>({prompt:async()=>{},abort:async()=>{},dispose(){}})){
 const dir=await mkdtemp(join(tmpdir(),'roundtable-test-')),store=new Store(dir);
 store.state.profiles.push({id:'p',name:'test',authMode:'none',baseUrl:'http://127.0.0.1',requestGapMs:0});
 store.state.models.push({id:'m',profileId:'p',name:'test',modelId:'test',enabled:true,contextWindow:32000,maxTokens:64});
 store.state.agents.push(...['a','b'].map(id=>({id,name:id,role:'test',defaultModelId:'m',canWrite:true})));
 const room=store.createRoom('test',['a','b']),engine=new Engine(store,dir,()=>{},undefined,factory);
 t.after(async()=>{await engine.close();store.close();await rm(dir,{recursive:true,force:true})});
 return {store,room,engine,dir};
}
async function settled(engine){for(let i=0;i<100;i++){if(!engine.active.size)return;await new Promise(r=>setTimeout(r,5));}throw Error('engine did not settle');}
test('duplicate and concurrent tool calls produce one durable artifact',async t=>{
 const {store,room,engine}=await fixture(t);room.status='running';
 const run={tools:0,cancelled:false},tool=engine.tools(room,store.agent('a'),run).find(t=>t.name==='save_artifact');
 const result=await Promise.all([tool.execute('same',{name:'x',content:'body'}),tool.execute('same',{name:'x',content:'body'})]);
 assert.deepEqual(result[0],result[1]);assert.equal(room.artifacts.length,1);assert.equal(store.artifact(room.id,room.artifacts[0].id).content,'body');
});
test('task claim is exclusive and only the owner can finish',async t=>{
 const {store,room,engine}=await fixture(t);room.status='running';engine.pumping=true;
 const tool=id=>engine.tools(room,store.agent(id),{tools:0}).find(t=>t.name==='task_board');
 const a=tool('a'),b=tool('b');await a.execute('create',{action:'create',title:'work'});const id=room.tasks[0].id;
 await a.execute('claim',{action:'claim',taskId:id});await assert.rejects(b.execute('claim2',{action:'claim',taskId:id}),/领取/);
 await assert.rejects(b.execute('finish',{action:'complete',taskId:id}),/负责人/);await a.execute('finish',{action:'complete',taskId:id,result:'done'});assert.equal(room.tasks[0].status,'done');
});
test('pause retains queued work and stop clears it',async t=>{
 const {room,engine}=await fixture(t);engine.pumping=true;room.queue=['a','b'];await engine.control(room,'pause');assert.deepEqual(room.queue,['a','b']);await engine.control(room,'stop');assert.deepEqual(room.queue,[]);
});
test('one member never has overlapping activations',async t=>{
 let release;const gate=new Promise(r=>release=r);let active=0,peak=0,calls=0;
 const {room,engine}=await fixture(t,async()=>({prompt:async()=>{calls++;peak=Math.max(peak,++active);await gate;active--;},abort:async()=>release(),dispose(){}}));
 room.status='running';engine.enqueue(room,'a');engine.pump();engine.enqueue(room,'a');engine.pump();await new Promise(r=>setTimeout(r,10));assert.equal(calls,1);release();await settled(engine);assert.equal(peak,1);
});
test('SQLite messages paginate without losing or duplicating sequence',async t=>{
 const {store,room}=await fixture(t);for(let i=0;i<225;i++)store.message(room,'user','text '+i);
 const first=store.listMessages(room.id,{after:0,limit:100}),second=store.listMessages(room.id,{after:100,limit:100});assert.equal(first.hasMore,true);assert.equal(second.messages[0].seq,101);assert.equal(new Set([...first.messages,...second.messages].map(m=>m.id)).size,200);
});
test('restart preserves metadata, effects, messages and interrupted state',async t=>{
 const {store,room,dir}=await fixture(t);room.status='running';room.members.a.status='running';store.message(room,'user','persist');store.saveEffect(room.id,'a:1',{ok:true});store.save();
 const reopened=new Store(dir);try{const r=reopened.room(room.id);assert.equal(r.status,'paused');assert.equal(reopened.listMessages(room.id).messages[0].text,'persist');assert.deepEqual(reopened.effect(room.id,'a:1'),{ok:true});}finally{reopened.close();}
});
test('outbound request seam caps output and performs both cancellation checks',async()=>{
 const calls=[],session={agent:{streamFunction:async(_m,_c,o)=>o}};installRequestPolicy(session,{profile:{baseUrl:'test',requestGapMs:0},modelConfig:{maxTokens:64},beforeRequest:(...a)=>calls.push(a)});const response=await session.agent.streamFunction({}, {messages:[]},{});assert.equal(response.maxTokens,64);assert.equal(calls.length,2);assert.equal(calls[0][0],true);assert.equal(calls[1][0],false);
});
test('request reservations stop before starting a request exceeding the workspace budget',async t=>{
 let requested=0;const {room,engine}=await fixture(t,async({beforeRequest})=>({prompt:async()=>{beforeRequest();requested++},abort:async()=>{},dispose(){}}));room.limits.tokens=100;room.status='running';engine.enqueue(room,'a');engine.pump();await settled(engine);assert.equal(requested,0);assert.equal(room.status,'paused');assert.match(room.members.a.error,/预算/);
});
test('missing token usage is visible rather than represented as measured zero',async t=>{
 const {room,engine}=await fixture(t,async({onEvent})=>({prompt:async()=>onEvent({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'ok'}],stopReason:'stop'}}),abort:async()=>{},dispose(){}}));room.status='running';engine.enqueue(room,'a');engine.pump();await settled(engine);assert.equal(room.unmeteredRequests,1);
});
