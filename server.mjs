import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Store,id} from './src/store.mjs';
import {Engine} from './src/engine.mjs';
import {acquire} from './src/lock.mjs';
import {SecretStore} from './src/secrets.mjs';
const root=dirname(fileURLToPath(import.meta.url));
export async function start({port=Number(process.env.PORT||4317),dataDir=process.env.DATA_DIR||join(root,'data')}={}){
 const directory=resolve(dataDir),unlock=acquire(directory);let store,secrets;try{store=new Store(directory);secrets=new SecretStore(directory);await secrets.init();}catch(e){store?.close();unlock();throw e;}const clients=new Set(),csrf=randomBytes(24).toString('hex');
 const emit=(type,data)=>{const payload=`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;for(const c of clients){if(c.writableLength>1000000){c.end();clients.delete(c);}else c.write(payload);}};
 const engine=new Engine(store,directory,emit,secrets);
 const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const text=(v,max=4000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('文本为空或超过长度限制');return v.trim();};
 const num=(v,def,min,max)=>{v=v??def;if(!Number.isInteger(v)||v<min||v>max)throw Error('数值超出允许范围');return v;};
 const assertConfigIdle=()=>{if(engine.active.size)throw Error('请先暂停正在运行的 Agent 再修改配置');};
 const endpoint=v=>{const base=new URL(text(v,2048));if(base.username||base.password||base.search||base.hash||!['https:','http:'].includes(base.protocol))throw Error('API 地址不合法');if(base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('远程 API 必须使用 HTTPS');return base.href.replace(/\/$/,'');};
 const server=http.createServer(async(req,res)=>{try{
  const host=req.headers.host;if(![`127.0.0.1:${server.address().port}`,`localhost:${server.address().port}`].includes(host))return json(res,{error:'Invalid host'},403);
  if(req.headers.origin&&![`http://127.0.0.1:${server.address().port}`,`http://localhost:${server.address().port}`].includes(req.headers.origin))return json(res,{error:'Invalid origin'},403);
  const url=new URL(req.url,`http://${host}`);
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  if(req.method==='GET'){
   if(url.pathname==='/api/health')return json(res,{name:'pi-multi-agent-workspace',pid:process.pid});
   if(url.pathname==='/api/state')return json(res,{...engine.publicState(),csrf});
   if(url.pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(`event: state\ndata: ${JSON.stringify(engine.publicState())}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;}
   const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/settings.css':'settings.css'};const file=files[url.pathname];if(!file)return json(res,{error:'Not found'},404);
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(await readFile(join(root,'public',file)));return;
  }
  if(req.method!=='POST')return json(res,{error:'Method not allowed'},405);
  if(req.headers['x-workspace-token']!==csrf)return json(res,{error:'请刷新页面重试'},403);
  let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw Error('请求过大');}const p=JSON.parse(body||'{}');
  if(url.pathname==='/api/profiles'){
   assertConfigIdle();if(store.state.profiles.length>=30&&!p.id)throw Error('最多配置 30 个接入');const old=p.id?store.profile(p.id):null;
   const api=p.api||'openai-completions';if(!['openai-completions','openai-responses','anthropic-messages','google-generative-ai'].includes(api))throw Error('不支持的协议');
   const authMode=p.authMode||'api_key';if(!['api_key','none'].includes(authMode))throw Error('认证方式无效');
   if(p.keyEnv&&!/^[A-Z][A-Z0-9_]{0,99}$/.test(p.keyEnv))throw Error('环境变量名格式不合法');
   const profile={id:old?.id||id(),name:text(p.name,80),baseUrl:endpoint(p.baseUrl),api,authMode,keyEnv:p.keyEnv||'',requestGapMs:num(p.requestGapMs,0,0,300000)};
   const destinationChanged=old&&(old.baseUrl!==profile.baseUrl||old.api!==profile.api||old.authMode!==profile.authMode);
   if(p.apiKey)await secrets.set(profile.id,text(p.apiKey,4096));else if((authMode==='none'||destinationChanged)&&secrets.has(profile.id))await secrets.delete(profile.id);
   if(old)Object.assign(old,profile);else store.state.profiles.push(profile);engine.change();return json(res,{...profile,hasCredential:secrets.has(profile.id)||!!(profile.keyEnv&&process.env[profile.keyEnv])});
  }
  if(url.pathname==='/api/profiles/key'){assertConfigIdle();const profile=store.profile(p.id);await secrets.set(profile.id,text(p.apiKey,4096));engine.change();return json(res,{ok:true});}
  if(url.pathname==='/api/profiles/logout'){assertConfigIdle();const profile=store.profile(p.id);await secrets.delete(profile.id);engine.change();return json(res,{ok:true});}
  if(url.pathname==='/api/profiles/remove'){assertConfigIdle();const profile=store.profile(p.id);if(store.state.models.some(m=>m.profileId===profile.id))throw Error('请先删除此接入下的模型');store.state.profiles=store.state.profiles.filter(x=>x.id!==profile.id);await secrets.delete(profile.id);engine.change();return json(res,{ok:true});}
  if(url.pathname==='/api/profiles/catalog'){
   const profile=store.profile(p.id),key=secrets.get(profile.id)||(profile.keyEnv&&process.env[profile.keyEnv]);if(profile.authMode!=='none'&&!key)throw Error('请先保存 API Key');
   const headers={};if(key){if(profile.api==='anthropic-messages'){headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';}else if(profile.api==='google-generative-ai')headers['x-goog-api-key']=key;else headers.Authorization=`Bearer ${key}`;}
   const response=await fetch(`${profile.baseUrl.replace(/\/$/,'')}/models`,{headers,signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error(`读取模型目录失败：HTTP ${response.status}`);const body=await response.json();const list=Array.isArray(body.data)?body.data:Array.isArray(body.models)?body.models:[];return json(res,list.map(x=>({id:x.id||x.name,name:x.displayName||x.name||x.id})).filter(x=>x.id).slice(0,500));
  }
  if(url.pathname==='/api/models'){
   assertConfigIdle();if(store.state.models.length>=100&&!p.id)throw Error('最多配置 100 个模型');const old=p.id?store.model(p.id):null,profile=store.profile(text(p.profileId,100));
   if(old&&old.profileId!==profile.id)throw Error('已有模型不能移动到其他接入，请新建模型');
   const model={id:old?.id||id(),profileId:profile.id,name:text(p.name,100),modelId:text(p.modelId,200),contextWindow:num(p.contextWindow,32000,1024,2000000),maxTokens:num(p.maxTokens,2048,64,200000),enabled:p.enabled!==false};if(model.maxTokens>=model.contextWindow)throw Error('输出上限必须小于上下文长度');
   if(old)Object.assign(old,model);else store.state.models.push(model);engine.change();return json(res,model);
  }
  if(url.pathname==='/api/models/remove'){assertConfigIdle();const model=store.model(p.id);if(store.state.agents.some(a=>a.defaultModelId===model.id)||store.state.rooms.some(r=>Object.values(r.members).some(m=>m.modelId===model.id)))throw Error('模型仍被 Agent 或历史工作区使用，不能删除');store.state.models=store.state.models.filter(x=>x.id!==model.id);engine.change();return json(res,{ok:true});}
  if(url.pathname==='/api/agents'){
   assertConfigIdle();if(store.state.agents.length>=30&&!p.id)throw Error('最多配置 30 个 Agent');const old=p.id?store.agent(p.id):null,defaultModel=store.model(text(p.defaultModelId,100));if(!defaultModel.enabled)throw Error('默认模型必须已启用');
   const agent={id:old?.id||id(),name:text(p.name,60),role:text(p.role,2000),canWrite:!!p.canWrite,defaultModelId:defaultModel.id};if(old)Object.assign(old,agent);else store.state.agents.push(agent);engine.change();return json(res,agent);
  }
  if(url.pathname==='/api/agents/remove'){assertConfigIdle();const agent=store.agent(p.id);if(store.state.rooms.some(r=>r.members[agent.id]))throw Error('Agent 被历史工作区引用，无法删除');store.state.agents=store.state.agents.filter(a=>a.id!==agent.id);engine.change();return json(res,{ok:true});}
  if(url.pathname==='/api/rooms'){if(!Array.isArray(p.agents))throw Error('需要 Agent 列表');if(store.state.rooms.length>=100)throw Error('工作区数量上限');const r=store.createRoom(text(p.title,100),p.agents);engine.change();return json(res,{id:r.id});}
  const r=store.room(p.room);
  if(url.pathname==='/api/rooms/model'){engine.switchModel(r,text(p.agent,100),text(p.modelId,100));return json(res,{ok:true});}
  if(url.pathname==='/api/message'){engine.submit(r,text(p.text,8000),p.to||null);return json(res,{ok:true});}
  if(url.pathname==='/api/control'){if(!['pause','resume','stop'].includes(p.action))throw Error('未知操作');await engine.control(r,p.action);return json(res,{ok:true});}
  if(url.pathname==='/api/limits'){r.limits={activations:num(p.activations,24,1,200),tokens:num(p.tokens,60000,1000,1000000),concurrency:num(p.concurrency,2,1,4)};engine.change();engine.pump();return json(res,{ok:true});}
  if(url.pathname==='/api/rename'){r.title=text(p.title,100);engine.change();return json(res,{ok:true});}
  return json(res,{error:'Not found'},404);
 }catch(e){json(res,{error:e.message},400);}});
 const heartbeat=setInterval(()=>{for(const c of clients)c.write(': heartbeat\n\n');},15000);heartbeat.unref();
 try{await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});}catch(e){clearInterval(heartbeat);store.close();unlock();throw e;}
 return {server,engine,store,port:server.address().port,async close(){clearInterval(heartbeat);await engine.close();for(const c of clients)c.end();await new Promise(r=>server.close(r));store.close();unlock();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=await start();console.log(`Pi Workspace: http://127.0.0.1:${app.port}`);for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{await app.close();process.exit(0);});
}
