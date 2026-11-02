'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http');
const {spawn}=require('node:child_process');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error('Timed out: '+label);}
async function main(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-operator-')),port=await freePort(),debugPort=await freePort(),base='http://127.0.0.1:'+port;
  const game=(id,live)=>({id:String(id),api_id:String(id),sport_id:1,league_id:700,league:'Fixture League',home_team:'Home '+id,away_team:'Away '+id,...(live?{result:'1-0',current_minute:'24:30'}:{}),odd:`${id}1|2|1|6575|Rezultat Final,${id}2|2|2|6575|Rezultat Final`});
  const provider=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/ajax/leagues/9'){setTimeout(()=>res.end('[]'),2500);return;}if(req.url==='/ajax/leagues/10'){res.statusCode=503;res.end(JSON.stringify({error:'Unavailable fixture'}));return;}if(req.url.startsWith('/ajax/livegame/')){setTimeout(()=>res.end('[]'),2500);return;}const catalog={'/ajax/sports':[{id:1,name:'Football'}],'/ajax/countries/1':[{id:2,name:'England'},{id:9,name:'Slow country'},{id:10,name:'Unavailable country'}],'/ajax/leagues/2':[{id:700,name:'Fixture League'}],'/ajax/gamesByLeague/700':[game(200,false)]};const match=req.url.match(/^\/ajax\/(?:livegame|prematchgame)\/(\d+)/);res.end(JSON.stringify(catalog[req.url]|| (match?[[{id:match[1]+'1',market_option_id:match[1]+'1',market_id:'6575',market_option:'1',market:'Rezultat Final',odd:2}]]:req.url.startsWith('/ajax/livegames')?[game(100,true)]:req.url.startsWith('/ajax/prematchgames24hour')?[game(200,false)]:[])));});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  let server,chrome,ws,root;const errors=[];
  try{
    server=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_FILE:path.join(temp,'test.db'),CENTER_PASSWORD:'Fixture-password!',DISABLE_UPSTREAM:'true',VBET_BASE:'https://euro07.bet'},windowsHide:true,stdio:'ignore'});
    await until(async()=>{try{return (await fetch(base+'/api/health')).ok;}catch{return false;}},'server');
    async function api(url,method='GET',body,token=root){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(url==='/api/bets'||url.includes('/credit')?{'Idempotency-Key':crypto.randomUUID()}:{})},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();assert(r.ok,JSON.stringify(d));return d;}
    const login=async username=>(await api('/api/auth/login','POST',{username,password:'Fixture-password!'},null)).token;
    root=await login('center');
    const create=async(role,username,parentId)=>(await api('/api/accounts','POST',{role,username,parentId,password:'Fixture-password!'})).user;
    chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu','--remote-debugging-port='+debugPort,'--user-data-dir='+path.join(temp,'chrome'),'about:blank'],{windowsHide:true,stdio:'ignore'});
    let target;await until(async()=>{try{target=(await fetch('http://127.0.0.1:'+debugPort+'/json').then(r=>r.json())).find(p=>p.type==='page');return !!target;}catch{return false;}},'browser');
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});let seq=0;const pending=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
    await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});

    await send('Page.addScriptToEvaluateOnNewDocument',{source: 'sessionStorage.setItem("sportsbook_token",'+JSON.stringify(root)+');'});
    await send('Page.navigate',{url:base+'/backoffice.html#/sport-competitions'});
    await until(()=>evaluate('!!document.querySelector("#competitionRows a")'),'sports');
    await evaluate('document.querySelector("#competitionViewToggle").click()');
    let fullTarget;await until(async()=>{fullTarget=(await fetch('http://127.0.0.1:'+debugPort+'/json').then(r=>r.json())).find(p=>p.id!==target.id&&p.type==='page'&&p.url.includes('view=full'));return !!fullTarget;},'live provider tab');
    const handleMessage=ws.onmessage;ws.close();ws=new WebSocket(fullTarget.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});ws.onmessage=handleMessage;
    await send('Page.enable');await send('Runtime.enable');
    await until(()=>evaluate('document.querySelector("#fullSport")?.value==="1"'),'football selected by default');
    await until(()=>evaluate('document.querySelectorAll("#fullTournaments a").length>0'),'real provider tournaments');
    console.log('Real provider tournament count: '+await evaluate('document.querySelectorAll("#fullTournaments a").length'));
    await evaluate('document.querySelector("#fullTournaments a").click()');
    await until(()=>evaluate('Array.from(document.querySelectorAll("#fullEvent option")).some(o=>o.value)'),'real provider matches');
    await until(()=>evaluate('!!document.querySelector("[data-competition-limit]")'),'real provider markets');
    assert.deepEqual(errors,[]);console.log('Real provider Full View: PASS — sports, tournaments, matches, markets.');
  }finally{
    ws?.close();for(const proc of [chrome,server])if(proc&&proc.exitCode===null){proc.kill();await Promise.race([new Promise(r=>proc.once('exit',r)),delay(2000)]);}
    await new Promise(r=>provider.close(r));const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('euro97-operator-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
