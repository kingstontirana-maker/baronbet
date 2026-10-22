const {test}=require('node:test'),assert=require('node:assert/strict');
async function fixture(status='accepted'){
 const SQL=await require('sql.js')(),db=new SQL.Database();
 db.run(`CREATE TABLE users(id INTEGER,balance REAL);CREATE TABLE bets(id INTEGER,user_id INTEGER,status TEXT,stake REAL,payout REAL,settled_at TEXT);CREATE TABLE bet_selections(id INTEGER,bet_id INTEGER,odd REAL,result_status TEXT);CREATE TABLE wallet_transactions(user_id INTEGER,type TEXT,amount REAL,balance_after REAL,bet_id INTEGER,note TEXT);CREATE TABLE audit_log(actor_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,details TEXT);INSERT INTO users VALUES(1,90);INSERT INTO bets VALUES(1,1,'${status}',10,0,NULL);INSERT INTO bet_selections VALUES(11,1,2,'pending'),(12,1,3,'pending')`);
 const run=(sql,args=[])=>db.run(sql,args),all=(sql,args=[])=>{const s=db.prepare(sql);s.bind(args);const rows=[];while(s.step())rows.push(s.getAsObject());s.free();return rows;},get=(...args)=>all(...args)[0];
 const deps={run,all,get,tx:fn=>{run('BEGIN');try{const result=fn();run('COMMIT');return result;}catch(e){run('ROLLBACK');throw e;}},now:()=>new Date().toISOString(),money:n=>Math.round(n*100)/100};
 return {...deps,service:require('./selection-status')(deps)};
}
test('individual results recalculate payout once and reverse it when reopened or lost',async()=>{
 const {service,get}=await fixture(),actor={id:9};
 service.update(1,11,'won',actor);assert.equal(get('SELECT status FROM bets').status,'accepted');
 service.update(1,12,'won',actor);assert.equal(get('SELECT balance FROM users').balance,150);
 service.update(1,12,'won',actor);assert.equal(get('SELECT balance FROM users').balance,150);
 assert.equal(get('SELECT COUNT(*) n FROM wallet_transactions').n,1);
 service.update(1,11,'pending',actor);assert.equal(get('SELECT status FROM bets').status,'accepted');assert.equal(get('SELECT balance FROM users').balance,90);
 assert.equal(get('SELECT manual_result FROM bet_selections WHERE id=11').manual_result,'pending');
 service.update(1,11,'lost',actor);assert.equal(get('SELECT status FROM bets').status,'lost');
 service.update(1,11,'won',actor);assert.equal(get('SELECT balance FROM users').balance,150);
});
test('unaccepted ticket results preserve reserved-stake workflow and reject invalid targets',async()=>{
 const {service,get}=await fixture('pending'),actor={id:9};
 service.update(1,11,'lost',actor);assert.equal(get('SELECT status FROM bets').status,'pending');assert.equal(get('SELECT balance FROM users').balance,90);
 assert.throws(()=>service.update(1,99,'won',actor));assert.throws(()=>service.update(1,11,'invalid',actor));
 assert.equal(get('SELECT COUNT(*) n FROM audit_log').n,1);
});
test('cancelled tickets cannot be modified',async()=>{
 const {service}=await fixture('cancelled');assert.throws(()=>service.update(1,11,'won',{id:9}));
});
test('status controls are icon-only and unavailable outside authorized staff roles',()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('public/backoffice.js','utf8');
 const ctx={me:{role:'operator'},can:()=>true};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function selectionStatusButtons('),source.indexOf('function operatorTicketCard(')),ctx);
 const html=ctx.selectionStatusButtons({id:1,status:'accepted'},{id:11,result_status:'won'});
 assert.equal((html.match(/<button /g)||[]).length,3);assert(html.includes('aria-pressed="true"'));assert(html.includes('aria-label="Në pritje"'));
 ctx.me.role='user';assert.equal(ctx.selectionStatusButtons({id:1,status:'accepted'},{id:11}),'');
});

test('automatic settlement preserves a manually pending selection',async()=>{
 const f=await fixture();f.service.update(1,11,'pending',{id:9});f.service.update(1,12,'won',{id:9});
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('server.js','utf8');
 const ctx={...f,console};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function norm('),source.indexOf('// ---- Euro07 real-time live feed ----')),ctx);
 ctx.fetchFinalGame=async()=>{throw Error('Manual results must skip provider evaluation');};
 await ctx.settleAcceptedBets();assert.equal(f.get('SELECT status FROM bets').status,'accepted');assert.equal(f.get('SELECT balance FROM users').balance,90);
});

test('shared staff middleware checks selection-settlement permission instead of user blocking',()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('access-control.js','utf8');
 const start=source.indexOf("    app.use('/api',(req,res,next)=>{"),end=source.indexOf('    const guard=',start);
 let middleware,checked;const ctx={app:{use:(path,fn)=>middleware=fn},auth:(req,res,next)=>next(),hasPermission:(user,p)=>{checked=p;return true;},jsonError(){throw Error('Unexpected denial');}};
 vm.runInNewContext(source.slice(start,end),ctx);
 let passed=false;middleware({path:'/operator/tickets/1/selections/11/status',method:'POST',body:{},user:{role:'operator'}},{},()=>passed=true);
 assert.equal(passed,true);assert.equal(checked,'bets.settle');
});
