'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/euro07.bet/vbet/user/build/main.js','utf8');

test('mobile stake panel remains inside the visible viewport while the keyboard opens and pans',()=>{
  const styles=new Map();
  const window={innerWidth:390,innerHeight:844,visualViewport:{height:844,offsetTop:0}};
  const ctx=vm.createContext({window,$:()=>({style:{setProperty:(key,value)=>styles.set(key,value),removeProperty:key=>styles.delete(key)}})});
  vm.runInContext(source.slice(source.indexOf('function syncMobileSlipViewport('),source.indexOf("window.visualViewport?.addEventListener('resize'")),ctx);
  for(const viewport of [{height:844,offsetTop:0},{height:400,offsetTop:0},{height:400,offsetTop:180},{height:844,offsetTop:0}]){
    window.visualViewport=viewport;ctx.syncMobileSlipViewport();
    const top=parseFloat(styles.get('--mobile-slip-top')),height=parseFloat(styles.get('--mobile-slip-height'));
    assert(top>=viewport.offsetTop);assert(height<=viewport.height);
    assert(Math.abs(top+height-(viewport.offsetTop+viewport.height))<.001,'stake footer stays directly above keyboard');
  }
  window.visualViewport=null;window.innerHeight=450;ctx.syncMobileSlipViewport();
  assert.equal(parseFloat(styles.get('--mobile-slip-top'))+parseFloat(styles.get('--mobile-slip-height')),450);
  window.innerWidth=1440;ctx.syncMobileSlipViewport();assert.equal(styles.size,0,'desktop layout is restored');
});

test('mobile betslip grows and shrinks with selections and keeps the footer above the keyboard',()=>{
  const styles=new Map();let selectionsHeight=0;
  const window={innerWidth:390,innerHeight:844,visualViewport:{height:844,offsetTop:0}};
  const panel={style:{setProperty:(key,value)=>styles.set(key,value),removeProperty:key=>styles.delete(key)},querySelector:selector=>({scrollHeight:selector==='.slipbody'?selectionsHeight:selector==='.sliphead'?50:selector==='.slipModeTabs'?40:60})};
  const ctx=vm.createContext({window,$:()=>panel});
  vm.runInContext(source.slice(source.indexOf('function syncMobileSlipViewport('),source.indexOf("window.visualViewport?.addEventListener('resize'")),ctx);
  for(const count of [0,1,2,3,2,1,0]){
    selectionsHeight=count*90;ctx.syncMobileSlipViewport();
    assert.equal(parseFloat(styles.get('--mobile-slip-height')),150+count*90);
    assert.equal(parseFloat(styles.get('--mobile-slip-top'))+parseFloat(styles.get('--mobile-slip-height')),844);
  }
  selectionsHeight=1500;window.visualViewport={height:400,offsetTop:100};ctx.syncMobileSlipViewport();
  assert.equal(parseFloat(styles.get('--mobile-slip-height')),344);
  assert.equal(parseFloat(styles.get('--mobile-slip-top'))+344,500);
});

test('live selections wait for a completed click instead of the start of scrolling',()=>{
  const ctx=vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function isNewLiveActivation'),source.indexOf('function clockToSeconds')),ctx);
  for(const pointerType of ['touch','pen','mouse']){
    assert.equal(ctx.isNewLiveActivation({type:'pointerdown',button:0,pointerType},'live-odd:1:1'),false);
    assert.equal(ctx.isNewLiveActivation({type:'pointercancel',button:0,pointerType},'live-odd:1:1'),false);
  }
  assert.equal(ctx.isNewLiveActivation({type:'click',button:0},'live-odd:1:1'),true);
  assert.equal(ctx.isNewLiveActivation({type:'click',button:0,detail:0},'live-option:1:1:1'),true,'keyboard activation works');
  assert.equal(ctx.isNewLiveActivation({type:'click',button:2},'live-odd:1:1'),false);
});

test('slow feeds share one request and navigation aborts the previous request',async()=>{
  const requests=[];
  const ctx=vm.createContext({AbortController,setTimeout,clearTimeout,mode:'live',selectedPrematchLeague:'',sportsHomeTab:'home',loadOnce:signal=>new Promise(resolve=>{requests.push({signal,resolve});})});
  vm.runInContext(source.slice(source.indexOf('let pageLoad='),source.indexOf('async function loadOnce(')),ctx);
  const first=ctx.load();for(let i=0;i<100;i++)assert.equal(ctx.load(),first);
  assert.equal(requests.length,1);
  ctx.cancelPageLoad();assert.equal(requests[0].signal.aborted,true);
  ctx.mode='home';const second=ctx.load();assert.equal(requests.length,2);
  requests[0].resolve();await first;
  assert.equal(ctx.load(),second,'an old completion must not clear the new request');
  requests[1].resolve();await second;
  ctx.mode='mybets';await ctx.load();assert.equal(requests.length,2);
});
function fixture(){
  const context=vm.createContext({Date});
  vm.runInContext(`const liveClockState=new Map(),liveClockRevision=new Map();let cache=[],mode='live',openLiveGameId=null;const liveMarketsCache=new Map();function queueLivePaint(){}function renderLive(){}function renderSlip(){}function refreshLiveMarkets(){}function hasLiveSummaryOdds(g){return !!g.odd}`+source.slice(source.indexOf('function clockToSeconds'),source.indexOf('function tickLiveClocks'))+source.slice(source.indexOf('function liveGameId'),source.indexOf('function setHashForMode'))+source.slice(source.indexOf('function applyLiveGame'),source.indexOf('let apiStatusRequest=')),context);
  return code=>vm.runInContext(code,context);
}
test('provider clock stays at halftime without a status and accepts corrections',()=>{
  const run=fixture();
  assert.equal(run("syncLiveClock({id:1,current_minute:'45:00'})"),'45:00');
  run('Date={now:()=>9999999999999}');
  assert.equal(run("syncLiveClock({id:1,current_minute:'45:00'})"),'45:00');
  assert.equal(run("syncLiveClock({id:1,current_minute:'44:59',api_status:1})"),'44:59');
  assert.equal(run("syncLiveClock({id:1,current_minute:'45:01',api_status:1})"),'45:01');
  assert.equal(run("syncLiveClock({id:1,current_minute:'HT'})"),'HT');
});
test('push time replaces elapsed time, preserves kickoff and resumes only on API update',()=>{
  const run=fixture();
  run("cache=[{id:1,current_minute:'48:00',game_time:'20:30:00',odd:'odds'}];applyLiveGame({id:1,game_time:'45:00'})");
  assert.equal(run('getLiveClock(cache[0])'),'45:00');
  assert.equal(run('cache[0].game_time'),'20:30:00');
  run("applyLiveGame({id:1,game_time:'45:00'})");
  assert.equal(run('getLiveClock(cache[0])'),'45:00');
  run("applyLiveGame({id:1,game_time:'45:02'})");
  assert.equal(run('getLiveClock(cache[0])'),'45:02');
  assert.equal(run('cache[0].odd'),'odds');
});

test('seconds interpolate smoothly between ten-second API samples and stop at halftime',()=>{
  const run=fixture();run('let testNow=0;Date={now:()=>testNow}');
  run("syncLiveClock({id:1,current_minute:'44:40',sport_id:1})");
  for(let i=1;i<=10;i++){run('testNow='+i*1000);assert.equal(run('getLiveClock({id:1})'),'44:'+String(40+i));}
  run("syncLiveClock({id:1,current_minute:'44:50',sport_id:1})");
  run('testNow=11000');assert.equal(run('getLiveClock({id:1})'),'44:51');
  run('testNow=20000');assert.equal(run('getLiveClock({id:1})'),'45:00');
  run("syncLiveClock({id:1,current_minute:'45:00',sport_id:1})");
  run('testNow=200000');assert.equal(run('getLiveClock({id:1})'),'45:00');
  run("syncLiveClock({id:1,current_minute:'45:01',sport_id:1})");
  run('testNow=201000');assert.equal(run('getLiveClock({id:1})'),'45:02');
});
test('unchanged samples and rendering cannot keep a stale clock running',()=>{
  const run=fixture();run('let testNow=0;Date={now:()=>testNow}');
  run("syncLiveClock({id:1,current_minute:'32:00'})");
  for(let i=1;i<=30;i++){run('testNow='+i*1000);run("syncLiveClock({id:1,current_minute:'32:00'})");}
  assert.equal(run('getLiveClock({id:1})'),'32:12');
  run("syncLiveClock({id:1,current_minute:'32:00',api_status:2})");
  assert.equal(run('getLiveClock({id:1})'),'32:00');
});
