'use strict';
// GSDeluxe slot integration in transfer (non-seamless) mode.
// Money leaves the sportsbook wallet only inside a ledgered casino session and is
// always swept back with decrease_all. Any outcome that cannot be proven is parked
// in status 'review' for the center instead of being guessed.
const crypto=require('crypto');
const fs=require('fs');
const express=require('express');

function encrypt(plaintext,password){
 const key=crypto.createHash('sha256').update(String(password)).digest(),iv=crypto.randomBytes(16);
 const cipher=crypto.createCipheriv('aes-256-cbc',key,iv),ct=Buffer.concat([cipher.update(String(plaintext),'utf8'),cipher.final()]);
 const mac=crypto.createHmac('sha256',key).update(Buffer.concat([ct,iv])).digest();
 return Buffer.concat([iv,mac,ct]).toString('base64');
}
function decrypt(payload,password){
 const raw=Buffer.from(String(payload),'base64'),key=crypto.createHash('sha256').update(String(password)).digest();
 const iv=raw.subarray(0,16),mac=raw.subarray(16,48),ct=raw.subarray(48);
 const expected=crypto.createHmac('sha256',key).update(Buffer.concat([ct,iv])).digest();
 if(mac.length!==32||!crypto.timingSafeEqual(mac,expected))throw Error('GSDeluxe payload MAC mismatch');
 const decipher=crypto.createDecipheriv('aes-256-cbc',key,iv);return Buffer.concat([decipher.update(ct),decipher.final()]).toString('utf8');
}
const sign=(message,key)=>crypto.createHash('md5').update(String(key)+String(message)).digest('hex');

// definite=true: GSDeluxe answered with an error, so the operation did not happen.
// definite=false: timeout/transport/unparseable answer, so it may or may not have happened.
class GsdError extends Error{constructor(message,code,definite){super(message);this.name='GsdError';this.code=code;this.definite=definite;}}

function createClient({url,tokenName,tokenValue,hashKey,timeoutMs=10000,fetchImpl=globalThis.fetch,monitor}){
 async function call(cmd,body={},{html=false}={}){
  const request=encrypt(JSON.stringify({cmd,...body,time:Math.floor(Date.now()/1000)}),tokenValue);
  const envelope=JSON.stringify({token_name:tokenName,request,sign:sign(request,hashKey)});
  const finish=monitor?monitor('Outgoing','POST',url+'#'+cmd):()=>{};
  let text;
  try{const r=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data:envelope}).toString(),signal:AbortSignal.timeout(timeoutMs)});text=await r.text();if(!r.ok){finish(r.status,'GSDeluxe HTTP '+r.status);throw new GsdError('GSDeluxe HTTP '+r.status,'HTTP_'+r.status,false);}}
  catch(e){if(e instanceof GsdError)throw e;finish(0,e.name==='TimeoutError'?'GSDeluxe timeout':'GSDeluxe connection failed');throw new GsdError('GSDeluxe: '+e.message,'NETWORK',false);}
  let data=null;try{data=JSON.parse(text);}catch(_){}
  if(data&&typeof data==='object'&&Number(data.success)<0){finish(200,'GSDeluxe '+cmd+' '+data.success);throw new GsdError(data.msg||('GSDeluxe error '+data.success),Number(data.success),true);}
  if(html&&!data&&/<\s*(html|iframe|script|div|body)/i.test(text)){finish(200,'');return text;}
  if(!data||Number(data.success)!==1){finish(200,'GSDeluxe invalid response');throw new GsdError('GSDeluxe invalid response for '+cmd,'INVALID',false);}
  finish(200,'');return data;
 }
 return {call};
}

const cents=n=>Math.round((Number(n)+Number.EPSILON)*100);
function gameUrl(html){
 const frames=[...String(html).matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(m=>m[1].replace(/&amp;/g,'&'));
 if(frames.length!==1)return null;
 try{const u=new URL(frames[0]);return u.protocol==='https:'?u.href:null;}catch(_){return null;}
}
const FINAL=new Set(['closed','failed']);

function createCasino({run,get,all,tx,now,client,config={},alert=()=>{},log=console}){
 const cfg={clubId:Number(config.clubId),loginPrefix:String(config.loginPrefix||'bb'),balanceDenomination:Number(config.balanceDenomination??100),gameDenomination:config.gameDenomination==null||config.gameDenomination===''?null:Number(config.gameDenomination),currency:String(config.currency||'EUR'),idleMs:Number(config.idleMs??180000),maxCredit:1500000,
  frameOrigin:config.frameOrigin?new URL(config.frameOrigin).origin:'',
  mode:config.mode==='transfer'?'transfer':'seamless',callbackSkewMs:Number(config.callbackSkewSeconds??120)*1000,
  // GSDeluxe did not name a separate secret_key: without GSD_CALLBACK_SECRET the callback hash is
  // checked against the shared API keys we hold, and only a correctly signed request is accepted.
  callbackSecrets:(config.callbackSecret?[['GSD_CALLBACK_SECRET',config.callbackSecret]]:Object.entries(config.fallbackSecrets||{})).filter(([,v])=>v).map(([label,value])=>({label,value:String(value)})),
  // '*' any IP, a list = only those, empty = signed requests from any IP, each new IP reported to the center.
  callbackIps:config.callbackIps==='*'?'*':String(config.callbackIps||'').split(',').map(x=>x.trim()).filter(Boolean)};
 run(`CREATE TABLE IF NOT EXISTS casino_accounts(user_id INTEGER PRIMARY KEY,provider TEXT NOT NULL DEFAULT 'gsdeluxe',login TEXT NOT NULL UNIQUE,password TEXT NOT NULL,provider_user_id INTEGER,created_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
 run(`CREATE TABLE IF NOT EXISTS casino_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,provider TEXT NOT NULL DEFAULT 'gsdeluxe',game_id INTEGER,game_name TEXT,status TEXT NOT NULL,amount_cents INTEGER NOT NULL,returned_cents INTEGER,credit_per_cent REAL,sweep_attempts INTEGER NOT NULL DEFAULT 0,sweep_uncertain INTEGER NOT NULL DEFAULT 0,error TEXT,opened_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,closed_at TEXT,resolved_by INTEGER,FOREIGN KEY(user_id) REFERENCES users(id))`);
 run('CREATE INDEX IF NOT EXISTS idx_casino_sessions_status ON casino_sessions(status,user_id)');

 const jwts=new Map(),frames=new Map(),locks=new Map();
 let games=null;
 // Serialises every wallet movement of one player across requests and the sweeper.
 function locked(userId,fn){const prev=locks.get(userId)||Promise.resolve();const next=prev.catch(()=>{}).then(fn);const tail=next.catch(()=>{});locks.set(userId,tail);tail.then(()=>{if(locks.get(userId)===tail)locks.delete(userId);});return next;}
 const session=id=>get('SELECT * FROM casino_sessions WHERE id=?',[id]);
 const openSessions=userId=>all("SELECT * FROM casino_sessions WHERE user_id=? AND status NOT IN ('closed','failed') ORDER BY id",[userId]);
 function note(id,fields){const keys=Object.keys(fields);tx(()=>run(`UPDATE casino_sessions SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`,[...keys.map(k=>fields[k]),id]));}
 function credit(userId,amountCents,type,sessionId,text){
  const u=get('SELECT id,balance FROM users WHERE id=?',[userId]);const balance=(cents(u.balance)+amountCents)/100;
  run('UPDATE users SET balance=? WHERE id=?',[balance,userId]);
  run('INSERT INTO wallet_transactions(user_id,type,amount,balance_before,balance_after,currency,reference,note) VALUES(?,?,?,?,?,?,?,?)',[userId,type,amountCents/100,Number(u.balance),balance,cfg.currency,'casino:'+sessionId+':'+type,text]);
  return balance;
 }
 function toReview(s,reason,details={}){note(s.id,{status:'review',error:reason});alert('casino:review:'+s.id,'casino_review','Seancë casino për verifikim',{sessionId:s.id,userId:s.user_id,reason,...details});}

 // ---- Seamless wallet: GSDeluxe calls balance / changebalance on every spin. ----
 // A full database save takes 30-80 ms, above GSDeluxe's 50 ms budget, so each change
 // is committed in memory plus an fsynced journal line before answering. The database
 // file is saved shortly after; on startup the journal is replayed (idempotent by
 // GSDeluxe transaction_id) so an acknowledged spin survives a crash.
 run(`CREATE TABLE IF NOT EXISTS casino_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT NOT NULL DEFAULT 'gsdeluxe',provider_tx_id INTEGER NOT NULL UNIQUE,user_id INTEGER NOT NULL,type TEXT NOT NULL,reason TEXT,amount_cents INTEGER NOT NULL,round_id INTEGER,round_finished INTEGER,game_id INTEGER,balance_after REAL NOT NULL,provider_time TEXT,created_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id))`);
 run('CREATE INDEX IF NOT EXISTS idx_casino_tx_round ON casino_transactions(user_id,round_id,game_id)');
 run('CREATE INDEX IF NOT EXISTS idx_casino_tx_date ON casino_transactions(created_at)');
 run('CREATE TABLE IF NOT EXISTS casino_callback_ips(ip TEXT PRIMARY KEY,secret TEXT,first_seen TEXT NOT NULL)');
 const isActive=config.isActive||(()=>true),persist=config.persist||(()=>{}),journalFile=config.journalFile||null;
 let journalFd=null,flushTimer=null;
 const LEDGER={BET:'casino_bet',WIN:'casino_win',REFUND:'casino_refund'};
 class WalletError extends Error{constructor(code,message){super(message);this.code=code;}}
 const available=u=>cents(u.balance)-cents(u.reserved_balance);
 function applyChange(op,replay){
  if(get('SELECT id FROM casino_transactions WHERE provider_tx_id=?',[op.txId]))return false;
  const u=get('SELECT id,balance,reserved_balance,status FROM users WHERE id=?',[op.userId]);
  if(!u)throw new WalletError('ERR1','Login does not exist');
  if(!replay){
   if(op.type==='BET'){
    if(u.status!=='active'||!isActive(u.id))throw new WalletError('ERR5','Player is blocked');
    if(available(u)<-op.amount)throw new WalletError('ERR2','Insufficient funds');
   }
   if(op.type==='REFUND'){
    // A refund can only return stakes we actually took in that round.
    const r=get("SELECT COALESCE(SUM(CASE WHEN type='BET' THEN -amount_cents ELSE 0 END),0) bets,COALESCE(SUM(CASE WHEN type='REFUND' THEN amount_cents ELSE 0 END),0) refunds FROM casino_transactions WHERE user_id=? AND round_id=? AND game_id=?",[u.id,op.roundId,op.gameId]);
    if(op.amount>Number(r.bets)-Number(r.refunds))throw Object.assign(new WalletError('ERR8','Refund does not match a bet in this round'),{alert:['casino:refund:'+op.txId,'casino_refund','Rimbursim casino pa bast përkatës',{...op}]});
   }
  }
  const balance=(cents(u.balance)+op.amount)/100;
  if(op.amount!==0){
   run('UPDATE users SET balance=? WHERE id=?',[balance,u.id]);
   run('INSERT INTO wallet_transactions(user_id,type,amount,balance_before,balance_after,currency,reference,note) VALUES(?,?,?,?,?,?,?,?)',[u.id,LEDGER[op.type],op.amount/100,Number(u.balance),balance,cfg.currency,'gsd:'+op.txId,`Casino ${op.type} · loja ${op.gameId} · raundi ${op.roundId}`]);
  }
  run('INSERT INTO casino_transactions(provider_tx_id,user_id,type,reason,amount_cents,round_id,round_finished,game_id,balance_after,provider_time,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[op.txId,u.id,op.type,op.reason,op.amount,op.roundId,op.roundFinished?1:0,op.gameId,balance,op.providerTime,now()]);
  return true;
 }
 function journal(op){
  if(!journalFile)return;
  if(journalFd===null)journalFd=fs.openSync(journalFile,'a',0o600);
  fs.writeSync(journalFd,JSON.stringify(op)+'\n');fs.fsyncSync(journalFd);
 }
 function flush(){
  flushTimer=null;
  try{persist();if(journalFd!==null)fs.ftruncateSync(journalFd,0);}
  catch(e){log.error?.('Casino flush failed',e.message);flushTimer=setTimeout(flush,5000);flushTimer.unref?.();}
 }
 function change(op){
  run('BEGIN');
  try{const applied=applyChange(op,false);if(applied)journal(op);run('COMMIT');if(applied&&!flushTimer){flushTimer=setTimeout(flush,1000);flushTimer.unref?.();}}
  catch(e){try{run('ROLLBACK');}catch(_){}throw e;}
 }
 function replayJournal(){
  if(!journalFile||!fs.existsSync(journalFile))return 0;
  let applied=0;
  const lines=fs.readFileSync(journalFile,'utf8').split('\n').filter(Boolean);
  run('BEGIN');
  try{for(const line of lines){let op;try{op=JSON.parse(line);}catch(_){continue;}try{if(applyChange(op,true))applied++;}catch(e){log.error?.('Casino journal entry skipped',line,e.message);}}run('COMMIT');}
  catch(e){try{run('ROLLBACK');}catch(_){}throw e;}
  if(applied)persist();
  fs.truncateSync(journalFile,0);
  return applied;
 }
 const replayed=replayJournal();if(replayed)log.warn?.('Casino journal replayed',replayed,'transactions');

 const refused=new Map();
 // Names the documented-looking variant a refused hash matches (algorithm, field order, which
 // key), so a wrong secret or formula shows up in the alert. Only the label is reported.
 function hashHint(body){
  const parts={command:body.command,timestamp:body.request_timestamp};
  for(const s of cfg.callbackSecrets)for(const algo of ['sha1','md5','sha256'])for(const [order,text] of [['command+timestamp+secret',parts.command+parts.timestamp+s.value],['secret+command+timestamp',s.value+parts.command+parts.timestamp],['command+timestamp',parts.command+parts.timestamp]])
   if(crypto.createHash(algo).update(text).digest('hex')===body.hash.toLowerCase())return algo+'('+order+') with '+s.label;
  return 'no known key matches';
 }
 // Request: {command,request_timestamp,hash,data}; hash = sha1(command+request_timestamp+secret).
 function callback(body,ip){
  const sha1=s=>crypto.createHash('sha1').update(s).digest('hex');
  const stamp=new Date().toISOString().slice(0,19).replace('T',' ');
  let secret=cfg.callbackSecrets[0]?.value||'';
  const reply=(status,data)=>({request:body,response:{status,response_timestamp:stamp,hash:sha1(status+stamp+secret),data}});
  const error=(code,message)=>reply('ERROR',{error_code:code,error_message:message});
  // A refused callback leaves the game without a balance (black screen), so the reason is
  // logged and reported, at most once a minute per reason. Secrets are never logged.
  const refuse=(code,message,details={})=>{
   const last=refused.get(message)||0;
   if(Date.now()-last>60000){refused.set(message,Date.now());
    const info={ip,command:String(body?.command||'').slice(0,20),request_timestamp:String(body?.request_timestamp||'').slice(0,30),server_time:stamp,...details};
    log.warn?.('Casino callback refused:',message,JSON.stringify(info));
    alert('casino:callback-refused:'+message,'casino_callback_refused','Callback casino i refuzuar: '+message,info);}
   return error(code,message);
  };
  try{
   if(!body||typeof body!=='object'||typeof body.command!=='string'||typeof body.request_timestamp!=='string'||typeof body.hash!=='string'||!body.data||typeof body.data!=='object')return refuse('ERR4','Invalid request',{keys:body&&typeof body==='object'?Object.keys(body).join(',').slice(0,100):typeof body});
   if(Array.isArray(cfg.callbackIps)&&cfg.callbackIps.length&&!cfg.callbackIps.includes(ip)){alert('casino:callback-ip:'+ip,'casino_callback_ip','Callback casino nga IP e palejuar',{ip,command:body.command});return error('ERR3','IP not allowed');}
   const given=Buffer.from(body.hash.toLowerCase());
   const match=cfg.callbackSecrets.find(s=>{const expected=Buffer.from(sha1(body.command+body.request_timestamp+s.value));return expected.length===given.length&&crypto.timingSafeEqual(expected,given);});
   if(!match)return refuse('ERR3','Invalid hash',{hash_length:body.hash.length,hint:hashHint(body)});
   secret=match.value;
   const sent=Date.parse(body.request_timestamp.replace(' ','T')+'Z');
   if(!Number.isFinite(sent)||Math.abs(Date.now()-sent)>cfg.callbackSkewMs)return refuse('ERR3','Request timestamp out of range',{skew_seconds:Number.isFinite(sent)?Math.round((sent-Date.now())/1000):null});
   if(Array.isArray(cfg.callbackIps)&&!cfg.callbackIps.length&&!get('SELECT ip FROM casino_callback_ips WHERE ip=?',[ip])){
    tx(()=>run('INSERT OR IGNORE INTO casino_callback_ips(ip,secret,first_seen) VALUES(?,?,?)',[ip,match.label,now()]));
    alert('casino:callback-ip:'+ip,'casino_callback_ip','IP e re e GSDeluxe për callback-et',{ip,secret:match.label,hint:'Vendose te GSD_CALLBACK_IPS për të pranuar vetëm këtë IP.'});
   }
   const d=body.data,acc=get('SELECT user_id FROM casino_accounts WHERE login=?',[String(d.token||'')]);
   if(!acc)return refuse('ERR1','Login does not exist',{data_keys:Object.keys(d).join(',').slice(0,200)});
   if(String(d.currency_code||'').toUpperCase()!==cfg.currency)return refuse('ERR6','Currency mismatch',{currency_code:String(d.currency_code??'').slice(0,10)});
   const userId=Number(acc.user_id),ok=()=>reply('OK',{balance:available(get('SELECT balance,reserved_balance FROM users WHERE id=?',[userId])),currency_code:cfg.currency});
   if(body.command==='balance')return ok();
   if(body.command!=='changebalance')return error('ERR4','Unknown command');
   const type=String(d.transaction_type||'').toUpperCase(),amount=Number(d.amount),txId=Number(d.transaction_id);
   if(!LEDGER[type]||!Number.isSafeInteger(amount)||!Number.isSafeInteger(txId)||(type==='BET'?amount>0:amount<0))return error('ERR4','Invalid transaction');
   change({txId,userId,type,reason:String(d.reason||'').slice(0,10),amount,roundId:Number(d.round_id)||0,roundFinished:d.round_finished===true||d.round_finished==='true'||d.round_finished===1,gameId:Number(d.game_id)||0,providerTime:String(d.transaction_timestamp||'').slice(0,19)});
   return ok();
  }catch(e){
   if(e instanceof WalletError){if(e.alert)alert(...e.alert);return error(e.code,e.message);}
   log.error?.('Casino callback failed',e.message);alert('casino:callback','casino_callback','Gabim në callback-un e casino-s',{error:e.message});
   return error('ERR7','Internal error');
  }
 }

 async function account(userId){
  const existing=get('SELECT * FROM casino_accounts WHERE user_id=?',[userId]);if(existing)return existing;
  for(let attempt=0;attempt<3;attempt++){
   const login=(cfg.loginPrefix+userId+'x'+crypto.randomBytes(3).toString('hex')).slice(0,32),password=crypto.randomBytes(18).toString('base64url');
   try{const r=await client.call('user_reg',{user_name:login,user_password:password,gh_id:cfg.clubId});
    tx(()=>run('INSERT INTO casino_accounts(user_id,login,password,provider_user_id,created_at) VALUES(?,?,?,?,?)',[userId,login,password,Number(r.user_id)||null,now()]));
    return get('SELECT * FROM casino_accounts WHERE user_id=?',[userId]);}
   catch(e){if(!(e.code===-3005||e.code===-3001))throw e;}
  }
  throw Error('Llogaria e casino-s nuk mund të krijohet.');
 }
 async function login(userId,fresh=false){
  const cached=jwts.get(userId);if(cached&&!fresh&&Date.now()-cached.at<10*60000)return cached;
  const a=await account(userId),r=await client.call('login',{login:a.login,password:a.password});
  const currency=(r.currency_list||[]).find(c=>String(c.ShortName).toUpperCase()===cfg.currency)?.CurrencyID??r.currency_id;
  const out={jwt:r.jwt,currencyId:Number(currency),at:Date.now()};jwts.set(userId,out);return out;
 }
 async function providerCredit(jwt){try{return Number((await client.call('balance',{jwt})).credit)||0;}catch(e){if(e.code===-50)return 0;throw e;}}

 // Sweeps the player's casino credit back. Safe to call repeatedly.
 async function sweep(id){
  let s=session(id);if(!s||FINAL.has(s.status)||s.status==='review')return s;
  if(s.status==='active')note(id,{status:'closing'});
  s=session(id);
  // While 'opening' the game was never started, so the full transfer is returned
  // whether or not the increase reached GSDeluxe.
  const opening=s.status==='opening';
  try{
   const {jwt}=await login(s.user_id);
   const before=await providerCredit(jwt);
   let taken=0;
   if(before===0&&s.sweep_uncertain&&!opening){toReview(s,'Tërheqja e mëparshme nuk u konfirmua; GSDeluxe tregon 0 kredit.');return session(id);}
   if(before>0){
    note(id,{sweep_attempts:s.sweep_attempts+1,sweep_uncertain:1});
    try{taken=Number((await client.call('balance_operation',{jwt,operation:'decrease_all',sum:0,denomenation:cfg.balanceDenomination})).credit)||0;}
    catch(e){if(e.definite)note(id,{sweep_uncertain:0});throw e;} // a GSDeluxe rejection means nothing was moved
    if(taken!==before)log.warn?.('GSDeluxe decrease_all returned',taken,'expected',before,'session',id);
   }
   let returned=Number(s.amount_cents);
   if(!opening){const factor=Number(s.credit_per_cent);if(!(factor>0)){toReview(s,'Faktori kredit/cent mungon.',{taken});return session(id);}returned=Math.floor(taken/factor+1e-6);}
   tx(()=>{const cur=session(id);if(FINAL.has(cur.status)||cur.status==='review')return;credit(s.user_id,returned,'casino_in',id,`Casino: kthim nga seanca #${id}`);run("UPDATE casino_sessions SET status='closed',returned_cents=?,sweep_uncertain=0,closed_at=?,error=NULL WHERE id=?",[returned,now(),id]);});
   jwts.delete(s.user_id);
  }catch(e){
   const cur=session(id);
   if(e.code===-21||e.code===-22||e.code===-24)jwts.delete(s.user_id);
   note(id,{error:String(e.message).slice(0,300)});
   if(cur.sweep_attempts>=10)alert('casino:sweep:'+id,'casino_sweep','Kthimi i balancës nga casino po dështon',{sessionId:id,userId:s.user_id,error:e.message});
   log.error?.('Casino sweep failed for session',id,e.message);
  }
  return session(id);
 }

 async function startGame(userId,game,{width,height},jwt,currencyId){
  // denomination is optional: club 125569 rejects every explicit value (-105) and uses its own
  // configured denomination when the field is left out.
  const html=await client.call('start_game',{jwt,game_id:game.id,currency_id:currencyId,...(cfg.gameDenomination!=null?{denomination:cfg.gameDenomination}:{}),width:Math.max(320,Math.min(3840,Number(width)||1280)),height:Math.max(240,Math.min(2160,Number(height)||720))},{html:true});
  if(typeof html!=='string')throw Error('GSDeluxe nuk ktheu lojën.');
  // A wrapper around a single HTTPS game iframe is opened directly: the browser isolates
  // that foreign origin itself, and the game keeps its own cookies and storage.
  const direct=gameUrl(html);if(direct)return {frameUrl:direct,external:true,game:game.name};
  const key=crypto.randomBytes(24).toString('hex');frames.set(key,{html,userId,expires:Date.now()+60000});
  return cfg.frameOrigin?{frameUrl:cfg.frameOrigin+'/api/casino/frame/'+key,external:true,game:game.name}:{frameUrl:'/api/casino/frame/'+key,external:false,game:game.name};
 }
 async function launch(userId,options){
  if(cfg.mode==='seamless'){
   const u=get('SELECT balance,reserved_balance,status FROM users WHERE id=?',[userId]);
   if(!u||u.status!=='active'||!isActive(userId))throw Object.assign(Error('Llogaria nuk është aktive.'),{status:403});
   const game=(await gameList(userId)).find(g=>g.id===options.gameId);if(!game)throw Object.assign(Error('Loja nuk u gjet.'),{status:404});
   const {jwt,currencyId}=await login(userId,true);
   try{return await startGame(userId,game,options,jwt,currencyId);}catch(e){throw Object.assign(Error('Loja nuk mund të hapet: '+e.message),{status:502});}
  }
  return launchTransfer(userId,options);
 }
 async function launchTransfer(userId,{gameId,width,height}){
  return locked(userId,async()=>{
   for(const s of openSessions(userId))await sweep(s.id);
   const pending=openSessions(userId);
   if(pending.some(s=>s.status==='review'))throw Object.assign(Error('Ka një seancë casino në verifikim. Kontaktoni administratorin.'),{status:409});
   if(pending.length)throw Object.assign(Error('Balanca nga loja e mëparshme po rikthehet. Provoni përsëri pas pak.'),{status:409});
   const game=(await gameList(userId)).find(g=>g.id===gameId);if(!game)throw Object.assign(Error('Loja nuk u gjet.'),{status:404});
   const {jwt,currencyId}=await login(userId,true);
   const leftover=await providerCredit(jwt);
   if(leftover!==0){
    const id=tx(()=>{run("INSERT INTO casino_sessions(user_id,game_id,status,amount_cents,error,opened_at,last_seen_at) VALUES(?,?,'review',0,?,?,?)",[userId,gameId,'Kredit i papritur në GSDeluxe: '+leftover,now(),now()]);return Number(get('SELECT last_insert_rowid() id').id);});
    alert('casino:review:'+id,'casino_review','Seancë casino për verifikim',{sessionId:id,userId,leftover});
    throw Object.assign(Error('Llogaria e casino-s ka nevojë për verifikim. Kontaktoni administratorin.'),{status:409});
   }
   const known=Number(get("SELECT credit_per_cent f FROM casino_sessions WHERE credit_per_cent>0 ORDER BY id DESC LIMIT 1")?.f||0);
   const id=tx(()=>{
    const u=get('SELECT balance,reserved_balance,status FROM users WHERE id=?',[userId]);
    let amount=cents(u.balance)-cents(u.reserved_balance);if(known>0)amount=Math.min(amount,Math.floor(cfg.maxCredit/known));
    if(u.status!=='active'||amount<=0)throw Object.assign(Error('Nuk keni balancë të disponueshme për casino.'),{status:400});
    run("INSERT INTO casino_sessions(user_id,game_id,game_name,status,amount_cents,opened_at,last_seen_at) VALUES(?,?,?,'opening',?,?,?)",[userId,gameId,game.name,amount,now(),now()]);
    const sid=Number(get('SELECT last_insert_rowid() id').id);credit(userId,-amount,'casino_out',sid,`Casino: ${game.name} (seanca #${sid})`);return sid;
   });
   const s=session(id);
   try{await client.call('balance_operation',{jwt,operation:'increase',sum:s.amount_cents,denomenation:cfg.balanceDenomination});}
   catch(e){
    if(e.definite){tx(()=>{credit(userId,s.amount_cents,'casino_in',id,`Casino: transferimi u refuzua (#${id})`);run("UPDATE casino_sessions SET status='failed',returned_cents=amount_cents,error=?,closed_at=? WHERE id=?",[String(e.message).slice(0,300),now(),id]);});throw Object.assign(Error('Casino nuk e pranoi transferimin: '+e.message),{status:502});}
    await sweep(id);throw Object.assign(Error('Lidhja me casino dështoi. Balanca rikthehet automatikisht.'),{status:502});
   }
   try{
    const creditNow=await providerCredit(jwt),factor=creditNow/s.amount_cents;
    if(!(factor>0)||!Number.isFinite(factor))throw Error('Kreditimi në GSDeluxe nuk u konfirmua.');
    note(id,{status:'active',credit_per_cent:factor,last_seen_at:now()});
    return {sessionId:id,...await startGame(userId,game,{width,height},jwt,currencyId)};
   }catch(e){await sweep(id);throw Object.assign(Error('Loja nuk mund të hapet: '+e.message),{status:502});}
  });
 }
 function frame(key){const f=frames.get(key);frames.delete(key);return f&&f.expires>Date.now()?f:null;}
 async function exit(userId){return locked(userId,async()=>{for(const s of openSessions(userId))await sweep(s.id);const u=get('SELECT balance,reserved_balance FROM users WHERE id=?',[userId]);return {pending:openSessions(userId).length,balance:Number(u.balance),availableBalance:(cents(u.balance)-cents(u.reserved_balance))/100};});}
 async function ping(userId){
  const cached=jwts.get(userId);if(cached)client.call('user_ping',{jwt:cached.jwt}).catch(()=>jwts.delete(userId));
  const s=all("SELECT * FROM casino_sessions WHERE user_id=? AND status='active'",[userId])[0];if(!s)return {active:cfg.mode==='seamless'};
  note(s.id,{last_seen_at:now()});
  return {active:true,sessionId:s.id};
 }
 async function gameList(userId){
  if(games&&Date.now()-games.at<10*60000)return games.rows;
  const {jwt}=await login(userId),r=await client.call('gamelist',{jwt,best_game_count:12,best_game_period:30});
  const base=r.baseURL||'';
  games={at:Date.now(),rows:(r.gamelist||[]).map(g=>({id:Number(g.ID),name:String(g.Name),platform:String(g.Platform||''),icon:g.GameIconUrl?base+g.GameIconUrl:''})).filter(g=>Number.isSafeInteger(g.id)),best:(r.best_games||[]).map(Number)};
  return games.rows;
 }
 // Background sweeper: unfinished transfers and players who left without pressing exit.
 async function tick(){
  const cutoff=new Date(Date.now()-cfg.idleMs).toISOString();
  const due=all("SELECT id,user_id FROM casino_sessions WHERE status IN ('opening','closing') OR (status='active' AND last_seen_at<?)",[cutoff]);
  for(const s of due)await locked(Number(s.user_id),()=>sweep(s.id)).catch(e=>log.error?.('Casino tick',e.message));
  for(const [key,f] of frames)if(f.expires<Date.now())frames.delete(key);
 }
 // Center decision for a 'review' session, after checking the GSDeluxe admin history.
 // Any credit still at GSDeluxe is withdrawn first so the account starts clean.
 function resolve(id,amount,actorId){
  const s=session(id);if(!s||s.status!=='review')throw Object.assign(Error('Seanca nuk është në verifikim.'),{status:409});
  const value=cents(amount);if(!Number.isSafeInteger(value)||value<0||value>100000000)throw Object.assign(Error('Shumë e pavlefshme.'),{status:400});
  return locked(Number(s.user_id),async()=>{
   const {jwt}=await login(s.user_id,true),before=await providerCredit(jwt);
   const taken=before>0?Number((await client.call('balance_operation',{jwt,operation:'decrease_all',sum:0,denomenation:cfg.balanceDenomination})).credit)||0:0;
   return tx(()=>{const cur=session(id);if(cur.status!=='review')throw Object.assign(Error('Seanca ka ndryshuar.'),{status:409});if(value>0)credit(s.user_id,value,'casino_in',id,`Casino: zgjidhje manuale e seancës #${id}`);run("UPDATE casino_sessions SET status='closed',returned_cents=?,closed_at=?,resolved_by=?,sweep_uncertain=0 WHERE id=?",[value,now(),actorId,id]);run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[actorId,'casino_session_resolved','user',s.user_id,JSON.stringify({sessionId:id,amount:value/100,providerCreditWithdrawn:taken,previousError:s.error})]);return session(id);});
  });
 }
 // Retries the automatic sweep of a stuck session; 'review' sessions need resolve().
 function retry(id){const s=session(id);if(!s)throw Object.assign(Error('Seanca nuk u gjet.'),{status:404});if(s.status==='review')throw Object.assign(Error('Seanca në verifikim zgjidhet me shumën e konfirmuar.'),{status:409});return locked(Number(s.user_id),()=>sweep(id));}
 // Credit currently held at GSDeluxe for a review session, to help the center decide.
 async function inspect(id){const s=session(id);if(!s)throw Object.assign(Error('Seanca nuk u gjet.'),{status:404});const {jwt}=await login(s.user_id,true),credit=await providerCredit(jwt),factor=Number(s.credit_per_cent)||Number(get("SELECT credit_per_cent f FROM casino_sessions WHERE credit_per_cent>0 ORDER BY id DESC LIMIT 1")?.f||0);return {providerCredit:credit,estimatedEur:factor>0?Math.floor(credit/factor+1e-6)/100:null};}
 function report({from,to}={}){
  if(cfg.mode==='seamless'){
   const where=[],args=[];if(from){where.push('t.created_at>=?');args.push(from);}if(to){where.push('t.created_at<?');args.push(to);}
   const w=where.length?' WHERE '+where.join(' AND '):'';
   const transactions=all(`SELECT t.*,u.username FROM casino_transactions t JOIN users u ON u.id=t.user_id${w} ORDER BY t.id DESC LIMIT 500`,args);
   const s=get(`SELECT COUNT(*) n,COALESCE(SUM(CASE WHEN type='BET' THEN -amount_cents ELSE 0 END),0) bets,COALESCE(SUM(CASE WHEN type='WIN' THEN amount_cents ELSE 0 END),0) wins,COALESCE(SUM(CASE WHEN type='REFUND' THEN amount_cents ELSE 0 END),0) refunds,COUNT(DISTINCT user_id) players FROM casino_transactions t${w}`,args);
   return {mode:'seamless',transactions,summary:{transactions:Number(s.n),players:Number(s.players),bets:Number(s.bets)/100,wins:Number(s.wins)/100,refunds:Number(s.refunds)/100,ggr:(Number(s.bets)-Number(s.wins)-Number(s.refunds))/100}};
  }
  const where=[],args=[];if(from){where.push('s.opened_at>=?');args.push(from);}if(to){where.push('s.opened_at<?');args.push(to);}
  const w=where.length?' WHERE '+where.join(' AND '):'';
  const sessions=all(`SELECT s.*,u.username FROM casino_sessions s JOIN users u ON u.id=s.user_id${w} ORDER BY s.id DESC LIMIT 500`,args);
  const t=get(`SELECT COUNT(*) sessions,COALESCE(SUM(CASE WHEN status='closed' THEN amount_cents END),0) sent,COALESCE(SUM(CASE WHEN status='closed' THEN returned_cents END),0) returned,SUM(CASE WHEN status='review' THEN 1 ELSE 0 END) review,SUM(CASE WHEN status IN ('opening','active','closing') THEN 1 ELSE 0 END) open FROM casino_sessions s${w}`,args);
  return {mode:'transfer',sessions,summary:{sessions:Number(t.sessions),sent:Number(t.sent)/100,returned:Number(t.returned)/100,ggr:(Number(t.sent)-Number(t.returned))/100,review:Number(t.review||0),open:Number(t.open||0)}};
 }
 return {launch,frame,exit,ping,tick,gameList,resolve,retry,inspect,report,sweep,openSessions,callback,flush,mode:cfg.mode};
}

// configured: credentials present, so balances can always be swept back.
// enabled: new games may be started (GSD_ENABLED=false stops launches only).
// The game host serves game frames and nothing else, so no player ever signs in there.
function frameHostGuard(frameHost){
 return (req,res,next)=>frameHost&&req.hostname===frameHost&&!req.path.startsWith('/api/casino/frame/')?res.status(404).type('text/plain').send('Not found'):next();
}
function mount(app,{casino,auth,centerAuth,jsonError,configured,enabled,trustProxy=false,frameHost='',frameAncestors='https:'}){
 const player=(req,res,next)=>auth(req,res,()=>req.user.role==='user'?next():jsonError(res,403,'Casino është vetëm për lojtarët.'));
 const fail=(res,e)=>{if(!e.status)console.error('Casino:',e.message);jsonError(res,e.status||502,e.status?e.message:'Casino është përkohësisht e padisponueshme.');};
 const guard=(fn,launching=false)=>async(req,res)=>{if(!configured||(launching&&!enabled))return jsonError(res,503,'Casino nuk është aktive.',{code:'CASINO_DISABLED'});try{await fn(req,res);}catch(e){fail(res,e);}};
 // Seamless wallet callbacks called by GSDeluxe. Always HTTP 200; errors travel in the body.
 app.post('/api/casino/gsd/:command(balance|changebalance)',express.text({type:()=>true,limit:'64kb'}),(req,res)=>{
  let body=req.body;
  if(typeof body==='string'){try{body=JSON.parse(body);}catch(_){try{body=JSON.parse(new URLSearchParams(body).get('data'));}catch(__){body=null;}}}
  const forwarded=trustProxy&&String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
  const ip=String(forwarded||req.socket.remoteAddress||'').replace(/^::ffff:/,'');
  const result=configured?casino.callback(body&&body.command===req.params.command?body:{...(body||{}),command:undefined},ip):{response:{status:'ERROR',data:{error_code:'ERR7',error_message:'Casino is not configured'}}};
  res.status(200).json(result);
 });
 app.get('/api/casino/status',player,(req,res)=>res.json({enabled:configured&&enabled,open:configured?casino.openSessions(req.user.id).map(s=>({id:s.id,status:s.status,game:s.game_name})):[]}));
 app.get('/api/casino/games',player,guard(async(req,res)=>res.json({games:await casino.gameList(req.user.id)}),true));
 app.post('/api/casino/launch',player,guard(async(req,res)=>{const gameId=Number(req.body?.gameId);if(!Number.isSafeInteger(gameId)||gameId<=0)return jsonError(res,400,'Loja e pavlefshme.');res.json(await casino.launch(req.user.id,{gameId,width:req.body.width,height:req.body.height}));},true));
 app.post('/api/casino/exit',player,guard(async(req,res)=>res.json(await casino.exit(req.user.id))));
 app.post('/api/casino/ping',player,guard(async(req,res)=>res.json(await casino.ping(req.user.id))));
 // One-time URL for the iframe (iframes cannot send the bearer header). On the dedicated
 // game host (GSD_FRAME_ORIGIN) the provider document gets a normal origin of its own, so its
 // games can use storage and cookies, while the browser keeps it away from the player's
 // session on the site. Without that host it falls back to an opaque sandbox.
 app.get('/api/casino/frame/:key',(req,res)=>{
  const f=configured&&casino.frame(String(req.params.key));
  if(!f)return res.status(404).type('text/plain').send('Loja ka skaduar. Hapeni përsëri.');
  if(frameHost&&req.hostname===frameHost){res.removeHeader('X-Frame-Options');res.setHeader('Content-Security-Policy','frame-ancestors '+frameAncestors);}
  else{res.setHeader('Content-Security-Policy','sandbox allow-scripts allow-forms allow-popups allow-pointer-lock allow-orientation-lock');res.setHeader('X-Frame-Options','SAMEORIGIN');}
  res.type('html').send(f.html);
 });
 app.get('/api/center/casino/sessions',centerAuth,(req,res)=>res.json({enabled:configured&&enabled,...casino.report({from:req.query.from,to:req.query.to})}));
 app.get('/api/center/casino/sessions/:id/provider',centerAuth,guard(async(req,res)=>res.json(await casino.inspect(Number(req.params.id)))));
 app.post('/api/center/casino/sessions/:id/retry',centerAuth,guard(async(req,res)=>res.json({session:await casino.retry(Number(req.params.id))})));
 app.post('/api/center/casino/sessions/:id/resolve',centerAuth,guard(async(req,res)=>res.json({session:await casino.resolve(Number(req.params.id),Number(req.body?.amount),req.user.id)})));
}

module.exports={encrypt,decrypt,sign,gameUrl,GsdError,createClient,createCasino,mount,frameHostGuard};
