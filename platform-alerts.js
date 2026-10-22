'use strict';
module.exports=function({run,get,all,tx,now}){
 run(`CREATE TABLE IF NOT EXISTS platform_alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,issue_key TEXT NOT NULL UNIQUE,code TEXT NOT NULL,title TEXT NOT NULL,details TEXT NOT NULL,occurrences INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,acknowledged_at TEXT,acknowledged_by INTEGER)`);
 const listeners=new Set();
 function snapshot(){return {unread:Number(get('SELECT COUNT(*) n FROM platform_alerts WHERE acknowledged_at IS NULL').n),alerts:all('SELECT * FROM platform_alerts ORDER BY updated_at DESC,id DESC LIMIT 200')};}
 function publish(){for(const fn of listeners){try{fn();}catch(_){listeners.delete(fn);}}}
 function report(key,code,title,details={}){
  const previous=get('SELECT * FROM platform_alerts WHERE issue_key=?',[key]);
  // Repeated failures remain one incident; persist at most once a minute.
  if(previous&&Date.now()-Date.parse(previous.updated_at)<60000)return;
  tx(()=>run(`INSERT INTO platform_alerts(issue_key,code,title,details,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(issue_key) DO UPDATE SET details=excluded.details,occurrences=platform_alerts.occurrences+1,updated_at=excluded.updated_at,acknowledged_at=NULL,acknowledged_by=NULL`,[key,code,title,JSON.stringify(details),now(),now()]));
  publish();
 }
 function acknowledge(id,actor){tx(()=>run('UPDATE platform_alerts SET acknowledged_at=?,acknowledged_by=? WHERE id=?',[now(),actor,id]));publish();}
 function remove(id){
  if(!Number.isSafeInteger(id)||id<=0)return false;
  const deleted=tx(()=>{if(!get('SELECT id FROM platform_alerts WHERE id=?',[id]))return false;run('DELETE FROM platform_alerts WHERE id=?',[id]);return true;});
  if(deleted)publish();return deleted;
 }
 function resolve(key){
  const alert=get('SELECT * FROM platform_alerts WHERE issue_key=? AND acknowledged_at IS NULL',[key]);if(!alert)return;
  let details={};try{details=JSON.parse(alert.details);}catch(_){}
  tx(()=>run('UPDATE platform_alerts SET acknowledged_at=?,acknowledged_by=NULL,details=? WHERE id=?',[now(),JSON.stringify({...details,resolvedAt:now()}),alert.id]));publish();
 }
 function mount(app,centerAuth,validSession){
  app.get('/api/center/alerts',centerAuth,(req,res)=>res.json(snapshot()));
  app.post('/api/center/alerts/:id/acknowledge',centerAuth,(req,res)=>{acknowledge(Number(req.params.id),req.user.id);res.json({ok:true});});
  app.post('/api/center/alerts/:id/delete',centerAuth,(req,res)=>{if(!remove(Number(req.params.id)))return res.status(404).json({error:'Njoftimi nuk u gjet.'});res.json({ok:true});});
  app.get('/api/center/alerts/stream',centerAuth,(req,res)=>{
   res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
   const cleanup=()=>{listeners.delete(send);clearInterval(ping);};
   const send=()=>{if(!validSession(req.user)){cleanup();res.end();return;}res.write('data: '+JSON.stringify(snapshot())+'\n\n');};
   const ping=setInterval(()=>{try{send();}catch(_){cleanup();res.end();}},15000);
   listeners.add(send);req.on('close',cleanup);send();
  });
 }
 return {report,snapshot,acknowledge,resolve,remove,mount};
};
