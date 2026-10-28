'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),init=require('sql.js');
const {create,validateRule}=require('./competition-control');
const {createUserGroups}=require('./user-groups');
const {checkTicket,validate,createPlatformRules}=require('./platform-rules');

async function setup(){
 const db=new(await init()).Database();
 const run=(sql,a=[])=>db.run(sql,a),all=(sql,a=[])=>{const s=db.prepare(sql);s.bind(a);const rows=[];while(s.step())rows.push(s.getAsObject());s.free();return rows;},get=(sql,a)=>all(sql,a)[0];
 run('CREATE TABLE audit_log(id INTEGER PRIMARY KEY,actor_id,action,target_type,target_id,details)');
 run('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,role TEXT,status TEXT,parent_id INTEGER,business_parent_id INTEGER,reserved_balance REAL DEFAULT 0)');
 run('CREATE TABLE bets(id INTEGER PRIMARY KEY,user_id INTEGER,stake REAL,potential_win REAL,status TEXT,reserved REAL,created_at TEXT,settled_at TEXT)');
 run('CREATE TABLE bet_selections(bet_id INTEGER,game_id TEXT,league_id TEXT,market TEXT,result_status TEXT)');
 run('CREATE TABLE risk_event_leagues(event_id TEXT,league_id TEXT)');
 // manager 2 > agent 3 > players 4 and 5; player 6 sits under another agent.
 for(const [id,role,parent] of [[1,'center',null],[2,'manager',1],[3,'agent',2],[4,'user',3],[5,'user',3],[7,'agent',1],[6,'user',7]])run('INSERT INTO users(id,username,role,status,parent_id) VALUES(?,?,?,?,?)',[id,role+id,role,'active',parent]);
 const lineage=id=>{const out=[];let u=get('SELECT * FROM users WHERE id=?',[id]);while(u){out.push(u);u=u.parent_id?get('SELECT * FROM users WHERE id=?',[u.parent_id]):null;}return out;};
 const routes=new Map(),app={post:(p,...f)=>routes.set('POST '+p,f.at(-1)),get:(p,...f)=>routes.set('GET '+p,f.at(-1)),put:(p,...f)=>routes.set('PUT '+p,f.at(-1)),delete:(p,...f)=>routes.set('DELETE '+p,f.at(-1))};
 const feeds={sports:[{id:1,name:'Football'}],'countries/1':[{id:2,name:'England'}],'leagues/2':[{id:3,name:'Premier League'}],'gamesByLeague/3':[{id:4,home_team:'A',away_team:'B'},{id:5,home_team:'C',away_team:'D'}],'livegame/4':[{id:901,game_id:4,market:'Rezultat Final',odd:'2.10'},{id:902,game_id:4,market:'Gola Mbi/Nen',odd:'1.80'}]};
 const deps={run,all,get,tx:f=>f(),now:()=>new Date().toISOString(),proxy:async p=>{const k=p.replace('/ajax/','');return feeds[k]?{status:200,text:JSON.stringify(feeds[k])}:{status:404,text:'[]'};}};
 const groups=createUserGroups({...deps,lineage});groups.mount(app,()=>{});
 const control=create(deps);control.mount(app,()=>{});
 async function call(route,params={},body={},query={}){let status=200,result;await routes.get(route)({params,body,query,user:{id:1}},{status:n=>{status=n;return {json:r=>result=r};},json:r=>result=r});if(status!==200)throw Object.assign(Error(result.error),{status});return result;}
 for(const [kind,parent] of [['sport',''],['group','1'],['tournament','2'],['event','3']])await call('GET /api/center/competitions',{},{},{kind,parent});
 return {db,run,all,get,call,control,groups,deps};
}
const rule=status=>({status,maxStake:null,maxPayout:null});

test('four statuses: active passes, hold waits, blocked and closed refuse',async()=>{
 const {call,control}=await setup();
 assert.deepEqual(control.check([{gameId:4}],1,2),{hold:[]});
 await call('PUT /api/center/competitions/:kind/:id',{kind:'tournament',id:'3'},rule('hold'));
 assert.deepEqual(control.check([{gameId:4}],1,2).hold,['Premier League'],'hold sends the ticket to the operator');
 await call('PUT /api/center/competitions/:kind/:id',{kind:'event',id:'4'},rule('blocked'));
 assert.throws(()=>control.check([{gameId:4}],1,2),/bllokuar/);
 assert.deepEqual(control.check([{gameId:5}],1,2).hold,['Premier League'],'other events of the tournament stay on hold');
 await call('PUT /api/center/competitions/:kind/:id',{kind:'group',id:'2'},rule('closed'));
 assert.throws(()=>control.check([{gameId:5}],1,2),/England nuk ofrohet/);
 assert.equal(validateRule({blocked:true,maxStake:null,maxPayout:null}).status,'blocked','legacy blocked flag still accepted');
 assert.throws(()=>validateRule({status:'paused',maxStake:null,maxPayout:null}),/Status/);
});

test('player feeds hide closed elements and lock blocked odds, per market too',async()=>{
 const {call,control}=await setup();
 const rows=[{id:4,league_id:3,odd:'11|2.10|1|6575|Rezultat Final,12|3.40|X|6575|Rezultat Final,13|1.80|O|7|Gola Mbi/Nen'},{id:5,league_id:3,odd:'21|1.50|1|6575|Rezultat Final'}];
 assert.deepEqual(control.filter.games(rows),rows,'nothing changes without rules');
 await call('PUT /api/center/competitions/:kind/:id',{kind:'event',id:'5'},rule('closed'));
 await call('GET /api/center/competitions',{},{},{kind:'market',parent:'4'});
 await call('PUT /api/center/competitions/:kind/:id',{kind:'market',id:'gola mbi/nen'},rule('closed'));
 await call('PUT /api/center/competitions/:kind/:id',{kind:'event-market',id:'4|rezultat final'},rule('blocked'));
 const out=control.filter.games(rows);
 assert.equal(out.length,1,'closed event disappears');
 assert.equal(out[0].odd,'11|-|1|6575|Rezultat Final,12|-|X|6575|Rezultat Final','blocked market locked, closed market removed');
 const markets=control.filter.markets([[{id:901,game_id:4,market:'Rezultat Final',odd:'2.10'},{id:902,game_id:4,market:'Gola Mbi/Nen',odd:'1.80'}]],'4');
 assert.deepEqual(markets,[[{id:901,game_id:4,market:'Rezultat Final',odd:'-'}]]);
 assert.deepEqual(control.filter.coefs({game_id:4,coefs:[{coef_id:11,odd:'2.2'},{coef_id:13,odd:'1.9'}]}),{game_id:4,coefs:[{coef_id:11,odd:'-'}]},'live updates follow the same rules');
 assert.equal(control.filter.coefs({game_id:5,coefs:[{coef_id:21,odd:'1.6'}]}),null);
 assert.throws(()=>control.check([{gameId:4,market:'Rezultat Final'}],1,2),/bllokuar/);
 assert.throws(()=>control.check([{gameId:4,market:'Gola Mbi/Nen'}],1,2),/nuk ofrohet/);
 await call('PUT /api/center/competitions/:kind/:id',{kind:'group',id:'2'},rule('closed'));
 assert.deepEqual(control.filter.catalog('countries',[{id:2,name:'England'},{id:9,name:'Spain'}]),[{id:9,name:'Spain'}]);
 assert.deepEqual(control.filter.catalog('leagues',[{id:3,name:'Premier League'}]),[]);
});

test('user groups: members, players under agents and managers, limits and own rules',async()=>{
 const {call,control,groups,run}=await setup();
 const g=(await call('POST /api/center/user-groups',{},{name:'VIP'})).group;
 await assert.rejects(call('POST /api/center/user-groups/:id/members',{id:g.id},{userId:1}),/vetëm përdorues, agjentë dhe menaxherë/);
 await call('POST /api/center/user-groups/:id/members',{id:g.id},{userId:2});
 assert.deepEqual(groups.groupsOf(5),[g.id],'player under the manager belongs to the group');
 assert.deepEqual(groups.groupsOf(6),[]);
 assert.deepEqual(groups.players(g.id).sort(),[4,5]);
 await call('PUT /api/center/user-groups/:id/limits',{id:g.id},{limits:{max_bet:50,max_exposure:300}});
 groups.checkLimits(4,50,100);assert.throws(()=>groups.checkLimits(4,51,100),/limitin e grupit VIP/);
 run("INSERT INTO bets(id,user_id,stake,potential_win,status) VALUES(1,5,10,250,'accepted')");
 assert.throws(()=>groups.checkLimits(4,10,60),/Ekspozimi i grupit VIP/,'exposure adds every player of the group');
 groups.checkLimits(6,500,1000);
 await call('PUT /api/center/competitions/:kind/:id',{kind:'tournament',id:'3'},{...rule('closed'),groupId:g.id});
 assert.throws(()=>control.check([{gameId:4}],1,2,4,null,{groups:[g.id]}),/nuk ofrohet/);
 assert.deepEqual(control.check([{gameId:4}],1,2,6),{hold:[]},'other players are not affected');
 assert.deepEqual(control.filter.games([{id:4,league_id:3,odd:'1|2|1|1|X'}]).length,1,'group rules never change what others see');
 const listing=await call('GET /api/center/competitions',{},{},{kind:'tournament',parent:'2',groupId:g.id});assert.equal(listing.items[0].rule.status,'closed');
 assert.equal((await call('GET /api/center/competitions',{},{},{kind:'tournament',parent:'2'})).items[0].rule,null);
 await call('DELETE /api/center/user-groups/:id',{id:g.id});assert.deepEqual(groups.groupsOf(5),[]);
});

test('centre ticket rules and the pending timeout',async()=>{
 const rules=validate({minSelections:2,maxSelections:3,minSelectionOdd:1.3,minTotalOdds:2,maxTotalOdds:500,sameEvent:'forbid',liveWithPrematch:'forbid',forbiddenPairs:[['Rezultat Final','Shans i Dyfishtë']]});
 const leg=(gameId,odd,market='Rezultat Final',acceptanceType='prematch')=>({gameId,odd,market,acceptanceType});
 assert.throws(()=>checkTicket(rules,[leg(1,2)],2),/të paktën 2/);
 assert.throws(()=>checkTicket(rules,[leg(1,2),leg(2,2),leg(3,2),leg(4,2)],16),/deri në 3/);
 assert.throws(()=>checkTicket(rules,[leg(1,1.2),leg(2,2)],2.4),/minimal për çdo ndeshje/);
 assert.throws(()=>checkTicket(rules,[leg(1,1.35),leg(2,1.4)],1.89),/total duhet/);
 assert.throws(()=>checkTicket(rules,[leg(1,2),leg(1,2,'Gola')],4),/e njëjta ndeshje/);
 assert.throws(()=>checkTicket(rules,[leg(1,2),leg(2,2,'Rezultat Final','live')],4),/live nuk kombinohen/);
 checkTicket(rules,[leg(1,2),leg(2,2)],4);
 const pairs=validate({sameEvent:'review',forbiddenPairs:[['rezultat final','shans i dyfishtë']]});
 assert.throws(()=>checkTicket(pairs,[leg(1,2),leg(1,1.5,'Shans i Dyfishtë')],3),/nuk kombinohen në të njëjtën ndeshje/);
 checkTicket(pairs,[leg(1,2),leg(2,1.5,'Shans i Dyfishtë')],3);
 assert.throws(()=>validate({minSelections:5,maxSelections:2}),/minimal/);
 const {run,get,deps}=await setup();
 const platform=createPlatformRules(deps);
 run('UPDATE platform_rules SET config=? WHERE id=1',[JSON.stringify({...validate({}),pendingTimeoutMinutes:10})]);
 run('UPDATE users SET reserved_balance=30 WHERE id=4');
 const ago=m=>new Date(Date.now()-m*60000).toISOString().slice(0,19).replace('T',' ');
 run("INSERT INTO bets(id,user_id,stake,potential_win,status,created_at) VALUES(1,4,10,20,'pending',?),(2,4,20,40,'pending',?)",[ago(11),ago(5)]);
 const expired=platform.expirePending();
 assert.deepEqual(expired,[{betId:1,userId:4}]);
 assert.equal(get('SELECT status FROM bets WHERE id=1').status,'rejected');assert.equal(get('SELECT status FROM bets WHERE id=2').status,'pending');
 assert.equal(get('SELECT reserved_balance FROM users WHERE id=4').reserved_balance,20,'the stake of the refused ticket is released');
 assert.deepEqual(platform.expirePending(),[]);
});
