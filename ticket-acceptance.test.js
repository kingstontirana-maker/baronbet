'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {defaults,validate,eligible}=require('./ticket-acceptance');
test('automatic acceptance requires every applicable rule and rejects unknown event types',()=>{
 const c=defaults(),live=[{acceptanceType:'live'}],pre=[{acceptanceType:'prematch'}],mixed=[...live,...pre];
 assert.equal(eligible(c,live,1,2,2),false);c.live.enabled=true;
 assert.equal(eligible(c,live,50,500,20),true);
 for(const values of [[50.01,500,20],[50,500.01,20],[50,500,20.01]])assert.equal(eligible(c,live,...values),false);
 assert.equal(eligible(c,Array(6).fill(live[0]),1,2,2),false);
 assert.equal(eligible(c,mixed,1,2,2),false);c.prematch.enabled=true;
 assert.equal(eligible(c,pre,100,1000,50),true);assert.equal(eligible(c,mixed,50,500,20),true);
 assert.equal(eligible(c,mixed,51,500,20),false);
 assert.equal(eligible(c,[{acceptanceType:'unknown'}],1,2,2),false);assert.equal(eligible(c,[],1,2,2),false);
 for(const bad of [NaN,Infinity,-1,0,'20'])assert.throws(()=>validate({...c,live:{...c.live,maxStake:bad}}));
 assert.throws(()=>validate({...c,live:{...c.live,maxEvents:1.5}}));
 assert.deepEqual(validate(c),c);
});

test('blank limits are independent, persist as null and do not remove other restrictions',()=>{
 const c=defaults();c.live={enabled:true,maxStake:null,maxPayout:100,maxOdds:'',maxEvents:null};
 const clean=validate(c);assert.equal(clean.live.maxOdds,null);
 assert.equal(eligible(clean,[{acceptanceType:'live'}],50,100,40),true);
 assert.equal(eligible(clean,[{acceptanceType:'live'}],50,101,40),false);
 clean.live.maxPayout=null;assert.equal(eligible(clean,Array(12).fill({acceptanceType:'live'}),1000,5000,100),true);
 clean.live.enabled=false;assert.equal(eligible(clean,[{acceptanceType:'live'}],1,2,2),false);
});

test('match limit counts distinct events across markets and mixed tickets',()=>{
 const c=defaults();for(const kind of ['live','prematch'])c[kind]={enabled:true,maxStake:null,maxPayout:null,maxOdds:null,maxEvents:1};
 const picks=[{gameId:10,acceptanceType:'live'},{gameId:10,acceptanceType:'live'}];
 assert.equal(eligible(c,picks,10,40,4),true);
 assert.equal(eligible(c,[...picks,{gameId:11,acceptanceType:'live'}],10,40,4),false);
 c.live.maxEvents=2;
 assert.equal(eligible(c,[picks[0],{gameId:11,acceptanceType:'prematch'}],10,40,4),false);
 c.prematch.maxEvents=2;
 assert.equal(eligible(c,[picks[0],{gameId:11,acceptanceType:'prematch'}],10,40,4),true);
 assert.equal(eligible(c,picks,NaN,40,4),false);
 const optional=validate({live:{enabled:true},prematch:{enabled:false}});
 assert.equal(optional.live.maxEvents,null);assert.equal(optional.live.maxOdds,null);
});

test('operator configuration endpoints preserve old settings and reject concurrent updates',async()=>{
 const SQL=await require('sql.js')(),db=new SQL.Database();
 const run=(sql,args=[])=>db.run(sql,args),get=(sql,args=[])=>{const q=db.prepare(sql);q.bind(args);const row=q.step()?q.getAsObject():null;q.free();return row;};
 run('CREATE TABLE audit_log(actor_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,details TEXT)');
 const acceptance=require('./ticket-acceptance').createAcceptance({run,get,tx:fn=>fn(),now:()=>new Date().toISOString(),money:n=>Math.round(n*100)/100});
 const old=defaults();for(const kind of ['live','prematch']){old[kind].maxSelections=old[kind].maxEvents;delete old[kind].maxEvents;}
 run('UPDATE ticket_acceptance_config SET config=?',[JSON.stringify(old)]);
 assert.equal(acceptance.read().rules.live.maxEvents,5);
 const routes=[];const guard=()=>{};
 acceptance.mount({get:(...args)=>routes.push(args),put:(...args)=>routes.push(args)},guard);
 assert(routes.every(r=>r[0].startsWith('/api/operator/ticket-acceptance')&&r[1]===guard));
 const rules=validate({live:{enabled:true},prematch:{enabled:false}});
 let result,status=200;const res={json:x=>result=x,status:n=>{status=n;return res;}};
 routes[2][2]({body:{rules,version:0},user:{id:9}},res);
 assert.equal(result.version,1);assert.equal(acceptance.read().rules.live.maxStake,null);
 routes[2][2]({body:{rules,version:0},user:{id:9}},res);
 assert.equal(status,409);
});

test('configuration access is restricted to operators allowed to accept tickets',()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('server.js','utf8');
 const registration=source.match(/ticketAcceptance\.mount\(app,[^\n]+/)[0];
 let guard;const ctx={app:{},ticketAcceptance:{mount:(app,fn)=>guard=fn},auth:(req,res,next)=>next(),hasPermission:u=>u.allow,jsonError:(res,status)=>res.status=status};
 vm.runInNewContext(registration,ctx);
 for(const [role,allow,expected] of [['operator',true,true],['operator',false,false],['center',true,false],['user',true,false]]){
  let passed=false;const res={};guard({user:{role,allow}},res,()=>passed=true);
  assert.equal(passed,expected);if(!expected)assert.equal(res.status,403);
 }
});

test('operator navigation displays the acceptance configuration and excludes it for other roles',()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('public/backoffice.js','utf8');
 const nodes={navigation:{innerHTML:''},search:{hidden:false}};
 const ctx={me:{role:'operator'},can:p=>['bets.view','bets.accept'].includes(p),$:id=>nodes[id],icon:()=>'',esc:String};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('const modules='),source.indexOf('function notice('))+source.slice(source.indexOf('function navigation('),source.indexOf('function heading(')),ctx);
 ctx.navigation();assert(nodes.navigation.innerHTML.includes('href="#/configuration"'));assert(nodes.navigation.innerHTML.includes('Konfigurime'));
 ctx.can=p=>p==='bets.view';ctx.navigation();assert(!nodes.navigation.innerHTML.includes('href="#/configuration"'));
 ctx.can=()=>true;ctx.me.role='center';ctx.navigation();assert(!nodes.navigation.innerHTML.includes('href="#/configuration"'));
});

test('advanced ranges enforce inclusive minima, maxima, per-selection odds and policy precedence',()=>{
 const {decision}=require('./ticket-acceptance'),c=defaults();c.live.enabled=true;c.live.minEvents=3;
 const picks=[1,2,3].map(gameId=>({gameId,acceptanceType:'live',odd:2}));
 assert.equal(eligible(c,picks.slice(0,2),10,80,8),false);assert.equal(eligible(c,picks,10,80,8),true);
 c.live.minOdds=8;c.live.minStake=10;c.live.minPayout=80;c.live.minSelectionOdds=2;c.live.maxSelectionOdds=2;
 assert.equal(eligible(c,picks,10,80,8),true);
 assert.equal(eligible(c,[...picks.slice(0,2),{...picks[2],odd:2.01}],10,80,8),false);
 c.blacklist=[50];assert.match(decision(c,picks,10,80,8,{lineage:[1,50]}),/listën e zezë/);
 c.blacklist=[];c.policy.blockRepeats=true;assert.equal(eligible(c,picks,10,80,8,{repeated:true}),false);
 c.policy.blockRepeats=false;c.policy.allowSameEvent=false;assert.equal(eligible(c,[...picks,picks[0]],10,80,8),false);
 c.policy.allowMixed=false;assert.equal(eligible(c,[...picks,{gameId:4,acceptanceType:'prematch',odd:2}],10,80,8),false);
 assert.throws(()=>validate({...c,live:{...c.live,minEvents:6,maxEvents:5}}));
 assert.throws(()=>validate({...c,blacklist:['50']}));assert.throws(()=>validate({...c,policy:{allowMixed:'yes'}}));
});

test('daily and open-ticket caps include the current ticket and fail closed without context',()=>{
 const c=defaults();c.live.enabled=true;c.live.maxDailyTickets=3;c.live.maxDailyStake=100;c.live.maxOpenTickets=2;
 const picks=[{gameId:1,odd:2,acceptanceType:'live'}],context={dailyTickets:3,dailyStake:100,openTickets:2};
 assert.equal(eligible(c,picks,10,20,2,context),true);
 for(const [key,value] of [['dailyTickets',4],['dailyStake',100.01],['openTickets',3]])assert.equal(eligible(c,picks,10,20,2,{...context,[key]:value}),false);
 assert.equal(eligible(c,picks,10,20,2),false);
});

test('real placement blocks a blacklisted ancestor and accepts an eligible ticket only once',async()=>{
 const SQL=await require('sql.js')(),db=new SQL.Database();
 const run=(sql,args)=>args?db.run(sql,args):db.run(sql),all=(sql,args=[])=>{const q=db.prepare(sql);q.bind(args);const rows=[];while(q.step())rows.push(q.getAsObject());q.free();return rows;},get=(...args)=>all(...args)[0];
 run("CREATE TABLE users(id INTEGER,role TEXT,parent_id INTEGER,business_parent_id INTEGER,status TEXT,balance REAL,reserved_balance REAL);CREATE TABLE bets(id INTEGER,user_id INTEGER,status TEXT,stake REAL,potential_win REAL,total_odds REAL,created_at TEXT,reserved REAL,accepted_by INTEGER,accepted_at TEXT);CREATE TABLE bet_selections(bet_id INTEGER,game_id TEXT,market_id TEXT,market TEXT,selection TEXT,special_value TEXT);CREATE TABLE audit_log(actor_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,details TEXT);CREATE TABLE wallet_transactions(user_id INTEGER,type TEXT,amount REAL,balance_after REAL,bet_id INTEGER,note TEXT);INSERT INTO users VALUES(1,'user',2,2,'active',100,10),(2,'agent',3,3,'active',0,0),(3,'partner',NULL,NULL,'active',0,0);INSERT INTO bets VALUES(10,1,'pending',10,20,2,'2026-10-16T10:00:00Z',10,NULL,NULL);INSERT INTO bet_selections VALUES(10,'50','1','Result','1','')");
 const service=require('./ticket-acceptance').createAcceptance({run,get,all,tx:fn=>fn(),now:()=> '2026-10-16T10:00:00Z',money:n=>Math.round(n*100)/100});
 const rules=defaults();rules.live.enabled=true;rules.blacklist=[3];run('UPDATE ticket_acceptance_config SET config=?',[JSON.stringify(rules)]);
 const picks=[{gameId:50,marketId:1,selection:'1',odd:2,acceptanceType:'live'}];
 assert.equal(service.apply(10,picks),null);assert.equal(get('SELECT balance FROM users WHERE id=1').balance,100);
 assert.match(JSON.parse(get("SELECT details FROM audit_log WHERE action='ticket_auto_review'").details).reason,/listën e zezë/);
 rules.blacklist=[];run('UPDATE ticket_acceptance_config SET config=?',[JSON.stringify(rules)]);
 run("INSERT INTO bets VALUES(11,1,'accepted',10,20,2,'2026-10-16T09:00:00Z',0,NULL,NULL);INSERT INTO bet_selections VALUES(11,'50','1','Result','1','')");
 rules.policy.blockRepeats=true;run('UPDATE ticket_acceptance_config SET config=?',[JSON.stringify(rules)]);
 assert.equal(service.apply(10,picks),null);
 assert.match(JSON.parse(all("SELECT details FROM audit_log WHERE action='ticket_auto_review'").at(-1).details).reason,/përsëritur/);
 rules.policy.blockRepeats=false;rules.live.maxDailyTickets=1;run('UPDATE ticket_acceptance_config SET config=?',[JSON.stringify(rules)]);
 assert.equal(service.apply(10,picks),null);
 rules.live.maxDailyTickets=null;run('UPDATE ticket_acceptance_config SET config=?',[JSON.stringify(rules)]);
 assert.equal(service.apply(10,picks).status,'accepted');assert.equal(service.apply(10,picks),null);
 assert.equal(get('SELECT balance FROM users WHERE id=1').balance,90);assert.equal(get('SELECT COUNT(*) n FROM wallet_transactions').n,1);
});

test('advanced configuration renders ranges, policy switches and inherited blacklist accounts',async()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('public/backoffice.js','utf8');
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',addEventListener(){},querySelectorAll:()=>[]});return nodes.get(id);};
 let html='',submit;const rules=defaults();rules.prematch.minEvents=3;
 const ctx={$:node,esc:String,date:String,labels:{partner:'Partner'},panel:(title,subtitle,body)=>title+body,table:rows=>rows.map(a=>a.username).join(','),bindForm:(id,fn)=>submit=fn,Map,clearTimeout,setTimeout};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function acceptancePage('),source.indexOf('async function competitionsPage(')),ctx);
 await ctx.acceptancePage({valid:()=>true,get:async()=>({rules,version:1,blockedAccounts:[{id:7,role:'partner',username:'partner_blocked'}]}),commit:s=>html=s});
 assert(html.includes('name="prematch.minEvents" value="3"'));assert(html.includes('name="live.maxDailyStake"'));assert(html.includes('name="policy.blockRepeats"'));assert(nodes.get('acceptanceBlacklist').innerHTML.includes('partner_blocked'));assert.equal(typeof submit,'function');
 // Older running servers return only the two original rule groups.
 delete rules.policy;
 await ctx.acceptancePage({valid:()=>true,get:async()=>({rules,version:1}),commit:s=>html=s});
 assert(html.includes('name="policy.allowMixed" checked'));
 assert(html.includes('name="policy.allowSameEvent" checked'));
 assert(!html.includes('name="policy.blockRepeats" checked'));
 assert(html.includes('name="prematch.minEvents" value="3"'));
 rules.policy={allowMixed:false};
 await ctx.acceptancePage({valid:()=>true,get:async()=>({rules,version:1}),commit:s=>html=s});
 assert(!html.includes('name="policy.allowMixed" checked'));
});
