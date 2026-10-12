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


    let account={id:1};for(const role of ['partner','admin','senior','manager','agent','user'])account=await create(role,role+'_homeclick',account.id);const player=await login('user_homeclick');
    await send('Page.addScriptToEvaluateOnNewDocument',{source:'sessionStorage.setItem("sportsbook_token",'+JSON.stringify(player)+');'});
    await send('Page.navigate',{url:base+'/'});
    await until(()=>evaluate('!!document.querySelector(".home-match-open")'),'home button');
    await evaluate('fetch("/api/livegames").then(r=>r.json()).then(g=>{homeExtras.live=g;renderSportsHome(cache)})');
    await until(()=>evaluate('!!document.querySelector(".home-live-score")'),'home live rows');
    assert.equal(await evaluate('document.querySelector(".home-live-score").textContent'),'10');
    const aligned=await evaluate('(()=>{const h=document.querySelector(".sports-home-live-head").children[1].getBoundingClientRect();const o=document.querySelector(".sports-live-row .odd").getBoundingClientRect();return Math.abs(h.left-o.left)<1 && Math.abs(h.width-o.width)<1})()');assert(aligned,'Home Live header aligns with odds');
    const liveShot=await send('Page.captureScreenshot',{format:'png'});fs.mkdirSync(path.join(__dirname,'artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'artifacts','home-live-grid.png'),Buffer.from(liveShot.data,'base64'));
    const id=await evaluate('document.querySelector(".home-match-open").dataset.homeMatch');
    await evaluate('document.querySelector(".home-match-open").click()');
    await until(()=>evaluate('!!document.querySelector("[data-live-market-option]")'),'prematch markets');
    assert.equal(await evaluate('openLiveGameId'),id);
    assert(await evaluate('document.querySelector(".prematch-match-title").textContent.includes("Home 200 vs Away 200")'));
    assert(await evaluate('!!document.querySelector(".prematch-match-date") && !!document.querySelector(".prematch-detail .live-detail-tabs")'));
    const shot=await send('Page.captureScreenshot',{format:'png'});fs.mkdirSync(path.join(__dirname,'artifacts'),{recursive:true});fs.writeFileSync(path.join(__dirname,'artifacts','prematch-header.png'),Buffer.from(shot.data,'base64'));
    await evaluate('document.querySelector("[data-live-market-option]").click()');assert.equal(await evaluate('slip.length'),1);
    await evaluate('document.querySelector("[data-live-detail-back]").click()');await until(()=>evaluate('!!document.querySelector(".home-match-open")'),'back home');
    await evaluate('homeExtras.main=cache.filter(g=>g.home_team);document.querySelector("[data-category]").click()');
    await until(()=>evaluate('!!document.querySelector("#categoryBody .sports-fixture")'),'football category fixtures');
    assert(!(await evaluate('document.querySelector("#categoryBody").textContent')).includes('not defined'));
    await api('/api/staff/'+account.id+'/credit','POST',{amount:100});
    const financeBet=await api('/api/bets','POST',{stake:10,selections:[{gameId:'200',coefId:'2001',marketId:'6575',selection:'1',odd:2}]},player);
    await api('/api/operator/tickets/'+financeBet.betId+'/accept','POST',{});await api('/api/operator/tickets/'+financeBet.betId+'/settle','POST',{status:'won'});
    const fin=await api('/api/account-finance','GET',undefined,player);assert.equal(fin.summary.turnover,10);assert.equal(fin.summary.payout,20);assert.equal(fin.summary.difference,-10);
    await evaluate('openPlayerFinance()');await until(()=>evaluate('!!document.querySelector("#financeDates")'),'static finances');assert.equal(await evaluate('document.querySelector("#controlModal").classList.contains("show")'),false);
    assert(await evaluate('document.querySelector(".player-finance").textContent.includes("user_homeclick")'));
    for(const width of [390,1440]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width===390});
      assert(await evaluate('Array.from(document.querySelectorAll(".finance-table-wrap")).every(e=>e.scrollWidth<=e.clientWidth+1)'),'finance tables fit '+width);
    }
    await evaluate('openControl(user.role,"password")');await until(()=>evaluate('!!document.querySelector("#passwordForm")'),'static password');assert.equal(await evaluate('document.querySelector("#controlModal").classList.contains("show")'),false);await evaluate('document.querySelector("#passwordPageBack").click()');await until(()=>evaluate('!!document.querySelector(".home-match-open")'),'home after finances');
    await evaluate('renderSportsHome([{id:"200",home_team:"Home 200",away_team:"Away 200",league:"Fixture League",league_id:700,odd:"2001|2|1|6575|Rezultat Final",game_date:new Date().toLocaleDateString("sv-SE",{timeZone:"Europe/Berlin"}),game_time:"23:59:59"}])');
    assert(await evaluate('document.querySelector("#content>section:last-child").classList.contains("home-upcoming-section")'));
    assert.equal(await evaluate('document.querySelectorAll(".home-upcoming-section .today-match-row").length'),1);
    await evaluate('sportsHomeTab="today";selectedSport="all";render([{id:"200",home_team:"Home 200",away_team:"Away 200",league:"Fixture League",league_id:700,odd:"2001|2|1|6575|Rezultat Final",game_date:new Date().toLocaleDateString("sv-SE",{timeZone:"Europe/Berlin"}),game_time:"23:59:59"}])');
    assert.equal(await evaluate('document.querySelectorAll(".today-match-row .odd").length'),3);
    await evaluate('document.querySelector(".today-match-teams").click()');await until(()=>evaluate('!!document.querySelector("[data-live-market-option]")'),'today match markets');
    await evaluate('document.querySelector("[data-live-detail-back]").click()');await until(()=>evaluate('!!document.querySelector(".home-match-open")'),'home after today');
    for(const role of ['partner','admin','senior','manager','agent']){
 const t=await login(role+'_homeclick');await evaluate('token='+JSON.stringify(t)+';fetch("/api/me",{headers:{Authorization:"Bearer "+token}}).then(r=>r.json()).then(d=>setAuthState(d.user))');
 await evaluate('handleStaffAction("directory")');await until(()=>evaluate('!!document.querySelector("#directorySearch")'),'directory '+role);
 assert.equal(await evaluate('document.querySelector("#controlModal").classList.contains("show")'),false);
 await evaluate('document.querySelector("#directorySearch").value="zz-no-match";document.querySelector("#directorySearch").dispatchEvent(new Event("input"))');assert.equal(await evaluate('document.querySelectorAll(".directory-account").length'),0);
 await evaluate('document.querySelector("#directorySearch").value="";document.querySelector("#directorySearch").dispatchEvent(new Event("input"))');assert(await evaluate('document.querySelectorAll(".directory-account").length>0'));
 await evaluate('openSportsHome()');
 }
 assert.deepEqual(errors,[]);console.log('Hierarchy directories, search and static pages: PASS');
  }finally{
    ws?.close();for(const proc of [chrome,server])if(proc&&proc.exitCode===null){proc.kill();await Promise.race([new Promise(r=>proc.once('exit',r)),delay(2000)]);}
    await new Promise(r=>provider.close(r));const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('euro97-operator-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
