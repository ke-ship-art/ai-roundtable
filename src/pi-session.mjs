import {createAgentSession,createExtensionRuntime,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import {mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const nextRequest=new Map();

export async function makeSession({modelConfig,profile,member,dir,systemPrompt,tools,key,onEvent,beforeRequest=()=>{}}){
  mkdirSync(dir,{recursive:true});
  const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,modelsStorePath:join(dir,'models-cache.json'),refreshOnCreate:false});
  const compat=profile.api==='openai-completions'?{supportsDeveloperRole:false,supportsStore:false,maxTokensField:'max_tokens'}:undefined;
  runtime.registerProvider('workspace',{baseUrl:profile.baseUrl,api:profile.api,apiKey:profile.authMode==='none'?'local-no-key':'WORKSPACE_UNUSED_KEY',authHeader:profile.authMode!=='none',models:[{id:modelConfig.modelId,name:modelConfig.name,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:modelConfig.contextWindow,maxTokens:modelConfig.maxTokens,...(compat?{compat}:{})}]});
  await runtime.setRuntimeApiKey('workspace',key||'local-no-key');
  const model=runtime.getModel('workspace',modelConfig.modelId);
  if(!model)throw Error('无法加载所选模型');
  const manager=member.sessionFile&&existsSync(member.sessionFile)?SessionManager.open(member.sessionFile,dir):SessionManager.create(dir,dir);
  // The durable Pi user entry is the delivery receipt, including when a run failed after submission.
  for(const e of manager.getEntries())if(e.type==='message'&&e.message.role==='user'){
    const s=typeof e.message.content==='string'?e.message.content:e.message.content?.filter(x=>x.type==='text').map(x=>x.text).join('');
    const match=s?.match(/^\[workspace-sync:(\d+)\]/);if(match)member.cursor=Math.max(member.cursor,Number(match[1]));
  }
  const resourceLoader={getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),getSystemPrompt:()=>systemPrompt,getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],extendResources:()=>{},reload:async()=>{}};
  const {session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model,thinkingLevel:'off',sessionManager:manager,resourceLoader,settingsManager:SettingsManager.inMemory({compaction:{enabled:true,reserveTokens:Math.min(4096,modelConfig.contextWindow/4),keepRecentTokens:Math.min(6000,modelConfig.contextWindow/3)},retry:{enabled:true,maxRetries:1}}),tools:tools.map(t=>t.name),customTools:tools});
  member.sessionFile=manager.getSessionFile();session.subscribe(onEvent);
  const stream=session.agent.streamFunction;
  session.agent.streamFunction=async(model,context,options)=>{
    beforeRequest();
    const gap=profile.requestGapMs||0,now=Date.now(),at=Math.max(now,nextRequest.get(profile.baseUrl)||0);
    nextRequest.set(profile.baseUrl,at+gap);
    if(at>now)await delay(at-now,undefined,{signal:options?.signal});
    options?.signal?.throwIfAborted();
    beforeRequest(false);
    return stream(model,context,{...options,maxTokens:modelConfig.maxTokens});
  };
  return session;
}

