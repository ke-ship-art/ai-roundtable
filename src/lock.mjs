import {mkdirSync,openSync,writeFileSync,readFileSync,closeSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
export function acquire(dir){
 mkdirSync(dir,{recursive:true});const path=join(dir,'server.lock');
 for(let attempt=0;attempt<2;attempt++){
  try{const fd=openSync(path,'wx');writeFileSync(fd,String(process.pid));closeSync(fd);return ()=>unlinkSync(path);}
  catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(readFileSync(path,'utf8'));if(!Number.isInteger(pid)||pid<=0)throw Error('数据目录锁异常；请检查 server.lock');let alive=true;try{process.kill(pid,0);}catch(err){if(err.code==='ESRCH')alive=false;}
   if(alive)throw Error('此数据目录已有服务进程；请使用现有服务。');unlinkSync(path);
  }
 }
 throw Error('无法取得数据目录锁');
}
