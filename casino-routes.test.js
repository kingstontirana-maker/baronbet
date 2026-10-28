'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),http=require('http'),crypto=require('crypto');
const {spawn}=require('child_process');
const gsd=require('./casino-gsdeluxe');

// Real server + fake GSDeluxe that only answers correctly encrypted and signed envelopes.
async function boot(t,extraEnv){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-casino-'));
 const state={credit:0,users:new Map(),commands:[]};
 const provider=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  const envelope=JSON.parse(new URLSearchParams(body).get('data'));
  if(envelope.token_name!=='test-token'||envelope.sign!==gsd.sign(envelope.request,'hash-key'))return res.end(JSON.stringify({success:-10,msg:'Authentication error'}));
  const r=JSON.parse(gsd.decrypt(envelope.request,'token-value'));state.commands.push(r.cmd);
  const ok=x=>res.end(JSON.stringify({success:1,...x,api_version:'test'}));
  if(r.cmd==='user_reg'){assert.equal(r.gh_id,12);state.users.set(r.user_name,r.user_password);return ok({user_id:1});}
  if(r.cmd==='login')return state.users.get(r.login)===r.password?ok({jwt:'jwt-1',currency_id:51,currency_list:[{CurrencyID:51,ShortName:'EUR'}]}):res.end('{"success":-111}');
  if(r.cmd==='gamelist')return ok({baseURL:'https://cdn.example/',gamelist:[{ID:17,Name:'Book of Test',GameIconUrl:'17.png'}]});
  if(r.cmd==='balance')return ok({credit:state.credit});
  if(r.cmd==='balance_operation'){if(r.operation==='increase'){state.credit+=r.sum*100;return ok({credit:r.sum*100});}const taken=state.credit;state.credit=0;return ok({credit:taken});}
  if(r.cmd==='start_game')return res.end('<!doctype html><html><body><div id="game">slot</div></body></html>');
  if(r.cmd==='user_ping')return ok({});
  res.end('{"success":-7}');
 });});
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base='http://127.0.0.1:'+port;
 let child,output='';
 async function start(){
  child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_FILE:path.join(dir,'test.db'),CENTER_PASSWORD:'Test-only-root-917!',DISABLE_UPSTREAM:'true',GSD_API_URL:`http://127.0.0.1:${provider.address().port}/api.php`,GSD_TOKEN_NAME:'test-token',GSD_TOKEN_VALUE:'token-value',GSD_API_HASH_KEY:'hash-key',GSD_CLUB_ID:'12',...(typeof extraEnv==='function'?extraEnv(port):extraEnv)},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===299)throw Error('Startup timeout: '+output);}
 }
 // On Windows kill() is TerminateProcess: no shutdown hooks run, like a crash.
 async function stop(){if(child.exitCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}}
 t.after(async()=>{await stop();await new Promise(r=>provider.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 await start();
 async function api(url,token,method='GET',body,expected=200,headers={}){
  const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();assert.equal(response.status,expected,`${method} ${url}: ${JSON.stringify(data)}`);return data;
 }
 const login=async(username,password='Fixture-password!')=>(await api('/api/auth/login',null,'POST',{username,password})).token;
 const root=await login('center','Test-only-root-917!');
 let parentId=1,player;
 for(const role of ['partner','admin','senior','manager','agent','user']){player=(await api('/api/accounts',root,'POST',{role,username:role+'_c',password:'Fixture-password!',parentId},201)).user;parentId=player.id;}
 await api(`/api/staff/${player.id}/credit`,root,'POST',{direction:'credit',amount:50},200,{'Idempotency-Key':crypto.randomUUID()});
 const token=await login('user_c');
 return {api,login,root,token,player,state,base,dir,start,stop};
}

test('transfer mode: player launch, sandboxed frame, exit and center report',async t=>{
 const {api,root,token,state,base}=await boot(t,{GSD_MODE:'transfer'});
 await api('/api/casino/games',root,'GET',undefined,403);
 const {games}=await api('/api/casino/games',token);
 assert.deepEqual(games,[{id:17,name:'Book of Test',platform:'',icon:'https://cdn.example/17.png'}]);
 const launch=await api('/api/casino/launch',token,'POST',{gameId:17,width:1000,height:600});
 assert.equal((await api('/api/me',token)).user.balance,0);
 assert.equal(state.credit,5000*100);

 const frame=await fetch(base+launch.frameUrl);
 assert.equal(frame.status,200);assert.match(await frame.text(),/id="game"/);
 assert.match(frame.headers.get('content-security-policy'),/^sandbox allow-scripts/);
 assert.doesNotMatch(frame.headers.get('content-security-policy'),/allow-same-origin/);
 assert.equal((await fetch(base+launch.frameUrl)).status,404,'frame URL is single use');

 await api('/api/casino/ping',token,'POST',{});
 state.credit+=1234*100; // a win of 12.34
 const exit=await api('/api/casino/exit',token,'POST',{});
 assert.equal(exit.balance,62.34);assert.equal(state.credit,0);

 const report=await api('/api/center/casino/sessions',root);
 assert.equal(report.enabled,true);assert.equal(report.mode,'transfer');assert.equal(report.sessions[0].status,'closed');assert.equal(report.summary.ggr,-12.34);
 await api('/api/center/casino/sessions',token,'GET',undefined,403);
 assert.ok(JSON.stringify(await api('/api/wallet',token)).includes('casino_in'));
});

test('seamless mode: signed callbacks within 50 ms and journal survives a crash',async t=>{
 const SECRET='callback-secret';
 // localhost plays the dedicated game host; the site itself is reached as 127.0.0.1.
 const ctx=await boot(t,port=>({GSD_CALLBACK_SECRET:SECRET,GSD_CALLBACK_IPS:'127.0.0.1',GSD_FRAME_ORIGIN:'http://localhost:'+port}));
 const {api,token,state}=ctx;
 const launch=await api('/api/casino/launch',token,'POST',{gameId:17,width:1000,height:600});
 assert.equal(launch.external,true,'the game opens from its own origin');
 const gameHost=new URL(launch.frameUrl);assert.equal(gameHost.hostname,'localhost');assert.match(gameHost.pathname,/^\/api\/casino\/frame\/[0-9a-f]{48}$/);
 const frame=await fetch(launch.frameUrl);
 assert.equal(frame.status,200);assert.match(await frame.text(),/id="game"/);
 assert.equal(frame.headers.get('content-security-policy'),'frame-ancestors https:','no sandbox: games keep storage and cookies');
 assert.equal(frame.headers.get('x-frame-options'),null);
 for(const p of ['/','/api/health','/api/me','/backoffice.html'])assert.equal((await fetch(gameHost.origin+p)).status,404,'game host serves frames only: '+p);
 assert.equal((await fetch(ctx.base+'/api/health')).status,200,'the site itself is unaffected');
 assert.equal((await api('/api/me',token)).user.balance,50,'seamless launch moves no money');
 assert.ok(!state.commands.includes('balance_operation'));
 const login=[...state.users.keys()][0];
 const sha1=s=>crypto.createHash('sha1').update(s).digest('hex');
 let txId=500;
 async function callback(command,data,{contentType='application/json'}={}){
  const time=new Date().toISOString().slice(0,19).replace('T',' ');
  const body={command,request_timestamp:time,hash:sha1(command+time+SECRET),data};
  const started=performance.now();
  const r=await fetch(ctx.base+'/api/casino/gsd/'+command,{method:'POST',headers:{'Content-Type':contentType},body:JSON.stringify(body)});
  const ms=performance.now()-started,out=await r.json();
  assert.equal(r.status,200);assert.equal(out.response.hash,sha1(out.response.status+out.response.response_timestamp+SECRET));
  return {...out.response,ms};
 }
 const change=(type,amount,round=1)=>callback('changebalance',{transaction_type:type,reason:'SPIN',amount,currency_code:'EUR',transaction_id:++txId,transaction_timestamp:new Date().toISOString().slice(0,19).replace('T',' '),round_id:round,round_finished:type!=='BET',game_id:17,token:login});

 assert.deepEqual((await callback('balance',{token:login,currency_code:'EUR'})).data,{balance:5000,currency_code:'EUR'});
 assert.equal((await callback('balance',{token:login,currency_code:'EUR'},{contentType:'text/plain'})).status,'OK','body parsed whatever the content type');
 const times=[];
 for(let i=0;i<20;i++){const b=await change('BET',-100,i);const w=await change('WIN',i%2?250:0,i);assert.equal(b.status,'OK');assert.equal(w.status,'OK');times.push(b.ms,w.ms);}
 times.sort((a,b)=>a-b);
 assert.ok(times[Math.floor(times.length*0.9)]<50,'p90 callback latency '+times.map(x=>x.toFixed(1)).join(','));
 assert.equal((await callback('balance',{token:login,currency_code:'EUR'})).data.balance,5000-2000+2500);

 // Crash right after an acknowledged spin, before the delayed database save.
 assert.equal((await change('BET',-700,99)).status,'OK');
 await ctx.stop();
 // The dead writer's lease goes stale after 30 s; age it instead of waiting.
 const lease=path.join(ctx.dir,'test.db.writer-lock'),old=new Date(Date.now()-60000);fs.utimesSync(lease,old,old);
 await ctx.start();
 assert.equal((await callback('balance',{token:login,currency_code:'EUR'})).data.balance,5500-700);
 const freshToken=await ctx.login('user_c');
 assert.equal((await api('/api/me',freshToken)).user.balance,48);

 const report=await api('/api/center/casino/sessions',await ctx.login('center','Test-only-root-917!')); // staff sessions end on restart
 assert.equal(report.mode,'seamless');assert.equal(report.summary.bets,27);assert.equal(report.summary.wins,25);assert.equal(report.summary.ggr,2);
 assert.equal(report.transactions.length,41);
});
