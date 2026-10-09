const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),vm=require('vm');

test('My Bets displays every selection result independently of ticket status and market name',()=>{
  const source=fs.readFileSync('public/euro07.bet/vbet/user/build/main.js','utf8');
  const ctx={user:{username:'fixture'},esc:s=>String(s??'').replaceAll('<','&lt;'),formatBetTime:()=>'',betStatusLabel:s=>s};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function selectionResultView('),source.indexOf('let myBetsLoadSequence=')),ctx);
  for(const [result,label] of [['won','Fituese'],['lost','Humbëse'],['void','rimbursim'],['half_won','Gjysmë fituese'],['half_lost','Gjysmë humbëse'],['cancelled','E anuluar']]){
    const html=ctx.renderMyBetCard({id:1,status:'lost',selections:[{market:'Any provider market',resultStatus:result,odd:2}]});
    assert(html.includes(`mybetResult ${result}`));assert(html.includes(label));
  }
  const waiting=ctx.renderMyBetCard({id:72,status:'accepted',selections:[{market:'Result',resultStatus:'pending',odd:2}]});
  assert(waiting.includes('data-bet-card="72"'));assert(!waiting.includes('mybetResult pending'));assert(!waiting.includes('Në pritje'));
  assert.equal(ctx.selectionResultView({result_status:'won'}).status,'won');
  assert.equal(ctx.selectionResultView({resultStatus:'constructor'}).status,'pending');
  assert.equal(ctx.selectionResultView({resultStatus:'<script>'}).status,'pending');
});

test('lost tickets keep resolving their remaining markets without another payout',async()=>{
  const SQL=await require('sql.js')();const db=new SQL.Database();
  const run=(sql,params)=>params?db.run(sql,params):db.run(sql);
  const all=(sql,params=[])=>{const stmt=db.prepare(sql);stmt.bind(params);const out=[];while(stmt.step())out.push(stmt.getAsObject());stmt.free();return out;};
  const get=(sql,params=[])=>all(sql,params)[0];
  run("CREATE TABLE event_identities(game_id TEXT,api_id TEXT,sport_id TEXT);CREATE TABLE bets(id INTEGER,status TEXT,user_id INTEGER,stake REAL,payout REAL,settled_at TEXT);CREATE TABLE bet_selections(id INTEGER,bet_id INTEGER,game_id TEXT,market TEXT,selection TEXT,odd REAL,result_status TEXT,game_api_id TEXT);CREATE TABLE users(id INTEGER,balance REAL,reserved_balance REAL);CREATE TABLE audit_log(actor_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,details TEXT);CREATE TABLE wallet_transactions(user_id INTEGER,type TEXT,amount REAL,balance_after REAL,bet_id INTEGER,note TEXT)");
  run("INSERT INTO users VALUES(1,100,30);INSERT INTO bets VALUES(1,'accepted',1,10,0,NULL);INSERT INTO bet_selections VALUES(1,1,'one','Fulltime Result','2',2,'pending','one'),(2,1,'two','Fulltime Result','1',2,'pending','two')");
  const source=fs.readFileSync('server.js','utf8');
  const ctx={console,all,get,run,tx:fn=>fn(),money:n=>Math.round(n*100)/100,now:()=>new Date().toISOString(),setInterval,clearInterval};vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function norm('),source.indexOf('// ---- Euro07 real-time live feed ----')),ctx);
  let secondFinished=false;
  ctx.fetchFinalGame=async id=>({finished:id==='one'||secondFinished,score:{home:2,away:0}});
  ctx.fetchTimeline=async()=>null;
  await ctx.settleAcceptedBets();
  assert.equal(get('SELECT status FROM bets').status,'lost');
  assert.equal(get('SELECT result_status FROM bet_selections WHERE id=2').result_status,'pending');
  secondFinished=true;await ctx.settleAcceptedBets();await ctx.settleAcceptedBets();
  assert.deepEqual(all('SELECT result_status FROM bet_selections ORDER BY id').map(s=>s.result_status),['lost','won']);
  assert.equal(get('SELECT balance FROM users').balance,100);
  assert.equal(get('SELECT count(*) n FROM wallet_transactions').n,0);
  assert.equal(get("SELECT count(*) n FROM audit_log WHERE action='auto_ticket_settled'").n,1);
  // Quarter-line payouts and void refunds are applied exactly once.
  run("INSERT INTO bets VALUES(2,'accepted',1,10,0,NULL),(3,'accepted',1,10,0,NULL);INSERT INTO bet_selections VALUES(3,2,'two','Asian Total Goals','Over 1.75',2,'pending','two'),(4,3,'two','Total Goals','Over 2',2,'pending','two')");
  await ctx.settleAcceptedBets();await ctx.settleAcceptedBets();
  assert.equal(get('SELECT payout FROM bets WHERE id=2').payout,15);
  assert.equal(get('SELECT status FROM bets WHERE id=3').status,'void');
  assert.equal(get('SELECT payout FROM bets WHERE id=3').payout,10);
  assert.equal(get('SELECT balance FROM users').balance,125);
  assert.equal(get('SELECT count(*) n FROM wallet_transactions').n,2);
  // A completed first half settles independently, including before a final score exists.
  run("INSERT INTO bets VALUES(4,'accepted',1,10,0,NULL),(5,'accepted',1,10,0,NULL);INSERT INTO bet_selections VALUES(5,4,'half','First Half - Match Result','1',2,'pending','half'),(6,4,'half','Fulltime Result','1',2,'pending','half'),(7,5,'half','First Half - Match Result','1',2,'pending','half')");
  ctx.fetchFinalGame=async()=>({finished:false,score:null});
  ctx.fetchTimeline=async()=>[{type_id:'5',game_status:'2',minute:'1-0',team:'0'}];
  await ctx.settleAcceptedBets();await ctx.settleAcceptedBets();
  assert.equal(get('SELECT result_status FROM bet_selections WHERE id=5').result_status,'won');
  assert.equal(get('SELECT result_status FROM bet_selections WHERE id=6').result_status,'pending');
  assert.equal(get('SELECT status FROM bets WHERE id=4').status,'accepted');
  assert.equal(get('SELECT payout FROM bets WHERE id=5').payout,20);
  assert.equal(get('SELECT balance FROM users').balance,145);
  assert.equal(get('SELECT count(*) n FROM wallet_transactions').n,3);
  assert.equal(get('SELECT reserved_balance FROM users').reserved_balance,30,'settlement must preserve reservations belonging to other pending tickets');
  db.close();
});

test('settlement advances past 100 unresolved tickets and prevents overlapping workers',async()=>{
  const source=fs.readFileSync('server.js','utf8');
  const visited=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const ctx={console,setInterval,clearInterval,get:()=>null,
    all:(sql,params)=>sql.startsWith('SELECT b.id')?Array.from({length:101},(_,i)=>({id:i+1,status:'accepted'})).filter(b=>b.id>params[0]).slice(0,100):[{game_id:String(params[0]),result_status:'pending'}]
  };
  vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function norm('),source.indexOf('// ---- Euro07 real-time live feed ----')),ctx);
  ctx.fetchFinalGame=async id=>{visited.push(id);await gate;return null;};ctx.fetchTimeline=async()=>null;
  const first=ctx.settleAcceptedBets();await ctx.settleAcceptedBets();
  assert.equal(visited.length,1);release();await first;await ctx.settleAcceptedBets();
  assert.equal(visited.length,101);assert.equal(visited[100],'101');
});

test('provider identities persist and backfill only matching missing timeline IDs',async()=>{
  const SQL=await require('sql.js')();let db=new SQL.Database(),saved;
  db.run("CREATE TABLE event_identities(game_id TEXT PRIMARY KEY,api_id TEXT,sport_id TEXT);CREATE TABLE bet_selections(game_id TEXT,game_api_id TEXT);INSERT INTO bet_selections VALUES('10',''),('11',''),('12','123')");
  const ctx={run:(sql,p)=>db.run(sql,p),get:(sql,p=[])=>{const st=db.prepare(sql);st.bind(p);const row=st.step()?st.getAsObject():null;st.free();return row;},saveDb:()=>{saved=db.export();}};
  const source=fs.readFileSync('server.js','utf8');vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function rememberEventIdentities('),source.indexOf('async function feedGames(')),ctx);
  ctx.rememberEventIdentities([{id:10,api_id:1000,sport_id:1},{id:12,api_id:1200,sport_id:1}]);
  assert.equal(ctx.get("SELECT game_api_id FROM bet_selections WHERE game_id='10'").game_api_id,'1000');
  assert.equal(ctx.get("SELECT game_api_id FROM bet_selections WHERE game_id='11'").game_api_id,'');
  assert.equal(ctx.get("SELECT game_api_id FROM bet_selections WHERE game_id='12'").game_api_id,'123');
  db.close();db=new SQL.Database(saved);
  ctx.rememberEventIdentities([]);
  assert.equal(ctx.get("SELECT api_id FROM event_identities WHERE game_id='10'").api_id,'1000');
  db.close();
});
