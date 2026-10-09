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
    await send('Page.navigate',{url:base+'/'});
    await until(()=>evaluate("typeof setMode==='function'"),'sportsbook');
    assert(await evaluate("document.body.classList.contains('auth-required') && getComputedStyle(document.querySelector('.top')).display==='none' && document.getElementById('authModal').getBoundingClientRect().height>0"),'visitors see login first');
    for(const width of [1440,390]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width===390});
      await until(()=>evaluate("document.querySelector('.login-logo').complete"),'login logo');
      fs.mkdirSync(path.join(__dirname,'artifacts'),{recursive:true});
      const shot=await send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(__dirname,'artifacts',`baronbet-login-${width}.png`),Buffer.from(shot.data,'base64'));
    }
    await evaluate(`document.getElementById('username').value=${JSON.stringify(parent.username)};document.getElementById('password').value='Browser-fixture-password!';document.getElementById('authForm').requestSubmit()`);
    await until(()=>evaluate("!!user && !document.body.classList.contains('auth-required')"),'login form success');
    assert.equal(await evaluate("document.getElementById('password').value"),'');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1050,deviceScaleFactor:1,mobile:false});
    await evaluate(`sessionStorage.setItem('sportsbook_token',${JSON.stringify(player)})`);
    await send('Page.navigate',{url:base+'/?regression=1#/InPlay'});
    await until(()=>evaluate("!!user && !!document.querySelector('.live-row')"),'live player');
    await evaluate("window.trackerGame={id:'100',sport_id:1,home_team:'Home',away_team:'Away',result:'0-0'};window.trackerGroups=[[{stream_id:444,market:'Rezultat Final',mainCategory:'Kryesore',market_option:'X',market_option_id:123,odd:2}]];renderLiveMarketPanel(trackerGame,trackerGroups);window.savedTracker=document.querySelector('.live-match-tracker');renderLiveMarketPanel(trackerGame,trackerGroups)");
    assert(await evaluate("document.querySelector('.live-match-tracker')===savedTracker && savedTracker.src.includes('/a.html?id=100&lng=en')"),'tracker uses event ID and survives odds renders');
    await evaluate("window.pitchSize=document.querySelector('.football-pitch-only').getBoundingClientRect().toJSON();window.tabsTop=document.querySelector('.live-detail-tabs').getBoundingClientRect().top");
    await evaluate("window.beforeTvFetch=fetch;window.fetch=(url,opts)=>String(url).endsWith('/stream')?Promise.resolve(new Response(JSON.stringify({url:'https://example.com/player'}),{headers:{'Content-Type':'application/json'}})):beforeTvFetch(url,opts);document.querySelector('[data-live-view=tv]').click()");
    await until(()=>evaluate("!!document.querySelector('.live-tv-frame')"),'TV click');
    assert(await evaluate("(()=>{const r=document.querySelector('.live-tv-view').getBoundingClientRect();return Math.abs(r.width-pitchSize.width)<1&&Math.abs(r.height-pitchSize.height)<1&&Math.abs(document.querySelector('.live-detail-tabs').getBoundingClientRect().top-tabsTop)<1})()"),'TV matches pitch dimensions without moving markets');
    assert(await evaluate("!!document.querySelector('.live-tv-frame') && document.querySelector('.live-field-view').hidden"),'TV opens in its own view');
    await evaluate("window.savedTv=document.querySelector('.live-tv-frame');renderLiveMarketPanel(trackerGame,trackerGroups)");
    assert(await evaluate("document.querySelector('.live-tv-frame')===savedTv"),'odds refresh preserves video');
    await evaluate("document.querySelector('[data-live-view=field]').click();window.fetch=beforeTvFetch");
    assert(await evaluate("!document.querySelector('.live-tv-frame') && !document.querySelector('.live-field-view').hidden && document.querySelector('.live-match-tracker')===savedTracker"),'returning to field stops video and retains tracker');
    await evaluate("renderLiveMarketPanel({...trackerGame,id:'101'},trackerGroups)");
    assert(await evaluate("document.querySelector('.live-match-tracker')!==savedTracker && document.querySelector('.live-match-tracker').dataset.gameId==='101'"),'changing event replaces tracker');
    await evaluate("setMode('live')");
    await until(()=>evaluate("!!document.getElementById('liveSearchInput')"),'return from tracker');
    const suspended = await evaluate("(()=>{const saved=cache;try{cache=[{id:'israel',sport_id:1,home_team:'Israel',away_team:'Ireland',count_options:100,odd:'11|1|1|6575|Result,12|1|X|6575|Result,13|1|2|6575|Result'}];renderLive(cache);const result={rows:document.querySelectorAll('.live-row').length,locked:document.querySelectorAll('.live-odd:disabled').length};cache=[{id:'test',home_team:'Home',odd:'11|2|1|6575|Result'}];applyLiveGame({id:'test',result:'1-0'});result.preserved=cache[0].odd;applyLiveGame({id:'test',odd:''});result.cleared=cache[0].odd;return result;}finally{cache=saved;renderLive(cache)}})()");
    assert.equal(suspended.rows,1,'suspended 1X2 does not hide the event');
    assert.equal(suspended.locked,3,'all suspended summary prices remain disabled');
    assert.equal(suspended.preserved,'11|2|1|6575|Result','score-only updates preserve prices');
    assert.equal(suspended.cleared,'','explicit suspension clears old prices');
    assert(await evaluate("(()=>{const row=document.querySelector('.live-row');renderLive(cache);return row===document.querySelector('.live-row')})()"),'unchanged live rows retain their DOM nodes');
    await evaluate("document.getElementById('liveSearchInput').focus()");
    for(const char of 'Live Home')await send('Input.insertText',{text:char});
    assert.equal(await evaluate("document.activeElement.id"),'liveSearchInput');
    assert.equal(await evaluate("document.getElementById('liveSearchInput').value"),'Live Home');
    assert.equal(await evaluate("document.querySelectorAll('.live-row').length"),1);
    await evaluate("window.searchNode=document.getElementById('liveSearchInput');searchNode.setSelectionRange(5,9);renderLive(cache)");
    assert(await evaluate("document.getElementById('liveSearchInput')===searchNode && searchNode.selectionStart===5 && searchNode.selectionEnd===9"),'live updates preserve the input and selection');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    assert.equal(await evaluate('searchNode.value'),'Live ');
    await evaluate('searchNode.select()');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
    assert.equal(await evaluate('searchNode.value'),'');
    assert.equal(await evaluate("document.querySelectorAll('.live-row').length"),1,'clearing restores results');
    await send('Input.insertText',{text:'Live Home'});
    await send('Input.insertText',{text:'missing'});
    assert.equal(await evaluate("document.querySelectorAll('.live-row').length"),0);
    await evaluate("window.savedLiveCache=cache;cache=Array.from({length:225},(_,i)=>({id:String(1000+i),sport_id:1,home_team:'Team '+i,away_team:'Away',league:'League',odd:'101|2|1|1|Fulltime Result'}));window.actualRenderLive=renderLive;window.paintCount=0;renderLive=(...args)=>{paintCount++;return actualRenderLive(...args)};for(let i=0;i<3000;i++)applyLiveCoefs({game_id:String(1000+i%225),coefs:[{coef_id:'101',odd:2+(i%3)/10}]})");
    assert.equal(await evaluate('paintCount'),0,'push bursts do not rebuild the DOM synchronously');
    await delay(400);assert(await evaluate('paintCount>0 && paintCount<=2'),'push bursts are coalesced into bounded paints');
    await evaluate('renderLive=actualRenderLive;cache=savedLiveCache');
    await evaluate("setEventSearch('');window.originalFetch=fetch;window.fetch=(url,opts)=>String(url).includes('/api/livegames')?new Promise(resolve=>{window.releaseLive=()=>resolve(new Response(JSON.stringify(cache),{headers:{'Content-Type':'application/json'}}))}):originalFetch(url,opts);load();document.getElementById('myTopBtn').click()");
    await until(()=>evaluate("!!document.querySelector('[data-bet-card]')"),'my bets');
    await evaluate("setMyBetsDates('2020-01-01','2020-01-01');document.querySelector('.mybetsStatusTabs [data-status=all]').click()");
    await until(()=>evaluate("!!document.querySelector('[data-bet-card]')"),'All restores tickets outside the previous date filter');
    assert(await evaluate("!document.getElementById('fromDate').value&&!document.getElementById('toDate').value"),'All clears stale date filters');

    assert(await evaluate(`(async()=>{const savedFetch=window.fetch;try{window.fetch=(url,opts)=>{if(String(url).startsWith('/api/my-bets?')){const status=new URL(String(url),location.origin).searchParams.get('status');return Promise.resolve(new Response(JSON.stringify({bets:[{id:901,status:'pending',created_at:'2026-09-27 12:00:00',selections:[]},{id:902,status:'accepted',created_at:'2026-09-27 12:00:00',selections:[]}]}),{headers:{'Content-Type':'application/json'}}))}return savedFetch(url,opts)};myBetsStatus='pending';await loadMyBets();const pendingVisible=!!document.querySelector('[data-bet-card="901"]')&&!!document.querySelector('[data-bet-card="902"]')&&!document.querySelector('.betStatus').textContent;myBetsStatus='all';await loadMyBets();return pendingVisible&&document.querySelectorAll('[data-bet-card="901"]').length===1&&document.querySelectorAll('[data-bet-card="902"]').length===1;}finally{window.fetch=savedFetch;myBetsStatus='all';await loadMyBets();}})()`),'pending filter includes both approval and result waiting tickets without pending labels');

    await evaluate("releaseLive();window.fetch=originalFetch;applyLiveGame({id:'100',home_team:'Stale update'});applyLiveCoefs({game_id:'100',coefs:[]})");
    await delay(200);
    assert(await evaluate("mode==='mybets' && !!document.getElementById('betsList') && !document.querySelector('.live-table')"),'late live response cannot replace bets');
    await evaluate("window.transitionFetch=fetch;window.fetch=(url,opts)=>String(url).includes('/api/livegames')?new Promise(resolve=>{window.finishTransition=()=>resolve(new Response(JSON.stringify([{id:'100',home_team:'Live Home',away_team:'Live Away',odd:'101|2.5|1|1|Fulltime Result'}]),{headers:{'Content-Type':'application/json'}}))}):transitionFetch(url,opts);document.getElementById('liveBtn').click()");
    assert(await evaluate("mode==='live' && !document.getElementById('betsList') && !!document.querySelector('.live-row')"),'recent Live snapshot appears immediately even when the refresh is slow');
    await evaluate("finishTransition();window.fetch=transitionFetch");
    await until(()=>evaluate("!!document.querySelector('.live-row')"),'delayed live transition');
    await evaluate("location.hash='/InPlay'");await until(()=>evaluate("mode==='live' && !!document.querySelector('.live-row')"),'hash live');
    await evaluate("location.hash='/MyBets'");await until(()=>evaluate("mode==='mybets' && !!document.querySelector('[data-bet-card]')"),'hash bets');
    const restoreProbe=await send('Page.addScriptToEvaluateOnNewDocument',{source:`
      window.loginFlashed=false;
      const originalFetch=window.fetch;
      window.fetch=(url,options)=>String(url)==='/api/me'?new Promise(resolve=>setTimeout(resolve,800)).then(()=>originalFetch(url,options)):originalFetch(url,options);
      function checkLogin(){const el=document.getElementById('authModal');if(el&&el.getBoundingClientRect().height>0&&getComputedStyle(el).display!=='none')window.loginFlashed=true;if(!window.restoreProbeDone)requestAnimationFrame(checkLogin)}
      requestAnimationFrame(checkLogin);
    `});
    await send('Page.reload');await until(()=>evaluate("!!user && mode==='mybets' && !!document.querySelector('[data-bet-card]')"),'reload bets');
    assert.equal(await evaluate("window.restoreProbeDone=true;window.loginFlashed"),false,'saved session never flashes login during a slow restore');
    assert.equal(await evaluate("document.documentElement.classList.contains('session-restoring')"),false);
    await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:restoreProbe.identifier});
    for(const width of [1440,768,390,320]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<=650});
      assert(await evaluate("!!document.getElementById('betsList')"));
      await until(()=>evaluate("Array.from(document.querySelectorAll('.top .brand img')).every(img=>img.complete && img.naturalWidth>0)"),'brand assets');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.top .brand-monogram')).display"),width<=650?'block':'none');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.top .brand-wordmark')).display"),width<=650?'none':'block');
      assert(await evaluate("(()=>{const a=document.querySelector('.top .brand').getBoundingClientRect(),b=document.getElementById('myTopBtn').getBoundingClientRect();return a.right<=b.left || b.right<=a.left})()"),'logo and My Bets do not overlap');
      fs.mkdirSync(path.join(__dirname,'artifacts'),{recursive:true});
const capture=await send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width,height:844,scale:1}});
      fs.writeFileSync(path.join(__dirname,'artifacts',`baronbet-navbar-${width}.png`),Buffer.from(capture.data,'base64'));
    }
    await evaluate("openSportsHome()");await until(()=>evaluate("mode==='home' && !!document.getElementById('sportsToday')"),'home');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.controls')).display"),'none','original Sport design has no added search/filter toolbar');
    await evaluate("cache=[{id:'s1',sport_id:1,home_team:'Tiranë',away_team:'Durrës',league:'Superliga',odd:'1|2|1|1|Fulltime Result'},{id:'s2',sport_id:1,home_team:'Roma',away_team:'Milan',league:'Serie A',odd:'2|2|1|1|Fulltime Result'}];setEventSearch('tirane')");
    assert.equal(await evaluate("document.querySelectorAll('.match').length"),1);
    await evaluate("document.getElementById('sideSearch').value='Roma';document.getElementById('sideSearch').dispatchEvent(new Event('input'))");
    assert(await evaluate("document.getElementById('content').textContent.includes('Roma')&&!document.getElementById('content').textContent.includes('Tiranë')"));
    await evaluate("sportsHomeTab='category';document.getElementById('content').innerHTML='<div id=categoryBody><button class=sports-category-row>Shqipëri</button><button class=sports-category-row>Italy</button></div>';setEventSearch('shqiperi')");
    assert.equal(await evaluate("document.querySelectorAll('.sports-category-row:not([hidden])').length"),1);
    await evaluate("pendingTicket=null;slipLimitNotice=null;slip=[{gameId:'100',key:'1',home:'Home',away:'Away',odd:2.5,previousOdd:2,oddsChanged:true,invalid:false}];renderOddsAcceptance()");
    assert(await evaluate("document.getElementById('slipOddsNotice').hidden"),'price updates do not interrupt with acceptance');
    await evaluate("document.getElementById('stake').value='5';placeBet()");
    assert(await evaluate("!document.getElementById('slipOddsNotice').hidden"),'placing requests odds confirmation');
    await evaluate("window.actualPlace=placeBet;window.confirmedCalls=0;placeBet=()=>{confirmedCalls++};document.querySelector('#slipOddsNotice button').click()");
    assert(await evaluate("confirmedCalls===1 && !slip[0].oddsChanged && document.getElementById('slipOddsNotice').hidden"),'acceptance submits automatically exactly once');
    await evaluate("placeBet=actualPlace;slip=[];renderSlip()");
    await evaluate(`sessionStorage.setItem('sportsbook_token',${JSON.stringify(root)})`);
    await send('Page.navigate',{url:base+'/backoffice.html'});await until(()=>evaluate("!!document.querySelector('.metrics')"),'backoffice');
    await evaluate("location.hash='/configuration'");await until(()=>evaluate("!!document.getElementById('acceptanceForm')"),'acceptance configuration');
    for(const width of [1440,390]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width===390});
      assert.equal(await evaluate("document.querySelectorAll('#acceptanceForm input[type=number]').length"),8);
      assert.equal(await evaluate("document.querySelectorAll('#acceptanceForm input:checked').length"),0);
      const shot=await send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(__dirname,'artifacts',`center-acceptance-${width}.png`),Buffer.from(shot.data,'base64'));
    }
    await evaluate("document.querySelector('#search input').value='partner_tirana';document.getElementById('search').dispatchEvent(new Event('submit',{cancelable:true}))");
    await until(()=>evaluate("document.getElementById('content').textContent.includes('partner_tirana')"),'global search');
    await evaluate("location.hash='/accounts'");await until(()=>evaluate("!!document.getElementById('accountFilter')"),'account search');
    await evaluate("document.getElementById('accountFilter').value='partner_tirana';document.getElementById('accountFilter').dispatchEvent(new Event('input'))");
    assert(await evaluate("document.getElementById('content').textContent.includes('partner_tirana') && !document.getElementById('content').textContent.includes('partner_prishtina')"));
    for(const [route,input] of [['network','treeSearch'],['bets','betFilter'],['finance/ledger','financeFilter'],['risk','leagueRiskFilter'],['api-monitor','monitorSearch'],['live','eventFilter'],['audit','auditFilter']]){
      await evaluate(`location.hash=${JSON.stringify('/'+route)}`);await until(()=>evaluate(`!!document.getElementById(${JSON.stringify(input)})`),'search field '+input);
      for(const value of ['zz-no-matching-result',''])await evaluate(`document.getElementById(${JSON.stringify(input)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(input)}).dispatchEvent(new Event('input'))`);
    }
    assert.deepEqual(errors,[]);console.log('Navigation and search browser: PASS (late Live responses, My Bets routes/reload, desktop/mobile, live typing, accents, sidebar/category, admin global/accounts).');
  }catch(error){console.error('Browser exceptions:',errors);throw error;}finally{
    if(ws)ws.close();for(const proc of [chrome,server])if(proc&&proc.exitCode===null){proc.kill();await Promise.race([new Promise(r=>proc.once('exit',r)),delay(2000)]);}await new Promise(r=>provider.close(r));
    try{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('euro97-browser-'));fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{console.warn('Temporary browser profile could not be removed:',temp);}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
