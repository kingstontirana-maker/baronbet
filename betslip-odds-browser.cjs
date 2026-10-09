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
    await evaluate("localStorage.removeItem('sportsbook_token')");
    await send('Page.navigate',{url:base+'/'});
    await until(()=>evaluate("typeof showSlipLimit==='function' && !!document.getElementById('betMsg')"),'user betslip loaded');
    await evaluate(`pendingTicket=null;user={role:'user',balance:500};token='fixture';slip=[{gameId:'100',key:'Home',home:'Home',away:'Away',marketType:'detail',odd:2.5,previousOdd:2,oddsChanged:true,coefId:'101'}];document.getElementById('stake').value='';renderSlip();window.requests=[];window.realFetch=window.fetch;window.fetch=async(url,opts)=>{if(url!='/api/bets')return window.realFetch(url,opts);requests.push(JSON.parse(opts.body));return new Response(JSON.stringify({oddsChanged:[{gameId:'100',selection:'Home',newOdd:2.8}]}),{status:409,headers:{'Content-Type':'application/json'}})}`);
    assert(await evaluate("!document.getElementById('slipOddsNotice').hidden && document.getElementById('place').textContent.includes('Vendos') && !document.getElementById('place').textContent.includes('Prano')"));
    await evaluate("document.getElementById('place').click()");assert.equal(await evaluate('requests.length'),0);
    await evaluate("document.querySelector('#slipOddsNotice button').click()");
    assert(await evaluate("requests.length===0 && !pendingTicket && slip[0].odd===2.5 && !slip[0].oddsChanged && document.getElementById('slipOddsNotice').hidden && document.getElementById('stake').value===''") ,'accept without stake does not submit');
    await evaluate("document.getElementById('stake').value='10';document.getElementById('place').click()");
    await until(()=>evaluate("requests.length===1 && document.getElementById('place').dataset.busy==='0'"),'revalidation');
    assert(await evaluate("!document.getElementById('slipOddsNotice').hidden && slip[0].odd===2.8 && requests[0].selections[0].odd===2.5"));
    await evaluate(`window.fetch=async(url,opts)=>{if(url!='/api/bets')return window.realFetch(url,opts);requests.push(JSON.parse(opts.body));return new Response(JSON.stringify({error:'Kredit i pamjaftueshëm'}),{status:400,headers:{'Content-Type':'application/json'}})};document.querySelector('#slipOddsNotice button').click()`);
    assert(await evaluate("requests.length===1 && !pendingTicket && !slip[0].oddsChanged && slip[0].odd===2.8"),'accept with stake does not submit');
    await evaluate("document.getElementById('place').click()");
    await until(()=>evaluate("requests.length===2 && document.getElementById('place').dataset.busy==='0'"),'credit rejection');
    assert(await evaluate("!pendingTicket && slip.length===1 && document.getElementById('betMsg').textContent==='Kredit i pamjaftueshëm'"));
    await evaluate(`slip[0].oddsChanged=true;renderSlip();window.fetch=async(url,opts)=>{if(url!='/api/bets')return window.realFetch(url,opts);requests.push(JSON.parse(opts.body));return new Response(JSON.stringify({betId:99999,balance:490,reservedBalance:10,totalOdds:2.8}),{status:200,headers:{'Content-Type':'application/json'}})};document.querySelector('#slipOddsNotice button').click();document.querySelector('#slipOddsNotice button').click()`);
    assert.equal(await evaluate('requests.length'),2);
    await evaluate("document.getElementById('place').click();document.getElementById('place').click()");
    await until(()=>evaluate('!!pendingTicket'),'accepted submission');
    assert(await evaluate("requests.length===3 && requests[2].selections[0].odd===2.8 && slip.length===0 && document.getElementById('slipOddsNotice').hidden"));
    assert.deepEqual(errors,[]);console.log('Odds acceptance: PASS — acceptance with empty/filled stake does not submit; explicit placement revalidates and prevents duplicates.');

  }catch(error){console.error('Browser exceptions:',errors);throw error;}finally{
    if(ws)ws.close();for(const proc of [chrome,server])if(proc&&proc.exitCode===null){proc.kill();await Promise.race([new Promise(r=>proc.once('exit',r)),delay(2000)]);}await new Promise(r=>provider.close(r));
    try{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('euro97-browser-'));fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{console.warn('Temporary browser profile could not be removed:',temp);}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
