import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export const id = () => randomUUID();
export class Store {
  constructor(dir) {
    mkdirSync(dir,{recursive:true}); this.db = new DatabaseSync(join(dir,'workspace.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS state_backup(createdAt INTEGER PRIMARY KEY, json TEXT NOT NULL)');
    const row=this.db.prepare('SELECT json FROM state WHERE id=1').get();
    this.state=row?JSON.parse(row.json):{schemaVersion:2,agents:[],profiles:[],models:[],rooms:[]};
    if(row&&this.state.schemaVersion!==2)this.db.prepare('INSERT INTO state_backup VALUES(?,?)').run(Date.now(),row.json);
    this.migrate();
    for(const r of this.state.rooms){ if(r.status==='running')r.status='paused'; for(const [agentId,member] of Object.entries(r.members)){if(member.status==='running'){member.status='interrupted';member.error='服务已重启；请确认成果后继续。';}member.modelId ||= this.agent(agentId).defaultModelId;} }
    this.save();
  }
  migrate(){
    this.state.agents ||= [];this.state.rooms ||= [];this.state.profiles ||= [];this.state.models ||= [];
    if(this.state.schemaVersion>=2)return;
    const agents=[];
    for(const legacy of this.state.agents){
      let defaultModelId=legacy.defaultModelId;
      if(!defaultModelId){
        const profileId=id();defaultModelId=id();
        this.state.profiles.push({id:profileId,name:`${legacy.name} 接入`,baseUrl:legacy.baseUrl,api:legacy.api||'openai-completions',authMode:legacy.keyEnv?'api_key':legacy.baseUrl?.startsWith('http://127.0.0.1')?'none':'api_key',keyEnv:legacy.keyEnv||'',requestGapMs:legacy.requestGapMs||0});
        this.state.models.push({id:defaultModelId,profileId,name:legacy.model,modelId:legacy.model,contextWindow:legacy.contextWindow||32000,maxTokens:legacy.maxTokens||2048,enabled:true});
      }
      agents.push({id:legacy.id,name:legacy.name,role:legacy.role,canWrite:!!legacy.canWrite,defaultModelId});
    }
    this.state.agents=agents;this.state.schemaVersion=2;
  }
  save(){this.db.prepare('INSERT OR REPLACE INTO state VALUES(1,?)').run(JSON.stringify(this.state));}
  room(roomId){const r=this.state.rooms.find(r=>r.id===roomId);if(!r)throw Error('工作区不存在');return r;}
  agent(agentId){const a=this.state.agents.find(a=>a.id===agentId);if(!a)throw Error('Agent 不存在');return a;}
  profile(profileId){const p=this.state.profiles.find(p=>p.id===profileId);if(!p)throw Error('接入配置不存在');return p;}
  model(modelId){const m=this.state.models.find(m=>m.id===modelId);if(!m)throw Error('模型不存在');return m;}
  createRoom(title,agents,limits={}){
    if(agents.length<2||agents.length>8||new Set(agents).size!==agents.length)throw Error('请选择 2–8 个不同 Agent');
    const members=Object.fromEntries(agents.map(a=>{const agent=this.agent(a);this.model(agent.defaultModelId);return [a,{cursor:0,status:'idle',sessionFile:null,modelId:agent.defaultModelId}];}));
    const r={id:id(),title:title.slice(0,100),createdAt:Date.now(),members,messages:[],tasks:[],artifacts:[],effects:{},queue:[],status:'idle',activations:0,tokens:0,limits:{activations:24,tokens:60000,concurrency:2,...limits}};
    this.state.rooms.unshift(r);this.save();return r;
  }
  message(r,from,text,kind='chat',to=null,extra={}){const m={seq:r.messages.length+1,id:id(),from,to,text,kind,time:Date.now(),...extra};r.messages.push(m);this.save();return m;}
  close(){this.db.close();}
}
