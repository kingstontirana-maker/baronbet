const test=require('node:test'),assert=require('node:assert/strict'),init=require('sql.js');
const {create,validateRule}=require('./competition-control');
test('API hierarchy, persisted limits, inherited checks and removal',async()=>{
 const db=new(await init()).Database();
 const run=(sql,a=[])=>db.run(sql,a),all=(sql,a=[])=>{const s=db.prepare(sql);s.bind(a);const rows=[];while(s.step())rows.push(s.getAsObject());s.free();return rows;},get=(sql,a)=>all(sql,a)[0];
 run('CREATE TABLE audit_log(actor_id,action,target_type,details)');
 const routes=new Map(),app={post:(p,...f)=>routes.set('POST '+p,f.at(-1)),get:(p,...f)=>routes.set('GET '+p,f.at(-1)),put:(p,...f)=>routes.set('PUT '+p,f.at(-1)),delete:(p,...f)=>routes.set('DELETE '+p,f.at(-1))};
 const feeds={sports:[{id:1,name:'Football'}],'countries/1':[{id:2,name:'England'}],'leagues/2':[{id:3,name:'Premier League'}],'gamesByLeague/3':[{id:4,home_team:'A',away_team:'B'}]};
 const deps={run,all,get,tx:f=>f(),now:()=>new Date().toISOString(),proxy:async p=>({status:200,text:JSON.stringify(feeds[p.replace('/ajax/','')])})};
 let control=create(deps);control.mount(app,()=>{});
 async function call(method,params={},body={},query={}){let status=200,result;await routes.get(method)({params,body,query,user:{id:1}},{status:n=>{status=n;return {json:r=>result=r};},json:r=>result=r});assert.equal(status,200,JSON.stringify(result));return result;}
 for(const [kind,parent] of [['sport',''],['group','1'],['tournament','2'],['event','3']])assert.equal((await call('GET /api/center/competitions',{}, {},{kind,parent})).items.length,1);
 await call('PUT /api/center/competitions/:kind/:id',{kind:'group',id:'2'},{blocked:false,maxStake:10,maxPayout:100});
 assert.throws(()=>control.check([{gameId:4}],11,50),/Basti/);assert.throws(()=>control.check([{game_id:4}],5,101),/Fitimi/);control.check([{gameId:4}],10,100);
 await call('PUT /api/center/competitions/:kind/:id',{kind:'event',id:'4'},{blocked:true,maxStake:null,maxPayout:null});assert.throws(()=>control.check([{gameId:4}],1,2),/bllokuar/);
 control=create(deps);assert.throws(()=>control.check([{gameId:4}],1,2),/bllokuar/);
 await call('DELETE /api/center/competitions/:kind/:id',{kind:'event',id:'4'});control.check([{gameId:4}],5,20);assert.throws(()=>control.check([{gameId:4}],11,20),/Basti/);
 run('CREATE TABLE bets(id INTEGER,user_id INTEGER,stake REAL,status TEXT)');run('CREATE TABLE bet_selections(bet_id INTEGER,game_id TEXT,league_id TEXT)');run('CREATE TABLE risk_event_leagues(event_id TEXT,league_id TEXT)');
 for(const [id,user,amount,status] of [[1,7,10,'accepted'],[2,7,5,'pending'],[3,7,100,'cancelled'],[4,8,100,'accepted'],[5,7,2,'won'],[6,7,100,'rejected'],[7,7,100,'void']]){run('INSERT INTO bets VALUES(?,?,?,?)',[id,user,amount,status]);run('INSERT INTO bet_selections VALUES(?,?,?)',[id,'4','3']);}
 run('INSERT INTO bet_selections VALUES(?,?,?)',[1,'5','3']);
 await call('PUT /api/center/competitions/:kind/:id',{kind:'tournament',id:'3'},{blocked:false,maxStake:null,maxPayout:null,maxUserTotal:20});
 control.check([{gameId:4}],3,5,7);assert.throws(()=>control.check([{gameId:4}],3.01,5,7),/Limiti total/);
 control.check([{gameId:4}],5,10,7,2);assert.throws(()=>control.check([{gameId:4}],1,2,8),/Limiti total/);control.check([{gameId:4}],10,20,9);
 const custom=await call('POST /api/center/competition-groups',{}, {name:'Favorites',sportId:'1',tournamentIds:['3']});
 const listing=await call('GET /api/center/competitions',{}, {},{kind:'group',parent:'1'});assert.equal(listing.items[0].id,custom.id);assert.equal(listing.items[1].name,'England');
 assert.equal((await call('GET /api/center/competitions',{}, {},{kind:'tournament',parent:custom.id})).items[0].id,'3');
 await call('PUT /api/center/competitions/:kind/:id',{kind:'custom-group',id:custom.id},{blocked:true,maxStake:null,maxPayout:null});
 // The tournament has a status of its own, so the blocked group above it does not apply.
 control.check([{gameId:4}],1,2,9);
 await call('DELETE /api/center/competitions/:kind/:id',{kind:'tournament',id:'3'});assert.throws(()=>control.check([{gameId:4}],1,2,9),/Favorites/);
 assert.equal(get('SELECT COUNT(*) n FROM audit_log').n,7);db.close();
});
test('invalid numeric limits cannot bypass checks',()=>{for(const n of [-1,NaN,Infinity,'10'])assert.throws(()=>validateRule({blocked:false,maxStake:n,maxPayout:null}));assert.throws(()=>validateRule({blocked:'false',maxStake:null,maxPayout:null}));});
test('per-user total also applies to tournament groups and center groups',async()=>{
 const db=new(await init()).Database();
 const run=(sql,a=[])=>db.run(sql,a),all=(sql,a=[])=>{const s=db.prepare(sql);s.bind(a);const rows=[];while(s.step())rows.push(s.getAsObject());s.free();return rows;},get=(sql,a)=>all(sql,a)[0];
 run('CREATE TABLE audit_log(actor_id,action,target_type,details)');
 run('CREATE TABLE bets(id INTEGER,user_id INTEGER,stake REAL,status TEXT)');run('CREATE TABLE bet_selections(bet_id INTEGER,game_id TEXT,league_id TEXT)');run('CREATE TABLE risk_event_leagues(event_id TEXT,league_id TEXT)');
 const routes=new Map(),app={post:(p,...f)=>routes.set('POST '+p,f.at(-1)),get:(p,...f)=>routes.set('GET '+p,f.at(-1)),put:(p,...f)=>routes.set('PUT '+p,f.at(-1)),delete:(p,...f)=>routes.set('DELETE '+p,f.at(-1))};
 // England (group 2) holds Premier League (3) and Championship (5).
 const feeds={sports:[{id:1,name:'Football'}],'countries/1':[{id:2,name:'England'}],'leagues/2':[{id:3,name:'Premier League'},{id:5,name:'Championship'}],'gamesByLeague/3':[{id:4,home_team:'A',away_team:'B'}],'gamesByLeague/5':[{id:6,home_team:'C',away_team:'D'}]};
 const control=create({run,all,get,tx:f=>f(),now:()=>new Date().toISOString(),proxy:async p=>({status:200,text:JSON.stringify(feeds[p.replace('/ajax/','')])})});control.mount(app,()=>{});
 async function call(method,params={},body={},query={}){let status=200,result;await routes.get(method)({params,body,query,user:{id:1}},{status:n=>{status=n;return {json:r=>result=r};},json:r=>result=r});assert.equal(status,200,JSON.stringify(result));return result;}
 for(const [kind,parent] of [['sport',''],['group','1'],['tournament','2'],['event','3'],['event','5']])await call('GET /api/center/competitions',{},{},{kind,parent});
 // Player 7 already played 12 € in the Premier League and 5 € in the Championship;
 // ticket 3 has a leg in each but counts once. Cancelled tickets never count.
 for(const [id,amount,status,legs] of [[1,10,'accepted',[['4','3']]],[2,5,'pending',[['6','5']]],[3,2,'won',[['4','3'],['6','5']]],[4,50,'cancelled',[['6','5']]]]){run('INSERT INTO bets VALUES(?,?,?,?)',[id,7,amount,status]);for(const [game,league] of legs)run('INSERT INTO bet_selections VALUES(?,?,?)',[id,game,league]);}
 await call('PUT /api/center/competitions/:kind/:id',{kind:'group',id:'2'},{blocked:false,maxStake:null,maxPayout:null,maxUserTotal:20});
 assert.equal(get("SELECT max_user_total FROM competition_rules WHERE kind='group'").max_user_total,20);
 control.check([{gameId:6}],3,6,7);
 assert.throws(()=>control.check([{gameId:6}],3.01,6,7),/Limiti total për përdoruesin në England është 20.00 €. Janë luajtur 17.00 €/);
 assert.throws(()=>control.check([{gameId:4}],3.01,6,7),/England/,'any tournament of the group');
 control.check([{gameId:6}],5,10,7,2);control.check([{gameId:6}],20,40,8);
 const custom=await call('POST /api/center/competition-groups',{},{name:'Favorites',sportId:'1',tournamentIds:['5']});
 await call('PUT /api/center/competitions/:kind/:id',{kind:'custom-group',id:custom.id},{blocked:false,maxStake:null,maxPayout:null,maxUserTotal:8});
 control.check([{gameId:6}],1,2,7);
 assert.throws(()=>control.check([{gameId:6}],1.01,2,7),/Favorites është 8.00 €. Janë luajtur 7.00 €/);
 control.check([{gameId:4}],3,6,7); // Premier League is outside Favorites
 await call('PUT /api/center/competitions/:kind/:id',{kind:'event',id:'4'},{blocked:false,maxStake:null,maxPayout:null,maxUserTotal:1});
 assert.equal(get("SELECT max_user_total FROM competition_rules WHERE kind='event'").max_user_total,null,'events keep per-ticket limits only');
});

test('market rules stay inside the selected tournament group, including feeds and restart',async()=>{
 const db=new(await init()).Database();
 const run=(sql,a=[])=>db.run(sql,a),all=(sql,a=[])=>{const s=db.prepare(sql);s.bind(a);const rows=[];while(s.step())rows.push(s.getAsObject());s.free();return rows;},get=(sql,a)=>all(sql,a)[0];
 run('CREATE TABLE audit_log(actor_id,action,target_type,details)');
 const routes=new Map(),app=Object.fromEntries(['post','get','put','delete'].map(m=>[m,(p,...f)=>routes.set(m+' '+p,f.at(-1))]));
 let upstreamCalls=0;
 const deps={run,all,get,tx:f=>f(),now:()=>new Date().toISOString(),proxy:async()=>{upstreamCalls++;return {status:200,text:'[]'};}};
 let c=create(deps);c.mount(app,()=>{});
 c.remember([{id:4,league_id:3,country_id:2,sport_id:1,league:'League A',country:'A'},{id:6,league_id:5,country_id:8,sport_id:1,league:'League B',country:'B'}]);
 c.filter.markets([{market:'Total Goals',id:1,odd:2}],4);
 async function call(method,params={},body={},query={}){let code=200,result;const res={status:n=>{code=n;return res;},json:r=>result=r};await routes.get(method)({params,body,query,user:{id:1}},res);assert.equal(code,200,JSON.stringify(result));return result;}
 run("INSERT INTO competition_nodes VALUES('sport','1',NULL,'Football')");run("INSERT INTO competition_nodes VALUES('sport','13',NULL,'Aussie rules')");
 const snapshot=await call('get /api/center/competitions',{},{},{kind:'workspace',tournament:'3'});
 assert.equal(upstreamCalls,0,'workspace snapshot must not wait for the provider');assert.equal(snapshot.sports[0].id,'1','default to football rather than alphabetical first sport');
 assert.equal(snapshot.tournaments.length,2);assert.equal(snapshot.events[0].id,'4');
 for(const [kind,id] of [['group','2'],['tournament','3']]){
  const list=await call('get /api/center/competitions',{},{},{kind:'market',scopeKind:kind,scopeId:id});assert.equal(list.items.length,1);
  const rule={kind:kind+'-market',id:list.items[0].id};
  await call('put /api/center/competitions/:kind/:id',rule,{status:'blocked',maxStake:10,maxPayout:100});
  assert.throws(()=>c.check([{gameId:4,market:'Total Goals'}],1,2),/bllokuar/);
  c.check([{gameId:6,market:'Total Goals'}],20,200);
  assert.equal(c.filter.markets([{market:'Total Goals',odd:2}],4)[0].odd,'-');
  assert.equal(c.filter.markets([{market:'Total Goals',odd:2}],6)[0].odd,2);
  c=create(deps);c.mount(app,()=>{});assert.throws(()=>c.check([{gameId:4,market:'Total Goals'}],1,2),/bllokuar/);
  await call('delete /api/center/competitions/:kind/:id',rule);
 }
 run("INSERT INTO competition_nodes VALUES('custom-group','favorites','1','Favorites')");run("INSERT INTO competition_group_members VALUES('favorites','3')");
 const list=await call('get /api/center/competitions',{},{},{kind:'market',scopeKind:'custom-group',scopeId:'favorites'});
 await call('put /api/center/competitions/:kind/:id',{kind:'custom-group-market',id:list.items[0].id},{status:'active',maxStake:5,maxPayout:null});
 assert.throws(()=>c.check([{gameId:4,market:'Total Goals'}],6,12),/Basti/);c.check([{gameId:6,market:'Total Goals'}],6,12);db.close();
});

test('prematch market catalog returns without waiting for an unresponsive live feed',{timeout:1000},async()=>{
 const db=new(await init()).Database();
 const run=(sql,a=[])=>db.run(sql,a),all=(sql,a=[])=>{const s=db.prepare(sql);s.bind(a);const rows=[];while(s.step())rows.push(s.getAsObject());s.free();return rows;},get=(sql,a)=>all(sql,a)[0];
 const routes=new Map(),app=Object.fromEntries(['post','get','put','delete'].map(m=>[m,(p,...f)=>routes.set(m+' '+p,f.at(-1))]));
 const control=create({run,all,get,tx:f=>f(),now:()=>'',proxy:path=>path.startsWith('/ajax/livegame/')?new Promise(()=>{}):Promise.resolve({status:200,text:JSON.stringify([{market:'Total Goals'}])})});control.mount(app,()=>{});
 let result;await routes.get('get /api/center/competitions')({query:{kind:'market',parent:'4'},body:{},user:{id:1}},{json:r=>result=r,status:()=>{throw Error('Unexpected error response');}});
 assert.equal(result.items[0].name,'Total Goals');db.close();
});
