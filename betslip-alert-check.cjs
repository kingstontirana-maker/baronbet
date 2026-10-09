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
    for(const width of [1440,390]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width===390});
      await evaluate("slip=[{gameId:'100',key:'Home',odd:2,home:'Home',away:'Away'}];user={id:1,role:'user'};token='test';document.getElementById('stake').value='51';window.savedFetch=window.fetch;window.fetch=(url,opts)=>url==='/api/bets'?Promise.resolve(new Response(JSON.stringify({code:'BET_LIMIT_EXCEEDED',limitAmount:50,limitKind:'stake'}),{status:400,headers:{'Content-Type':'application/json'}})):savedFetch(url,opts);placeBet()");
      await delay(100);
      assert(await evaluate("(()=>{const e=document.getElementById('slipLimitAlert'),r=e.getBoundingClientRect();return getComputedStyle(e).display!=='none' && r.height>20 && r.bottom<=innerHeight && r.top>=0 && e.textContent.includes('50')})()"),'limit message visible at '+width);
      assert(await evaluate("(()=>{const a=document.getElementById('betslip').getBoundingClientRect(),b=document.getElementById('slipLimitAlert').getBoundingClientRect();return Math.abs((a.top+a.height/2)-(b.top+b.height/2))<2})()"),'message centered in betslip');
      await screenshot('betslip-limit-'+width+'.png');
      await evaluate('renderSlip()');
      assert(await evaluate("document.getElementById('slipLimitAlert').textContent.includes('Shuma e bastit kalon limitin maksimal')"),'message survives live render');
      await until(()=>evaluate('slip.length===0 && slipLimitNotice===null'),'three-second slip cleanup');
      await evaluate('window.fetch=window.savedFetch');
    }
    assert.deepEqual(errors,[]);console.log('Betslip rejection browser checks: PASS — submitted bet rejection, desktop/mobile centered alert, live rerender, three-second cleanup.');
    console.log('Screenshots: artifacts/betslip-limit-1440.png, artifacts/betslip-limit-390.png');
  }catch(error){console.error('Browser exceptions:',errors);throw error;}finally{
    if(ws)ws.close();for(const proc of [chrome,server])if(proc&&proc.exitCode===null){proc.kill();await Promise.race([new Promise(r=>proc.once('exit',r)),delay(2000)]);}await new Promise(r=>provider.close(r));
    try{assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('euro97-browser-'));fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{console.warn('Temporary browser profile could not be removed:',temp);}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
