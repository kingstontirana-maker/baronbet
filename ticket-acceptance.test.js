'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {defaults,validate,migrate,eligible,decision,albaniaDayStart}=require('./ticket-acceptance');
const live=(gameId=1)=>({gameId,acceptanceType:'live'}),pre=(gameId=2)=>({gameId,acceptanceType:'prematch'});

test('a ticket is accepted only inside every cap of its type',()=>{
 const c=defaults();
 assert.match(decision(c,[live()],1,2,2),/nuk është aktiv për Live/);
 c.live.enabled=true;
 assert.equal(eligible(c,[live()],50,500,20),true,'caps are inclusive');
 for(const [stake,payout,odds,reason] of [[50.01,500,20,/shumës maksimale/],[50,500.01,20,/fitimit maksimal/],[50,500,20.01,/koeficientit maksimal/]])
  assert.match(decision(c,[live()],stake,payout,odds),reason);
 assert.match(decision(c,[1,2,3,4,5,6].map(live),1,2,2),/numrit të ndeshjeve/);
 assert.match(decision(c,[{gameId:9,acceptanceType:'unknown'}],1,2,2),/nuk është aktiv/);
 assert.equal(eligible(c,[],1,2,2),false);
});

test('mandatory caps: stake and payout must be set when a type is enabled',()=>{
 const c=defaults();c.live.enabled=true;
 assert.throws(()=>validate({...c,live:{...c.live,maxStake:null}}),/shuma maksimale është e detyrueshme/);
 assert.throws(()=>validate({...c,live:{...c.live,maxPayout:''}}),/fitimi maksimal është i detyrueshëm/);
 const optional=validate({...c,live:{...c.live,maxOdds:null,maxEvents:null}});
 assert.equal(optional.live.maxOdds,null);assert.equal(eligible(optional,[live()],50,500,999),true,'blank optional cap = no limit');
 assert.equal(validate({...c,prematch:{...c.prematch,enabled:false,maxStake:null,maxPayout:null}}).prematch.maxStake,null,'a disabled type needs no caps');
 for(const bad of [NaN,Infinity,-1,0,'20'])assert.throws(()=>validate({...c,live:{...c.live,maxStake:bad}}));
 assert.throws(()=>validate({...c,live:{...c.live,maxEvents:1.5}}));
 assert.throws(()=>validate({...c,blacklist:['50']}));
 assert.deepEqual(validate(c),c);
});

test('fixed rules: same match goes to the operator, mixed tickets need both rule sets',()=>{
 const c=defaults();c.live.enabled=true;
 assert.match(decision(c,[live(10),{...live(10),selection:'Over'}],10,40,4),/e njëjta ndeshje/);
 assert.match(decision(c,[live(10),pre(11)],10,40,4),/nuk është aktiv për Prematch/);
 c.prematch.enabled=true;
 assert.equal(eligible(c,[live(10),pre(11)],50,40,4),true);
 assert.match(decision(c,[live(10),pre(11)],51,40,4),/Live: mbi kufirin e shumës/,'the stricter Live cap applies');
});

test('blacklist and the daily cap per player',()=>{
 const c=defaults();c.live.enabled=true;c.blacklist=[50];
 assert.match(decision(c,[live()],10,20,2,{lineage:[1,50]}),/listën e zezë/);
 c.blacklist=[];c.maxDailyStake=100;
 assert.equal(eligible(c,[live()],10,20,2,{dailyStake:100}),true);
 assert.match(decision(c,[live()],10,20,2,{dailyStake:100.01}),/kufiri ditor/);
 assert.equal(eligible(c,[live()],10,20,2),false,'fails closed without the daily total');
});

test('the day starts at midnight in Albania, not UTC',()=>{
 assert.equal(albaniaDayStart('2026-10-23T23:30:00Z'),'2026-10-23 22:00:00'); // 01:30 on the 24th in Tirana (UTC+2)
 assert.equal(albaniaDayStart('2026-10-23T21:59:00Z'),'2026-10-22 22:00:00');
 assert.equal(albaniaDayStart('2026-12-01T10:00:00Z'),'2026-11-30 23:00:00'); // winter time, UTC+1
});

test('old detailed configurations migrate to the simple one',()=>{
 const old={live:{enabled:true,minEvents:2,maxStake:null,maxPayout:300,maxOdds:15,maxSelections:4,maxDailyStake:200,maxDailyTickets:9},prematch:{enabled:false,maxStake:80,maxPayout:null,maxDailyStake:150},policy:{allowMixed:false,blockRepeats:true},blacklist:[7]};
 assert.deepEqual(migrate(old),{live:{enabled:true,maxStake:50,maxPayout:300,maxOdds:15,maxEvents:4},prematch:{enabled:false,maxStake:80,maxPayout:null,maxOdds:null,maxEvents:null},maxDailyStake:150,blacklist:[7]});
 const current=validate(defaults());assert.deepEqual(migrate(current),current,'new configurations pass through unchanged');
});

test('configuration endpoints migrate stored settings and reject concurrent updates',async()=>{
 const SQL=await require('sql.js')(),db=new SQL.Database();
 const run=(sql,args=[])=>db.run(sql,args),get=(sql,args=[])=>{const q=db.prepare(sql);q.bind(args);const row=q.step()?q.getAsObject():null;q.free();return row;};
 run('CREATE TABLE audit_log(actor_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,details TEXT)');
 run('CREATE TABLE users(id INTEGER,username TEXT,role TEXT)');run("INSERT INTO users VALUES(7,'manager_x','manager')");
 const acceptance=require('./ticket-acceptance').createAcceptance({run,get,tx:fn=>fn(),now:()=>new Date().toISOString(),money:n=>Math.round(n*100)/100});
 run('UPDATE ticket_acceptance_config SET config=?',[JSON.stringify({live:{enabled:false,maxSelections:3},prematch:{enabled:false},policy:{}})]);
 assert.equal(acceptance.read().rules.live.maxEvents,3);
 const routes=[];const guard=()=>{};
 acceptance.mount({get:(...args)=>routes.push(args),put:(...args)=>routes.push(args)},guard);
 assert(routes.every(r=>r[0].startsWith('/api/operator/ticket-acceptance')&&r[1]===guard));
 const rules={...defaults(),blacklist:[7]};rules.live.enabled=true;
 let result,status=200;const res={json:x=>result=x,status:n=>{status=n;return res;}};
 routes[2][2]({body:{rules,version:0},user:{id:9}},res);
 assert.equal(result.version,1);assert.deepEqual(result.rules.blacklist,[7],'any network role can be blacklisted');
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

test('real placement: blacklisted branch, daily cap, and a single acceptance',async()=>{
 const SQL=await require('sql.js')(),db=new SQL.Database();
 const run=(sql,args)=>args?db.run(sql,args):db.run(sql),all=(sql,args=[])=>{const q=db.prepare(sql);q.bind(args);const rows=[];while(q.step())rows.push(q.getAsObject());q.free();return rows;},get=(...args)=>all(...args)[0];
 run("CREATE TABLE users(id INTEGER,role TEXT,parent_id INTEGER,business_parent_id INTEGER,status TEXT,balance REAL,reserved_balance REAL);CREATE TABLE bets(id INTEGER,user_id INTEGER,status TEXT,stake REAL,potential_win REAL,total_odds REAL,created_at TEXT,reserved REAL,accepted_by INTEGER,accepted_at TEXT);CREATE TABLE audit_log(actor_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,details TEXT);CREATE TABLE wallet_transactions(user_id INTEGER,type TEXT,amount REAL,balance_after REAL,bet_id INTEGER,note TEXT)");
 run("INSERT INTO users VALUES(1,'user',3,3,'active',100,10),(3,'agent',NULL,NULL,'active',0,0);INSERT INTO bets VALUES(10,1,'pending',10,20,2,'2026-10-23 08:00:00',10,NULL,NULL)");
 const service=require('./ticket-acceptance').createAcceptance({run,get,all,tx:fn=>fn(),now:()=>'2026-10-23T10:00:00.000Z',money:n=>Math.round(n*100)/100});
 const save=rules=>run('UPDATE ticket_acceptance_config SET config=?',[JSON.stringify(rules)]);
 const reason=()=>JSON.parse(all("SELECT details FROM audit_log WHERE action='ticket_auto_review'").at(-1).details).reason;
 const rules=defaults();rules.live.enabled=true;rules.blacklist=[3];save(rules);
 const picks=[{gameId:50,odd:2,acceptanceType:'live'}];
 assert.equal(service.apply(10,picks),null);assert.match(reason(),/listën e zezë/);
 // 95 € already played today (Albanian day starts 2026-10-22 22:00 UTC); yesterday's ticket does not count.
 run("INSERT INTO bets VALUES(11,1,'won',95,190,2,'2026-10-22 23:00:00',0,NULL,NULL),(12,1,'lost',500,1000,2,'2026-10-22 21:00:00',0,NULL,NULL)");
 rules.blacklist=[];rules.maxDailyStake=100;save(rules);
 assert.equal(service.apply(10,picks),null);assert.match(reason(),/kufiri ditor/);
 rules.maxDailyStake=105;save(rules);
 assert.equal(service.apply(10,picks).status,'accepted');assert.equal(service.apply(10,picks),null,'never twice');
 assert.equal(get('SELECT balance FROM users WHERE id=1').balance,90);assert.equal(get('SELECT COUNT(*) n FROM wallet_transactions').n,1);
 assert.deepEqual(service.apply(10,picks,{defer:true}),null,'an accepted ticket is not deferred again');
});

test('the configuration page shows only the essential fields',async()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('public/backoffice.js','utf8');
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',addEventListener(){},querySelectorAll:()=>[]});return nodes.get(id);};
 let html='',submit,sent;const rules=defaults();rules.maxDailyStake=250;
 const ctx={$:node,esc:String,date:String,labels:{partner:'Partner'},panel:(title,subtitle,body)=>title+body,table:rows=>rows.map(a=>a.username).join(','),bindForm:(id,fn)=>submit=fn,notice(){},api:async(url,method,body)=>{sent=body;return {version:2,updatedAt:'now'};},Map,clearTimeout,setTimeout};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('// Automatic acceptance: a switch'),source.indexOf('async function competitionsPage(')),ctx);
 await ctx.acceptancePage({valid:()=>true,get:async()=>({rules,version:1,blockedAccounts:[{id:7,role:'partner',username:'partner_blocked'}]}),commit:s=>html=s});
 const inputs=[...html.matchAll(/name="([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(inputs.sort(),['live.enabled','live.maxEvents','live.maxOdds','live.maxPayout','live.maxStake','maxDailyStake','prematch.enabled','prematch.maxEvents','prematch.maxOdds','prematch.maxPayout','prematch.maxStake'].sort());
 assert(html.includes('name="maxDailyStake" min="0.01" step="0.01" value="250"'));
 assert(nodes.get('acceptanceBlacklist').innerHTML.includes('partner_blocked'));
 const form=new Map([['live.enabled','on'],['live.maxStake','40'],['live.maxPayout','400'],['live.maxOdds',''],['live.maxEvents','3'],['prematch.maxStake',''],['prematch.maxPayout',''],['prematch.maxOdds',''],['prematch.maxEvents',''],['maxDailyStake','']]);
 await submit({get:k=>form.get(k)??null,has:k=>form.has(k)});
 sent=JSON.parse(JSON.stringify(sent)); // objects built inside vm carry another realm's prototypes
 assert.deepEqual(sent,{rules:{maxDailyStake:null,blacklist:[7],live:{enabled:true,maxStake:40,maxPayout:400,maxOdds:null,maxEvents:3},prematch:{enabled:false,maxStake:null,maxPayout:null,maxOdds:null,maxEvents:null}},version:1});
 assert.deepEqual(validate(sent.rules),sent.rules,'what the page sends is accepted by the server');
});
