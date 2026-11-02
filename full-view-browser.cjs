'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http');
const {spawn}=require('node:child_process');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function until(fn,label){for(let i=0;i<300;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error('Timed out: '+label);}
async function main(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-operator-')),port=await freePort(),debugPort=await freePort(),base='http://127.0.0.1:'+port;
  const game=(id,live)=>({id:String(id),api_id:String(id),sport_id:1,league_id:700,league:'Fixture League',home_team:'Home '+id,away_team:'Away '+id,...(live?{result:'1-0',current_minute:'24:30'}:{}),odd:`${id}1|2|1|6575|Rezultat Final,${id}2|2|2|6575|Rezultat Final`});
  let providerUpdated=false;
  const provider=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/ajax/leagues/9'){setTimeout(()=>res.end('[]'),2500);return;}if(req.url==='/ajax/leagues/10'){res.statusCode=503;res.end(JSON.stringify({error:'Unavailable fixture'}));return;}if(req.url.startsWith('/ajax/livegame/')){setTimeout(()=>res.end('[]'),2500);return;}const catalog={'/ajax/sports':[{id:13,name:'Aussie rules'},{id:1,name:'Football'}],'/ajax/countries/1':[{id:2,name:'England'},{id:9,name:'Slow country'},{id:10,name:'Unavailable country'}],'/ajax/leagues/2':[{id:700,name:'Fixture League'},...(providerUpdated?[{id:701,name:'New API Tournament'}]:[])],'/ajax/gamesByLeague/700':[game(200,false),...(providerUpdated?[game(201,false)]:[])]};const match=req.url.match(/^\/ajax\/(?:livegame|prematchgame)\/(\d+)/);res.end(JSON.stringify(catalog[req.url]|| (match?[[{id:match[1]+'1',market_option_id:match[1]+'1',market_id:'6575',market_option:'1',market:'Rezultat Final',odd:2},...(providerUpdated?[{id:match[1]+'2',market:'Total Goals',odd:2}]:[])]]:req.url.startsWith('/ajax/livegames')?[game(100,true)]:req.url.startsWith('/ajax/prematchgames24hour')?[game(200,false)]:[])));});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  let server,chrome,ws,root;const errors=[];
  try{
    server=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_FILE:path.join(temp,'test.db'),CENTER_PASSWORD:'Fixture-password!',DISABLE_UPSTREAM:'true',VBET_BASE:'http://127.0.0.1:'+provider.address().port},windowsHide:true,stdio:'ignore'});
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
    await api('/api/center/competitions?kind=group&parent=1');
    await api('/api/center/competitions?kind=tournament&parent=2');
    const createdGroup=await api('/api/center/competition-groups','POST',{name:'Center Favorites',sportId:'1',tournamentIds:['700']});
    assert(await evaluate('document.querySelector("#competitionViewToggle").target==="_blank"'));
    const openedAt=Date.now();
    await evaluate('document.querySelector("#competitionViewToggle").click()');
    assert(await evaluate('!location.hash.includes("view=full")'),'original tab stays compact');
    let fullTarget;await until(async()=>{fullTarget=(await fetch('http://127.0.0.1:'+debugPort+'/json').then(r=>r.json())).find(p=>p.id!==target.id&&p.type==='page'&&p.url.includes('view=full'));return !!fullTarget;},'new Full View tab');
    const handleMessage=ws.onmessage;ws.close();
    ws=new WebSocket(fullTarget.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});ws.onmessage=handleMessage;
    await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await until(()=>evaluate('!!document.querySelector("#fullStatus")'),'full workspace');
    assert(Date.now()-openedAt<2200,'workspace opens before the slow country finishes');
    assert(await evaluate('window.opener===null'),'new tab detaches opener');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#sidebar")).display'),'none');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".main-shell")).marginLeft'),'0px');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".competition-explorer-title")).backgroundColor'),'rgb(6, 75, 59)');
    assert(await evaluate('document.querySelector("#main").getBoundingClientRect().width===document.documentElement.clientWidth'),'uses full width');
    assert(await evaluate('!!document.querySelector(".competition-explorer")'));
    assert.equal(await evaluate('document.querySelector("#fullSport").value'),'1');
    assert(await evaluate('Math.abs(document.querySelector("#fullTournaments").getBoundingClientRect().bottom-(innerHeight-11))<=2'),'tournament list fills sidebar to viewport bottom');
    assert(await evaluate('document.querySelector("#fullTournaments").getBoundingClientRect().height>innerHeight/2'),'tournament list uses remaining screen height');

    assert(await evaluate('document.querySelector("#fullTree").textContent.includes("Center Favorites") && !document.querySelector("#fullTree").textContent.includes("England")'));
    await until(()=>evaluate('document.querySelector("#competitionRows").textContent.includes("Rezultat Final")'),'markets arrive in background despite slow live endpoint');
    assert.equal(await evaluate('document.querySelectorAll(".reference-board").length'),1);
    await evaluate('document.querySelector("[data-competition-limit]").click();document.querySelector("[name=maxStake]").value="12";document.querySelector("#competitionForm").requestSubmit()');
    await until(()=>evaluate('!document.querySelector("#dialog").open && document.querySelector("#competitionRows").textContent.includes("12")'),'saved group market limit');
    assert(await evaluate('document.querySelector("#fullTournaments").textContent.includes("England / Fixture League")'));
    const rule=(await api('/api/center/competitions?kind=market&scopeKind=custom-group&scopeId='+createdGroup.id)).items[0].rule;
    assert.equal(rule.max_stake,12);assert.equal(rule.kind,'custom-group-market');
    await evaluate('document.querySelector("[data-market-category=Goals]").click()');
    assert(await evaluate('document.querySelector("#fullCount").textContent.includes("0 markets")'));
    await evaluate('document.querySelector("[data-market-category=All]").click()');
    await evaluate('document.querySelector("#fullTournament").value="700";document.querySelector("#fullTournament").dispatchEvent(new Event("change"))');
    await until(()=>evaluate('!!document.querySelector("#fullEvent option[value="+JSON.stringify("200")+"]")'),'tournament matches');
    await evaluate('document.querySelector("#fullEvent").value="200";document.querySelector("#fullEvent").dispatchEvent(new Event("change"))');
    await until(()=>evaluate('location.hash.includes("event=200") && !!document.querySelector("[data-competition-limit]")'),'match markets');
    providerUpdated=true;
    await until(()=>evaluate('document.querySelector("#fullTournaments").textContent.includes("New API Tournament")'),'new API tournament appears automatically');
    await until(()=>evaluate('Array.from(document.querySelectorAll("#fullEvent option")).some(o=>o.value==="201")'),'new API match appears automatically');
    await until(()=>evaluate('document.querySelector("#competitionRows").textContent.includes("Total Goals")'),'new API market appears automatically');
    await until(()=>evaluate('document.querySelector("#fullLoadStatus").textContent.includes("nuk u rifreskuan")'),'partial failure is visible');
    assert(await evaluate('!!document.querySelector("[data-competition-limit]")'),'controls survive failed country');
    await evaluate('document.querySelector("#fullRetry").click()');
    await until(()=>evaluate('!!document.querySelector("#fullStatus")'),'retry remains usable');
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.mkdirSync(path.join(__dirname,'artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'artifacts','competition-reference.png'),Buffer.from(shot.data,'base64'));
    assert.deepEqual(errors,[]);
    console.log('Full View browser: PASS — hierarchy, persisted limit, markets, categories.');
  }finally{
    ws?.close();for(const proc of [chrome,server])if(proc&&proc.exitCode===null){proc.kill();await Promise.race([new Promise(r=>proc.once('exit',r)),delay(2000)]);}
    await new Promise(r=>provider.close(r));const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('euro97-operator-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
