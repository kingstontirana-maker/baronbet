'use strict';
module.exports=function createMonitor(){
  const requests=[],apis=new Map(),listeners=new Set();let sequence=0,timer,issueHandler=()=>{};
  const slowMs=1500,capacity=500;
  function publish(){if(timer)return;timer=setTimeout(()=>{timer=null;for(const fn of listeners)fn();},250);timer.unref?.();}
  function begin(direction,method,address){
    const url=new URL(address,'http://local');
    const endpoint=url.pathname.replace(/\/[0-9]+(?=\/|$)/g,'/:id');
    const host=direction==='Incoming'?'Platform':url.host;
    const key=[direction,method,host,endpoint].join(' ');
    let api=apis.get(key);if(!api){if(apis.size>=300)apis.delete(apis.keys().next().value);api={key,direction,method,host,endpoint,total:0,errors:0,inFlight:0,totalMs:0};apis.set(key,api);}
    const row={id:++sequence,key,direction,method,host,endpoint,startedAt:Date.now(),status:null,durationMs:null,error:'',state:'Pending'};
    requests.unshift(row);if(requests.length>capacity)requests.pop();api.inFlight++;publish();let done=false;
    const finish=(status,error='')=>{if(done)return;done=true;row.status=status;row.durationMs=row.streaming?row.durationMs:Date.now()-row.startedAt;row.error=error;row.state=error||status>=400?'Issue':row.durationMs>=slowMs?'Slow':'Real-time';api.inFlight--;api.total++;api.totalMs+=row.durationMs;if(row.state==='Issue'){api.errors++;if(direction==='Outgoing'||status>=500){try{issueHandler({direction,method,host,endpoint,status,error});}catch(_){}}}Object.assign(api,{lastStatus:status,lastDurationMs:row.durationMs,lastSeen:Date.now(),state:row.state,lastError:error});publish();};
    finish.openStream=status=>{if(done||row.streaming)return;row.streaming=true;row.status=status;row.durationMs=Date.now()-row.startedAt;row.state='Streaming';Object.assign(api,{lastStatus:status,lastDurationMs:row.durationMs,lastSeen:Date.now(),state:row.durationMs>=slowMs?'Slow':'Real-time',lastError:''});publish();};
    return finish;
  }
  function snapshot(){const at=Date.now();const rows=[...apis.values()].map(a=>({...a,averageMs:a.total?Math.round(a.totalMs/a.total):0,state:requests.some(r=>r.key===a.key&&r.state==='Pending'&&at-r.startedAt>=slowMs)?'Slow':a.state||'Pending'}));return {at,slowMs,capacity,apis:rows,requests,counts:{realtime:rows.filter(a=>a.state==='Real-time').length,slow:rows.filter(a=>a.state==='Slow').length,issues:rows.filter(a=>a.state==='Issue').length}};}
  function middleware(req,res,next){
    if(!req.path.startsWith('/api/')||req.path.startsWith('/api/monitor'))return next();
    const end=begin('Incoming',req.method,req.path);let streaming=false;
    const writeHead=res.writeHead;
    res.writeHead=function(...args){const result=writeHead.apply(this,args);streaming=res.statusCode<400&&String(res.getHeader('content-type')||'').includes('text/event-stream');if(streaming)end.openStream(res.statusCode);return result;};
    res.once('finish',()=>end(res.statusCode));
    // Closing a successful SSE subscription on navigation is not a failed API call.
    res.once('close',()=>{if(!res.writableFinished)end(streaming?res.statusCode:0,streaming?'':'Connection closed before response completed');});next();
  }

  return {begin,snapshot,middleware,onIssue(fn){issueHandler=fn;},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
};
