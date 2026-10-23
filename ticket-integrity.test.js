'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),http=require('http'),crypto=require('crypto');
const {spawn}=require('child_process');

test('ticket integrity: odds, payouts and the live safety delay',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-integrity-'));
 // Live provider fixture: one "Home" price per game, movable during the test.
 const odds={100:2,101:1.55,102:1.37,103:1.91,104:3};
 const games=Object.keys(odds).map(id=>({id,current_minute:'10:00',game_api_id:id,league_id:700,league:'Fixture League'}));
 const provider=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  const detail=req.url.match(/^\/ajax\/livegame\/(\d+)/);
  res.end(JSON.stringify(detail?[{id:detail[1]+'01',market_option_id:detail[1]+'01',odd:odds[detail[1]],market_id:'1',market_option:'Home',market:'Fulltime Result'}]:games));
 });
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_FILE:path.join(dir,'test.db'),CENTER_PASSWORD:'Test-only-root-917!',DISABLE_UPSTREAM:'true',VBET_BASE:'http://127.0.0.1:'+provider.address().port,LIVE_ACCEPT_DELAY_SECONDS:'1'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 t.after(async()=>{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await new Promise(r=>provider.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+port;
 for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===299)throw Error('Startup timeout: '+output);}
 async function api(url,token,method='GET',body,expected=200){
  const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(url==='/api/bets'||url.endsWith('/credit')?{'Idempotency-Key':crypto.randomUUID()}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();assert.equal(response.status,expected,`${method} ${url}: ${JSON.stringify(data)}`);return data;
 }
 const login=async(username,password='Fixture-password!')=>(await api('/api/auth/login',null,'POST',{username,password})).token;
 const root=await login('center','Test-only-root-917!');
 let parentId=1,player;
 for(const role of ['partner','admin','senior','manager','agent','user']){player=(await api('/api/accounts',root,'POST',{role,username:role+'_i',password:'Fixture-password!',parentId},201)).user;parentId=player.id;}
 await api(`/api/staff/${player.id}/credit`,root,'POST',{direction:'credit',amount:500});
 const operator=(await api('/api/accounts',root,'POST',{role:'operator',username:'operator_i',password:'Fixture-password!'},201)).user;
 await api('/api/center/accounts/'+operator.id+'/permissions',root,'PUT',{permissions:['bets.view','bets.accept','bets.settle']});
 const [user,op]=[await login('user_i'),await login('operator_i')];
 const leg=id=>({gameId:String(id),coefId:id+'01',marketId:'1',selection:'Home',odd:odds[id]});
 const place=(ids,stake=10)=>api('/api/bets',user,'POST',{stake,selections:ids.map(leg)});
 const ticket=async id=>(await api('/api/my-bets/'+id,user)).bet;
 const balance=async()=>(await api('/api/me',user)).user.balance;

 await t.test('a moved market never rewrites the ticket; the operator must confirm the original odds',async()=>{
  const {betId}=await place([100]);
  odds[100]=2.5;
  const refused=await api(`/api/operator/tickets/${betId}/accept`,op,'POST',{},409);
  assert.equal(refused.code,'ODDS_CHANGED');assert.deepEqual(refused.changes.map(c=>[c.odd,c.currentOdd]),[[2,2.5]]);
  let b=await ticket(betId);assert.equal(b.status,'pending');assert.equal(b.total_odds,2);assert.equal(b.potential_win,20);
  const listed=(await api('/api/operator/tickets?status=pending',op)).tickets.find(x=>x.id===betId);
  assert.equal(listed.selections[0].currentOdd,2.5,'operator sees the market price');
  await api(`/api/operator/tickets/${betId}/accept`,op,'POST',{confirmOdds:true});
  b=await ticket(betId);assert.equal(b.status,'accepted');assert.equal(b.total_odds,2);assert.equal(b.potential_win,20);
  odds[100]=2;
 });

 await t.test('settled payout equals the potential win shown on the ticket',async()=>{
  const {betId,potentialWin,totalOdds}=await place([101,102,103]);
  assert.deepEqual([totalOdds,potentialWin],[4.06,40.6]); // 1.55 x 1.37 x 1.91 = 4.0558...
  await api(`/api/operator/tickets/${betId}/accept`,op,'POST',{});
  const before=await balance();
  for(const s of (await ticket(betId)).selections)await api(`/api/operator/tickets/${betId}/selections/${s.id}/status`,op,'POST',{status:'won'});
  const b=await ticket(betId);
  assert.equal(b.status,'won');assert.equal(b.payout,40.6,'not the unrounded 40.56');
  assert.equal(Math.round((await balance()-before)*100)/100,40.6);
 });

 await t.test('manual "won" is computed from the selections and refuses a lost leg',async()=>{
  const {betId}=await place([101,102,103]);
  await api(`/api/operator/tickets/${betId}/accept`,op,'POST',{});
  const [first]=(await ticket(betId)).selections;
  await api(`/api/operator/tickets/${betId}/selections/${first.id}/status`,op,'POST',{status:'lost'});
  // The selection correction already settled the ticket as lost; a center "won" correction
  // must go through the selections, not overwrite them.
  const refused=await api(`/api/operator/tickets/${betId}/settle`,root,'POST',{status:'won'},400);
  assert.match(refused.error,/përzgjedhje të humbur/);
  await api(`/api/operator/tickets/${betId}/selections/${first.id}/status`,op,'POST',{status:'pending'});
  const settled=await api(`/api/operator/tickets/${betId}/settle`,op,'POST',{status:'won'});
  assert.equal(settled.payout,40.6);
  assert.ok((await ticket(betId)).selections.every(s=>s.result_status==='won'));
 });

 await t.test('live tickets are auto-accepted only after the safety delay re-check',async()=>{
  const config=await api('/api/operator/ticket-acceptance',op);
  config.rules.live.enabled=true;
  await api('/api/operator/ticket-acceptance',op,'PUT',{rules:config.rules,version:config.version});
  const waitFor=async(id,status)=>{for(let i=0;i<50;i++){const b=await ticket(id);if(b.status===status)return b;await new Promise(r=>setTimeout(r,100));}return ticket(id);};

  const before=await balance();
  const ok=await place([104]);
  assert.equal(ok.status,'pending','not accepted before the delay');
  assert.equal((await ticket(ok.betId)).status,'pending');
  assert.equal((await waitFor(ok.betId,'accepted')).status,'accepted');
  assert.equal(Math.round((before-await balance())*100)/100,10);

  const moved=await place([104]);
  odds[104]=3.4; // e.g. a goal the feed had not yet suspended
  await new Promise(r=>setTimeout(r,2000));
  assert.equal((await ticket(moved.betId)).status,'pending','moved market goes to the operator');
  const listed=(await api('/api/operator/tickets?status=pending',op)).tickets.find(x=>x.id===moved.betId);
  assert.match(listed.autoReviewReason,/ndryshuan gjatë vonesës/);
 });
});
