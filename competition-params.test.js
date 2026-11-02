'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),init=require('sql.js');
const {create,validateRule,adjustOdds}=require('./competition-control');

async function setup(){
 const db=new(await init()).Database();
 const run=(sql,a=[])=>db.run(sql,a),all=(sql,a=[])=>{const s=db.prepare(sql);s.bind(a);const rows=[];while(s.step())rows.push(s.getAsObject());s.free();return rows;},get=(sql,a)=>all(sql,a)[0];
 run('CREATE TABLE audit_log(id INTEGER PRIMARY KEY,actor_id,action,target_type,target_id,details)');
 run('CREATE TABLE bets(id INTEGER PRIMARY KEY,user_id INTEGER,stake REAL,status TEXT)');
 run('CREATE TABLE bet_selections(bet_id INTEGER,game_id TEXT,league_id TEXT,market TEXT,market_id TEXT)');
 run('CREATE TABLE risk_event_leagues(event_id TEXT,league_id TEXT)');
 const routes=new Map(),app={post:(p,...f)=>routes.set('POST '+p,f.at(-1)),get:(p,...f)=>routes.set('GET '+p,f.at(-1)),put:(p,...f)=>routes.set('PUT '+p,f.at(-1)),delete:(p,...f)=>routes.set('DELETE '+p,f.at(-1))};
 const feeds={sports:[{id:1,name:'Football'}],'countries/1':[{id:2,name:'England'}],'leagues/2':[{id:3,name:'Premier League'}],'gamesByLeague/3':[{id:4,home_team:'A',away_team:'B'}]};
 const deps={run,all,get,tx:f=>f(),now:()=>new Date().toISOString(),proxy:async p=>{const k=p.replace('/ajax/','');return feeds[k]?{status:200,text:JSON.stringify(feeds[k])}:{status:404,text:'[]'};}};
 const control=create(deps);control.mount(app,()=>{});
 async function call(route,params={},body={},query={}){let status=200,result;await routes.get(route)({params,body,query,user:{id:1}},{status:n=>{status=n;return {json:r=>result=r};},json:r=>result=r});if(status!==200)throw Object.assign(Error(result.error),{status});return result;}
 for(const [kind,parent] of [['sport',''],['group','1'],['tournament','2'],['event','3']])await call('GET /api/center/competitions',{},{},{kind,parent});
 const put=(kind,id,params,extra={})=>call('PUT /api/center/competitions/:kind/:id',{kind,id},{status:'active',params,...extra});
 return {run,call,control,put};
}
const pick=(extra={})=>({gameId:4,market:'Rezultat Final',marketId:'1',odd:2,...extra});

test('ticket-type limits: the type value wins over "all", and every level applies',async()=>{
 const {control,put}=await setup();
 await put('sport','1',{limits:{all:{maxBet:100,minBet:1},liveSingle:{maxBet:20}}});
 assert.deepEqual(control.check([pick()],100,200,1),{hold:[],delay:0});
 assert.throws(()=>control.check([pick()],101,202,1),/Basti tejkalon limitin për Football/);
 assert.throws(()=>control.check([pick({acceptanceType:'live'})],21,42,1),/20\.00 €/,'live single has its own maximum');
 assert.throws(()=>control.check([pick()],0.5,1,1),/Basti minimal/);
 await put('tournament','3',{limits:{preSingle:{maxWin:150}}});
 assert.throws(()=>control.check([pick()],80,160,1),/Fitimi tejkalon limitin për Premier League/,'the stricter level wins');
});

test('hold thresholds, repeated tickets, selections and processing time',async()=>{
 const {run,control,put}=await setup();
 await put('event','4',{limits:{all:{holdStake:50,holdWin:300,sameTicketHold:2,sameTicket:3}},minSelections:1,maxCombinations:1,processingSeconds:30});
 assert.deepEqual(control.check([pick()],10,20,1),{hold:[],delay:30});
 assert.match(control.check([pick()],60,120,1).hold.join(),/bast mbi 50\.00/);
 assert.match(control.check([pick()],10,400,1).hold.join(),/fitim mbi 300\.00/);
 for(const id of [1,2]){run('INSERT INTO bets VALUES(?,?,?,?)',[id,1,10,'accepted']);run('INSERT INTO bet_selections VALUES(?,?,?,?,?)',[id,'4','3','Rezultat Final','1']);}
 assert.match(control.check([pick()],10,20,1).hold.join(),/përsëritur 3 herë/,'the third copy waits for the operator');
 run('INSERT INTO bets VALUES(3,1,10,?)',['accepted']);run("INSERT INTO bet_selections VALUES(3,'4','3','Rezultat Final','1')");
 assert.throws(()=>control.check([pick()],10,20,1),/deri në 3 herë/);
 assert.deepEqual(control.check([pick()],10,20,2).hold,[],'other players have their own count');
 assert.throws(()=>control.check([pick(),pick({gameId:5})],10,40,2),/deri në 1 ndeshje/);
});

test('odds settings: payout factor, correction, caps and playable range',async()=>{
 const {control,put}=await setup();
 const s=(o={})=>({payoutFactor:null,oddFactor:null,minOdd:null,maxOdd:null,maxOddGenerated:null,...o});
 // 2.00/2.00 is a 100% line; 90% payout gives 1.80/1.80.
 assert.deepEqual(adjustOdds(s({payoutFactor:90}),[2,2]).values,[1.8,1.8]);
 assert.deepEqual(adjustOdds(s({oddFactor:-10}),[3]).values,[2.7]);
 assert.deepEqual(adjustOdds(s({oddFactor:10}),[1.9,1.9]).values,[2,2],'a raise stops at 100% payout');
 assert.deepEqual(adjustOdds(s({maxOddGenerated:20,maxOdd:15,minOdd:1.1}),[1.05,30,12]).values,[null,null,12]);
 await put('tournament','3',{oddFactor:-10,minOdd:1.2});
 const [game]=control.filter.games([{id:4,league_id:3,odd:'11|2.00|1|1|Rezultat Final,12|1.25|2|1|Rezultat Final'}]);
 assert.equal(game.odd,'11|1.80|1|1|Rezultat Final,12|-|2|1|Rezultat Final','players see corrected and locked prices');
 assert.equal(control.price.detail([{id:11,market:'Rezultat Final',market_id:1,odd:'2.00'}],4,11),1.8,'bet placement uses the same price');
 assert.equal(control.price.detail([{id:12,market:'Rezultat Final',market_id:1,odd:'1.25'}],4,12),null);
 assert.throws(()=>control.check([pick({odd:1.1})],10,11,1),/Koeficienti minimal/);
});

test('parameters validate and status-only edits keep them',async()=>{
 const {call,put}=await setup();
 assert.throws(()=>validateRule({status:'active',params:{limits:{all:{minBet:10,maxBet:5}}}}),/minimal/);
 assert.throws(()=>validateRule({status:'active',params:{minOdd:3,maxOdd:2}}),/minimal/);
 assert.throws(()=>validateRule({status:'active',params:{limits:{all:{sameTicket:1.5}}}}),/pavlefshme/);
 await put('tournament','3',{limits:{all:{maxBet:40},preMulti:{maxWin:900}},oddFactor:-2});
 await call('PUT /api/center/competitions/:kind/:id',{kind:'tournament',id:'3'},{status:'hold',maxStake:40,maxPayout:null});
 const {items}=await call('GET /api/center/competitions',{},{},{kind:'tournament',parent:'2'});
 const r=items.find(t=>t.id==='3').rule;
 assert.equal(r.status,'hold');assert.equal(r.params.limits.preMulti.maxWin,900);assert.equal(r.params.oddFactor,-2);
});

test('live overrides the status and settings; prematch hides events beyond the days to offer',async()=>{
 const {control,put}=await setup();
 await put('tournament','3',{minOdd:1.5,daysToOffer:2,live:{status:'blocked',minOdd:1.1}});
 assert.throws(()=>control.check([pick({acceptanceType:'live'})],10,20,1),/bllokuar/,'live is blocked');
 assert.deepEqual(control.check([pick()],10,20,1).hold,[],'prematch stays active');
 assert.throws(()=>control.check([pick({odd:1.3})],10,13,1),/Koeficienti minimal/);
 const soon=new Date(Date.now()+86400000).toISOString(),later=new Date(Date.now()+5*86400000).toISOString();
 const rows=[{id:4,league_id:3,game_date:soon,odd:'11|2.00|1|1|Rezultat Final'},{id:5,league_id:3,game_date:later,odd:'21|2.00|1|1|Rezultat Final'}];
 assert.deepEqual(control.filter.games(rows,undefined,'pre').map(g=>g.id),[4],'events beyond 2 days are not offered');
 assert.equal(control.filter.games([{...rows[0],current_minute:'10:00'}])[0].odd,'11|-|1|1|Rezultat Final','live rows use the live status');
});

test('copy model replaces the target model with the source rules',async()=>{
 const {run,call,put}=await setup();
 run('CREATE TABLE user_groups(id TEXT PRIMARY KEY,name TEXT)');run("INSERT INTO user_groups VALUES('g1','VIP')");
 await put('tournament','3',{limits:{all:{maxBet:40}}});
 assert.equal((await call('POST /api/center/competitions/copy',{},{from:'',to:'g1'})).copied,1);
 const {items}=await call('GET /api/center/competitions',{},{},{kind:'tournament',parent:'2',groupId:'g1'});
 assert.equal(items.find(t=>t.id==='3').rule.params.limits.all.maxBet,40);
 await assert.rejects(call('POST /api/center/competitions/copy',{},{from:'g1',to:'g1'}),/tjetër/);
});

test('saved models: save from an element, apply with one click, keep the link until edited',async()=>{
 const {call,control,put}=await setup();
 await put('event','4',{limits:{all:{maxBet:30}},minOdd:1.3,live:{status:'hold'}});
 const {template}=await call('POST /api/center/competition-templates',{},{name:'Derby',fromKind:'event',fromId:'4'});
 assert.equal(template.params.limits.all.maxBet,30);
 await assert.rejects(call('POST /api/center/competition-templates',{},{name:'Derby',fromKind:'event',fromId:'4'}),/Ekziston/);
 const out=await call('POST /api/center/competition-templates/:id/apply',{id:template.id},{targets:[{kind:'tournament',id:'3'},{kind:'tournament',id:'999'}]});
 assert.deepEqual([out.applied,out.failed.length],[1,1],'unknown elements are reported, the rest is applied');
 const rule=()=>control.check([{gameId:5,league_id:3,market:'Rezultat Final',odd:2}],31,62,1);
 assert.throws(rule,/30\.00 €/,'the tournament now has the model limits');
 let t=(await call('GET /api/center/competitions',{},{},{kind:'tournament',parent:'2'})).items.find(x=>x.id==='3').rule;
 assert.equal(t.template_id,template.id);assert.equal(t.params.live.status,'hold');
 assert.equal((await call('GET /api/center/competition-templates')).templates[0].uses,1);
 await put('tournament','3',{limits:{all:{maxBet:60}}});
 t=(await call('GET /api/center/competitions',{},{},{kind:'tournament',parent:'2'})).items.find(x=>x.id==='3').rule;
 assert.equal(t.template_id,null,'editing by hand unlinks the model');
 await call('DELETE /api/center/competition-templates/:id',{id:template.id});
 assert.equal((await call('GET /api/center/competition-templates')).templates.length,0);
});

test('a model carries the configuration of every market of the league or event',async()=>{
 const {call,control,put}=await setup();
 // The centre learns a market from a match feed, then lists it inside the tournament.
 control.filter.markets([{id:1,market:'Rezultat Final',market_id:1001,odd:'2'}],'4');
 await call('GET /api/center/competitions',{},{},{kind:'market',scopeKind:'tournament',scopeId:'3'});
 await put('tournament','3',{limits:{all:{maxBet:100}}});
 await call('PUT /api/center/competitions/:kind/:id',{kind:'tournament-market',id:'3|rezultat final'},{status:'active',params:{payoutFactor:92,live:{status:'hold'}}});
 const {template}=await call('POST /api/center/competition-templates',{},{name:'Me market-e',fromKind:'tournament',fromId:'3'});
 assert.deepEqual(template.markets.map(m=>[m.key,m.params.payoutFactor,m.params.live.status]),[['rezultat final',92,'hold']]);
 const out=await call('POST /api/center/competition-templates/:id/apply',{id:template.id},{targets:[{kind:'event',id:'4'}]});
 assert.deepEqual([out.applied,out.marketRules],[1,1]);
 assert.equal(control.check([{gameId:4,market:'Rezultat Final',odd:2,acceptanceType:'live'}],10,20,1).hold.length,1,'the event market is on hold for live, from the model');
 assert.throws(()=>control.check([{gameId:4,market:'Rezultat Final',odd:2}],101,202,1),/100.00 €/,'and the league limits came along');
});

test('the most specific status wins in the player feeds too',async()=>{
 const {call,control}=await setup();
 const set=(kind,id,status)=>call('PUT /api/center/competitions/:kind/:id',{kind,id},{status,params:{}});
 control.filter.markets([{id:1,market:'Rezultat Final',odd:'2'}],'4');
 await call('GET /api/center/competitions',{},{},{kind:'market',scopeKind:'tournament',scopeId:'3'});
 const row={id:4,league_id:3,odd:'11|2.00|1|1|Rezultat Final'};
 await set('group','2','blocked');
 assert.equal(control.filter.games([row],undefined,'pre')[0].odd,'11|-|1|1|Rezultat Final','a blocked group locks its tournaments');
 await set('tournament','3','active');
 assert.equal(control.filter.games([row],undefined,'pre')[0].odd,'11|2.00|1|1|Rezultat Final','an active tournament inside it opens');
 await set('market','rezultat final','blocked');
 assert.equal(control.filter.games([row],undefined,'pre')[0].odd,'11|-|1|1|Rezultat Final','a market blocked everywhere');
 await set('tournament-market','3|rezultat final','active');
 assert.equal(control.filter.games([row],undefined,'pre')[0].odd,'11|2.00|1|1|Rezultat Final','is open where the tournament says so');
 await set('event','4','closed');
 assert.deepEqual(control.filter.games([row],undefined,'pre'),[],'a closed event is hidden whatever its tournament says');
});

test('a model assigned to an agent or a user group limits their players everywhere',async()=>{
 const {run,call,control}=await setup();
 run('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,role TEXT)');run("INSERT INTO users VALUES(3,'agent3','agent'),(4,'player4','user'),(9,'center','center')");
 run('CREATE TABLE user_groups(id TEXT PRIMARY KEY,name TEXT)');run("INSERT INTO user_groups VALUES('vip','VIP')");
 const {template}=await call('POST /api/center/competition-templates',{},{name:'Kujdes',status:'active',params:{limits:{all:{maxBet:20}},live:{status:'hold'}}});
 await assert.rejects(call('POST /api/center/competition-templates/:id/assign',{id:template.id},{type:'account',targetId:'9'}),/përdorues, agjent/);
 await call('POST /api/center/competition-templates/:id/assign',{id:template.id},{type:'account',targetId:'3'});
 const leg={gameId:4,market:'Rezultat Final',odd:2};
 assert.throws(()=>control.check([leg],21,42,4,null,{accounts:['4','3']}),/Basti tejkalon limitin për Kujdes \(20\.00 €\)/,'the agent model reaches its player');
 assert.deepEqual(control.check([{...leg,acceptanceType:'live'}],10,20,4,null,{accounts:['4','3']}).hold,['Kujdes'],'and its live status');
 control.check([leg],21,42,5,null,{accounts:['5']});
 await call('POST /api/center/competition-templates/:id/assign',{id:template.id},{type:'user-group',targetId:'vip'});
 assert.throws(()=>control.check([leg],21,42,5,null,{accounts:['5'],groups:['vip']}),/Kujdes/,'a user group model too');
 const {assignments}=await call('GET /api/center/competition-templates/assignments');
 assert.deepEqual(assignments.map(a=>[a.type,a.target.name]).sort(),[['account','agent3'],['user-group','VIP']]);
 await call('DELETE /api/center/competition-templates/assignments/:type/:targetId',{type:'account',targetId:'3'});
 control.check([leg],21,42,4,null,{accounts:['4','3']});
});
