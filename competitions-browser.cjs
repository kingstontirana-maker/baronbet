'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http');
const {spawn}=require('node:child_process');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error('Timed out: '+label);}
async function main(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-operator-')),port=await freePort(),debugPort=await freePort(),base='http://127.0.0.1:'+port;
  const game=(id,live)=>({id:String(id),api_id:String(id),sport_id:1,league_id:700,league:'Fixture League',home_team:'Home '+id,away_team:'Away '+id,...(live?{result:'1-0',current_minute:'24:30'}:{}),odd:`${id}1|2|1|6575|Rezultat Final,${id}2|2|2|6575|Rezultat Final`});
  const provider=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');const catalog={'/ajax/sports':[{id:1,name:'Football'}],'/ajax/countries/1':[{id:2,name:'England'}],'/ajax/leagues/2':[{id:700,name:'Fixture League'}],'/ajax/gamesByLeague/700':[game(200,false)]};const match=req.url.match(/^\/ajax\/(?:livegame|prematchgame)\/(\d+)/);res.end(JSON.stringify(catalog[req.url]|| (match?[[{id:match[1]+'1',market_option_id:match[1]+'1',market_id:'6575',market_option:'1',market:'Rezultat Final',odd:2}]]:req.url.startsWith('/ajax/livegames')?[game(100,true)]:req.url.startsWith('/ajax/prematchgames24hour')?[game(200,false)]:[])));});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
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
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
    await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});

    await send('Page.addScriptToEvaluateOnNewDocument',{source: 'sessionStorage.setItem("sportsbook_token",'+JSON.stringify(root)+');'});
    await send('Page.navigate',{url:base+'/backoffice.html#/sport-competitions'});
    await until(()=>evaluate('!!document.querySelector("#competitionRows a")'),'sports');
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'),'rgb(241, 244, 246)');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".topbar")).backgroundColor'),'rgb(255, 255, 255)');
    const themeShot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const themeArtifacts=path.join(__dirname,'artifacts');fs.mkdirSync(themeArtifacts,{recursive:true});fs.writeFileSync(path.join(themeArtifacts,'center-theme.png'),Buffer.from(themeShot.data,'base64'));
    for(const kind of ['group','tournament','event']){
      await evaluate('document.querySelector("#competitionRows a").click()');
      await until(()=>evaluate('location.hash.includes("kind='+kind+'") && !!document.querySelector("#competitionRows '+(kind==='event'?'[data-competition-edit]':'a')+'")'),'level '+kind);
    }
    await evaluate('document.querySelector("[data-competition-edit]").click();document.querySelector("[name=maxStake]").value="12";document.querySelector("[name=blocked]").checked=true;document.querySelector("#competitionForm").requestSubmit()');
    await until(()=>evaluate('!document.querySelector("#dialog").open && document.querySelector("#competitionRows").textContent.includes("Bllokuar")'),'saved rule');
    assert.equal((await api('/api/center/competitions?kind=event&parent=700')).items[0].rule.max_stake,12);
    let playerAccount={id:1};for(const role of ['partner','admin','senior','manager','agent','user'])playerAccount=await create(role,role+'_competition',playerAccount.id);
    await api('/api/staff/'+playerAccount.id+'/credit','POST',{amount:100});const playerToken=await login('user_competition');
    const blocked=await fetch(base+'/api/bets',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+playerToken,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({stake:5,selections:[{gameId:'200',coefId:'2001',marketId:'6575',selection:'1',odd:2}]})});assert.equal(blocked.status,400);assert.match((await blocked.json()).error,/bllokuar/);
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    assert(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),'mobile width');
    await evaluate('document.querySelector("[data-rule-remove]").click()');
    await until(()=>evaluate('!document.querySelector("[data-rule-remove]")'),'rule removed');
    await evaluate('location.hash="/sport-competitions?kind=tournament&parent=2"');await until(()=>evaluate('!!document.querySelector("[data-competition-edit]")'),'tournament limit');
    await evaluate('document.querySelector("[data-competition-edit]").click();document.querySelector("[name=maxUserTotal]").value="10";document.querySelector("#competitionForm").requestSubmit()');
    await until(()=>evaluate('!document.querySelector("#dialog").open && document.querySelector("#competitionRows").textContent.includes("Total/user")'),'total saved');
    const selection={gameId:'200',coefId:'2001',marketId:'6575',selection:'1',odd:2};
    const first=await api('/api/bets','POST',{stake:6,selections:[selection]},playerToken);await api('/api/bets','POST',{stake:4,selections:[selection]},playerToken);
    const over=await fetch(base+'/api/bets',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+playerToken,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({stake:0.01,selections:[selection]})});assert.equal(over.status,400);assert.match((await over.json()).error,/Limiti total/);
    await api('/api/operator/tickets/'+first.betId+'/accept','POST',{});
    const before=(await api('/api/me','GET',undefined,playerToken)).user.balance;
    await api('/api/operator/tickets/'+first.betId+'/settle','POST',{status:'won'});
    assert.equal((await api('/api/me','GET',undefined,playerToken)).user.balance,before+12);
    await api('/api/operator/tickets/'+first.betId+'/settle','POST',{status:'won'});
    assert.equal((await api('/api/me','GET',undefined,playerToken)).user.balance,before+12);
    await evaluate('location.hash="/bets?status=pending"');await until(()=>evaluate('document.querySelector("#content").textContent.includes("Ticket Accepting")'),'ticket tabs');
    assert(await evaluate('Array.from(document.querySelectorAll(".tabs a")).some(a=>a.textContent==="Në pritje" && a.href.includes("status=accepted"))'));
    await evaluate('location.hash="/ticket/'+first.betId+'"');await until(()=>evaluate('!!document.querySelector("[data-action=lost-ticket]")'),'correct settled ticket');
    await evaluate('document.querySelector("[data-action=lost-ticket]").click();document.querySelector("#confirmTicket").requestSubmit()');
    await until(async()=>{return (await api('/api/admin/bets/'+first.betId)).bet.status==='lost';},'corrected loss');
    assert.equal((await api('/api/me','GET',undefined,playerToken)).user.balance,before);
    await api('/api/operator/tickets/'+first.betId+'/settle','POST',{status:'won'});assert.equal((await api('/api/me','GET',undefined,playerToken)).user.balance,before+12);

    await evaluate('location.hash="/sport-competitions?kind=group&parent=1"');await until(()=>evaluate('!!document.querySelector("#createTournamentGroup")'),'create group button');
    await evaluate('document.querySelector("#createTournamentGroup").click();document.querySelector("#tournamentGroupForm [name=name]").value="Our Tournaments";document.querySelector("#groupCountry").value="2";document.querySelector("#groupCountry").dispatchEvent(new Event("change"))');
    await until(()=>evaluate('!!document.querySelector("[data-pick-tournament]")'),'tournament choices');
    await evaluate('document.querySelector("[data-pick-tournament]").click();document.querySelector("#tournamentGroupForm").requestSubmit()');
    await until(()=>evaluate('!document.querySelector("#dialog").open && document.querySelector("#competitionRows").textContent.includes("Our Tournaments")'),'custom group saved');
    assert(await evaluate('document.querySelector("#competitionRows tbody tr:first-child").textContent.includes("Our Tournaments")'),'custom groups precede countries');
    await evaluate('document.querySelector("#competitionRows a").click()');await until(()=>evaluate('document.querySelector("#competitionRows").textContent.includes("Fixture League")'),'group tournaments');
    const partner=await create('partner','competition_partner',1),partnerToken=await login('competition_partner');
    const denied=await fetch(base+'/api/center/competitions',{headers:{Authorization:'Bearer '+partnerToken}});assert.equal(denied.status,403);
    assert.deepEqual(errors,[]);console.log('Competitions browser: PASS — hierarchy, save, remove, mobile, center-only access.');
  }finally{
    ws?.close();for(const proc of [chrome,server])if(proc&&proc.exitCode===null){proc.kill();await Promise.race([new Promise(r=>proc.once('exit',r)),delay(2000)]);}
    await new Promise(r=>provider.close(r));const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('euro97-operator-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
