'use strict';
// Browser integration against an isolated real server/database. Requires Chrome.
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),http=require('http');
const {spawn}=require('child_process');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
async function until(fn,label){for(let i=0;i<100;i++){try{const result=await fn();if(result)return result;}catch{}await delay(100);}throw Error('Timed out: '+label);}
async function main(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-browser-')),port=await freePort(),chromePort=await freePort(),base='http://127.0.0.1:'+port;
  const provider=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.startsWith('/ajax/livegame/')?[{market_option_id:'101',odd:2,market_id:'1',market_option:'Home',market:'Fulltime Result'}]:req.url.includes('livegames')?[{id:'100',league_id:700,league:'Fixture League',home_team:'Live Home',away_team:'Live Away',result:'2-1',current_minute:'67:30',count_options:123,odd:'101|2.5|1|1|Fulltime Result,102|1|X|1|Fulltime Result'}]:[{id:'100',game_api_id:'100',league_id:700,league:'Fixture League'},...Array.from({length:12},(_,i)=>({id:String(200+i),league_id:700,league:'Fixture League'})),{id:'999',league_id:701,league:'Other League'}]));});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  let server,chrome,ws;const errors=[];let output='';
  try{
    server=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_FILE:path.join(temp,'browser.db'),CENTER_PASSWORD:'Browser-fixture-password!',DISABLE_UPSTREAM:'true',VBET_BASE:'http://127.0.0.1:'+provider.address().port},windowsHide:true,stdio:['ignore','pipe','pipe']});
    server.stdout.on('data',b=>output+=b);server.stderr.on('data',b=>output+=b);
    await until(async()=>{if(server.exitCode!==null)throw Error(output);return (await fetch(base+'/api/health')).ok;},'test server');
    async function api(url,method='GET',body,token=root,key){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();assert(r.ok,JSON.stringify(d));return d;}
    const login=await api('/api/auth/login','POST',{username:'center',password:'Browser-fixture-password!'},null);const root=login.token;
    const create=async(role,username,parentId)=>(await api('/api/accounts','POST',{role,username,parentId,password:'Browser-fixture-password!'})).user;
    const partner=await create('partner','partner_tirana',1);await create('partner','partner_prishtina',1);const operator=await create('operator','operator_main',1);
    let parent=partner;for(const role of ['admin','senior','manager','agent','user'])parent=await create(role,role+'_tirana',parent.id);
    await api('/api/staff/'+partner.id+'/credit','POST',{amount:12500},root,'browser-partner-credit');await api('/api/staff/'+parent.id+'/credit','POST',{amount:500},root,'browser-player-credit');
    const player=(await api('/api/auth/login','POST',{username:parent.username,password:'Browser-fixture-password!'},null)).token;
    const bet=await api('/api/bets','POST',{stake:20,selections:[{gameId:'100',gameApiId:'100',coefId:'101',selection:'Home',odd:2,home:'Arsenal',away:'Chelsea',league:'Premier League'}]},player,'browser-bet-0001');
    const executable=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    chrome=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-gpu','--remote-debugging-port='+chromePort,'--user-data-dir='+path.join(temp,'chrome'),'about:blank'],{windowsHide:true,stdio:'ignore'});
    chrome.on('error',e=>errors.push(e.message));
    const target=await until(async()=>{const pages=await fetch('http://127.0.0.1:'+chromePort+'/json').then(r=>r.json());return pages.find(p=>p.type==='page');},'Chrome debugger');
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});let seq=0;const pending=new Map();
    ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);}if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description||msg.params.exceptionDetails.text);};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const d=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(d.exceptionDetails)throw Error(d.exceptionDetails.exception?.description||d.exceptionDetails.text);return d.result.value;};
    await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:base+'/backoffice.html'});await until(()=>evaluate("document.querySelector('#content .empty-state strong')?.textContent==='Kërkohet identifikimi'"),'unauthenticated page settled');
    await evaluate(`localStorage.setItem('sportsbook_token',${JSON.stringify(root)})`);
    // Enter through the sportsbook: Center must land on the single workspace.
    await send('Page.navigate',{url:base+'/'});await until(()=>evaluate("location.pathname==='/backoffice.html' && document.querySelector('.metrics')"),'center redirect');
    assert.equal(await evaluate("!!document.getElementById('centerDashboard')"),false);
    await until(()=>evaluate("document.querySelector('#content .metric-value')?.textContent.includes('20')"),'dashboard data');
    const artifactDir=path.join(__dirname,'artifacts');fs.mkdirSync(artifactDir,{recursive:true});
    const screenshot=async name=>{const d=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(artifactDir,name),Buffer.from(d.data,'base64'));};
    await screenshot('center-desktop.png');
    async function navigate(route,selector){await evaluate(`location.hash=${JSON.stringify('/'+route)}`);await until(()=>evaluate(`currentRoute===${JSON.stringify(route)} && !!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector('#content .loading')`),route);assert.equal(await evaluate("document.querySelector('#message.error')?.hidden===false"),false,'page error: '+route);}
    for(const [route,selector] of [['partners','#accountRows'],['operators','#accountRows'],['accounts','#accountRows'],['network','.tree-root'],['bets','#betRows'],['live','#events'],['risk','#content .panel'],['finance','#financeRows'],['reports','.metrics'],['permissions','#content table'],['audit','#auditRows'],['security/password','#ownPassword'],['security/sessions','#content table'],['security/history','#content table']])await navigate(route,selector);
    await evaluate("window.NativeEventSource=window.EventSource;window.EventSource=class extends NativeEventSource{constructor(url){super(url);if(url==='/api/live-stream')window.testLiveSource=this;}}");
    await navigate('live','.live-event');
    assert.equal(await evaluate("document.querySelector('.live-event .score').textContent"),'2-1');
    assert(await evaluate("document.querySelector('.live-event').textContent.includes('67:30') && document.querySelector('.live-event').textContent.includes('2.50') && document.querySelector('.live-event').textContent.includes('Pezull')"));
    assert(await evaluate("document.querySelector('.live-risk').textContent.includes('Fitimi potencial')"));
    await evaluate("testLiveSource.dispatchEvent(new MessageEvent('coefs',{data:JSON.stringify({game_id:'100',current_result:'3-1',current_minute:'68:15',coefs:[{coef_id:'101',odd:3.25}]})}))");
    await until(()=>evaluate("document.querySelector('.score').textContent==='3-1' && document.querySelector('.live-odds').textContent.includes('3.25')"),'push score and odds');
    await evaluate("testLiveSource.dispatchEvent(new MessageEvent('game',{data:JSON.stringify({id:'push-test',league:'Push League',home_team:'Push Home',result:'0-0'})}))");
    assert.equal(await evaluate("document.querySelectorAll('.live-event').length"),2);
    await evaluate("testLiveSource.dispatchEvent(new MessageEvent('delete-game',{data:JSON.stringify({game_id:'push-test'})}))");
    assert.equal(await evaluate("document.querySelectorAll('.live-event').length"),1);
    await evaluate("testLiveSource.dispatchEvent(new MessageEvent('game',{data:JSON.stringify({id:'100',game_time:'69:10'})}))");
    assert(await evaluate("document.querySelector('.live-indicator').textContent.includes('69:10')"));
    await screenshot('center-live.png');
    await evaluate("document.getElementById('eventFilter').value='no-match';document.getElementById('eventFilter').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.querySelectorAll('.live-event').length"),0);
    for(const tab of ['profile','limits','finance','bets','permissions','security'])await navigate('account/'+partner.id+'/'+tab,'.tabs');
    await navigate('risk','[data-event-risk]');
    await evaluate("document.querySelector('[data-event-risk]').click()");await until(()=>evaluate("!!document.getElementById('eventRiskForm')"),'event risk dialog');
    await evaluate("document.querySelector('#eventRiskForm [name=maxStake]').value='15';document.getElementById('eventRiskForm').requestSubmit()");
    await until(()=>evaluate("document.getElementById('message').textContent==='Limitet e eventit u ruajtën.'"),'event limit save');
    assert.equal((await api('/api/risk/events/100/limits')).rules.find(r=>r.scope_id===0).max_stake,15);
    await evaluate("document.getElementById('removeEventLimit').click()");await until(()=>evaluate("document.getElementById('message').textContent==='Limiti u hoq.'"),'event limit removal');
    assert.equal((await api('/api/risk/events/100/limits')).rules.length,0);await evaluate("document.getElementById('dialog').close()");
    await evaluate("document.getElementById('leagueRiskFilter').value='Fixture';document.getElementById('leagueRiskFilter').dispatchEvent(new Event('input'));document.querySelector('[data-league-risk]').click()");
    await until(()=>evaluate("!!document.getElementById('eventRiskForm')"),'league risk dialog');
    await evaluate("document.querySelector('#eventRiskForm [name=maxStake]').value='15';document.getElementById('eventRiskForm').requestSubmit()");
    await until(()=>evaluate("document.getElementById('message').textContent==='Limitet e ligës u ruajtën.'"),'league limit save');
    assert.equal((await api('/api/risk/leagues/700/limits')).rules.find(r=>r.scope_id===0).max_stake,15);
    await screenshot('center-league-risk.png');
    await evaluate("document.getElementById('removeEventLimit').click()");
    await until(()=>evaluate("document.getElementById('message').textContent==='Limiti u hoq.'"),'league limit removal');
    assert.equal((await api('/api/risk/leagues/700/limits')).rules.length,0);
    await evaluate("document.getElementById('dialog').close()");
    await navigate('live','.live-event');
    const longBet=await api('/api/bets','POST',{stake:5,selections:Array.from({length:12},(_,i)=>({gameId:String(200+i),gameApiId:String(200+i),coefId:'101',selection:'Home',odd:2,home:'Home team '+i,away:'Away team '+i,league:'Test league'}))},player,'browser-long-bet-0001');
    await until(()=>evaluate("document.querySelectorAll('#liveMetrics .metric-value')[0].textContent==='1'"),'live remains mounted');
    await navigate('bets?status=pending','.queue-ticket');
    await screenshot('center-pending-queue.png');
    await evaluate(`document.querySelector('[data-quick="offer"][data-id="${longBet.betId}"]').click()`);
    await until(()=>evaluate("!!document.getElementById('offerForm')"),'inline queue offer');
    assert(await evaluate("document.querySelector('.offer-footer').getBoundingClientRect().bottom<=innerHeight"),'offer submit visible on desktop');
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(100);
    assert(await evaluate("document.querySelector('.offer-footer').getBoundingClientRect().bottom<=innerHeight"),'offer submit visible on mobile');
    assert(await evaluate("document.querySelector('.offer-selections').scrollHeight>document.querySelector('.offer-selections').clientHeight"),'long selections scroll independently');
    await screenshot('center-quick-offer-mobile.png');
    await evaluate("document.getElementById('offerForm').requestSubmit()");await until(()=>evaluate("!document.getElementById('dialog').open"),'offer submit keeps queue');
    assert.equal(await evaluate('currentRoute'),'bets?status=pending');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.querySelector('[data-quick="accept"][data-id="${longBet.betId}"]').click()`);
    await until(()=>evaluate(`!document.querySelector('[data-queue-ticket="${longBet.betId}"]')`),'single-click queue acceptance');
    assert.equal((await api('/api/admin/bets/'+longBet.betId)).bet.status,'accepted');
    assert.equal(await evaluate("document.getElementById('dialog').open"),false,'acceptance has no extra dialog');
    const arriving=await api('/api/bets','POST',{stake:1,selections:[{gameId:'999',gameApiId:'999',coefId:'101',selection:'Home',odd:2,home:'New home',away:'New away'}]},player,'browser-arriving-bet');
    await until(()=>evaluate(`!!document.querySelector('[data-queue-ticket="${arriving.betId}"]')`),'new ticket arrives without page refresh');
    await evaluate(`document.querySelector('[data-quick="cancel"][data-id="${arriving.betId}"]').click()`);
    await until(()=>evaluate(`!document.querySelector('[data-queue-ticket="${arriving.betId}"]')`),'quick rejection');
    assert.equal((await api('/api/admin/bets/'+arriving.betId)).bet.status,'cancelled');
    await navigate('operators','#accountRows');await evaluate("document.querySelector('[data-action=create]').click()");assert.equal(await evaluate("document.getElementById('dialog').open"),true);
    await evaluate("document.querySelector('#createAccount [name=username]').value='operator_browser';document.querySelector('#createAccount [name=password]').value='Browser-fixture-password!';document.getElementById('createAccount').requestSubmit()");
    await until(()=>evaluate("!!document.getElementById('permissionForm')"),'operator creation');
    await evaluate("document.querySelector('#permissionForm [value=\"bets.view\"]').checked=true;document.getElementById('permissionForm').requestSubmit()");await until(()=>evaluate("document.getElementById('message').textContent.includes('u ruajtën')"),'permission save');
    await navigate('account/'+partner.id+'/finance','.tabs');await evaluate("document.querySelector('[data-action=account-transfer]').click();document.querySelector('#transferForm [name=amount]').value='12';document.getElementById('transferForm').requestSubmit()");await until(()=>evaluate("document.getElementById('message').textContent.includes('Transferimi u krye')"),'transfer');
    assert.equal((await api('/api/accounts/'+partner.id)).user.balance,12512);
    await navigate('ticket/'+bet.betId,'.ticket-meta');await evaluate("document.querySelector('[data-action=offer-ticket]').click();document.getElementById('offerForm').requestSubmit()");await until(()=>evaluate("document.getElementById('message').textContent.includes('Oferta iu dërgua')"),'odds offer');
    await evaluate("document.querySelector('[data-action=accept-ticket]').click();document.getElementById('confirmTicket').requestSubmit()");await until(()=>evaluate("!!document.querySelector('[data-action=won-ticket]')"),'accept');
    await evaluate("document.querySelector('[data-action=won-ticket]').click();document.getElementById('confirmTicket').requestSubmit()");await until(()=>evaluate("!!document.querySelector('#content .badge.won')"),'settlement');
    // A stale server or HTML proxy error must not leak a JSON parser exception.
    await evaluate(`window.originalFetch=window.fetch;window.fetch=(url,options)=>String(url)==='/api/admin/bets/${bet.betId}'?Promise.resolve(new Response('<!DOCTYPE html><h1>Not Found</h1>',{status:404,headers:{'Content-Type':'text/html'}})):window.originalFetch(url,options);renderRoute()`);
    await until(()=>evaluate("document.getElementById('message').classList.contains('error') && !document.getElementById('message').hidden"),'friendly HTML error');
    assert(!/Unexpected token|DOCTYPE|SyntaxError/.test(await evaluate("document.getElementById('message').textContent")));
    await evaluate("window.fetch=window.originalFetch;delete window.originalFetch;document.querySelector('[data-action=refresh]').click()");
    await until(()=>evaluate("!!document.querySelector('#content .badge.won')"),'retry recovers ticket');
    await navigate('dashboard','.metrics');await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(200);
    assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'),'mobile horizontal overflow');
    await evaluate("document.getElementById('mobileToggle').click()");assert.equal(await evaluate("document.getElementById('sidebar').classList.contains('open')"),true);await evaluate("document.getElementById('mobileShade').click()");
    await screenshot('center-mobile.png');
    // History restores the module and only the chosen account subpage is rendered.
    await navigate('account/'+partner.id+'/limits','#accountLimits');assert.equal(await evaluate("!!document.getElementById('transferForm') || !!document.getElementById('permissionForm')"),false);
    await evaluate("localStorage.removeItem('sportsbook_token')");
    await send('Page.navigate',{url:base+'/'});
    await until(()=>evaluate("typeof showSlipLimit==='function' && !!document.getElementById('betMsg')"),'user betslip loaded');
    for(const width of [1440,390]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width===390});
      await evaluate("slip=[{gameId:'100',key:'Home',odd:2,home:'Home',away:'Away'}];document.getElementById('betslip').classList.add('mobile-open');showSlipLimit(50,'stake')");
      await delay(100);
      assert(await evaluate("(()=>{const e=document.getElementById('slipLimitAlert'),r=e.getBoundingClientRect();return getComputedStyle(e).display!=='none' && r.height>20 && r.bottom<=innerHeight && r.top>=0 && e.textContent.includes('50')})()"),'limit message visible at '+width);
      assert(await evaluate("(()=>{const a=document.getElementById('betslip').getBoundingClientRect(),b=document.getElementById('slipLimitAlert').getBoundingClientRect();return Math.abs((a.top+a.height/2)-(b.top+b.height/2))<2})()"),'message centered in betslip');
      await screenshot('betslip-limit-'+width+'.png');
      await evaluate('renderSlip()');
      assert(await evaluate("document.getElementById('slipLimitAlert').textContent.includes('Shuma e bastit kalon limitin maksimal')"),'message survives live render');
      await until(()=>evaluate('slip.length===0 && slipLimitNotice===null'),'three-second slip cleanup');
    }
    assert.deepEqual(errors,[]);console.log('Backoffice browser checks: PASS — single Center entry, 14 modules, 6 account tabs, create, permissions, transfer, offer, accept, settle, mobile.');
    console.log('Screenshots: artifacts/center-desktop.png, artifacts/center-mobile.png');
  }catch(error){console.error('Browser exceptions:',errors);throw error;}finally{
    if(ws)ws.close();for(const proc of [chrome,server])if(proc&&proc.exitCode===null){proc.kill();await Promise.race([new Promise(r=>proc.once('exit',r)),delay(2000)]);}await new Promise(r=>provider.close(r));
    try{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('euro97-browser-'));fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{console.warn('Temporary browser profile could not be removed:',temp);}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
