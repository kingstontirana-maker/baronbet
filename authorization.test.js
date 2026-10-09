'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const {spawn}=require('child_process');
const http=require('http');

test('direct API: RBAC, hierarchy, limits, ledger, revocation and legacy isolation',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-auth-'));
  // Deterministic provider fixture; production handlers still validate server odds.
  let invalidFeed=false,fixtureOdd=2;
  const provider=http.createServer((req,res)=>{if(req.url==='/ajax/livestream/444'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,url:'https://example.com/live-player'}));return;}if(invalidFeed){res.setHeader('Content-Type','text/html');res.end('<!DOCTYPE html><h1>Provider unavailable</h1>');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.startsWith('/ajax/livegame/')?[{stream_id:444,id:'50101',market_option_id:'101',odd:fixtureOdd,market_id:'1',market_option:'Home',market:'Fulltime Result'}]:[{id:'100',current_minute:'10:00',game_api_id:'100',league_id:700,league:'Fixture League'},...Array.from({length:12},(_,i)=>({id:String(200+i),league_id:700,league:'Fixture League'})),{id:'999',league_id:701,league:'Other League'}]));});
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const startServer=()=>spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_FILE:path.join(dir,'test.db'),CENTER_PASSWORD:'Test-only-root-917!',DISABLE_UPSTREAM:'true',VBET_BASE:'http://127.0.0.1:'+provider.address().port},stdio:['ignore','pipe','pipe']});
  let child=startServer();
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  t.after(async()=>{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await new Promise(r=>provider.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+port;
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===99)throw Error('Startup timeout: '+output);}
  async function api(url,token,method='GET',body,expected=200,key){
    if(url==='/api/bets'&&!key)key=require('crypto').randomUUID();
    const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();assert.equal(response.status,expected,`${method} ${url}: ${JSON.stringify(data)}`);return data;
  }
  const login=async(username,password='Fixture-password!')=>(await api('/api/auth/login',null,'POST',{username,password})).token;
  let root=await login('center','Test-only-root-917!');
  await t.test('staff sessions expire within 30 minutes and cannot survive server restart',async()=>{
    await api('/api/access/me',null,'GET',undefined,401);
    await api('/api/admin/audit',null,'GET',undefined,401);
    const {sessions}=await api('/api/sessions',root);
    const current=sessions.find(s=>s.current);
    assert(current);assert(Date.parse(current.expires_at)<=Date.now()+30*60*1000);
    const oldToken=root;
    const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;
    child=startServer();child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    let ready=false;
    for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
    assert(ready,'Restart timeout');
    await api('/api/access/me',oldToken,'GET',undefined,401);
    await api('/api/admin/audit',oldToken,'GET',undefined,401);
    root=await login('center','Test-only-root-917!');
    await api('/api/access/me',root);
  });
  await t.test('unknown APIs, invalid request JSON and upstream HTML always return JSON',async()=>{
    await api('/api/not-a-real-endpoint',root,'GET',undefined,404);
    const malformed=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad-json'});
    assert.equal(malformed.status,400);assert.match(malformed.headers.get('content-type'),/application\/json/);assert.equal((await malformed.json()).code,'INVALID_REQUEST');
    const oversized=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({padding:'x'.repeat(270000)})});
    assert.equal(oversized.status,413);assert.equal((await oversized.json()).code,'INVALID_REQUEST');
    invalidFeed=true;
    try{for(const url of ['/api/prematch','/api/livegames','/api/livegame/100']){const data=await api(url,root,'GET',undefined,502);assert.equal(data.code,'UPSTREAM_INVALID_RESPONSE');}}finally{invalidFeed=false;}
  });
  const create=async(role,username,parentId,token=root)=>(await api('/api/accounts',token,'POST',{role,username,password:'Fixture-password!',parentId},201)).user;
  const branches=[];
  for(const suffix of ['a','b']){
    const branch={};let parentId=1;
    for(const role of ['partner','admin','senior','manager','agent','user']){
      const u=await create(role,role+'_'+suffix,parentId);branch[role]={...u,token:await login(u.username)};parentId=u.id;
    }branches.push(branch);
  }
  const [a,b]=branches;
  await t.test('each business level rejects other branch IDs',async()=>{
    for(const [role,targetRole] of [['partner','partner'],['admin','senior'],['senior','manager'],['manager','agent'],['agent','user']]){
      await api('/api/accounts/'+b[targetRole].id,a[role].token,'GET',undefined,403);
      const tree=await api('/api/network',a[role].token);assert(tree.users.every(u=>!Object.values(b).some(v=>v.id===u.id)));
      await api('/api/accounts/'+b[targetRole].id+'/status',a[role].token,'POST',{status:'suspended'},403);
    }
    await api('/api/accounts/'+a.user.id,a.agent.token);
  });
  await t.test('same partner sibling branches are isolated',async()=>{
    const admin=await create('admin','admin_sibling',a.partner.id);
    const senior=await create('senior','senior_sibling',admin.id);
    await api('/api/accounts/'+senior.id,a.admin.token,'GET',undefined,403);
    await api('/api/accounts/'+senior.id,a.partner.token);
    for(const [role,parent] of [['senior',a.admin],['manager',a.senior],['agent',a.manager]]){
      const sibling=await create(role,role+'_same_parent',parent.id);
      await api('/api/accounts/'+sibling.id,a[role].token,'GET',undefined,403);
    }
  });
  await t.test('new hierarchy and privilege escalation',async()=>{
    await create('senior','created_by_admin',a.admin.id,a.admin.token);
    await api('/api/accounts',a.agent.token,'POST',{role:'manager',username:'escalate',password:'Fixture-password!'},403);
    await api('/api/accounts',a.agent.token,'POST',{role:'user',parentId:b.agent.id,username:'cross_parent',password:'Fixture-password!'},403);
    await api('/api/center/accounts',a.manager.token,'POST',{role:'partner',username:'escalate2',password:'Fixture-password!'},403);
    await api('/api/accounts',root,'POST',{role:'senior',username:'invalid_senior',password:'Fixture-password!'},403);
    for(const url of ['/api/accounts','/api/network','/api/admin/stats','/api/operator/tickets','/api/staff/overview','/api/dashboard','/api/risk'])await api(url,a.user.token,'GET',undefined,403);
  });
  await t.test('operator explicit grants and mutation permission checks',async()=>{
    const operator=await create('operator','test_operator',1),token=await login(operator.username);
    await api('/api/operator/tickets',token,'GET',undefined,403);
    await api('/api/center/accounts/'+operator.id+'/permissions',root,'PUT',{permissions:['bets.view']});
    await api('/api/operator/tickets',token);
    for(const action of ['accept','cancel','settle'])await api('/api/operator/tickets/999/'+action,token,'POST',{status:'won'},403);
    await api('/api/center/accounts/'+operator.id+'/permissions',token,'PUT',{permissions:['permissions.manage']},403);
  });
  await t.test('limits cannot exceed parent; descendants inherit reductions',async()=>{
    await api('/api/accounts/'+a.partner.id+'/limits',root,'PUT',{max_bet:100,max_payout:200,max_exposure:300});
    await api('/api/accounts/'+a.admin.id+'/limits',a.partner.token,'PUT',{max_bet:101},403);
    await api('/api/accounts/'+a.admin.id+'/limits',a.partner.token,'PUT',{max_bet:50});
    assert.equal((await api('/api/accounts/'+a.user.id,root)).limits.max_bet,50);
    await api('/api/accounts/'+a.partner.id+'/limits',root,'PUT',{max_bet:20});
    assert.equal((await api('/api/accounts/'+a.user.id,root)).limits.max_bet,20);
    await api('/api/accounts/'+b.admin.id+'/limits',a.partner.token,'PUT',{max_bet:1},403);
  });
  await t.test('atomic transfer, idempotent replay and scoped transactions',async()=>{
    const url='/api/staff/'+a.partner.id+'/credit',body={amount:100,direction:'credit'};
    const first=await api(url,root,'POST',body,200,'root-credit-0001');
    assert.deepEqual(await api(url,root,'POST',body,200,'root-credit-0001'),first);
    await api(url,root,'POST',{amount:101},409,'root-credit-0001');
    await api('/api/staff/'+a.admin.id+'/credit',a.partner.token,'POST',{amount:30},200,'partner-credit-01');
    await api('/api/staff/'+a.admin.id+'/credit',a.partner.token,'POST',{amount:999},400,'partner-credit-02');
    await api('/api/admin/users/'+a.user.id+'/balance',a.admin.token,'POST',{amount:999},403,'legacy-mint-0001');
    await api('/api/staff/'+b.admin.id+'/credit',a.partner.token,'POST',{amount:1},403,'cross-credit-001');
    const rows=(await api('/api/admin/transactions',a.partner.token)).transactions;
    assert.equal(rows.length,3);assert(rows.every(r=>[a.partner.id,a.admin.id].includes(r.user_id)));
    assert(rows.every(r=>r.balance_before!==null&&r.created_by&&r.reference));
    assert.equal((await api('/api/admin/transactions',b.partner.token)).transactions.length,0);
    await api('/api/accounts/'+a.admin.id+'/transactions',b.partner.token,'GET',undefined,403);
  });
  await t.test('legacy aggregation and search are scoped',async()=>{
    const stats=await api('/api/admin/stats',b.admin.token);assert.equal(stats.counts.partner,0);assert.equal(stats.counts.admin,1);
    const search=await api('/api/search?q=partner_a',b.partner.token);assert.equal(search.users.length,0);
    const users=await api('/api/admin/users',b.admin.token);assert(users.users.every(u=>u.partnerId===b.partner.id));
    await api('/api/admin/audit',b.admin.token,'GET',undefined,403);
  });
  await t.test('real bet API checks limits, snapshot, exposure and settlement permissions',async()=>{
    await api('/api/staff/'+a.user.id+'/credit',root,'POST',{amount:200},200,'player-credit-001');
    const selections=[{gameId:'100',gameApiId:'999999999',coefId:'101',selection:'Home',odd:2}];
    const insufficient=await api('/api/bets',a.user.token,'POST',{stake:201,selections},400);assert.equal(insufficient.code,'INSUFFICIENT_CREDIT');
    await api('/api/bets',a.user.token,'POST',{stake:5,selections:[{...selections[0],coefId:'removed-option'}]},409);
    fixtureOdd=1;await api('/api/bets',a.user.token,'POST',{stake:5,selections},409);fixtureOdd=2;
    const newQuote=await api('/api/bets',a.user.token,'POST',{stake:5,selections:[{...selections[0],coefId:'50101',odd:3}]},409);assert.equal(newQuote.oddsChanged[0].newOdd,2);assert.equal(newQuote.invalidSelections,undefined);

    assert.equal((await api('/api/me',a.user.token)).user.reservedBalance,0);

    const overStake=await api('/api/bets',a.user.token,'POST',{stake:21,selections},400);assert.equal(overStake.code,'BET_LIMIT_EXCEEDED');assert.equal(overStake.limitAmount,20);assert.equal(overStake.limitKind,'stake');
    await api('/api/bets',a.user.token,'POST',{stake:10,selections:[{...selections[0],odd:3}]},409);
    await api('/api/accounts/'+a.partner.id+'/limits',root,'PUT',{max_exposure:30});
    const streamAbort=new AbortController();
    const exposureStream=await fetch(base+'/api/live-exposure-stream',{headers:{Authorization:'Bearer '+root},signal:streamAbort.signal});assert.equal(exposureStream.status,200);
    const exposureReader=exposureStream.body.getReader();await exposureReader.read();
    const bet=await api('/api/bets',a.user.token,'POST',{stake:10,selections},200,'bet-replay-00001');
    const pushedExposure=await Promise.race([exposureReader.read(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Exposure push timeout')),3000))]);
    assert(new TextDecoder().decode(pushedExposure.value).includes('100'));streamAbort.abort();
    // Every selected hierarchy level restricts descendants; acceptance rechecks pending tickets.
    const liveExposure=(await api('/api/live-exposure',root)).events.find(e=>e.game_id==='100');assert.equal(liveExposure.tickets,1);assert.equal(liveExposure.pending,1);assert.equal(liveExposure.stake,10);assert.equal(liveExposure.liability,20);
    await api('/api/live-exposure',a.user.token,'GET',undefined,403);
    const riskUrl='/api/risk/events/100/limits';
    await api(riskUrl,a.user.token,'PUT',{scopeId:0,maxStake:1,maxPayout:null},403);
    await api(riskUrl,a.agent.token,'PUT',{scopeId:a.user.id,maxStake:1,maxPayout:null},403);
    const originalPermissions=(await api('/api/access/me',a.agent.token)).permissions;
    await api('/api/center/accounts/'+a.agent.id+'/permissions',root,'PUT',{permissions:[...originalPermissions,'risk.view','risk.manage']});
    await api(riskUrl,a.agent.token,'PUT',{scopeId:b.user.id,maxStake:1,maxPayout:null},403);
    await api(riskUrl,a.agent.token,'PUT',{scopeId:0,maxStake:1,maxPayout:null},403);
    await api(riskUrl+'/0',a.agent.token,'DELETE',undefined,403);
    await api(riskUrl,a.agent.token,'PUT',{scopeId:a.user.id,maxStake:5,maxPayout:null});
    await api(riskUrl+'/'+a.user.id,a.agent.token,'DELETE');
    for(const scopeId of [0,a.partner.id,a.admin.id,a.senior.id,a.manager.id,a.agent.id,a.user.id]){
      await api(riskUrl,root,'PUT',{scopeId,maxStake:5,maxPayout:null});
      await api('/api/bets',a.user.token,'POST',{stake:6,selections},400);
      await api('/api/operator/tickets/'+bet.betId+'/accept',root,'POST',{},400);
      await api(riskUrl+'/'+scopeId,root,'DELETE');
    }
    await api(riskUrl,root,'PUT',{scopeId:b.user.id,maxStake:0,maxPayout:0});
    await api(riskUrl,root,'PUT',{scopeId:0,maxStake:null,maxPayout:15});
    await api('/api/bets',a.user.token,'POST',{stake:8,selections},400);
    await api(riskUrl,root,'PUT',{scopeId:a.user.id,maxStake:100,maxPayout:100});
    await api('/api/operator/tickets/'+bet.betId+'/accept',root,'POST',{},400);
    await api(riskUrl+'/0',root,'DELETE');await api(riskUrl+'/'+a.user.id,root,'DELETE');
    await api(riskUrl,root,'PUT',{scopeId:0,maxStake:-1,maxPayout:null},400);
    await api(riskUrl,root,'PUT',{scopeId:0,maxStake:null,maxPayout:null},400);
    await api('/api/monitor',a.user.token,'GET',undefined,403);
    await api('/api/monitor',a.admin.token,'GET',undefined,403);
    const monitoring=await api('/api/monitor',root);assert(monitoring.requests.length>0);assert(!JSON.stringify(monitoring).includes(root));
    const leagueList=await api('/api/risk/leagues',root);assert(leagueList.leagues.some(l=>l.league_id==='700'&&l.name==='Fixture League'));
    const leagueUrl='/api/risk/leagues/700/limits';
    await api(leagueUrl,a.agent.token,'PUT',{scopeId:b.user.id,maxStake:1,maxPayout:null},403);
    await api(leagueUrl,a.agent.token,'PUT',{scopeId:0,maxStake:1,maxPayout:null},403);
    for(const scopeId of [0,a.partner.id,a.admin.id,a.senior.id,a.manager.id,a.agent.id,a.user.id]){
      await api(leagueUrl,root,'PUT',{scopeId,maxStake:5,maxPayout:null});
      const rejected=await api('/api/bets',a.user.token,'POST',{stake:6,selections:[{...selections[0],gameId:'200',league_id:701,league:'Other League'}]},400);
      assert(JSON.stringify(rejected).includes('Fixture League'));assert.equal(rejected.code,'BET_LIMIT_EXCEEDED');assert.equal(rejected.limitAmount,5);assert.equal(rejected.limitKind,'league_stake');
      await api('/api/operator/tickets/'+bet.betId+'/accept',root,'POST',{},400);
      await api(leagueUrl+'/'+scopeId,root,'DELETE');
    }
    await api(leagueUrl,root,'PUT',{scopeId:0,maxStake:null,maxPayout:15});
    await api(leagueUrl,root,'PUT',{scopeId:a.user.id,maxStake:100,maxPayout:100});
    await api('/api/operator/tickets/'+bet.betId+'/accept',root,'POST',{},400);
    await api(leagueUrl+'/0',root,'DELETE');await api(leagueUrl+'/'+a.user.id,root,'DELETE');
    await api(leagueUrl,root,'PUT',{scopeId:0,maxStake:-1,maxPayout:null},400);
    assert.deepEqual(await api('/api/bets',a.user.token,'POST',{stake:10,selections},200,'bet-replay-00001'),bet);
    await api('/api/bets',a.user.token,'POST',{stake:10,selections},400);
    assert.equal((await api('/api/admin/bets',b.admin.token)).bets.length,0);
    const own=(await api('/api/admin/bets',a.admin.token)).bets;assert.equal(own.length,1);assert.equal(own[0].partner_id,a.partner.id);assert.equal(own[0].manager_id,a.manager.id);
    const staffDetail=(await api('/api/admin/bets/'+bet.betId,a.admin.token)).bet;
    assert.equal(staffDetail.id,bet.betId);assert.equal(staffDetail.selections[0].original_odd,2);
    await api('/api/admin/bets/'+bet.betId,b.admin.token,'GET',undefined,403);
    await api('/api/admin/bets/'+bet.betId,a.user.token,'GET',undefined,403);
    const detail=(await api('/api/my-bets/'+bet.betId,a.user.token)).bet;assert.equal(detail.selections[0].original_odd,2);assert.equal(detail.selections[0].game_api_id,'100','Timeline identity must come from provider, not client');
    await api('/api/my-bets/'+bet.betId,b.user.token,'GET',undefined,404);
    await api('/api/operator/tickets/'+bet.betId+'/accept',a.admin.token,'POST',{},403);
    await api('/api/accounts/'+a.partner.id+'/limits',root,'PUT',{max_bet:5});
    await api('/api/operator/tickets/'+bet.betId+'/accept',root,'POST',{},400);
    await api('/api/accounts/'+a.partner.id+'/limits',root,'PUT',{max_bet:20});
    await api('/api/operator/tickets/'+bet.betId+'/accept',root,'POST',{});
    await api('/api/operator/tickets/'+bet.betId+'/accept',root,'POST',{},400);
    await api('/api/operator/tickets/'+bet.betId+'/settle',root,'POST',{status:'won'});
    await api('/api/operator/tickets/'+bet.betId+'/settle',root,'POST',{status:'won'},400);
    assert.equal((await api('/api/me',a.user.token)).user.balance,210);
    assert.equal((await api('/api/dashboard',a.admin.token)).ggr,-10);
    assert.equal((await api('/api/dashboard?from=2099-01-01',a.admin.token)).totalBets,0);
  });

  await t.test('center acceptance configuration and automatic debit are scoped and idempotent',async()=>{
    const url='/api/center/ticket-acceptance';
    await api(url,a.user.token,'GET',undefined,403);await api(url,a.admin.token,'GET',undefined,403);
    const initial=await api(url,root);assert.equal(initial.rules.live.enabled,false);
    const rules=structuredClone(initial.rules);rules.live.enabled=true;rules.live.maxStake=1;
    await api(url,a.admin.token,'PUT',{rules,version:initial.version},403);
    await api(url,root,'PUT',{rules:{...rules,live:{...rules.live,maxStake:-1}},version:initial.version},400);
    const saved=await api(url,root,'PUT',{rules,version:initial.version});
    await api(url,root,'PUT',{rules,version:initial.version},409);
    const before=(await api('/api/me',a.user.token)).user;
    const body={stake:1,selections:[{gameId:'100',coefId:'101',selection:'Home',odd:2}]};
    const result=await api('/api/bets',a.user.token,'POST',body,200,'auto-replay-0001');assert.equal(result.status,'accepted');
    const replay=await api('/api/bets',a.user.token,'POST',body,200,'auto-replay-0001');assert.equal(replay.betId,result.betId);
    const after=(await api('/api/me',a.user.token)).user;assert.equal(Number(after.balance),Number(before.balance)-1);assert.equal(Number(after.reservedBalance),Number(before.reservedBalance));
    await api('/api/operator/tickets/'+result.betId+'/accept',root,'POST',{},400);
    await api('/api/operator/tickets/'+result.betId+'/cancel',root,'POST',{});
    const manual=await api('/api/bets',a.user.token,'POST',{...body,stake:2});assert.equal(manual.status,'pending');
    await api('/api/operator/tickets/'+manual.betId+'/cancel',root,'POST',{});
    await api(url,root,'PUT',{rules:initial.rules,version:saved.version});
  });
  await t.test('TV resolves provider stream IDs only for authenticated viewers',async()=>{
    await api('/api/livegame/100/stream',null,'GET',undefined,401);
    const d=await api('/api/livegame/100/stream',a.user.token);assert.equal(d.url,'https://example.com/live-player');
    await api('/api/livegame/invalid/stream',a.user.token,'GET',undefined,400);
    invalidFeed=true;await api('/api/livegame/100/stream',a.user.token,'GET',undefined,502);invalidFeed=false;
  });
  await t.test('individual deny applies immediately to legacy routes',async()=>{
    await api('/api/center/accounts/'+a.agent.id+'/permissions',root,'PUT',{permissions:['reports.view']});
    await api('/api/accounts/'+a.user.id,a.agent.token,'GET',undefined,403);
    await api('/api/manager/tree',a.agent.token,'GET',undefined,403);
    await api('/api/agent/users',a.agent.token,'POST',{username:'denied_child',password:'Fixture-password!'},403);
  });
  await t.test('suspension, reset and force logout invalidate sessions',async()=>{
    await api('/api/accounts/'+b.manager.id+'/status',root,'POST',{status:'suspended'});
    await api('/api/me',b.agent.token,'GET',undefined,401);
    await api('/api/auth/login',null,'POST',{username:b.user.username,password:'Fixture-password!'},401);
    await api('/api/accounts/'+b.manager.id+'/status',root,'POST',{status:'active'});
    const token=await login(b.user.username);
    await api('/api/accounts/'+b.user.id+'/password',root,'POST',{password:'Reset-fixture-password!'});
    await api('/api/me',token,'GET',undefined,401);
    const reset=await login(b.user.username,'Reset-fixture-password!');
    await api('/api/accounts/'+b.user.id+'/logout',root,'POST',{});
    await api('/api/me',reset,'GET',undefined,401);
  });
  await t.test('audit context and self session history',async()=>{
    const logs=(await api('/api/admin/audit',root)).logs;
    assert(logs.some(l=>l.action==='ticket_accepted'&&l.actor_role==='center'&&l.ip_address));
    assert(logs.some(l=>l.action==='wallet_transfer'&&l.actor_role==='partner'));
    assert((await api('/api/login-history',root)).logins.length>0);
    assert((await api('/api/sessions',root)).sessions.every(s=>!('token' in s)));
  });
});

test('existing database migration preserves accounts and never writes the source database',async t=>{
  const SQL=await require('sql.js')();
  const source=fs.readFileSync(path.join(__dirname,'sportsbook.db'));
  const snapshot=buffer=>{const d=new SQL.Database(buffer);try{return d.exec('SELECT id,username,password_hash,role,status,parent_id,business_parent_id,control_parent_id,balance,reserved_balance FROM users ORDER BY id');}finally{d.close();}};
  const before=snapshot(source),dir=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-migration-')),file=path.join(dir,'copy.db');fs.writeFileSync(file,source);
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_FILE:file,DISABLE_UPSTREAM:'true'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  t.after(async()=>{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch('http://127.0.0.1:'+port+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===99)throw Error('Startup timeout');}
  assert.deepEqual(snapshot(fs.readFileSync(file)),before);
  assert.deepEqual(fs.readFileSync(path.join(__dirname,'sportsbook.db')),source);
});
