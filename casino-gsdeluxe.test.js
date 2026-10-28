'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('http');
const initSqlJs=require('sql.js');
const gsd=require('./casino-gsdeluxe');

async function setup(config={mode:'transfer'},snapshot){
 const SQL=await initSqlJs({locateFile:file=>require.resolve('sql.js/dist/'+file)});const db=snapshot?new SQL.Database(snapshot):new SQL.Database();
 const run=(sql,p=[])=>db.run(sql,p);
 const get=(sql,p=[])=>{const s=db.prepare(sql);s.bind(p);const r=s.step()?s.getAsObject():null;s.free();return r;};
 const all=(sql,p=[])=>{const s=db.prepare(sql);s.bind(p);const a=[];while(s.step())a.push(s.getAsObject());s.free();return a;};
 const tx=fn=>{run('BEGIN');try{const out=fn();run('COMMIT');return out;}catch(e){run('ROLLBACK');throw e;}};
 if(!snapshot){
  run('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,balance REAL NOT NULL DEFAULT 0,reserved_balance REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT \'active\')');
  run('CREATE TABLE wallet_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,type TEXT,amount REAL,balance_before REAL,balance_after REAL,currency TEXT,reference TEXT,note TEXT)');
  run('CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id INTEGER,action TEXT,target_type TEXT,target_id INTEGER,details TEXT)');
  run("INSERT INTO users(id,username,balance,reserved_balance) VALUES(1,'ana',100,10)");
 }
 // Fake GSDeluxe: 1 cent = 100 credits; `fail` injects definite (-code) or lost (network) failures.
 const provider={credit:0,factor:100,fail:{},calls:[],users:new Map()};
 const client={async call(cmd,body){
  provider.calls.push(cmd);const f=provider.fail[cmd];
  if(f){if(f.times!==undefined&&--f.times<0)delete provider.fail[cmd];else{if(f.applyFirst)apply(cmd,body);throw new gsd.GsdError('injected',f.code??'NETWORK',f.code!==undefined);}}
  return apply(cmd,body);
 }};
 function apply(cmd,body){
  if(cmd==='user_reg'){provider.users.set(body.user_name,body.user_password);return {success:1,user_id:7};}
  if(cmd==='login'){assert.equal(provider.users.get(body.login),body.password);return {success:1,jwt:'jwt',currency_id:49,currency_list:[{CurrencyID:49,ShortName:'USD'},{CurrencyID:51,ShortName:'EUR'}]};}
  if(cmd==='gamelist')return {success:1,baseURL:'https://cdn/',gamelist:[{ID:17,Name:'Book',GameIconUrl:'017.png'}]};
  if(cmd==='balance')return {success:1,credit:provider.credit};
  if(cmd==='balance_operation'){if(body.operation==='increase'){provider.credit+=body.sum*provider.factor;return {success:1,credit:body.sum*provider.factor};}const taken=provider.credit;provider.credit=0;return {success:1,credit:taken};}
  if(cmd==='start_game'){assert.equal(body.currency_id,51);return '<html><body><iframe src="https://game"></iframe></body></html>';}
  if(cmd==='user_ping')return {success:1};
  throw Error('unexpected '+cmd);
 }
 const alerts=[];
 const casino=gsd.createCasino({run,get,all,tx,now:()=>new Date().toISOString(),client,config:{clubId:12,idleMs:0,...config},alert:(...a)=>alerts.push(a),log:{warn(){},error(){}}});
 const balance=()=>Number(get('SELECT balance FROM users WHERE id=1').balance);
 const ledger=()=>all('SELECT type,amount FROM wallet_transactions ORDER BY id').map(r=>[r.type,r.amount]);
 return {casino,provider,balance,ledger,alerts,get,all,run,db};
}

test('envelope encryption round-trips and signs the encrypted body',()=>{
 const enc=gsd.encrypt('{"cmd":"login"}','token-value');
 assert.equal(gsd.decrypt(enc,'token-value'),'{"cmd":"login"}');
 assert.throws(()=>gsd.decrypt(enc,'other'));
 assert.equal(gsd.sign('abc','KEY'),require('crypto').createHash('md5').update('KEYabc').digest('hex'));
});

test('only a single HTTPS game iframe is opened directly',()=>{
 assert.equal(gsd.gameUrl('<html><iframe class="g" src="https://games.example/play?a=1&amp;b=2"></iframe></html>'),'https://games.example/play?a=1&b=2');
 for(const html of ['<div>inline game</div>','<iframe src="http://insecure/"></iframe>','<iframe src="javascript:alert(1)"></iframe>','<iframe src="https://a/"></iframe><iframe src="https://b/"></iframe>'])assert.equal(gsd.gameUrl(html),null,html);
});

test('client posts the documented envelope and classifies errors',async()=>{
 let received;
 const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{received=JSON.parse(new URLSearchParams(body).get('data'));const cmd=JSON.parse(gsd.decrypt(received.request,'tv')).cmd;res.end(cmd==='login'?JSON.stringify({success:-111,msg:'Incorrect login/password pair'}):cmd==='start_game'?'<html>game</html>':'{"success":1,"credit":5}');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const client=gsd.createClient({url:`http://127.0.0.1:${server.address().port}/api.php`,tokenName:'tn',tokenValue:'tv',hashKey:'hk'});
  assert.equal((await client.call('balance',{jwt:'j'})).credit,5);
  assert.equal(received.token_name,'tn');assert.equal(received.sign,gsd.sign(received.request,'hk'));
  const plain=JSON.parse(gsd.decrypt(received.request,'tv'));assert.equal(plain.cmd,'balance');assert.ok(Number.isInteger(plain.time));
  await assert.rejects(client.call('login',{}),e=>e.code===-111&&e.definite===true);
  assert.equal(await client.call('start_game',{},{html:true}),'<html>game</html>');
  const dead=gsd.createClient({url:'http://127.0.0.1:1/api.php',tokenName:'tn',tokenValue:'tv',hashKey:'hk',timeoutMs:500});
  await assert.rejects(dead.call('balance',{}),e=>e.definite===false);
 }finally{server.close();}
});

test('launch moves available balance out and exit returns winnings',async()=>{
 const {casino,provider,balance,ledger}=await setup();
 const r=await casino.launch(1,{gameId:17});
 assert.deepEqual([r.frameUrl,r.external],['https://game/',true]); // wrapper around one HTTPS iframe opens directly
 assert.equal(balance(),10); // reserved sportsbook stake stays home
 assert.equal(provider.credit,9000*100);
 provider.credit+=2550*100; // player wins 25.50
 const out=await casino.exit(1);
 assert.equal(out.balance,125.5);assert.equal(provider.credit,0);
 assert.deepEqual(ledger(),[['casino_out',-90],['casino_in',115.5]]);
 assert.equal(casino.report().summary.ggr,-25.5);
});

test('rejected transfer is refunded immediately',async()=>{
 const {casino,provider,balance}=await setup();
 provider.fail.balance_operation={code:-1023};
 await assert.rejects(casino.launch(1,{gameId:17}),/nuk e pranoi/);
 assert.equal(balance(),100);assert.equal(casino.report().sessions[0].status,'failed');
});

test('lost increase response never loses money, whether or not it landed',async()=>{
 for(const landed of [false,true]){
  const {casino,provider,balance}=await setup();
  provider.fail.balance_operation={times:1,applyFirst:landed};
  await assert.rejects(casino.launch(1,{gameId:17}),/rikthehet/);
  assert.equal(balance(),100,'landed='+landed);assert.equal(provider.credit,0);
  assert.equal(casino.report().sessions[0].status,'closed');
 }
});

test('lost decrease response is parked for review instead of guessed',async()=>{
 const {casino,provider,balance,alerts}=await setup();
 await casino.launch(1,{gameId:17});
 provider.fail.balance_operation={times:1,applyFirst:true}; // GSDeluxe withdrew, the answer was lost
 await casino.exit(1);
 assert.equal(balance(),10);
 await casino.tick();
 const s=casino.report().sessions[0];assert.equal(s.status,'review');assert.equal(balance(),10);
 assert.equal(alerts.at(-1)[1],'casino_review');
 await assert.rejects(casino.launch(1,{gameId:17}),/verifikim/);
 await casino.resolve(s.id,90,99);
 assert.equal(balance(),100);assert.equal(casino.report().sessions[0].status,'closed');
});

test('provider outage on exit keeps retrying until credit comes home',async()=>{
 const {casino,provider,balance}=await setup();
 await casino.launch(1,{gameId:17});
 provider.fail.balance={times:2}; // balance read fails before any withdrawal is attempted
 await casino.exit(1);await casino.tick();
 assert.equal(balance(),10);
 await casino.tick();
 assert.equal(balance(),100);assert.equal(casino.report().sessions[0].status,'closed');
});

test('unexpected credit at GSDeluxe blocks launch and is cleaned on resolve',async()=>{
 const {casino,provider,balance}=await setup();
 await casino.gameList(1);provider.credit=500;
 await assert.rejects(casino.launch(1,{gameId:17}),/verifikim/);
 assert.equal(balance(),100);
 const s=casino.report().sessions[0];assert.equal(s.status,'review');
 await casino.resolve(s.id,0,99);
 assert.equal(provider.credit,0);assert.equal(balance(),100);
 await casino.launch(1,{gameId:17});assert.equal(balance(),10);
});

test('concurrent launches cannot double spend',async()=>{
 const {casino,provider,balance}=await setup();
 const results=await Promise.allSettled([casino.launch(1,{gameId:17}),casino.launch(1,{gameId:17})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2); // the second sweeps the first, then reopens
 assert.equal(balance(),10);assert.equal(provider.credit,9000*100);
 assert.equal(casino.openSessions(1).length,1);
});

// ---- Seamless wallet callbacks ----
const fs=require('fs'),os=require('os'),path=require('path');
const SECRET='cb-secret';
const sha1=s=>require('crypto').createHash('sha1').update(s).digest('hex');
const stamp=(offset=0)=>new Date(Date.now()+offset).toISOString().slice(0,19).replace('T',' ');
function request(command,data,{secret=SECRET,time=stamp()}={}){return {command,request_timestamp:time,hash:sha1(command+time+secret),data};}
let txSeq=1000;
const bet=(login,amount,extra={})=>request('changebalance',{transaction_type:'BET',reason:'SPIN',amount:-amount,currency_code:'EUR',transaction_id:++txSeq,transaction_timestamp:stamp(),round_id:7,round_finished:false,game_id:17,token:login,...extra});
const win=(login,amount,extra={})=>request('changebalance',{transaction_type:'WIN',reason:'SPIN',amount,currency_code:'EUR',transaction_id:++txSeq,transaction_timestamp:stamp(),round_id:7,round_finished:true,game_id:17,token:login,...extra});
async function seamless(extra={}){
 const ctx=await setup({mode:'seamless',callbackSecret:SECRET,callbackIps:'10.0.0.5',...extra});
 await ctx.casino.launch(1,{gameId:17}); // registers the GSDeluxe login for player 1
 ctx.login=ctx.get('SELECT login FROM casino_accounts WHERE user_id=1').login;
 ctx.call=(body,ip='10.0.0.5')=>ctx.casino.callback(body,ip);
 return ctx;
}

test('seamless launch opens the game without moving money',async()=>{
 const {casino,provider,balance}=await setup({mode:'seamless',callbackSecret:SECRET,callbackIps:'*'});
 const r=await casino.launch(1,{gameId:17});
 assert.equal(r.frameUrl,'https://game/');assert.equal(balance(),100);
 assert.ok(!provider.calls.includes('balance_operation'));
});

test('balance callback answers in cents with a signed response and echoes the request',async()=>{
 const {call,login}=await seamless();
 const body=request('balance',{token:login,currency_code:'EUR'});
 const out=call(body);
 assert.deepEqual(out.request,body);
 assert.equal(out.response.status,'OK');assert.deepEqual(out.response.data,{balance:9000,currency_code:'EUR'}); // 100 - 10 reserved
 assert.equal(out.response.hash,sha1('OK'+out.response.response_timestamp+SECRET));
 assert.match(out.response.response_timestamp,/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
});

test('callbacks reject bad hash, foreign IP, stale time, unknown login and currency',async()=>{
 const {call,login}=await seamless();
 const code=out=>out.response.status==='ERROR'&&out.response.data.error_code;
 assert.equal(code(call(request('balance',{token:login,currency_code:'EUR'},{secret:'wrong'}))),'ERR3');
 assert.equal(code(call(request('balance',{token:login,currency_code:'EUR'}),'10.0.0.6')),'ERR3');
 assert.equal(code(call(request('balance',{token:login,currency_code:'EUR'},{time:stamp(-3600e3)}))),'ERR3');
 assert.equal(code(call(request('balance',{token:'nobody',currency_code:'EUR'}))),'ERR1');
 assert.equal(code(call(request('balance',{token:login,currency_code:'USD'}))),'ERR6');
 assert.equal(code(call(null)),'ERR4');
 const err=call(request('balance',{token:'nobody',currency_code:'EUR'}));
 assert.equal(err.response.hash,sha1('ERROR'+err.response.response_timestamp+SECRET));
});

test('bets and wins move the shared balance once per transaction id',async()=>{
 const {call,login,balance,ledger}=await seamless();
 const b=bet(login,1725);
 assert.equal(call(b).response.data.balance,9000-1725);
 assert.equal(call(b).response.data.balance,9000-1725,'a retried transaction is not applied twice');
 assert.equal(call(win(login,4000)).response.data.balance,9000-1725+4000);
 assert.equal(call(win(login,0)).response.status,'OK','zero win settles the round');
 assert.equal(balance(),122.75);
 assert.deepEqual(ledger(),[['casino_bet',-17.25],['casino_win',40]]);
});

test('bets cannot exceed available balance or come from blocked players',async()=>{
 const {call,login,balance,run}=await seamless();
 assert.equal(call(bet(login,9001)).response.data.error_code,'ERR2');
 assert.equal(balance(),100);
 run("UPDATE users SET status='blocked' WHERE id=1");
 assert.equal(call(bet(login,100)).response.data.error_code,'ERR5');
 assert.equal(call(win(login,500)).response.status,'OK','wins are always paid');
 assert.equal(call(bet(login,1,{transaction_type:'BET',amount:5})).response.data.error_code,'ERR4','positive bet amount');
});

test('refunds only return stakes taken in the same round',async()=>{
 const {call,login,balance,alerts}=await seamless();
 call(bet(login,500,{round_id:9}));
 const refund=(amount,round)=>call(request('changebalance',{transaction_type:'REFUND',reason:'SPIN',amount,currency_code:'EUR',transaction_id:++txSeq,transaction_timestamp:stamp(),round_id:round,round_finished:true,game_id:17,token:login}));
 assert.equal(refund(600,9).response.data.error_code,'ERR8');
 assert.equal(refund(500,8).response.data.error_code,'ERR8');
 assert.equal(alerts.at(-1)[1],'casino_refund');
 assert.equal(refund(500,9).response.status,'OK');
 assert.equal(refund(1,9).response.data.error_code,'ERR8','cannot refund twice');
 assert.equal(balance(),100);
});

test('an acknowledged spin survives a crash before the database is saved',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'casino-journal-'));const journalFile=path.join(dir,'db.casino-journal');
 try{
  let saved=null;
  const first=await seamless({journalFile,persist:()=>{saved=Buffer.from(first.db.export());}});
  first.casino.flush();const beforeSpin=saved; // last state on disk
  assert.equal(first.call(bet(first.login,2500)).response.status,'OK');
  assert.equal(fs.readFileSync(journalFile,'utf8').trim().split('\n').length,1);
  // Crash: restart from the file saved before the spin; the journal replays it once.
  let persisted=0;
  const second=await setup({mode:'seamless',callbackSecret:SECRET,callbackIps:'*',journalFile,persist:()=>persisted++},beforeSpin);
  assert.equal(second.balance(),75);assert.equal(persisted,1);
  assert.equal(fs.readFileSync(journalFile,'utf8'),'');
  const third=await setup({mode:'seamless',callbackSecret:SECRET,callbackIps:'*',journalFile},Buffer.from(second.db.export()));
  assert.equal(third.balance(),75,'replay is idempotent');
  first.casino.flush();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('without a named secret_key or IPs: only callbacks signed with our API keys pass, new IPs are reported',async()=>{
 const ctx=await setup({mode:'seamless',fallbackSecrets:{GSD_API_HASH_KEY:'hash-key',GSD_TOKEN_VALUE:'token-value'},callbackIps:''});
 await ctx.casino.launch(1,{gameId:17});
 const login=ctx.get('SELECT login FROM casino_accounts WHERE user_id=1').login;
 const body=secret=>request('balance',{token:login,currency_code:'EUR'},{secret});
 assert.equal(ctx.casino.callback(body('guessed'),'203.0.113.9').response.data.error_code,'ERR3','unsigned callbacks are refused');
 assert.equal(ctx.alerts.length,0,'a refused callback does not register its IP');
 const ok=ctx.casino.callback(body('hash-key'),'203.0.113.9');
 assert.equal(ok.response.status,'OK');
 assert.equal(ok.response.hash,sha1('OK'+ok.response.response_timestamp+'hash-key'),'the reply is signed with the key that matched');
 assert.equal(ctx.alerts.at(-1)[1],'casino_callback_ip');assert.equal(ctx.alerts.at(-1)[3].ip,'203.0.113.9');assert.equal(ctx.alerts.at(-1)[3].secret,'GSD_API_HASH_KEY');
 assert.equal(ctx.casino.callback(body('token-value'),'203.0.113.9').response.status,'OK');
 assert.equal(ctx.alerts.length,1,'each IP is reported once');
 assert.equal(ctx.casino.callback(request('balance',{token:login,currency_code:'EUR'},{secret:'hash-key',time:stamp(-180e3)}),'203.0.113.9').response.data.error_code,'ERR3','a 3-minute-old signature is too old');
});
