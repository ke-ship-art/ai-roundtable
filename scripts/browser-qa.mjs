import {ensureChrome,startChrome} from '../../chrome-cdp/chrome-cdp.mjs';
import {connectNative} from '../../chrome-cdp/native-cdp.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const url=process.env.QA_URL||'http://127.0.0.1:4317/';
await ensureChrome({start:()=>startChrome({url})});
const c=await connectNative({browserURL:'http://127.0.0.1:9222',targetUrl:url});
const wait=async(fn,limit=60)=>{for(let i=0;i<limit;i++){if(await c.evaluate(fn))return;await new Promise(r=>setTimeout(r,150));}throw Error('等待页面状态超时');};
const click=selector=>c.evaluate(s=>document.querySelector(s)?.click(),selector);
const fill=async(name,value)=>{await c.evaluate(n=>{const f=document.querySelector(`[name="${n}"]`);f.focus();f.select();},name);await c.send('Input.insertText',{text:String(value)});};
const choose=(name,value)=>c.evaluate((n,v)=>{const f=document.querySelector(`[name="${n}"]`);f.value=v;f.dispatchEvent(new Event('change',{bubbles:true}));},name,value);
const submit=async()=>{await c.evaluate(()=>document.querySelector('#dialogForm').requestSubmit());await wait(()=>!document.querySelector('#dialog').open);};

try{
 await c.send('Page.bringToFront');await c.send('Page.enable');await c.send('Page.reload',{ignoreCache:true});
 await wait(()=>document.querySelector('#connection')?.textContent==='本地服务已连接');
 await click('#manage');await click('#createProfile');
 await fill('name','QA Local');await fill('baseUrl','http://127.0.0.1:1/v1');await choose('authMode','none');await fill('requestGapMs','0');await submit();

 const addModel=async(name,id)=>{await click('#manage');await click('#createModel');await fill('name',name);await fill('modelId',id);await fill('contextWindow','32000');await fill('maxTokens','1024');await submit();};
 await addModel('QA Model One','qa-one');await addModel('QA Model Two','qa-two');

 const addAgent=async(name,role,modelIndex)=>{await click('#manage');await click('#createAgent');await fill('name',name);await fill('role',role);await c.evaluate(i=>{const f=document.querySelector('[name="defaultModelId"]');f.selectedIndex=i;f.dispatchEvent(new Event('change',{bubbles:true}));},modelIndex);await submit();};
 await addAgent('QA 设计师','设计方案',0);await addAgent('QA 评审员','审查方案',1);

 await click('#newRoom');await fill('title','模型切换 UI 验收');await submit();
 await wait(()=>document.querySelectorAll('[data-member-model]').length===2);
 const before=await c.evaluate(()=>document.querySelector('[data-member-model]').value);
 const after=await c.evaluate(old=>{const f=document.querySelector('[data-member-model]');const next=[...f.options].find(o=>o.value!==old);f.value=next.value;f.dispatchEvent(new Event('change',{bubbles:true}));return next.value;},before);
 await wait(()=>document.querySelector('#messages').textContent.includes('已切换至'));
 assert.notEqual(before,after);assert.equal(await c.evaluate(()=>document.querySelector('[data-member-model]').value),after);

 await c.send('Page.reload',{ignoreCache:true});await wait(()=>document.querySelectorAll('[data-member-model]').length===2);
 assert.equal(await c.evaluate(()=>document.querySelector('[data-member-model]').value),after);
 assert(await c.evaluate(()=>document.querySelector('#messages').textContent.includes('原 Pi Session 与上下文继续保留')));

 const state=await fetch(new URL('/api/state',url)).then(r=>r.json()),roomId=state.rooms[0].id;
 const post=async(path,body)=>{const response=await fetch(new URL(`/api/${path}`,url),{method:'POST',headers:{'Content-Type':'application/json','X-Workspace-Token':state.csrf},body:JSON.stringify(body)});assert.equal(response.ok,true);};
 await post('control',{room:roomId,action:'pause'});
 await post('message',{room:roomId,to:null,text:'## Markdown 验收\n\n**加粗文字**'});
 await wait(()=>document.querySelector('#messages .markdown strong')?.textContent==='加粗文字');

 await mkdir('artifacts',{recursive:true});await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 let shot=await c.send('Page.captureScreenshot',{format:'png'});await writeFile('artifacts/settings-and-switch.png',Buffer.from(shot.data,'base64'));
 await c.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});assert(await c.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 shot=await c.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile('artifacts/settings-mobile.png',Buffer.from(shot.data,'base64'));
 await c.send('Emulation.clearDeviceMetricsOverride');
 await c.evaluate(()=>{window.confirm=()=>true;document.querySelector('#deleteRoom').click();});
 await wait(()=>document.querySelector('#roomCount')?.textContent==='0');
 console.log('PASS: setup, incremental messages, Markdown, model switch persistence, room deletion, responsive layout.');
}finally{await c.disconnect();}
