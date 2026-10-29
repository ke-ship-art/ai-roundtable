import {start} from '../server.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const key=process.env.AGNES_API_KEY;if(!key)throw Error('请设置 AGNES_API_KEY；不会使用模拟模型替代。');
const app=await start({port:0,dataDir:join('data','live-'+Date.now())});
const base=`http://127.0.0.1:${app.port}`,initial=await fetch(base+'/api/state').then(r=>r.json());
const post=async(path,p)=>{const r=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Workspace-Token':initial.csrf},body:JSON.stringify(p)});const j=await r.json();if(!r.ok)throw Error(j.error);return j;};
const events=[];app.engine.emit=(type,data)=>{if(type==='activity'||type==='diagnostic')events.push({type,...data});};
try{
 const profile=await post('profiles',{name:'Agnes live',baseUrl:process.env.LIVE_BASE_URL||'https://api.agnes-ai.cn/v1',api:'openai-completions',authMode:'api_key',apiKey:key,requestGapMs:Number(process.env.LIVE_GAP_MS||22000)});
 const modelA=await post('models',{profileId:profile.id,name:'Agnes Flash',modelId:process.env.LIVE_MODEL_A||'agnes-2.5-flash',contextWindow:32000,maxTokens:2048,enabled:true});
 const modelB=await post('models',{profileId:profile.id,name:'Agnes Pro',modelId:process.env.LIVE_MODEL_B||'agnes-2.5-pro',contextWindow:32000,maxTokens:2048,enabled:true});
 const a=await post('agents',{name:'方案设计师',defaultModelId:modelA.id,canWrite:true,role:'设计方案。必须先调用 send_message 向评审员请求检查。收到意见后保存最终成果。'});
 const b=await post('agents',{name:'独立评审员',defaultModelId:modelB.id,canWrite:true,role:'独立评审方案，指出缺陷。收到设计师请求后必须调用 send_message 把评审结论发回设计师；然后结束，不循环致谢。'});
 const r=await post('rooms',{title:'真实双模型协作验收',agents:[a.id,b.id]});
 await post('limits',{room:r.id,activations:10,tokens:40000,concurrency:2});
 await post('message',{room:r.id,to:a.id,text:`设计一个三步的番茄钟学习计划。先创建并领取一个共享任务，然后用 send_message 向独立评审员 ${b.id} 请求审查；收到回复后保存名为 study-plan.md 的最终成果并完成任务。保持每次回答简短。`});
 const deadline=Date.now()+900000;
 while(Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));const room=app.store.room(r.id);if(['idle','paused','stopped'].includes(room.status)&&!app.engine.active.size)break;}
 const room=app.store.room(r.id),messages=app.store.listMessages(r.id,{after:0,limit:500}).messages,artifacts=room.artifacts.map(item=>app.store.artifact(r.id,item.id)),report={timestamp:new Date().toISOString(),models:[modelA.modelId,modelB.modelId],status:room.status,activations:room.activations,tokens:room.tokens,checks:{bothAgentsResponded:[a.id,b.id].every(id=>messages.some(m=>m.from===id)),directedHandoff:messages.some(m=>m.from===a.id&&m.kind==='handoff'&&m.to===b.id),returnHandoff:messages.some(m=>m.from===b.id&&m.kind==='handoff'&&m.to===a.id),artifact:artifacts.length>0,taskCompleted:room.tasks.some(t=>t.status==='done'),independentSessions:new Set(Object.values(room.members).map(m=>m.sessionFile).filter(Boolean)).size===2},messages,tasks:room.tasks,artifacts,events};
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/live-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,activations:report.activations,tokens:report.tokens,checks:report.checks,events},null,2));
 if(!Object.values(report.checks).every(Boolean))process.exitCode=1;
}finally{await app.close();}
