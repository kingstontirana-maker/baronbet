'use strict';
// Read-only provider access. All tickets and balances exist only in this sandbox DB.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const dir=__dirname;
async function main(){
  const groups=JSON.parse(fs.readFileSync(path.join(dir,'inca-simulation-markets.json'),'utf8'));
  const rows=groups.flat(Infinity),first=rows[0];assert.equal(String(first.game_id),'3036903');
  const response=await fetch('https://euro07.bet/games-timeline/14720052.json',{signal:AbortSignal.timeout(15000)});
  assert(response.ok);const timeline=await response.json();assert(Array.isArray(timeline));
  fs.writeFileSync(path.join(dir,'inca-simulation-timeline.json'),JSON.stringify(timeline,null,2));
  const SQL=await require('sql.js')(),db=new SQL.Database();
  const run=(sql,args)=>args?db.run(sql,args):db.run(sql);
  const all=(sql,args=[])=>{const s=db.prepare(sql);try{s.bind(args);const out=[];while(s.step())out.push(s.getAsObject());return out;}finally{s.free();}};
  const get=(sql,args)=>all(sql,args)[0];
  run(`CREATE TABLE users(id INTEGER,username TEXT,balance REAL,reserved_balance REAL);
    CREATE TABLE event_identities(game_id TEXT,api_id TEXT,sport_id TEXT);
    CREATE TABLE bets(id INTEGER,status TEXT,user_id INTEGER,stake REAL,payout REAL,settled_at TEXT);
    CREATE TABLE bet_selections(id INTEGER,bet_id INTEGER,game_id TEXT,market_id TEXT,market TEXT,selection TEXT,odd REAL,special_value TEXT,result_status TEXT,game_api_id TEXT);
    CREATE TABLE audit_log(actor_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,details TEXT);
    CREATE TABLE wallet_transactions(user_id INTEGER,type TEXT,amount REAL,balance_after REAL,bet_id INTEGER,note TEXT);`);
  run("INSERT INTO users VALUES(1,'user123_SIMULATION',100000,0)");
  run("INSERT INTO event_identities VALUES('3036903','14720052','1')");
  const markets=new Map();
  for(const row of rows){const key=String(row.market_id)+'|'+row.market+'|'+(row.special_value??'');if(!markets.has(key))markets.set(key,[]);markets.get(key).push(row);}
  const skipped=[];let id=0;
  for(const [key,options] of markets){
    const option=options.find(r=>Number.isFinite(Number(r.odd))&&Number(r.odd)>1);
    if(!option){skipped.push({market:key,reason:'No open odds above 1'});continue;}
    ++id;run("INSERT INTO bets VALUES(?,'accepted',1,10,0,NULL)",[id]);
    run("INSERT INTO bet_selections VALUES(?,?,?,?,?,?,?,?,'pending','14720052')",[id,id,'3036903',String(option.market_id),option.market,String(option.market_option).trim(),Number(option.odd),option.special_value==null?null:String(option.special_value)]);
  }
  run('UPDATE users SET balance=balance-?',[id*10]);
  const errors=[];
  const ctx=vm.createContext({console:{error:(...a)=>errors.push(a.join(' '))},all,get,run,
    tx:fn=>{run('BEGIN');try{const out=fn();run('COMMIT');return out;}catch(e){run('ROLLBACK');throw e;}},
    money:n=>Math.round(n*100)/100,now:()=>new Date().toISOString(),setInterval,clearInterval});
  const source=fs.readFileSync(path.join(dir,'..','server.js'),'utf8');
  vm.runInContext(source.slice(source.indexOf('function norm('),source.indexOf('// ---- Euro07 real-time live feed ----')),ctx);
  const end=timeline.filter(e=>String(e.type_id)==='6'&&String(e.game_status)==='255').at(-1);
  const score=ctx.normalizeFinalScore(end?.minute||first.result);
  const game={finished:!!end,score,record:{game_api_id:'14720052'}};
  ctx.fetchFinalGame=async()=>game;ctx.fetchTimeline=async()=>timeline;
  for(let pass=0;pass<Math.ceil(id/100)+1;pass++)await ctx.settleAcceptedBets();
  const snapshot=JSON.stringify(all('SELECT * FROM bets ORDER BY id'));
  const balance=get('SELECT balance FROM users').balance,transactions=get('SELECT COUNT(*) n FROM wallet_transactions').n;
  for(let pass=0;pass<Math.ceil(id/100)+1;pass++)await ctx.settleAcceptedBets();
  assert.equal(JSON.stringify(all('SELECT * FROM bets ORDER BY id')),snapshot,'Repeated settlement changes tickets');
  assert.equal(get('SELECT balance FROM users').balance,balance,'Repeated settlement pays twice');
  assert.equal(get('SELECT COUNT(*) n FROM wallet_transactions').n,transactions);
  assert.deepEqual(errors,[]);
  const tickets=all('SELECT b.id,b.stake,b.status,b.payout,s.market_id,s.market,s.selection,s.odd,s.result_status FROM bets b JOIN bet_selections s ON s.bet_id=b.id ORDER BY b.id');
  const report={simulation:true,account:'user123_SIMULATION',event:first.home_team+' - '+first.away_team,
    capturedAt:new Date().toISOString(),providerFinished:!!end,score,stakePerTicket:10,ticketCount:id,totalSimulatedStake:id*10,
    statuses:all('SELECT status,COUNT(*) count,SUM(payout) payout FROM bets GROUP BY status'),skipped,
    checks:{noSettlementErrors:true,noDuplicatePayouts:true},limitation:'Pending markets need confirmed final provider results; this run does not independently verify every market formula.',tickets};
  fs.writeFileSync(path.join(dir,'inca-simulation.db'),Buffer.from(db.export()));
  fs.writeFileSync(path.join(dir,'inca-simulation-report.json'),JSON.stringify(report,null,2));
  db.close();console.log(JSON.stringify({...report,tickets:undefined},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
