'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),http=require('node:http');
const {spawn}=require('node:child_process');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function until(fn,label){for(let i=0;i<150;i++){try{if(await fn())return;}catch{}await delay(100);}throw Error('Timed out: '+label);}
async function main(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-operator-')),port=await freePort(),debugPort=await freePort(),base='http://127.0.0.1:'+port;
  const game=(id,live)=>({id:String(id),api_id:String(id),sport_id:1,league_id:700,league:'Fixture League',home_team:'Home '+id,away_team:'Away '+id,...(live?{result:'1-0',current_minute:'24:30'}:{}),odd:`${id}1|2|1|6575|Rezultat Final,${id}2|2|2|6575|Rezultat Final`});
  const provider=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');const match=req.url.match(/^\/ajax\/(?:livegame|prematchgame)\/(\d+)/);res.end(JSON.stringify(match?[[{id:match[1]+'1',market_option_id:match[1]+'1',market_id:'6575',market_option:'1',market:'Rezultat Final',odd:2}]]:req.url.startsWith('/ajax/livegames')?[game(100,true)]:req.url.startsWith('/ajax/prematchgames24hour')?[game(200,false)]:[]));});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  let server,chrome,ws,root;const errors=[];
  try{
    server=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_FILE:path.join(temp,'test.db'),CENTER_PASSWORD:'Fixture-password!',DISABLE_UPSTREAM:'true',VBET_BASE:'http://127.0.0.1:'+provider.address().port},windowsHide:true,stdio:'ignore'});
    await until(async()=>{try{return (await fetch(base+'/api/health')).ok;}catch{return false;}},'server');
    async function api(url,method='GET',body,token=root){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(url==='/api/bets'||url.includes('/credit')?{'Idempotency-Key':crypto.randomUUID()}:{})},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();assert(r.ok,JSON.stringify(d));return d;}
    const login=async username=>(await api('/api/auth/login','POST',{username,password:'Fixture-password!'},null)).token;
    root=await login('center');
    const create=async(role,username,parentId)=>(await api('/api/accounts','POST',{role,username,parentId,password:'Fixture-password!'})).user;
    const operator=await create('operator','operator_desk',1),readonly=await create('operator','operator_view',1);
    await api('/api/center/accounts/'+operator.id+'/permissions','PUT',{permissions:['bets.view','bets.accept','bets.cancel','bets.offer_odds']});
    await api('/api/center/accounts/'+readonly.id+'/permissions','PUT',{permissions:['bets.view']});
    let parent={id:1};for(const role of ['partner','admin','senior','manager','agent','user'])parent=await create(role,role+'_desk',parent.id);
    await api('/api/staff/'+parent.id+'/credit','POST',{amount:500});const player=await login('user_desk'),operatorToken=await login('operator_desk');
    const selection=id=>({gameId:String(id),coefId:id+'1',marketId:'6575',selection:'1',odd:2,home:'Home '+id,away:'Away '+id,eventTime:'2026-10-11T18:30:00+02:00'});
    const place=async(ids,stake)=>(await api('/api/bets','POST',{stake,selections:ids.map(selection)},player)).betId;
    const pre=await place([200],20),preBulk=await place([200],15),live=await place([100],30),mixed=await place([100,200],10);
    const queued=(await api('/api/operator/tickets?status=pending','GET',undefined,operatorToken)).tickets;
    assert.equal(queued.find(t=>t.id===pre).selections[0].acceptanceType,'prematch');
    assert.equal(queued.find(t=>t.id===pre).repeatCount,2);assert.equal(queued.find(t=>t.id===preBulk).repeatCount,2);
    assert.equal(queued.find(t=>t.id===live).selections[0].acceptanceType,'live');
    assert.deepEqual(queued.find(t=>t.id===mixed).selections.map(s=>s.acceptanceType),['live','prematch']);
    chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu','--remote-debugging-port='+debugPort,'--user-data-dir='+path.join(temp,'chrome'),'about:blank'],{windowsHide:true,stdio:'ignore'});
    let target;await until(async()=>{try{target=(await fetch('http://127.0.0.1:'+debugPort+'/json').then(r=>r.json())).find(p=>p.type==='page');return !!target;}catch{return false;}},'browser');
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});let seq=0;const pending=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
    await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await send('Page.addScriptToEvaluateOnNewDocument',{source:`sessionStorage.setItem('sportsbook_token',${JSON.stringify(operatorToken)});`});
    await send('Page.navigate',{url:base+'/'});
    await until(()=>evaluate("location.pathname==='/backoffice.html' && !!document.querySelector('.operator-columns')"),'operator redirect');
    await until(()=>evaluate("document.querySelectorAll('#prematchTickets .operator-ticket').length===2 && document.querySelectorAll('#liveTickets .operator-ticket').length===2"),'separate queues');
    assert.equal(await evaluate("document.querySelectorAll('[data-nav]').length"),3);
    assert(await evaluate(`document.querySelector('[data-operator-ticket="${pre}"] .operator-repeat').classList.contains('repeat-normal')`),'two identical ticket combinations are green');
    assert(await evaluate("Math.abs(document.querySelector('[data-lane=prematch]').getBoundingClientRect().width-document.querySelector('[data-lane=live]').getBoundingClientRect().width)<2"),'equal columns');
    assert(await evaluate("[...document.querySelectorAll('.operator-lane')].every(lane=>lane.getBoundingClientRect().height>=innerHeight-32)"),'both lanes fill the screen');
    assert(await evaluate("Math.abs(document.querySelector('[data-lane=prematch]').getBoundingClientRect().bottom-document.querySelector('[data-lane=live]').getBoundingClientRect().bottom)<2"),'both lanes extend equally');
    assert(await evaluate("(()=>{const list=document.getElementById('liveTickets'),card=list.querySelector('.operator-ticket');const clones=Array.from({length:12},()=>card.cloneNode(true));clones.forEach(c=>list.appendChild(c));const ok=document.documentElement.scrollHeight>innerHeight&&list.scrollHeight<=list.clientHeight+1&&getComputedStyle(list).overflowY==='visible';clones.forEach(c=>c.remove());return ok;})()"),'long queues expand the page without internal scroll');
    await until(()=>evaluate("document.querySelector('.operator-result').textContent.includes('1-0') || [...document.querySelectorAll('.operator-result')].some(n=>n.textContent.includes('1-0'))"),'live result');
    const artifacts=path.join(__dirname,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
    const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,'operator-desktop.png'),Buffer.from(shot.data,'base64'));
    await evaluate(`document.querySelector('[data-operator-ticket="${pre}"] [data-operator-action=accept]').click()`);
    await until(()=>evaluate(`!document.querySelector('[data-operator-ticket="${pre}"]')`),'accept ticket');assert.equal((await api('/api/admin/bets/'+pre)).bet.status,'accepted');
    await evaluate(`document.querySelector('[data-operator-ticket="${live}"] [data-operator-action=offer]').click()`);
    await until(()=>evaluate("document.getElementById('offerForm') && document.getElementById('dialog').open"),'offer form');
    await evaluate("document.querySelector('#offerForm input').value='1.5';document.querySelector('#offerForm button').click()");
    await until(()=>evaluate(`document.querySelector('[data-operator-ticket="${live}"] .operator-offer-status')`),'offer status');
    await evaluate(`document.querySelector('[data-operator-ticket="${mixed}"] [data-operator-action=cancel]').click()`);
    await until(()=>evaluate(`!document.querySelector('[data-operator-ticket="${mixed}"]')`),'refuse ticket');assert.equal((await api('/api/admin/bets/'+mixed)).bet.status,'cancelled');
    await evaluate("document.querySelector('[data-lane=prematch] details').open=true;const input=document.querySelector('[data-kind=prematch][data-lane-filter=bulk]');input.value='25';input.dispatchEvent(new Event('input'));document.querySelector('[data-kind=prematch][data-operator-bulk=accept]').click()");
    await until(()=>evaluate("!!document.getElementById('confirmOperatorBulk')"),'bulk confirmation');await evaluate("document.querySelector('#confirmOperatorBulk button').click()");
    await until(()=>evaluate("!document.getElementById('dialog').open && !document.querySelector('#prematchTickets .operator-ticket')"),'bulk accepted');assert.equal((await api('/api/admin/bets/'+preBulk)).bet.status,'accepted');
    const arrival=await place([100],5);await until(()=>evaluate(`!!document.querySelector('[data-operator-ticket="${arrival}"]')`),'new arrival updates automatically');
    const third=await place([200],2),fourth=await place([200],3);
    await until(()=>evaluate(`document.querySelector('[data-operator-ticket="${fourth}"] .operator-repeat')?.textContent==='4'`),'repetition counter');
    assert.equal(await evaluate(`document.querySelector('[data-operator-ticket="${third}"] .operator-repeat').textContent`),'4','all matching tickets show the updated total');
    assert(await evaluate(`document.querySelector('[data-operator-ticket="${fourth}"] .operator-repeat').classList.contains('repeat-high')`),'fourth repeat is red');
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    assert(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"),'mobile viewport fits');
    const mobile=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifacts,'operator-mobile.png'),Buffer.from(mobile.data,'base64'));
    const readonlyToken=await login('operator_view');await send('Page.addScriptToEvaluateOnNewDocument',{source:`sessionStorage.setItem('sportsbook_token',${JSON.stringify(readonlyToken)});`});
    await send('Page.reload');await until(()=>evaluate("me?.username==='operator_view' && !!document.querySelector('#liveTickets .operator-ticket')"),'read-only desk');
    assert.equal(await evaluate("document.querySelectorAll('[data-operator-action],[data-operator-bulk]').length"),0);
    assert.deepEqual(errors,[]);console.log('Operator browser: PASS — persisted types, role redirect, equal queues, live score, accept, offer, refuse, bulk confirmation, automatic arrivals, mobile, permission checks.');
  }finally{
    ws?.close();for(const proc of [chrome,server])if(proc&&proc.exitCode===null){proc.kill();await Promise.race([new Promise(r=>proc.once('exit',r)),delay(2000)]);}
    await new Promise(r=>provider.close(r));const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('euro97-operator-'));fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
