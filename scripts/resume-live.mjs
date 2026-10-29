import {start} from '../server.mjs';
import {readdir,writeFile} from 'node:fs/promises';
const dirs=(await readdir('data')).filter(n=>n.startsWith('live-')).sort();
const app=await start({port:0,dataDir:'data/'+dirs.at(-1)});
try{
 const r=app.store.state.rooms[0],agents=app.store.state.agents,prior=Object.values(r.members).map(m=>m.sessionFile),cursors=Object.values(r.members).map(m=>m.cursor);
 if(process.env.AGNES_API_KEY)for(const profile of app.store.state.profiles)await app.engine.secrets.set(profile.id,process.env.AGNES_API_KEY);
 await app.engine.control(r,'resume');
 const end=Date.now()+900000;
 while(Date.now()<end){await new Promise(r=>setTimeout(r,1000));if(['paused','idle'].includes(r.status)&&!app.engine.active.size)break;}
 const [a,b]=agents;
 const report={timestamp:new Date().toISOString(),models:Object.values(r.members).map(m=>app.store.model(m.modelId).modelId),status:r.status,activations:r.activations,tokens:r.tokens,checks:{bothAgentsResponded:agents.every(a=>r.messages.some(m=>m.from===a.id)),directedHandoff:r.messages.some(m=>m.from===a.id&&m.to===b.id&&m.kind==='handoff'),returnHandoff:r.messages.some(m=>m.from===b.id&&m.to===a.id&&m.kind==='handoff'),artifact:r.artifacts.length>0,taskCompleted:r.tasks.some(t=>t.status==='done'),independentSessions:new Set(Object.values(r.members).map(m=>m.sessionFile)).size===2,restoredSameSessions:JSON.stringify(prior)===JSON.stringify(Object.values(r.members).map(m=>m.sessionFile)),incrementalCursors:Object.values(r.members).every((m,i)=>m.cursor>=cursors[i])},messages:r.messages,tasks:r.tasks,artifacts:r.artifacts};
 await writeFile('artifacts/live-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,messages:undefined,tasks:undefined,artifacts:undefined},null,2));if(!Object.values(report.checks).every(Boolean))process.exitCode=1;
}finally{await app.close();}
