'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function until(fn,label){for(let i=0;i<100;i++){if(await fn())return;await delay(100);}throw Error('Timed out: '+label);}
async function main(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-user-management-')),port=await freePort(),debugPort=await freePort(),base='http://127.0.0.1:'+port;
  let server,chrome,ws;const errors=[];
  try{
    server=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_FILE:path.join(temp,'test.db'),CENTER_PASSWORD:'Fixture-password!',DISABLE_UPSTREAM:'true'},windowsHide:true,stdio:'ignore'});
    await until(async()=>{try{return (await fetch(base+'/api/health')).ok;}catch{return false;}},'server');
    let token;
    async function api(url,body){const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});const d=await r.json();assert(r.ok,JSON.stringify(d));return d;}
    token=(await api('/api/auth/login',{username:'center',password:'Fixture-password!'})).token;
    const create=async(role,username,parentId)=>(await api('/api/accounts',{role,username,parentId,password:'Fixture-password!'})).user;
    const partner=await create('partner','partner_tirana',1);await create('partner','partner_other',1);await create('operator','operator_main',1);
    let parent=partner;for(const role of ['admin','senior','manager','agent','user'])parent=await create(role,role+'_tirana',parent.id);
    for(let i=0;i<26;i++)await create('operator','operator_extra_'+i,1);
    chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu','--remote-debugging-port='+debugPort,'--user-data-dir='+path.join(temp,'chrome'),'about:blank'],{windowsHide:true,stdio:'ignore'});
    let target;await until(async()=>{try{target=(await fetch('http://127.0.0.1:'+debugPort+'/json').then(r=>r.json())).find(p=>p.type==='page');return !!target;}catch{return false;}},'browser');
    ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
    let seq=0;const pending=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
    await send('Page.enable');await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument',{source:`sessionStorage.setItem('sportsbook_token',${JSON.stringify(token)});`});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url:base+'/backoffice.html#/user-management'});
    await until(()=>evaluate("!!document.querySelector('#accountRows table')"),'directory');
    assert.equal(await evaluate("document.querySelectorAll('[data-nav=user-management]').length"),1);
    assert.equal(await evaluate("document.querySelectorAll('[data-nav=partners],[data-nav=operators],[data-nav=accounts],[data-nav=network]').length"),0);
    assert.equal(await evaluate("document.querySelectorAll('#accountRows tbody tr').length"),25);
    await evaluate("document.querySelector('[data-management-page=\"1\"]').click()");
    assert(await evaluate("document.querySelector('#managementPagination').textContent.includes('Faqja 2')"),'pagination advances');
    await evaluate("document.getElementById('accountFilter').value='user_tirana';document.getElementById('accountFilter').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.querySelectorAll('#accountRows tbody tr').length"),1);
    await evaluate("document.querySelector('[data-management-view=tree]').click()");
    assert(await evaluate("document.querySelector('#tree').textContent.includes('partner_tirana') && document.querySelector('#tree').textContent.includes('user_tirana')"),'matching leaf retains ancestors');
    await evaluate("document.getElementById('collapseTree').click()");
    assert(await evaluate("[...document.querySelectorAll('#tree .tree-node')].every(n=>!n.open)"));
    await evaluate("document.getElementById('resetManagement').click();document.querySelector('[data-management-view=list]').click();document.querySelector('[data-management-role=operator]').click()");
    assert.equal(await evaluate("document.querySelectorAll('#accountRows tbody tr').length"),25);
    await evaluate("document.querySelector('[data-management-page=\"1\"]').click()");
    assert.equal(await evaluate("document.querySelectorAll('#accountRows tbody tr').length"),2);
    await evaluate("document.querySelector('[data-action=create]').click()");
    assert.equal(await evaluate("document.querySelector('#newRole').value"),'operator');
    await evaluate("document.getElementById('dialog').close();document.getElementById('resetManagement').click();document.querySelector('[data-management-branch]').click()");
    assert(await evaluate("!document.querySelector('#accountRows').textContent.includes('partner_other')"),'branch excludes other partners');
    await send('Page.reload');await until(()=>evaluate("!!document.querySelector('#branchFilter') && !!document.querySelector('#branchFilter').value"),'filters survive reload');
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    assert(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"),'mobile page fits viewport');
    await evaluate("document.getElementById('resetManagement').click();location.hash='/network'");await until(()=>evaluate("document.querySelector('#tree')?.hidden===false"),'legacy network route');
    assert(await evaluate("location.hash.includes('/user-management')"),'legacy route opens unified workspace');
    const playerToken=(await api('/api/auth/login',{username:'user_tirana',password:'Fixture-password!'})).token;
    await send('Page.addScriptToEvaluateOnNewDocument',{source:`sessionStorage.setItem('sportsbook_token',${JSON.stringify(playerToken)});`});
    await send('Page.navigate',{url:base+'/'});
    await until(()=>evaluate("typeof renderSlip==='function' && user?.role==='user'"),'player page');
    await evaluate("window.fixturePick=i=>({id:String(i),gameId:String(i),key:'1',odd:2,market:'Rezultat Final',home:'Home '+i,away:'Away '+i,league:'Fixture'});slip=[fixturePick(1)];renderSlip();document.getElementById('mobileSlipBar').click()");
    await delay(150);
    const singleHeight=await evaluate("document.getElementById('betslip').getBoundingClientRect().height");
    assert(singleHeight>100&&singleHeight<350,'one selection has compact height');
    const checkBottom=()=>evaluate("Math.abs(document.getElementById('betslip').getBoundingClientRect().bottom-(visualViewport.offsetTop+visualViewport.height))<2");
    assert(await checkBottom(),'compact slip is anchored at bottom');
    await evaluate("slip=Array.from({length:4},(_,i)=>fixturePick(i));renderSlip()");
    assert((await evaluate("document.getElementById('betslip').getBoundingClientRect().height"))>singleHeight+100,'selections grow upward');
    await evaluate("slip=Array.from({length:15},(_,i)=>fixturePick(i));renderSlip()");
    assert(await checkBottom(),'long slip remains anchored at bottom');
    await evaluate("slip=[fixturePick(1)];renderSlip()");
    assert(Math.abs((await evaluate("document.getElementById('betslip').getBoundingClientRect().height"))-singleHeight)<2,'removing selections eliminates leftover blank space');
    await evaluate("document.getElementById('slipClose').click();document.getElementById('mobileSlipBar').click()");await delay(100);
    assert(Math.abs((await evaluate("document.getElementById('betslip').getBoundingClientRect().height"))-singleHeight)<2,'reopening a hidden slip measures content');
    console.log('Mobile betslip browser: PASS — compact single selection, upward growth, shrinking and reopening.');
    await evaluate("document.getElementById('slipClose').click();mode='live';openLiveGameId=null;selectedSport='soccer';cache=Array.from({length:3},(_,i)=>({id:String(i+1),sport_id:1,league:'Premier League',home_team:'Ipswich',away_team:'Fulham',result:'0-0',current_minute:'47:14',count_options:398,odd:'101|3.5|1|1,102|2.5|X|1,103|2.63|2|1'}));renderLive(cache)");
    for(const width of [313,331,390]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
      assert(await evaluate("[...document.querySelectorAll('.live-row')].every(row=>row.getBoundingClientRect().height===56)"),'live rows match 56px reference');
      assert(await evaluate("[...document.querySelectorAll('.live-info')].every(info=>info.scrollHeight<=info.clientHeight)"),'team names and clock fit compact rows');
    }
    console.log('Mobile live rows browser: PASS — 56px reference height at 313, 331 and 390px widths.');
    assert.deepEqual(errors,[]);console.log('User Management browser: PASS — single nav, search, ancestor tree, role creation, branch filtering, reload, mobile, legacy routes.');
  }finally{
    ws?.close();for(const proc of [chrome,server])if(proc&&proc.exitCode===null){proc.kill();await Promise.race([new Promise(r=>proc.once('exit',r)),delay(2000)]);}
    const resolved=path.resolve(temp);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert(path.basename(resolved).startsWith('euro97-user-management-'));
    fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
