'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),http=require('http'),crypto=require('crypto');
const {spawn}=require('child_process');

test('centre controls end to end: statuses, user groups, ticket rules, delegated operators',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-centre-'));
 // Two live games of league 700 and one of league 800, one "Home" price each.
 const games=[{id:'100',league_id:700},{id:'101',league_id:700},{id:'200',league_id:800}].map(g=>({...g,current_minute:'10:00',game_api_id:g.id,league:'League '+g.league_id,odd:`${g.id}01|2|Home|1|Fulltime Result`}));
 const provider=http.createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  const detail=req.url.match(/^\/ajax\/livegame\/(\d+)/);
  res.end(JSON.stringify(detail?[{id:detail[1]+'01',market_option_id:detail[1]+'01',odd:2,market_id:'1',market_option:'Home',market:'Fulltime Result',game_id:detail[1]}]:games));
 });
 await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_FILE:path.join(dir,'test.db'),CENTER_PASSWORD:'Test-only-root-917!',DISABLE_UPSTREAM:'true',VBET_BASE:'http://127.0.0.1:'+provider.address().port,LIVE_ACCEPT_DELAY_SECONDS:'0'},stdio:['ignore','pipe','pipe']});
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
 // Two partner branches, each down to an agent and a player.
 const branch={};
 for(const name of ['a','b']){let parentId=1;const accounts={};for(const role of ['partner','admin','senior','manager','agent','user']){accounts[role]=(await api('/api/accounts',root,'POST',{role,username:role+'_'+name,password:'Fixture-password!',parentId},201)).user;parentId=accounts[role].id;}
  await api(`/api/staff/${accounts.user.id}/credit`,root,'POST',{direction:'credit',amount:500});branch[name]={...accounts,token:await login('user_'+name)};}
 const operator=(await api('/api/accounts',root,'POST',{role:'operator',username:'operator_c',password:'Fixture-password!'},201)).user;
 await api('/api/center/accounts/'+operator.id+'/permissions',root,'PUT',{permissions:['bets.view','bets.accept','bets.settle']});
 const op=await login('operator_c');
 const leg=id=>({gameId:id,coefId:id+'01',marketId:'1',selection:'Home',odd:2,market:'Fulltime Result'});
 const place=(who,ids,stake=10,expected=200)=>api('/api/bets',branch[who].token,'POST',{stake,selections:ids.map(leg)},expected);
 await api('/api/center/competitions?kind=event&parent=700',root);await api('/api/center/competitions?kind=event&parent=800',root);

 await t.test('closed hides and refuses, blocked locks odds, hold always waits for the operator',async()=>{
  await api('/api/operator/ticket-acceptance',op,'PUT',{version:0,rules:{live:{enabled:true,maxStake:100,maxPayout:1000,maxOdds:20,maxEvents:5},prematch:{enabled:false,maxStake:100,maxPayout:1000,maxOdds:50,maxEvents:10},maxDailyStake:null,blacklist:[]}});
  assert.equal((await place('a',['200'])).status,'accepted','auto-accept is on');
  await api('/api/center/competitions/event/100',root,'PUT',{status:'closed',maxStake:null,maxPayout:null});
  await api('/api/center/competitions/event/101',root,'PUT',{status:'blocked',maxStake:null,maxPayout:null});
  const feed=await api('/api/livegames');
  assert.deepEqual(feed.map(g=>g.id),['101','200'],'closed event is not shown');
  assert.equal(feed[0].odd,'10101|-|Home|1|Fulltime Result','blocked event shows locked odds');
  assert.match((await place('a',['100'],10,400)).error,/nuk ofrohet/);
  assert.match((await place('a',['101'],10,400)).error,/bllokuar/);
  await api('/api/center/competitions/tournament/800',root,'PUT',{status:'hold',maxStake:null,maxPayout:null});
  assert.equal((await place('a',['200'])).status,'pending','hold beats automatic acceptance');
  for(const [kind,id] of [['event','100'],['event','101'],['tournament','800']])await api(`/api/center/competitions/${kind}/${id}`,root,'DELETE');
  const config=await api('/api/operator/ticket-acceptance',op);
  await api('/api/operator/ticket-acceptance',op,'PUT',{version:config.version,rules:{...config.rules,live:{...config.rules.live,enabled:false}}});
 });

 await t.test('a user group limits every player under its agent',async()=>{
  const g=(await api('/api/center/user-groups',root,'POST',{name:'Agjentët A'})).group;
  await api(`/api/center/user-groups/${g.id}/members`,root,'POST',{userId:branch.a.agent.id});
  await api(`/api/center/user-groups/${g.id}/limits`,root,'PUT',{limits:{max_bet:5}});
  assert.match((await place('a',['200'],6,400)).error,/limitin e grupit Agjentët A/);
  await place('a',['200'],5);
  await place('b',['200'],6);
  await api(`/api/center/competitions/tournament/800`,root,'PUT',{groupId:g.id,status:'closed',maxStake:null,maxPayout:null});
  assert.match((await place('a',['200'],1,400)).error,/nuk ofrohet/);
  await place('b',['200'],1);
  assert.equal((await api('/api/livegames')).length,3,'group rules do not hide games for others');
  await api(`/api/center/user-groups/${g.id}`,root,'DELETE');
  await place('a',['200'],6);
 });

 await t.test('centre ticket rules are enforced at placement',async()=>{
  const current=await api('/api/center/platform-rules',root);
  await api('/api/center/platform-rules',root,'PUT',{version:current.version,rules:{...current.rules,maxSelections:1}});
  assert.match((await place('a',['100','200'],10,400)).error,/deri në 1 ndeshje/);
  await api('/api/center/platform-rules',root,'PUT',{version:current.version,rules:current.rules},409);
  await api('/api/center/platform-rules',op,'GET',undefined,403);
 });

 await t.test('an operator delegated to a partner only sees and handles that partner',async()=>{
  const ticketB=(await place('b',['100'])).betId;
  await api(`/api/center/operators/${operator.id}/partners`,op,'PUT',{partnerIds:[branch.a.partner.id]},403);
  await api(`/api/center/operators/${operator.id}/partners`,root,'PUT',{partnerIds:[branch.b.partner.id+1000]},400);
  assert.deepEqual((await api(`/api/center/operators/${operator.id}/partners`,root,'PUT',{partnerIds:[branch.a.partner.id]})).partnerIds,[branch.a.partner.id]);
  const ticketA=(await place('a',['100'])).betId;
  const pending=(await api('/api/operator/tickets?status=pending',op)).tickets.map(x=>x.id);
  assert.ok(pending.includes(ticketA));assert.ok(!pending.includes(ticketB),'other partner hidden');
  await api(`/api/operator/tickets/${ticketB}/accept`,op,'POST',{},403);
  await api(`/api/operator/tickets/${ticketB}/cancel`,op,'POST',{},403);
  await api(`/api/operator/tickets/${ticketA}/accept`,op,'POST',{});
  const rules=await api('/api/operator/ticket-acceptance',op);
  assert.match((await api('/api/operator/ticket-acceptance',op,'PUT',{version:rules.version,rules:rules.rules},403)).error,/gjithë rrjetin/);
  await api(`/api/center/operators/${operator.id}/partners`,root,'PUT',{partnerIds:[]});
  assert.ok((await api('/api/operator/tickets?status=pending',op)).tickets.some(x=>x.id===ticketB),'without partners the operator is global again');
 });
});
