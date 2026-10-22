'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
async function fixture(){
 const SQL=await require('sql.js')(),db=new SQL.Database();
 const run=(sql,args=[])=>db.run(sql,args),all=(sql,args=[])=>{const s=db.prepare(sql);s.bind(args);const rows=[];while(s.step())rows.push(s.getAsObject());s.free();return rows;},get=(...args)=>all(...args)[0];
 const deps={run,all,get,tx:fn=>{db.run('BEGIN');try{const out=fn();db.run('COMMIT');return out;}catch(e){db.run('ROLLBACK');throw e;}},now:()=>new Date().toISOString()};
 return {db,deps,alerts:require('./platform-alerts')(deps)};
}
test('alerts persist, group repeated issues, acknowledge and reopen continuing incidents',async()=>{
 const {alerts,deps}=await fixture();
 alerts.report('market:6663','unknown_market','Market i panjohur',{betId:7,marketId:'6663'});
 alerts.report('market:6663','unknown_market','Market i panjohur',{betId:8});
 assert.equal(alerts.snapshot().unread,1);assert.equal(alerts.snapshot().alerts.length,1);
 assert.equal(alerts.snapshot().alerts[0].occurrences,1);
 const id=alerts.snapshot().alerts[0].id;alerts.acknowledge(id,1);
 assert.equal(alerts.snapshot().unread,0);
 deps.run('UPDATE platform_alerts SET updated_at=?',[new Date(Date.now()-61000).toISOString()]);
 alerts.report('market:6663','unknown_market','Market i panjohur',{betId:9});
 assert.equal(alerts.snapshot().unread,1);assert.equal(alerts.snapshot().alerts[0].occurrences,2);
 assert.equal(require('./platform-alerts')(deps).snapshot().unread,1);
 alerts.resolve('market:6663');
 assert.equal(alerts.snapshot().unread,0);
 assert(JSON.parse(alerts.snapshot().alerts[0].details).resolvedAt);
});
test('all alert endpoints use center authentication and stream pushes a new incident immediately',async()=>{
 const {alerts}=await fixture(),routes=[];const auth=()=>{};let valid=true;
 alerts.mount({get:(...args)=>routes.push(args),post:(...args)=>routes.push(args)},auth,()=>valid);
 assert.equal(routes.length,4);assert(routes.every(r=>r[1]===auth));
 const chunks=[];let cleanup,ended=false;
 const req={user:{id:1},on:(name,fn)=>cleanup=fn},res={writeHead(){},write:s=>chunks.push(s),end:()=>ended=true};
 routes.find(r=>r[0].endsWith('/stream'))[2](req,res);
 try{
  assert.equal(chunks.length,1);
  alerts.report('api:test','api_failure','API failure',{});
  assert.equal(chunks.length,2);assert(chunks[1].includes('API failure'));
  assert.equal(alerts.remove(alerts.snapshot().alerts[0].id),true);
  assert.equal(chunks.length,3);assert(chunks[2].includes('"unread":0'));assert(chunks[2].includes('"alerts":[]'));
  valid=false;alerts.report('api:other','api_failure','Other failure',{});assert.equal(ended,true);
 }finally{cleanup();}
});

test('deleted alerts disappear persistently and a newly detected incident can notify again',async()=>{
 const {alerts,deps}=await fixture();
 alerts.report('identity:7','missing_timeline_identity','Mungon identiteti',{betId:1});
 const id=alerts.snapshot().alerts[0].id;
 assert.equal(alerts.remove(id),true);assert.equal(alerts.remove(id),false);
 assert.equal(alerts.remove(NaN),false);assert.equal(alerts.remove(-1),false);
 assert.equal(require('./platform-alerts')(deps).snapshot().alerts.length,0);
 alerts.report('identity:7','missing_timeline_identity','Mungon identiteti',{betId:1});
 assert.equal(alerts.snapshot().unread,1);assert.notEqual(alerts.snapshot().alerts[0].id,id);
});
test('API monitor reports outgoing failures and internal errors, excluding expected client errors',()=>{
 const monitor=require('./api-monitor')(),issues=[];monitor.onIssue(row=>issues.push(row));
 monitor.begin('Incoming','GET','/api/auth/me')(401);
 monitor.begin('Outgoing','GET','https://provider.test/ajax/feed')(200,'Invalid JSON');
 monitor.begin('Incoming','GET','/api/test')(500);
 monitor.begin('Outgoing','GET','https://provider.test/ajax/feed')(200);
 assert.equal(issues.length,2);assert.equal(issues[0].error,'Invalid JSON');assert.equal(issues[1].status,500);
});

test('center banner reads streamed notification frames without page reload',async()=>{
 const fs=require('fs'),vm=require('vm');const source=fs.readFileSync('public/backoffice.js','utf8');
 const nodes={},navigation={textContent:''};let delivered=false,release;
 const finished=new Promise(resolve=>release=resolve);
 const ctx={AbortController,TextDecoder,sessionToken:'fixture',currentRoute:'dashboard',esc:String,$:id=>nodes[id],
  document:{addEventListener(){},createElement:()=>({setAttribute(){}}),body:{append:node=>nodes[node.id]=node},querySelector:()=>navigation},
  window:{addEventListener(){}},setTimeout:()=>{release();return 0;},clearTimeout(){},
  fetch:async()=>({ok:true,status:200,body:{getReader:()=>({read:async()=>{if(delivered)return {done:true};delivered=true;return {done:false,value:new TextEncoder().encode('data: '+JSON.stringify({unread:2,alerts:[]})+'\n\n')};}})}})};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('let platformAlertSnapshot=')),ctx);
 await ctx.startPlatformAlerts();await finished;
 assert.equal(navigation.textContent,'Njoftime (2)');
 assert(nodes.platformAlertBanner.innerHTML.includes('2 probleme'));
});
