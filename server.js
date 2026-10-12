const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const ioClient = require('socket.io-client');
const {AsyncLocalStorage}=require('async_hooks');
const requestContext=new AsyncLocalStorage();
const apiMonitor=require('./api-monitor')();

const STARTED_AT = new Date().toISOString();
const SETTLEMENT_VERSION = 'first-half-confirmed-v2';
const PORT = Number(process.env.PORT || 3000);
const BASE = process.env.VBET_BASE || 'https://euro07.bet';
const LIVE_SOCKET_URL = process.env.LIVE_SOCKET_URL || 'https://xbet.socketi355.com:1440';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'sportsbook.db');
const SESSION_DAYS = 30;
const STAFF_SESSION_MS = 30 * 60 * 1000;
let db, access;
const prematchLeagueByGame=new Map();
let competitions;
const exposureSubscribers=new Set();
let exposurePushQueued=false;
function queueExposurePush(){if(exposurePushQueued||!exposureSubscribers.size)return;exposurePushQueued=true;queueMicrotask(()=>{exposurePushQueued=false;for(const send of exposureSubscribers)send();});}

const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const now = () => new Date().toISOString();
const asyncHandler=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const jsonError = (res, code, message, extra={}) => res.status(code).json({ error: message, ...extra });
// `supermanager` is kept as a legacy-compatible alias. New accounts should use
// the explicit Senior -> Manager business hierarchy.
const ROLES = new Set(['center','operator','partner','admin','senior','manager','supermanager','agent','user']);
const PERMISSIONS = [
  'users.view','users.create','users.edit','users.block','users.password.reset',
  'wallet.view','wallet.credit','wallet.debit','bets.view','bets.review',
  'bets.offer_odds','bets.accept','bets.reject','bets.cancel','bets.settle',
  'reports.view','audit.view','permissions.manage','risk.view','risk.manage'
];
function hashPassword(password) { const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.scryptSync(String(password), salt, 64).toString('hex'); return `scrypt$${salt}$${hash}`; }
function verifyPassword(password, stored) { try { if (!stored) return false; if (stored.startsWith('scrypt$')) { const [,salt,hex]=stored.split('$'); const hash=crypto.scryptSync(String(password),salt,64).toString('hex'); return crypto.timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(hex,'hex')); } const old=crypto.createHash('sha256').update(String(password)).digest('hex'); return old===stored; } catch (_) { return false; } }
let loginChecks=0;
async function verifyLoginPassword(password,stored){
  if(loginChecks>=4)return false;loginChecks++;
  try{if(!stored?.startsWith('scrypt$'))return verifyPassword(password,stored);
    const [,salt,hex]=stored.split('$');
    const hash=await new Promise((resolve,reject)=>crypto.scrypt(String(password),salt,64,(error,key)=>error?reject(error):resolve(key)));
    const expected=Buffer.from(hex,'hex');return expected.length===hash.length&&crypto.timingSafeEqual(hash,expected);
  }catch(_){return false;}finally{loginChecks--;}
}
function makeToken(prefix='') { return prefix + crypto.randomBytes(32).toString('hex'); }
function saveDb() { const temporary=DB_FILE+'.tmp';const fd=fs.openSync(temporary,'w');try{fs.writeFileSync(fd,Buffer.from(db.export()));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,DB_FILE); }
function run(sql, params=[]) {
  const req=requestContext.getStore();
  const insert=sql.match(/^INSERT INTO (audit_log|wallet_transactions)\(([^)]+)\) VALUES\(([^)]+)\)$/i);
  if(req?.user&&insert){
    const fields=insert[2].split(',').map(x=>x.trim());
    const extra=insert[1]==='audit_log'?{actor_role:req.user.role,ip_address:req.ip,user_agent:String(req.headers['user-agent']||'').slice(0,500)}:{created_by:req.user.id};
    const missing=Object.entries(extra).filter(([k])=>!fields.includes(k));
    if(missing.length){sql=`INSERT INTO ${insert[1]}(${insert[2]},${missing.map(([k])=>k).join(',')}) VALUES(${insert[3]},${missing.map(()=>'?').join(',')})`;params=[...params,...missing.map(([,v])=>v)];}
  }
  db.run(sql, params);
}
function get(sql, params=[]) { const s=db.prepare(sql); s.bind(params); const r=s.step()?s.getAsObject():null; s.free(); return r; }
function all(sql, params=[]) { const s=db.prepare(sql); s.bind(params); const a=[]; while(s.step()) a.push(s.getAsObject()); s.free(); return a; }
function lastId() { return Number(get('SELECT last_insert_rowid() id').id); }
function tx(fn) {
  const before=db.export();let committed=false;
  run('BEGIN');
  try {const out=fn();run('COMMIT');committed=true;saveDb();queueExposurePush();return out;}
  catch(e){if(committed){const Database=db.constructor;db.close();db=new Database(before);db.run('PRAGMA foreign_keys=ON');}else{try{run('ROLLBACK')}catch(_){}}throw e;}
}
function normalizeUsername(v){ return String(v||'').trim().toLowerCase(); }
function validateCredentials(username,password){ if(!/^[a-z0-9_.-]{3,32}$/.test(username)) throw Error('Username: 3-32 characters, letters/numbers/._- only.'); if(String(password).length<6) throw Error('Password must contain at least 6 characters.'); }
function publicUser(u){ const isCenter=u.role==='center'; return {id:Number(u.id),username:u.username,balance:isCenter?0:Number(u.balance||0),reservedBalance:isCenter?0:Number(u.reserved_balance||0),availableBalance:isCenter?0:money(Number(u.balance||0)-Number(u.reserved_balance||0)),unlimited:isCenter,role:u.role,status:u.status,parentId:u.parent_id==null?null:Number(u.parent_id),businessParentId:u.business_parent_id==null?null:Number(u.business_parent_id),controlParentId:u.control_parent_id==null?null:Number(u.control_parent_id),creditLimit:Number(u.credit_limit||0)}; }
function roleCanCreate(parentRole, childRole){ return !!access.children[parentRole]?.includes(childRole); }
function isDescendant(actorId, targetId){ if(Number(actorId)===Number(targetId)) return true; let cur=get('SELECT COALESCE(business_parent_id,parent_id) parent_id FROM users WHERE id=?',[Number(targetId)]); let guard=0; while(cur && cur.parent_id!=null && guard++<30){ if(Number(cur.parent_id)===Number(actorId)) return true; cur=get('SELECT COALESCE(business_parent_id,parent_id) parent_id FROM users WHERE id=?',[Number(cur.parent_id)]); } return false; }
function canManageUser(actor,target){ if(!actor||!target||Number(actor.id)===Number(target.id))return false; if(actor.role==='center')return true; return isDescendant(actor.id,target.id); }
function roleCanFund(actorRole,targetRole){ return actorRole==='center' || (actorRole==='partner'&&targetRole==='admin') || ((actorRole==='senior'||actorRole==='supermanager')&&targetRole==='manager') || (actorRole==='manager'&&targetRole==='agent') || (actorRole==='agent'&&targetRole==='user'); }
function canFundTarget(actor,target){
  if(!actor||!target||Number(actor.id)===Number(target.id)||target.status!=='active') return false;
  if(!roleCanFund(actor.role,target.role)) return false;
  return actor.role==='center'||Number(target.business_parent_id??target.parent_id)===Number(actor.id);
}
function canOperate(role){ return role==='operator' || role==='center'; }
function permissionsFor(userId,role){
  if(role==='center') return new Set(PERMISSIONS);
  const inherited=all('SELECT permission_key FROM role_permissions WHERE role_key=?',[role]).map(x=>x.permission_key);
  const assigned=all('SELECT permission_key,allowed FROM user_permissions WHERE user_id=?',[userId]);
  const out=new Set(inherited);
  for(const row of assigned){ if(Number(row.allowed))out.add(row.permission_key); else out.delete(row.permission_key); }
  return out;
}
function hasPermission(actor,permission){ return !!actor && permissionsFor(actor.id,actor.role).has(permission); }
function permissionAuth(...permissions){ return (req,res,next)=>auth(req,res,()=>permissions.some(p=>hasPermission(req.user,p))?next():jsonError(res,403,'Permission denied.')); }
function isBusinessChild(parentRole,childRole){ return roleCanCreate(parentRole,childRole); }

function auth(req,res,next){
  const h=req.headers.authorization||''; const token=h.startsWith('Bearer ')?h.slice(7):''; if(!token)return jsonError(res,401,'Authentication required.');
  const s=get(`SELECT s.token,s.user_id,s.expires_at,u.username,u.role,u.balance,u.reserved_balance,u.status,u.parent_id,u.business_parent_id,u.control_parent_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?`,[token,now()]);
  if(!s)return jsonError(res,401,'Session expired.'); if(s.status!=='active'||!access.active(s.user_id))return jsonError(res,403,'Account or ancestor is not active.'); req.user={id:Number(s.user_id),username:s.username,role:s.role,balance:Number(s.balance),reservedBalance:Number(s.reserved_balance||0),parentId:s.parent_id==null?null:Number(s.parent_id),businessParentId:s.business_parent_id==null?null:Number(s.business_parent_id),controlParentId:s.control_parent_id==null?null:Number(s.control_parent_id),token}; next();
}
function roleAuth(...roles){ return (req,res,next)=>auth(req,res,()=>roles.includes(req.user.role)?next():jsonError(res,403,'Insufficient permissions.')); }
const centerAuth=roleAuth('center');
const adminAuth=roleAuth('partner','admin','center');
const operatorAuth=roleAuth('operator','center');
const partnerAuth=roleAuth('partner','center');
const seniorAuth=roleAuth('senior','supermanager','center');
const managerAuth=roleAuth('center','partner','admin','senior','supermanager','manager','agent');

async function proxy(pathname, body, method){
  const headers={accept:'application/json, text/plain, */*','accept-language':'en-US,en;q=0.9','content-type':'application/x-www-form-urlencoded',origin:BASE,referer:BASE+'/vbet/user/src/','user-agent':'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/153.0.0.0 Mobile Safari/537.36'};
  const opts={method:method||((body!==undefined&&body!==null&&body!=='')?'POST':'GET'),headers};
  if(body!==undefined&&body!==null&&body!=='')opts.body=typeof body==='string'?body:new URLSearchParams(body).toString();
  const finish=apiMonitor.begin('Outgoing',opts.method,BASE+pathname);
  try{const r=await fetch(BASE+pathname,{...opts,signal:AbortSignal.timeout(20000)});const text=await r.text();let invalid=false;try{JSON.parse(text)}catch(_){invalid=true;}finish(r.status,invalid?(/<title>\s*Page Not Found\s*<\/title>/i.test(text)?'Provider returned an HTML Page Not Found instead of JSON':'Provider returned invalid JSON'):'');return {status:r.status,text};}catch(e){finish(0,e.name==='TimeoutError'?'Upstream timeout':'Upstream connection failed');throw e;}
}
function sendFeedResponse(res,upstream){
  if(upstream.status<200||upstream.status>=300)return jsonError(res,502,'Furnizimi i të dhënave është përkohësisht i padisponueshëm.',{code:'UPSTREAM_ERROR'});
  try{const data=JSON.parse(upstream.text);if(!data||typeof data!=='object')throw Error('Invalid feed');return res.json(data);}
  catch(_){return jsonError(res,502,'Furnizimi i të dhënave ktheu përgjigje të pavlefshme.',{code:'UPSTREAM_INVALID_RESPONSE'});}
}
function rememberFeedIdentities(response){
  if(response.status<200||response.status>=300)return;
  let rows;try{rows=JSON.parse(response.text)}catch(_){return;}
  if(Array.isArray(rows))rememberEventIdentities(rows);
}
function rememberEventIdentities(games){
  let changed=false;
  for(const g of games){
    const id=String(g.id??g.game_id??''),apiId=String(g.game_api_id??g.api_id??'');
    if(!/^\d+$/.test(id)||!/^\d+$/.test(apiId))continue;
    if(!get('SELECT game_id FROM event_identities WHERE game_id=?',[id])){
      run('INSERT INTO event_identities(game_id,api_id,sport_id) VALUES(?,?,?)',[id,apiId,g.sport_id==null?null:String(g.sport_id)]);changed=true;
    }
  }
  // Backfill only exact event IDs seen in the provider feed, never team-name guesses.
  run("UPDATE bet_selections SET game_api_id=(SELECT api_id FROM event_identities e WHERE e.game_id=bet_selections.game_id) WHERE COALESCE(game_api_id,'')='' AND EXISTS (SELECT 1 FROM event_identities e WHERE e.game_id=bet_selections.game_id)");
  if(Number(get('SELECT changes() n').n))changed=true;
  if(changed)saveDb();
}
async function feedGames(){
  const [live,pre]=await Promise.allSettled([proxy('/ajax/livegames?market_type=1'),proxy('/ajax/prematchgames24hour')]);
  const out=[]; for(const x of [live,pre]) if(x.status==='fulfilled'&&x.value.status>=200&&x.value.status<300){try{const d=JSON.parse(x.value.text);if(Array.isArray(d))out.push(...d)}catch(_){}}
  // Refresh routing from current feeds; browsing a league is not a prerequisite
  // for placing a prematch bet. A live event takes precedence over an old listing.
  if(pre.status==='fulfilled'&&pre.value.status===200){try{const rows=JSON.parse(pre.value.text);if(Array.isArray(rows))for(const g of rows){if(g.league_id){if(prematchLeagueByGame.size>=20000)prematchLeagueByGame.delete(prematchLeagueByGame.keys().next().value);prematchLeagueByGame.set(String(g.id??g.game_id),String(g.league_id));}}}catch(_){}}
  if(live.status==='fulfilled'&&live.value.status===200){try{const rows=JSON.parse(live.value.text);if(Array.isArray(rows))for(const g of rows)prematchLeagueByGame.delete(String(g.id??g.game_id));}catch(_){}}
  rememberEventIdentities(out);
  if(typeof competitions!=="undefined"&&competitions)competitions.remember(out);
  return out;
}
function parseDetailOdd(data, selection, coefId, requested={}){
  const groups=[];
  if(Array.isArray(data)){
    for(const item of data){
      if(Array.isArray(item)&&item.length)groups.push(...item);
      else if(item&&typeof item==='object')groups.push(item);
    }
  }
  let found=null;
  if(coefId)found=groups.find(x=>(String(x.id)===String(coefId)||String(x.market_option_id)===String(coefId))&&(!requested.marketId||String(x.market_id)===String(requested.marketId))&&(requested.specialValue==null||String(x.special_value??'')===String(requested.specialValue)));
  if(!coefId&&!found&&selection)found=groups.find(x=>String(x.market_option||'').trim()===String(selection).trim());
  if(!found)return null;
  const odd=Number(found.odd); // A matched but closed coefficient must not fall back to summary odds.
  return {coefId:coefId||String(found.id??found.market_option_id??''),odd,marketId:found.market_id==null?'':String(found.market_id),selection:String(found.market_option||selection||'').trim(),market:String(found.market||'Fulltime Result').trim()||'Fulltime Result',specialValue:found.special_value??found.specialValue??''};
}

function parseSummaryOdd(game, selection, coefId){
  if(!game||typeof game.odd!=='string')return null;
  const parts=game.odd.split(',').map(part=>part.split('|')).filter(p=>p.length>=4);
  if(coefId){
    const byCoef=parts.find(p=>String(p[0])===String(coefId));
    if(byCoef) return {coefId:String(byCoef[0]),odd:Number(byCoef[1]),marketId:String(byCoef[3]),selection:String(byCoef[2]),specialValue:''};
    return null;
  }
  const bySelection=parts.find(p=>String(p[2])===String(selection));
  return bySelection?{coefId:String(bySelection[0]),odd:Number(bySelection[1]),marketId:String(bySelection[3]),selection:String(bySelection[2]),specialValue:''}:null;
}

// Authoritative odds validation used by the bet-placement endpoint.
// Detail/live markets come from /ajax/livegame/:gameId; summary markets come
// from the sportsbook feed. We prefer coefficient id, then exact option text.
async function validateSelections(selections){
  const current=[];
  const invalid=[];
  const changed=[];
  const feedCache=new Map();
  const detailCache=new Map();

  async function getFeed(){
    if(feedCache.has('all')) return feedCache.get('all');
    const value=await feedGames();
    for(const id of new Set(selections.map(s=>prematchLeagueByGame.get(String(s.gameId))).filter(Boolean))){try{const r=await proxy('/ajax/gamesByLeague/'+id),rows=JSON.parse(r.text);if(r.status===200&&Array.isArray(rows))for(const row of rows){const i=value.findIndex(g=>String(g.id)===String(row.id));if(i>=0)value[i]=row;else value.push(row);}}catch(_){}}

    access.rememberLeagues(value||[]);
    feedCache.set('all',value||[]);
    return value||[];
  }
  async function getDetail(gameId){
    const key=String(gameId||'');
    if(!key)return null;
    if(detailCache.has(key))return detailCache.get(key);
    await getFeed();
    try{
      const r=await proxy((prematchLeagueByGame.has(key)?'/ajax/prematchgame/':'/ajax/livegame/')+encodeURIComponent(key));
      if(r.status>=200&&r.status<300){
        const data=JSON.parse(r.text);
        detailCache.set(key,data);
        return data;
      }
    }catch(_){ }
    detailCache.set(key,null);
    return null;
  }

  for(const sel of selections){
    const gameId=String(sel.gameId||'');
    const selection=String(sel.selection||'').trim();
    const coefId=String(sel.coefId||'');
    const suppliedOdd=Number(sel.odd);
    let found=null,detailChecked=false;

    // A detail selection is explicitly identified by a coefficient/market id,
    // and live selections should be checked against the livegame response.
    if(coefId || sel.marketType==='detail' || sel.marketId){
      const detail=await getDetail(gameId);
      if(Array.isArray(detail)){detailChecked=true;found=parseDetailOdd(detail,selection,coefId,sel);}
    }

    // Fallback for prematch/summary selections.
    if(!found&&!detailChecked){
      const games=await getFeed();
      const game=games.find(g=>String(g.id??g.game_id??'')===gameId);
      if(game) found=parseSummaryOdd(game,selection,coefId);
      if(!found && game) {
        // Some feeds expose full market groups under the game object.
        found=parseDetailOdd(game,selection,coefId);
      }
    }

    if(!found || !Number.isFinite(Number(found.odd)) || Number(found.odd)<=1){
      invalid.push({gameId,selection,coefId,reason:'Koeficienti nuk është më aktiv ose nuk u gjet.'});
      continue;
    }

    const authoritativeGame=(await getFeed()).find(g=>String(g.id??g.game_id??'')===gameId);
    const normalized={
      ...sel,
      acceptanceType:authoritativeGame?(prematchLeagueByGame.has(gameId)?'prematch':(authoritativeGame.current_minute!=null?'live':'unknown')):'unknown',
      league_id:authoritativeGame?.league_id==null?null:String(authoritativeGame.league_id),
      sport_id:authoritativeGame?.sport_id==null?null:String(authoritativeGame.sport_id),
      league:String(authoritativeGame?.league||''),
      gameId,
      game_id:gameId,
      coefId:found.coefId||coefId,
      marketId:found.marketId||String(sel.marketId||''),
      market:found.market||String(sel.market||'Fulltime Result'),
      selection:found.selection||selection,
      odd:Number(found.odd),
      specialValue:found.specialValue??sel.specialValue??sel.special_value??'',
      gameApiId:String(authoritativeGame?.game_api_id??authoritativeGame?.api_id??''),
    };
    if(!normalized.gameApiId){
      try{
        const games=await getFeed();
        const game=games.find(g=>String(g.id??g.game_id??'')===gameId);
        normalized.gameApiId=String(game?.game_api_id??game?.api_id??'');
      }catch(_){ }
    }

    if(!Number.isFinite(suppliedOdd)||suppliedOdd<=1){
      invalid.push({gameId,selection,coefId,reason:'Koeficienti i zgjedhur nuk është i vlefshëm.'});
      continue;
    }
    if(Math.abs(Number(found.odd)-suppliedOdd)>0.0001){
      changed.push({gameId,selection,coefId,newOdd:Number(found.odd)});
      continue;
    }
    current.push(normalized);
  }
  return {current,invalid,changed};
}
// ---- Automatic settlement engine ----
// Settlement is deliberately conservative: if the feed does not provide enough authoritative
// information to evaluate a market, the selection stays pending instead of being guessed.
const TIMELINE_TTL_MS = 2500;
const timelineCache = new Map();

function norm(v){ return String(v??'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' '); }
function num(v){ if(v==null||String(v).trim()==='')return null;const n=Number(String(v??'').replace(',','.')); return Number.isFinite(n)?n:null; }
function normalizeFinalScore(value){
  const m=String(value??'').trim().match(/^(\d+)\s*[-:]\s*(\d+)$/);
  return m ? {home:Number(m[1]),away:Number(m[2])} : null;
}
function finishedGame(data){
  if(!data)return false;
  const status=data.game_status??data.api_status??data.status??data.state;
  const s=norm(status);
  return s==='255' || ['finished','finish','ended','completed','fulltime','ft'].includes(s);
}
function extractGameRecord(data,gameId){
  const candidates=[];
  const add=v=>{ if(Array.isArray(v))v.forEach(add); else if(v&&typeof v==='object')candidates.push(v); };
  add(data);
  const found=candidates.find(x=>String(x.id??x.game_id??'')===String(gameId));
  if(!found)return null;
  const score=normalizeFinalScore(found.game_result??found.final_result??found.result_score??found.current_result??found.result);
  return {record:found,score,finished:finishedGame(found)};
}

async function fetchTimeline(apiGameId){
  const key=String(apiGameId||'');if(!key)return null;
  const cached=timelineCache.get(key);
  if(cached&&Date.now()-cached.at<(cached.failed?60000:TIMELINE_TTL_MS))return cached.data;
  try{
    const r=await proxy('/games-timeline/'+encodeURIComponent(key)+'.json');
    if(r.status>=200&&r.status<300){
      let data;try{data=JSON.parse(r.text);}catch(_){data=null;}
      if(Array.isArray(data)){timelineCache.set(key,{at:Date.now(),data,failed:false});return data;}
    }
  }catch(_){ /* Proxy records the failure in API Monitor. */ }
  // Missing timeline is unknown, never an empty/zero-stat match.
  timelineCache.set(key,{at:Date.now(),data:cached?.data||null,failed:true});
  return cached?.data||null;
}

async function fetchFinalGame(gameId,cache){
  const key=String(gameId);
  if(cache.has(key))return cache.get(key);
  let result=null;
  try{
    if(!cache.has('feed'))cache.set('feed',feedGames());
    const games=await cache.get('feed');
    const g=games.find(x=>String(x.id??x.game_id??'')===key || String(x.game_id??'')===key);
    if(g)result=extractGameRecord(g,key);
  }catch(_){}
  if(!result||!result.finished||!result.score){
    try{
      const r=await proxy('/ajax/livegame/'+encodeURIComponent(key));
      if(r.status>=200&&r.status<300)result=extractGameRecord(JSON.parse(r.text),key)||result;
    }catch(_){}
  }
  cache.set(key,result||null);
  return result||null;
}
function eventTimeSeconds(v){
  const m=String(v??'').match(/(\d+)\s*:\s*(\d+)/);
  return m?Number(m[1])*60+Number(m[2]):null;
}
function buildStats(timeline,score){
  const events=Array.isArray(timeline)?timeline:[];
  const ordered=events.slice().sort((a,b)=>{const phase=e=>String(e.game_status)==='1'?0:String(e.game_status)==='2'?1:String(e.game_status)==='3'?2:3;return phase(a)-phase(b)||(eventTimeSeconds(a.minute)??1e9)-(eventTimeSeconds(b.minute)??1e9);}); const stats={homeGoals:score?.home??0,awayGoals:score?.away??0,homeCorners:0,awayCorners:0,homeCards:0,awayCards:0,homeRedCards:0,awayRedCards:0,homeYellowCards:0,awayYellowCards:0,homeShots:0,awayShots:0,homeFouls:0,awayFouls:0,firstGoal:null,firstCorner:null,firstCard:null,goals:[],corners:[],cards:[],events:ordered,halfTimeScore:null,finished:false};
  for(const e of ordered){
    const type=norm(e.type), team=String(e.team??'0'), sec=eventTimeSeconds(e.minute);
    const isHome=team==='1',isAway=team==='2';
    if(type==='end of the first half'||String(e.type_id)==='5'){const hs=normalizeFinalScore(e.minute);if(hs)stats.halfTimeScore=hs;} if(type==='end of the match'||String(e.type_id)==='6')stats.finished=String(e.game_status??'')==='255';
    if(type==='goal'||String(e.type_id)==='1'){
      if(isHome)stats.homeGoals++; else if(isAway)stats.awayGoals++;
      if(isHome||isAway){ const g={team:isHome?'home':'away',sec,minute:e.minute,period:String(e.game_status??''),sequence:num(e.value)}; stats.goals.push(g); if(!stats.firstGoal)stats.firstGoal=g; }
    } else if(type==='corner'||String(e.type_id)==='2'){
      if(isHome)stats.homeCorners++; else if(isAway)stats.awayCorners++;
      if(isHome||isAway){const c={team:isHome?'home':'away',sec,minute:e.minute,period:String(e.game_status??''),sequence:num(e.value)};stats.corners.push(c);if(!stats.firstCorner)stats.firstCorner=c;}
    } else if(type.includes('yellow card')||type==='yellow card'||String(e.type_id)==='4'){
      if(isHome){stats.homeYellowCards++;stats.homeCards++;} else if(isAway){stats.awayYellowCards++;stats.awayCards++;}
      if(isHome||isAway){const c={team:isHome?'home':'away',sec,minute:e.minute,kind:'yellow'};stats.cards.push(c);if(!stats.firstCard)stats.firstCard=c;}
    } else if(type.includes('red card')){
      if(isHome){stats.homeRedCards++;stats.homeCards++;} else if(isAway){stats.awayRedCards++;stats.awayCards++;}
      if(isHome||isAway){const c={team:isHome?'home':'away',sec,minute:e.minute,kind:'red'};stats.cards.push(c);if(!stats.firstCard)stats.firstCard=c;}
    }
  }
  // The provider's global sequence resolves same-minute ordering and exposes gaps/duplicates.
  for(const key of ['goals','corners']){
    const items=stats[key],hasSequence=items.some(e=>e.sequence!==null);
    stats[key+'Complete']=!hasSequence||items.every(e=>Number.isInteger(e.sequence)&&e.sequence>0)&&new Set(items.map(e=>e.sequence)).size===items.length&&Math.max(...items.map(e=>e.sequence))===items.length;
    if(hasSequence&&stats[key+'Complete'])items.sort((a,b)=>a.sequence-b.sequence);
  }
  // Timeline contains cumulative values in its `value` field for some event types.
  // The event count is the authoritative fallback because it matches Euro07's own timeline UI.
  if(score){stats.homeGoals=score.home;stats.awayGoals=score.away;}
  return stats;
}
function finalishTimeline(timeline,game){
  if(game?.finished&&game?.score)return true;
  if(!Array.isArray(timeline)||!timeline.length)return false;
  return timeline.some(e=>String(e.type_id)==='6'&&String(e.game_status)==='255') || timeline.some(e=>norm(e.type)==='end of the match'&&String(e.game_status)==='255') || !!game?.finished;
}
function parseLine(text){
  const s=String(text??'').replace(',','.');
  const m=s.match(/(?:^|\s)([-+]?\d+(?:\.\d+)?)(?:\s*$)/);
  return m?Number(m[1]):null;
}
function teamOf(selection){
  const s=norm(selection);
  if(/^(1)(?:\s|$)/.test(s)||s.includes('home')||s.includes('team 1'))return 'home';
  if(/^(2)(?:\s|$)/.test(s)||s.includes('away')||s.includes('team 2'))return 'away';
  return null;
}
// Exact names prevent a goal rule from accidentally settling cards, corners or players.
function namedGoalMarket(market){
  let name=norm(market).replace(/ live$/, '');
  let period='full';
  const periods=[['first',/^(?:first half|1st half|pjesa e pare|p1)\s*[-:]?\s+/],['second',/^(?:second half|2nd half|pjesa e dyte|p2)\s*[-:]?\s+/]];
  for(const [key,re] of periods)if(re.test(name)){period=key;name=name.replace(re,'');break;}
  const suffix=name.match(/\s*[-:]?\s+(first half|1st half|pjesa e pare|p1|second half|2nd half|pjesa e dyte|p2)$/);
  if(suffix){period=/^(first|1st|pjesa e pare|p1)/.test(suffix[1])?'first':'second';name=name.slice(0,suffix.index).trim();}
  if(/^fitore\s*\/\s*fitore$|^draw no bet$/.test(name))return {family:'draw_no_bet',period};
  const aliases={
    '1x2':'1x2','match result':'1x2','fulltime result':'1x2','rezultat final':'1x2','rezultati':'1x2',
    'double chance':'doublechance','shans i dyfishte':'doublechance','shansi i dyfishte':'doublechance',
    'total goals':'goals_total','over/under goals':'goals_total','goals over/under':'goals_total','numri i golave ne ndeshje':'goals_total','numri i golave':'goals_total','lart/poshte gola':'goals_total',
    'asian total goals':'goals_asian_total','lart/poshte gola aziatike':'goals_asian_total',
    'home team total goals':'home_goals_total','home total goals':'home_goals_total','away team total goals':'away_goals_total','away total goals':'away_goals_total',
    'both teams to score':'btts','gol jo gol':'btts',
    'odd/even':'odd_even','total goals odd/even':'odd_even','tek/cift':'odd_even',
    'correct score':'exact_score','exact score':'exact_score','rezultati i sakte':'exact_score','rezultat i sakte':'exact_score',
    'asian handicap':'asian_handicap','handikap aziatik':'asian_handicap',
    'european handicap':'euro_handicap','handikap europian':'euro_handicap'
  };
  return aliases[name]?{family:aliases[name],period}:null;
}
// Provider names verified against the captured live catalog. Period is part of the rule.
function providerMarket(sel){
  const id=String(sel.market_id||''),m=norm(sel.market).replace(/ live$/, '');
  const first=/pjesa (?:1(?:-re)?|i|pare)$|pjesen e 1(?:re|re)?$|pjesa1$/.test(m);
  const period=first?'first':'full';
  const base=m.replace(/\s+(?:ne )?(?:pjesa (?:1(?:-re)?|i|pare)|pjesen e 1re|pjesa1)$/, '');
  const rule=(family,extra={})=>({family,period,...extra});
  // Confirmed by the platform owner: Fitore / Fitore refunds a draw.
  if(id==='6661'||/^fitore\s*\/\s*fitore$/.test(base))return rule('draw_no_bet');
  // These labels/options do not establish their settlement convention.
  if(['6663','6595','6831','6832','6833'].includes(id))return rule('unknown');
  if(id==='6576')return rule('1x2',{period:'first'});
  if(id==='6799')return rule('exact_score',{period:'first'});
  if(id==='6809'||id==='6811')return rule('btts',{period:id==='6809'?'first':'second'});
  if(id==='6800')return rule('nth_goal',{period:'first',nth:1});
  if(id==='6801')return rule('nth_goal',{period:'first',nth:2});
  const periodGoal=m.match(/^shenon golin e (\d+|pare|dyte|trete|katert|peste|gjashte) (?:ne )?(?:pjesa\s*([12])|pjesen e ([12])|p([12]))$/);
  if(periodGoal){const nth=Number(periodGoal[1])||({pare:1,dyte:2,trete:3,katert:4,peste:5,gjashte:6})[periodGoal[1]];if(nth>0)return rule('nth_goal',{nth,period:(periodGoal[2]||periodGoal[3]||periodGoal[4])==='1'?'first':'second'});}
  const periodBtts=m.match(/^gol\s*\/?\s*jo\s*gol (?:ne )?(?:pjesa\s*([12])|pjesen e ([12])|p([12]))$/);
  if(periodBtts)return rule('btts',{period:(periodBtts[1]||periodBtts[2]||periodBtts[3])==='1'?'first':'second'});
  if(/^sa gola shenohen ne pjesen e 1re$/.test(m))return rule('goals_total',{period:'first'});
  if(/^lart\/poshte korne(?: totali)?$/.test(base))return rule('corners_total');
  if(base==='handikap aziatik')return rule('asian_handicap');
  if(base==='lart/poshte gola aziatike')return rule('goals_asian_total');
  if(/^handikap live pjesa pare \([+-]?\d+:[+-]?\d+\)$/.test(m))return rule('euro_handicap',{period:'first'});
  if(m==='sa gola do shenohen nga ekipi udhetues')return rule('away_goals_total');
  if(m==='sa gola do shenohen nga ekipi vendas')return rule('home_goals_total');
  if(id==='6816'||id==='6817')return rule('scores_both_halves',{team:id==='6816'?'home':'away'});
  if(/^rezultati final gola \d+\+$/.test(m))return rule('result_goals_combo');
  const ordinals={pare:1,dyte:2,trete:3,katert:4,peste:5,gjashte:6,shtate:7,tete:8,nente:9,dhjete:10,njembedhjete:11,dymbedhjete:12,trembedhjete:13};
  const goal=m.match(/^shenon golin e (\w+) \(skuadra\)$/),corner=m.match(/^godet kornen e (\w+)$/);
  if(goal&&ordinals[goal[1]])return rule('nth_goal',{nth:ordinals[goal[1]]});
  if(corner&&ordinals[corner[1]])return rule('nth_corner',{nth:ordinals[corner[1]]});
  return null;
}
function marketFamily(sel){
  const provider=providerMarket(sel);if(provider)return provider.family;
  const id=String(sel.market_id||'');
  const m=norm(sel.market);
  const named=namedGoalMarket(m);if(named)return named.family;
  if(/pjes|half|\bp[12]\b/.test(m)&&!['6662','6811','6818','6819'].includes(id))return 'unknown';
  if(id==='6840'||/^rezultat(?:i)? final\s*\/\s*gol\s*-\s*gol(?: live)?$/.test(m))return 'ft_btts';
  if(id==='6575'||m.includes('fulltime result')||m.includes('rezultat final'))return '1x2';
  if(id==='6653'||m.includes('double chance'))return 'doublechance';
  if(id==='6577'||id==='6579'||m.includes('total gol'))return 'goals_total';
  if(id==='6711'||m.includes('gola aziatik'))return 'goals_asian_total';
  if(id==='6763'||id==='6764'||m.includes('ekipi vendas'))return 'home_goals_total';
  if(id==='6812')return 'home_goals_count';
  if(id==='6813')return 'away_goals_count';
  if(id==='6780'||m.includes('gol jo gol'))return 'btts';
  if(id==='6757'||m.includes('tek/cift')||m.includes('odd/even'))return 'odd_even';
  if(id==='6620'||id==='6789'||id==='6790'||id==='6791'||(m.includes('corner')&&m.includes('posht')&&m.includes('lart')))return 'corners_total';
  if(id==='6648')return 'nth_corner';
  if(id==='6660')return 'last_corner';
  if(id==='6657'||m.includes('gara e korneve'))return 'race_corners';
  if(id==='6581')return 'second_goal';
  if(id==='6578'||m.includes('first goal')||m.includes('golin e pare'))return 'first_goal';
  if(id==='6662'||m.includes('rezultati i pjeses se dyte'))return 'second_half_result';
  if(id==='6811')return 'second_half_btts';
  if(id==='6818')return 'home_scores_second_half';
  if(id==='6819')return 'away_scores_second_half';
  if(id==='6810')return 'final_3plus_combo';
  if(id==='6664'||id==='6665'||id==='6666'||id==='6677'||m.includes('handikap aziatik'))return 'asian_handicap';
  if(id==='9086'||id==='9087'||m.includes('handikap europian'))return 'euro_handicap';
  if(m.includes('rezultati sakte')||m.includes('rezultat sakte'))return 'exact_score';
  if(id==='6831')return 'extra_time_winner';
  if(id==='6832')return 'penalty_shootout_winner';
  return 'unknown';
}
function parseOverUnder(selection,specialValue){
  const s=norm(selection);
  const side=s.includes('over')||s.includes('lart')?'over':s.includes('under')||s.includes('poshte')?'under':null;
  const line=parseLine(selection)??parseLine(specialValue);
  return side&&line!==null?{side,line}:null;
}
function resultForTotal(total,side,line,odd){
  if(total===null||line===null)return null;
  if(side==='over'){if(total>line)return {status:'won',factor:odd};if(total<line)return {status:'lost',factor:0};return {status:'void',factor:1};}
  if(side==='under'){if(total<line)return {status:'won',factor:odd};if(total>line)return {status:'lost',factor:0};return {status:'void',factor:1};}
  return null;
}
function asianLineParts(line){
  const q=Number(line);
  if(!Number.isFinite(q)||!Number.isInteger(q*4))return null;
  const quarter=Math.abs((q*4)%2)===1;
  return quarter?[q-0.25,q+0.25]:[q,q];
}
function evaluateAsianTotal(total,side,line,odd){
  const parts=asianLineParts(line); if(!parts)return null;
  const evalOne=(ln)=>{
    if(side==='over') return total>ln?'won':total<ln?'lost':'void';
    return total<ln?'won':total>ln?'lost':'void';
  };
  const a=evalOne(parts[0]),b=evalOne(parts[1]);
  if(a==='won'&&b==='won')return {status:'won',factor:odd};
  if(a==='lost'&&b==='lost')return {status:'lost',factor:0};
  if(a==='void'&&b==='void')return {status:'void',factor:1};
  if((a==='won'&&b==='void')||(a==='void'&&b==='won'))return {status:'half_won',factor:(odd+1)/2};
  if((a==='lost'&&b==='void')||(a==='void'&&b==='lost'))return {status:'half_lost',factor:0.5};
  return null;
}
function exactOptionValue(selection){
  const m=norm(selection).match(/(?:^|\s)(\d+)\s*$/); return m?Number(m[1]):null;
}
function yesNo(selection){
  const s=norm(selection);
  if(s==='po'||s==='yes'||s==='gg'||s==='g')return true;
  if(s==='jo'||s==='no'||s==='jg')return false;
  return null;
}
// Confirmed by the platform owner: numeric BTTS buttons mean 1=Gol, 2=Jo Gol.
// Keep this mapping local to BTTS; team/result markets retain their own 1/2 meaning.
function bttsChoice(selection){const value=norm(selection);return value==='1'?true:value==='2'?false:yesNo(selection);}
function secondHalfStats(stats){
  const first=stats.halfTimeScore||{home:0,away:0};
  return {home:stats.homeGoals-first.home,away:stats.awayGoals-first.away};
}
function confirmedFirstHalf(timeline){
  const ends=(timeline||[]).filter(e=>(String(e.type_id)==='5'||norm(e.type)==='end of the first half')&&String(e.game_status)==='2');
  if(!ends.length)return null;
  const scores=ends.map(e=>normalizeFinalScore(e.minute));
  if(scores.some(s=>!s||s.home!==scores[0]?.home||s.away!==scores[0]?.away))return null;
  return scores[0];
}
function isFirstHalfSelection(sel){return (providerMarket(sel)||namedGoalMarket(sel.market))?.period==='first';}
function evaluateSelection(sel,stats,game,timeline){
  const family=marketFamily(sel), s=norm(sel.selection), odd=Number(sel.odd);
  if(!Number.isFinite(odd)||odd<=1)return null;
  if(sel.sport_id!=null&&String(sel.sport_id)!=='1')return null;
  if(game?.record?.sport_id!=null&&String(game.record.sport_id)!=='1')return null;
  if(isFirstHalfSelection(sel)){
    const half=confirmedFirstHalf(timeline);if(!half)return null;
    timeline=timeline.filter(e=>['1','2'].includes(String(e.game_status)));
    stats=buildStats(timeline,half);
  }else if(!finalishTimeline(timeline,game))return null;
  if(stats.halfTimeScore&&(stats.halfTimeScore.home>stats.homeGoals||stats.halfTimeScore.away>stats.awayGoals))return null;
  if(Array.isArray(timeline)&&timeline.some(e=>['1','2','3','4'].includes(String(e.type_id))&&!['1','3'].includes(String(e.game_status))))return null;
  const named=providerMarket(sel)||namedGoalMarket(sel.market);
  if(named&&named.period!=='full'){
    if(!stats.halfTimeScore||stats.halfTimeScore.home>stats.homeGoals||stats.halfTimeScore.away>stats.awayGoals)return null;
    const half=named.period==='first'?stats.halfTimeScore:secondHalfStats(stats);
    if(half.home<0||half.away<0)return null;
    const phase=named.period==='first'?'1':'3';
    const inPeriod=items=>items.filter(e=>e.period===phase);
    const corners=inPeriod(stats.corners),goals=inPeriod(stats.goals);
    if(['corners_total','nth_corner','last_corner','race_corners','nth_goal','first_goal','second_goal'].includes(family)&&stats.events.some(e=>['1','2'].includes(String(e.type_id))&&!['1','3'].includes(String(e.game_status))))return null;
    stats={...stats,homeGoals:half.home,awayGoals:half.away,corners,goals,homeCorners:corners.filter(e=>e.team==='home').length,awayCorners:corners.filter(e=>e.team==='away').length};
  }
  const timelineFamilies=new Set(['corners_total','nth_corner','last_corner','race_corners','first_goal','second_goal','nth_goal']);
  if(timelineFamilies.has(family)&&(!Array.isArray(timeline)||!timeline.length))return null;
  if(['corners_total','nth_corner','last_corner','race_corners'].includes(family)&&stats.cornersComplete===false)return null;
  if(['first_goal','second_goal','nth_goal'].includes(family)&&stats.goalsComplete===false)return null;
  // A partial goal timeline cannot establish which team scored first or second.
  if(['first_goal','second_goal','nth_goal'].includes(family)&&(stats.goals.filter(g=>g.team==='home').length!==stats.homeGoals||stats.goals.filter(g=>g.team==='away').length!==stats.awayGoals))return null;
  const totalGoals=stats.homeGoals+stats.awayGoals;
  if(family==='draw_no_bet'){
    if(!['1','2'].includes(s))return null;
    if(stats.homeGoals===stats.awayGoals)return {status:'void',factor:1};
    const winner=stats.homeGoals>stats.awayGoals?'1':'2',ok=s===winner;
    return {status:ok?'won':'lost',factor:ok?odd:0};
  }
  if(family==='1x2'){
    const r=stats.homeGoals>stats.awayGoals?'1':stats.homeGoals<stats.awayGoals?'2':'x';
    const want=({home:'1',away:'2',draw:'x'})[s]||s;
    return ['1','2','x'].includes(want)?{status:want===r?'won':'lost',factor:want===r?odd:0}:null;
  }
  if(family==='doublechance'){
    const r=stats.homeGoals>stats.awayGoals?'1':stats.homeGoals<stats.awayGoals?'2':'x';
    const want=s.replace(/[\s/]/g,'');
    const ok=want==='1x'?['1','x'].includes(r):want==='x2'?['x','2'].includes(r):want==='12'?['1','2'].includes(r):null;
    return ok===null?null:{status:ok?'won':'lost',factor:ok?odd:0};
  }
  if(family==='goals_total'){
    const ou=parseOverUnder(sel.selection,sel.special_value); return ou?resultForTotal(totalGoals,ou.side,ou.line,odd):null;
  }
  if(family==='goals_asian_total'){
    const ou=parseOverUnder(sel.selection,sel.special_value); return ou?evaluateAsianTotal(totalGoals,ou.side,ou.line,odd):null;
  }
  if(family==='home_goals_total'||family==='away_goals_total'){
    const n=family==='home_goals_total'?stats.homeGoals:stats.awayGoals;
    const ou=parseOverUnder(sel.selection,sel.special_value); return ou?resultForTotal(n,ou.side,ou.line,odd):null;
  }
  if(family==='home_goals_count'||family==='away_goals_count'){
    const n=family==='home_goals_count'?stats.homeGoals:stats.awayGoals;
    if(s.includes('3+'))return {status:n>=3?'won':'lost',factor:n>=3?odd:0};
    const m=s.match(/(?:^|\s)(0|1|2)\s*(?:gol|gola)?$/); if(!m)return null;
    const ok=n===Number(m[1]); return {status:ok?'won':'lost',factor:ok?odd:0};
  }
  if(family==='corners_total'){
    const n=stats.homeCorners+stats.awayCorners;
    if(s.includes('sakte')||s.includes('exact')){const line=parseLine(sel.selection);if(line===null)return null;const ok=n===line;return {status:ok?'won':'lost',factor:ok?odd:0};}
    const ou=parseOverUnder(sel.selection,sel.special_value); return ou?resultForTotal(n,ou.side,ou.line,odd):null;
  }
  if(family==='btts'){
    const ok=stats.homeGoals>0&&stats.awayGoals>0, want=bttsChoice(sel.selection);
    return want===null?null:{status:want===ok?'won':'lost',factor:want===ok?odd:0};
  }
  if(family==='odd_even'){
    const want=s.includes('odd')||s.includes('tek')?'odd':s.includes('even')||s.includes('cift')?'even':null;
    if(!want)return null;const ok=want==='odd'?totalGoals%2===1:totalGoals%2===0;return {status:ok?'won':'lost',factor:ok?odd:0};
  }
  if(family==='first_goal'||family==='second_goal'||family==='nth_goal'){
    const index=family==='nth_goal'?named.nth-1:family==='first_goal'?0:1, g=stats.goals[index];
    const want=teamOf(sel.selection);
    if(want){const ok=g?.team===want;return {status:ok?'won':'lost',factor:ok?odd:0};}
    const noGoal=s==='x'||/^s['’]?ka gol(?: te \d+)?$/.test(s)||s==='no goal'; if(noGoal){const ok=!g;return {status:ok?'won':'lost',factor:ok?odd:0};}
    return null;
  }
  if(family==='nth_corner'){
    const n=Number(named?.nth||(String(sel.market_id)==='6648'?13:0));if(!n)return null;const c=stats.corners[n-1],want=teamOf(sel.selection);if(!want||!c)return null;const ok=c?.team===want;return {status:ok?'won':'lost',factor:ok?odd:0};
  }
  if(family==='last_corner'){
    const c=stats.corners[stats.corners.length-1],want=teamOf(sel.selection);if(!want||!c)return null;const ok=c?.team===want;return {status:ok?'won':'lost',factor:ok?odd:0};
  }
  if(family==='race_corners'){
    const threshold=parseLine(sel.selection)||parseLine(sel.special_value);if(threshold===null)return null;
    let hc=0,ac=0,hIndex=-1,aIndex=-1; for(let i=0;i<stats.corners.length;i++){if(stats.corners[i].team==='home'){hc++;if(hc===threshold){hIndex=i;break;}}else if(stats.corners[i].team==='away'){ac++;if(ac===threshold){aIndex=i;break;}}} if(hIndex<0||aIndex<0){hc=0;ac=0;for(let i=0;i<stats.corners.length;i++){if(stats.corners[i].team==='home'){hc++;if(hc===threshold){hIndex=i;break;}}} for(let i=0;i<stats.corners.length;i++){if(stats.corners[i].team==='away'){ac++;if(ac===threshold){aIndex=i;break;}}}}
    const winner=hIndex<0&&aIndex<0?'x':hIndex<0?'away':aIndex<0?'home':hIndex<aIndex?'home':'away';
    const want=s.startsWith('1')?'home':s.startsWith('2')?'away':s.startsWith('x')?'x':null;if(!want)return null;const ok=winner===want;return {status:ok?'won':'lost',factor:ok?odd:0};
  }
  if(family==='second_half_result'||family==='second_half_btts'||family==='home_scores_second_half'||family==='away_scores_second_half'){
    if(!stats.halfTimeScore)return null;
    const sh=secondHalfStats(stats);
    if(family==='second_half_result'){
      const r=sh.home>sh.away?'1':sh.home<sh.away?'2':'x';const ok=s===r;return ['1','2','x'].includes(s)?{status:ok?'won':'lost',factor:ok?odd:0}:null;
    }
    if(family==='second_half_btts'){
      const want=bttsChoice(sel.selection),ok=sh.home>0&&sh.away>0;return want===null?null:{status:want===ok?'won':'lost',factor:want===ok?odd:0};
    }
    const want=yesNo(sel.selection),n=family==='home_scores_second_half'?sh.home:sh.away,ok=n>0;return want===null?null:{status:want===ok?'won':'lost',factor:want===ok?odd:0};
  }
  if(family==='scores_both_halves'){
    if(!stats.halfTimeScore)return null;
    const sh=secondHalfStats(stats),want=yesNo(sel.selection),team=named.team;
    if(sh.home<0||sh.away<0||want===null)return null;
    const ok=stats.halfTimeScore[team]>0&&sh[team]>0;
    return {status:want===ok?'won':'lost',factor:want===ok?odd:0};
  }
  if(family==='result_goals_combo'||family==='final_3plus_combo'){
    const p=s.replace(/\s/g,'').split('|');if(p.length!==2)return null;
    const result=stats.homeGoals>stats.awayGoals?'1':stats.homeGoals<stats.awayGoals?'2':'x';const okResult=p[0]===result;const threshold=p[1].match(/^(\d+)\+$/),marketThreshold=norm(sel.market).match(/gola (\d+)\+$/);if(!threshold||!['1','x','2'].includes(p[0])||(marketThreshold&&Number(marketThreshold[1])!==Number(threshold[1])))return null;const okGoals=totalGoals>=Number(threshold[1]);const ok=okResult&&okGoals;return {status:ok?'won':'lost',factor:ok?odd:0};
  }
  if(family==='exact_score'){
    const m=s.match(/(\d+)\s*[-:]\s*(\d+)/);if(!m)return null;const ok=stats.homeGoals===Number(m[1])&&stats.awayGoals===Number(m[2]);return {status:ok?'won':'lost',factor:ok?odd:0};
  }
  if(family==='euro_handicap'){
    const line=String(sel.special_value||'').match(/^([+-]?\d+)\s*:\s*([+-]?\d+)$/);if(!line)return null;
    const sh=stats.homeGoals+Number(line[1]),sa=stats.awayGoals+Number(line[2]);const r=sh>sa?'1':sh<sa?'2':'x';const want=s.startsWith('1')?'1':s.startsWith('2')?'2':s.startsWith('x')?'x':null;if(!want)return null;const ok=r===want;return {status:ok?'won':'lost',factor:ok?odd:0};
  }
  if(family==='ft_btts'){
    const p=s.replace(/\s/g,'').split('|');if(p.length!==2)return null;const ft=stats.homeGoals>stats.awayGoals?'1':stats.homeGoals<stats.awayGoals?'2':'x';const gg=stats.homeGoals>0&&stats.awayGoals>0,want=yesNo(p[1]);if(!['1','x','2'].includes(p[0])||want===null)return null;const ok=p[0]===ft&&want===gg;return {status:ok?'won':'lost',factor:ok?odd:0};
  }
  if(family==='asian_handicap'){
    const team=teamOf(sel.selection);if(!team)return null;let line=parseLine(sel.special_value);if(line===null)line=parseLine(sel.selection);if(line===null)return null;
    if(team==='away'&&providerMarket(sel)&&line!==0)return null;
    const diff=team==='home'?stats.homeGoals-stats.awayGoals:stats.awayGoals-stats.homeGoals;
    const parts=asianLineParts(line);if(!parts)return null;const evalOne=ln=>{const d=diff+ln;return d>0?'won':d<0?'lost':'void'};const a=evalOne(parts[0]),b=evalOne(parts[1]);
    if(a==='won'&&b==='won')return {status:'won',factor:odd};if(a==='lost'&&b==='lost')return {status:'lost',factor:0};if(a==='void'&&b==='void')return {status:'void',factor:1};if((a==='won'&&b==='void')||(a==='void'&&b==='won'))return {status:'half_won',factor:(odd+1)/2};if((a==='lost'&&b==='void')||(a==='void'&&b==='lost'))return {status:'half_lost',factor:0.5};return null;
  }
  // These two markets depend on extra-time / shootout outcome data which the supplied football timeline does not encode.
  if(family==='extra_time_winner'||family==='penalty_shootout_winner')return null;
  return null;
}
let settlementRunning=false,settlementCursor=0;
async function settleAcceptedBets(){
  if(settlementRunning)return;
  settlementRunning=true;
  try{await settleSelectionBatch();}finally{settlementRunning=false;}
}
async function settleSelectionBatch(){
  const query="SELECT b.id,b.status FROM bets b WHERE (b.status='accepted' OR (b.status='lost' AND EXISTS (SELECT 1 FROM bet_selections s WHERE s.bet_id=b.id AND s.result_status='pending'))) AND b.id>? ORDER BY b.id ASC LIMIT 100";
  let bets=all(query,[settlementCursor]);
  if(!bets.length&&settlementCursor){settlementCursor=0;bets=all(query,[0]);}
  if(bets.length)settlementCursor=Number(bets[bets.length-1].id);
  if(!bets.length)return;
  const gameCache=new Map();
  for(const row of bets){
    try{
      const selections=all('SELECT * FROM bet_selections WHERE bet_id=? ORDER BY id',[row.id]);
      if(!selections.length)continue;
      const evaluated=[];
      for(const sel of selections){
        if(['won','lost','void','half_won','half_lost'].includes(sel.result_status)){evaluated.push({status:sel.result_status,factor:sel.result_status==='won'?Number(sel.odd):sel.result_status==='void'?1:sel.result_status==='half_won'?(Number(sel.odd)+1)/2:sel.result_status==='half_lost'?0.5:0});continue;}
        const game=await fetchFinalGame(sel.game_id,gameCache);
        const identity=get('SELECT api_id,sport_id FROM event_identities WHERE game_id=?',[String(sel.game_id)]);
        if(identity?.sport_id&&String(identity.sport_id)!=='1'){evaluated.push(null);continue;}
        const apiId=String(identity?.api_id||game?.record?.game_api_id||game?.record?.api_id||sel.game_api_id||'');
        const timeline=await fetchTimeline(apiId);
        const halfScore=isFirstHalfSelection(sel)?confirmedFirstHalf(timeline):null;
        if(!halfScore&&!finalishTimeline(timeline,game)){evaluated.push(null);continue;}
        const endEvents=(timeline||[]).filter(e=>String(e.type_id)==='6'||norm(e.type)==='end of the match');
        const timelineScore=endEvents.length?normalizeFinalScore(endEvents[endEvents.length-1]?.minute):null;
        const score=halfScore||(game?.score&&timelineScore ? (game.score.home===timelineScore.home&&game.score.away===timelineScore.away?game.score:null) : (timelineScore||game?.score));
        if(!score){evaluated.push(null);continue;}
        const stats=buildStats(timeline,score);
        const outcome=evaluateSelection(sel,stats,game,timeline);
        if(!outcome){evaluated.push(null);continue;}
        tx(()=>{
          run("UPDATE bet_selections SET result_status=? WHERE id=? AND result_status='pending' AND EXISTS (SELECT 1 FROM bets WHERE bets.id=bet_selections.bet_id AND bets.status IN ('accepted','lost'))",[outcome.status,sel.id]);
          if(!Number(get('SELECT changes() n').n))return;
          run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[null,'auto_selection_settled','bet_selection',sel.id,JSON.stringify({betId:Number(row.id),gameId:String(sel.game_id),marketId:String(sel.market_id||''),market:String(sel.market||''),selection:String(sel.selection),score,outcome,apiGameId:String(apiId||'')})]);
        });
        evaluated.push(outcome);
      }
      // Continue resolving remaining legs of lost tickets without changing their payout.
      if(row.status!=='accepted')continue;
      if(evaluated.some(x=>x?.status==='lost')){
        tx(()=>settleTicket(row.id,'lost',0,evaluated));
      } else if(evaluated.length===selections.length && evaluated.every(Boolean)){
        const payout=money(Number(get('SELECT stake FROM bets WHERE id=?',[row.id]).stake)*evaluated.reduce((p,x)=>p*Number(x.factor),1));
        const allVoid=evaluated.every(x=>x.status==='void');
        tx(()=>settleTicket(row.id,allVoid?'void':(payout>0?'won':'lost'),payout,evaluated));
      }
    }catch(e){console.error('Automatic settlement:',e.message||e)}
  }
}
function settleTicket(betId,status,payout,evaluated){
  const b=get('SELECT * FROM bets WHERE id=?',[betId]); if(!b||b.status!=='accepted')return;
  const u=get('SELECT id,balance FROM users WHERE id=?',[b.user_id]);
  const finalPayout=money(payout);
  const balance=money(Number(u.balance)+finalPayout);
  run('UPDATE bets SET status=?,payout=?,settled_at=? WHERE id=?',[status,finalPayout,now(),b.id]);
  run('UPDATE users SET balance=? WHERE id=?',[balance,b.user_id]);
  if(finalPayout>0)run('INSERT INTO wallet_transactions(user_id,type,amount,balance_after,bet_id,note) VALUES(?,?,?,?,?,?)',[b.user_id,status==='void'?'refund':'payout',finalPayout,balance,b.id,status==='void'?'Automatic void ticket refund':'Automatic winning ticket payout']);
  run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[null,'auto_ticket_settled','bet',b.id,JSON.stringify({status,payout:finalPayout,selections:evaluated})]);
}
let settlementTimer=null;
function startSettlementEngine(){
  if(settlementTimer)clearInterval(settlementTimer);
  const tick=()=>settleAcceptedBets().catch(e=>console.error('Settlement engine:',e.message||e));
  tick(); settlementTimer=setInterval(tick,10000);
}

// ---- Euro07 real-time live feed ----
const liveClients=new Set(); let upstreamSocket=null,upstreamReconnectTimer=null,upstreamReconnectDelay=1000,upstreamConnected=false;
function broadcastLive(type,payload){const msg=`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;for(const res of liveClients){try{res.write(msg)}catch(_){liveClients.delete(res)}}}
function broadcastLiveStatus(status,extra={}){broadcastLive('status',{status,...extra});}
// Private SSE channel for account-specific updates (offers, ticket decisions).
// Unlike the public odds feed, no other player can receive these events.
const notificationClients=new Map();
function notifyUser(userId,type,payload){const clients=notificationClients.get(Number(userId));if(!clients)return;const message=`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;for(const res of clients){try{res.write(message)}catch(_){clients.delete(res)}}if(!clients.size)notificationClients.delete(Number(userId));}
function scheduleUpstreamReconnect(){if(upstreamReconnectTimer)return;const delay=upstreamReconnectDelay;upstreamReconnectDelay=Math.min(upstreamReconnectDelay*2,15000);upstreamReconnectTimer=setTimeout(()=>{upstreamReconnectTimer=null;connectUpstream()},delay)}
function connectUpstream(){if(upstreamSocket){try{upstreamSocket.close()}catch(_){}upstreamSocket=null}broadcastLiveStatus('connecting');try{const browserHeaders={Origin:BASE,Referer:BASE+'/vbet/user/src/','User-Agent':'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/153.0.0.0 Mobile Safari/537.36',Accept:'*/*','Accept-Language':'en-US,en;q=0.9'};upstreamSocket=ioClient(LIVE_SOCKET_URL,{path:'/socket.io',transports:['websocket'],upgrade:false,rememberUpgrade:false,reconnection:false,timeout:15000,forceNew:true,autoConnect:true,perMessageDeflate:false,transportOptions:{polling:{extraHeaders:browserHeaders},websocket:{extraHeaders:browserHeaders}},extraHeaders:browserHeaders});upstreamSocket.on('connect',()=>{upstreamConnected=true;upstreamReconnectDelay=1000;broadcastLiveStatus('connected');upstreamSocket.emit('connectToRoom',{room:'inplay'})});upstreamSocket.on('new-coefs',data=>broadcastLive('coefs',data));upstreamSocket.on('new-live-game',data=>broadcastLive('game',data));upstreamSocket.on('delete-live-game',data=>broadcastLive('delete-game',data));upstreamSocket.on('disconnect',()=>{upstreamConnected=false;broadcastLiveStatus('reconnecting');scheduleUpstreamReconnect()});upstreamSocket.on('connect_error',err=>{upstreamConnected=false;console.error('Live socket:',err&&err.message||err);broadcastLiveStatus('reconnecting');scheduleUpstreamReconnect()});upstreamSocket.on('error',err=>{upstreamConnected=false;console.error('Live socket error:',err&&err.message||err);broadcastLiveStatus('reconnecting')});}catch(_){upstreamConnected=false;broadcastLiveStatus('reconnecting');scheduleUpstreamReconnect()}}

async function start(){
  const SQL=await initSqlJs({locateFile:file=>require.resolve('sql.js/dist/'+file)}); db=fs.existsSync(DB_FILE)?new SQL.Database(fs.readFileSync(DB_FILE)):new SQL.Database(); run('PRAGMA foreign_keys=ON');
  run(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,balance REAL NOT NULL DEFAULT 0,reserved_balance REAL NOT NULL DEFAULT 0,role TEXT NOT NULL DEFAULT 'user',status TEXT NOT NULL DEFAULT 'active',parent_id INTEGER,created_by INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,last_login TEXT,FOREIGN KEY(parent_id) REFERENCES users(id) ON DELETE SET NULL,FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL)`);
  run(`CREATE TABLE IF NOT EXISTS event_identities(game_id TEXT PRIMARY KEY,api_id TEXT NOT NULL,sport_id TEXT)`);
  run(`CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL,role TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`);
  run(`CREATE TABLE IF NOT EXISTS bets(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,agent_id INTEGER,supermanager_id INTEGER,stake REAL NOT NULL,total_odds REAL NOT NULL,potential_win REAL NOT NULL,status TEXT NOT NULL DEFAULT 'pending',payout REAL NOT NULL DEFAULT 0,reserved REAL NOT NULL DEFAULT 0,accepted_by INTEGER,accepted_at TEXT,cancelled_by INTEGER,cancelled_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,settled_at TEXT,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(agent_id) REFERENCES users(id) ON DELETE SET NULL,FOREIGN KEY(supermanager_id) REFERENCES users(id) ON DELETE SET NULL,FOREIGN KEY(accepted_by) REFERENCES users(id) ON DELETE SET NULL,FOREIGN KEY(cancelled_by) REFERENCES users(id) ON DELETE SET NULL)`);
  run(`CREATE TABLE IF NOT EXISTS bet_selections(id INTEGER PRIMARY KEY AUTOINCREMENT,bet_id INTEGER NOT NULL,game_id TEXT NOT NULL,coef_id TEXT,market_id TEXT,league TEXT,home_team TEXT,away_team TEXT,market TEXT NOT NULL,selection TEXT NOT NULL,odd REAL NOT NULL,event_time TEXT,result_status TEXT NOT NULL DEFAULT 'pending',special_value TEXT,game_api_id TEXT,FOREIGN KEY(bet_id) REFERENCES bets(id) ON DELETE CASCADE)`);
  run(`CREATE TABLE IF NOT EXISTS wallet_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,type TEXT NOT NULL,amount REAL NOT NULL,balance_after REAL NOT NULL,bet_id INTEGER,note TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(bet_id) REFERENCES bets(id) ON DELETE SET NULL)`);
  run(`CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id INTEGER,action TEXT NOT NULL,target_type TEXT,target_id INTEGER,details TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL)`);
  run(`CREATE TABLE IF NOT EXISTS bet_offers(id INTEGER PRIMARY KEY AUTOINCREMENT,bet_id INTEGER NOT NULL UNIQUE,offered_by INTEGER,offers_json TEXT NOT NULL,total_odds REAL NOT NULL,potential_win REAL NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,responded_at TEXT,FOREIGN KEY(bet_id) REFERENCES bets(id) ON DELETE CASCADE,FOREIGN KEY(offered_by) REFERENCES users(id) ON DELETE SET NULL)`);
  // Additive RBAC and dual-hierarchy migration. The legacy parent_id is kept
  // untouched so existing users and endpoints remain compatible.
  run(`CREATE TABLE IF NOT EXISTS roles(role_key TEXT PRIMARY KEY,label TEXT NOT NULL,hierarchy_type TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS permissions(permission_key TEXT PRIMARY KEY,label TEXT NOT NULL)`);
  run(`CREATE TABLE IF NOT EXISTS role_permissions(role_key TEXT NOT NULL,permission_key TEXT NOT NULL,PRIMARY KEY(role_key,permission_key),FOREIGN KEY(role_key) REFERENCES roles(role_key) ON DELETE CASCADE,FOREIGN KEY(permission_key) REFERENCES permissions(permission_key) ON DELETE CASCADE)`);
  run(`CREATE TABLE IF NOT EXISTS user_permissions(user_id INTEGER NOT NULL,permission_key TEXT NOT NULL,allowed INTEGER NOT NULL DEFAULT 1,granted_by INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(user_id,permission_key),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(permission_key) REFERENCES permissions(permission_key) ON DELETE CASCADE,FOREIGN KEY(granted_by) REFERENCES users(id) ON DELETE SET NULL)`);
  const alter=(table,col,sql)=>{const cols=all(`PRAGMA table_info(${table})`).map(x=>x.name);if(!cols.includes(col))run(sql)};
  alter('bet_selections','acceptance_type',"ALTER TABLE bet_selections ADD COLUMN acceptance_type TEXT NOT NULL DEFAULT 'unknown'");
  alter('users','reserved_balance',"ALTER TABLE users ADD COLUMN reserved_balance REAL NOT NULL DEFAULT 0"); alter('users','parent_id','ALTER TABLE users ADD COLUMN parent_id INTEGER'); alter('users','created_by','ALTER TABLE users ADD COLUMN created_by INTEGER'); alter('users','business_parent_id','ALTER TABLE users ADD COLUMN business_parent_id INTEGER'); alter('users','control_parent_id','ALTER TABLE users ADD COLUMN control_parent_id INTEGER'); alter('users','credit_limit','ALTER TABLE users ADD COLUMN credit_limit REAL NOT NULL DEFAULT 0'); alter('users','updated_at','ALTER TABLE users ADD COLUMN updated_at TEXT'); alter('bets','agent_id','ALTER TABLE bets ADD COLUMN agent_id INTEGER'); alter('bets','supermanager_id','ALTER TABLE bets ADD COLUMN supermanager_id INTEGER'); alter('bets','reserved','ALTER TABLE bets ADD COLUMN reserved REAL NOT NULL DEFAULT 0'); alter('bets','accepted_by','ALTER TABLE bets ADD COLUMN accepted_by INTEGER'); alter('bets','accepted_at','ALTER TABLE bets ADD COLUMN accepted_at TEXT'); alter('bets','cancelled_by','ALTER TABLE bets ADD COLUMN cancelled_by INTEGER'); alter('bets','cancelled_at','ALTER TABLE bets ADD COLUMN cancelled_at TEXT'); alter('bet_selections','coef_id','ALTER TABLE bet_selections ADD COLUMN coef_id TEXT'); alter('bet_selections','market_id','ALTER TABLE bet_selections ADD COLUMN market_id TEXT'); alter('bet_selections','special_value','ALTER TABLE bet_selections ADD COLUMN special_value TEXT'); alter('bet_selections','game_api_id','ALTER TABLE bet_selections ADD COLUMN game_api_id TEXT');alter('bet_selections','sport_id','ALTER TABLE bet_selections ADD COLUMN sport_id TEXT');
  const roleSeeds=[['center','Center','control'],['operator','Operator','control'],['partner','Partner','business'],['admin','Administrator','business'],['senior','Senior','business'],['manager','Manager','business'],['supermanager','Senior (legacy)','business'],['agent','Agent','business'],['user','User','business']];
  for(const row of roleSeeds)run('INSERT OR IGNORE INTO roles(role_key,label,hierarchy_type) VALUES(?,?,?)',row);
  for(const key of PERMISSIONS)run('INSERT OR IGNORE INTO permissions(permission_key,label) VALUES(?,?)',[key,key]);
  const defaultRolePermissions={operator:[],partner:['users.view','users.create','users.edit','users.block','users.password.reset','wallet.view','wallet.credit','wallet.debit','bets.view','reports.view'],admin:['users.view','users.create','users.edit','users.block','users.password.reset','wallet.view','wallet.credit','wallet.debit','bets.view','reports.view'],senior:['users.view','users.create','users.edit','users.block','users.password.reset','wallet.view','wallet.credit','wallet.debit','bets.view','reports.view'],supermanager:['users.view','users.create','users.edit','wallet.view','wallet.credit','wallet.debit','bets.view','reports.view'],manager:['users.view','users.create','users.edit','users.block','users.password.reset','wallet.view','wallet.credit','wallet.debit','bets.view','reports.view'],agent:['users.view','users.create','users.edit','users.block','users.password.reset','wallet.view','wallet.credit','wallet.debit','bets.view','reports.view']};
  for(const [role,keys] of Object.entries(defaultRolePermissions))for(const key of keys)run('INSERT OR IGNORE INTO role_permissions(role_key,permission_key) VALUES(?,?)',[role,key]);
  run(`CREATE INDEX IF NOT EXISTS idx_users_parent ON users(parent_id)`);run(`CREATE INDEX IF NOT EXISTS idx_users_business_parent ON users(business_parent_id)`);run(`CREATE INDEX IF NOT EXISTS idx_users_control_parent ON users(control_parent_id)`);run(`CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status,created_at DESC)`);run(`CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id,created_at DESC)`);run(`DELETE FROM sessions WHERE expires_at<=?`,[now()]);
  // A server restart requires staff to authenticate again, including legacy sessions.
  run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role <> 'user')");
  // Never reparent, reactivate or create demo accounts during normal startup.
  if(!get("SELECT id FROM users WHERE role='center'")) {
    const username=normalizeUsername(process.env.CENTER_USER||'center');
    const password=String(process.env.CENTER_PASSWORD||'');
    validateCredentials(username,password);
    run("INSERT INTO users(username,password_hash,role,status) VALUES(?,?,'center','active')",[username,hashPassword(password)]);
  }
  access=require('./access-control')({get,all,run,tx,now,hashPassword,validateCredentials,publicUser,auth,hasPermission,permissionsFor,jsonError,feedGames,checkCompetitions:(picks,stake,payout,userId,excludeBet)=>competitions?.check(picks,stake,payout,userId,excludeBet)});
  tx(()=>access.migrate());

  const app=express(); app.use(apiMonitor.middleware); app.disable('x-powered-by'); app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy-Report-Only',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https: wss:; frame-src https:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");next();}); app.use(express.json({limit:'256kb'})); app.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next()}); app.use(express.static(path.join(__dirname,'public'))); app.use((req,res,next)=>requestContext.run(req,next));
  app.get('/api/monitor',centerAuth,(req,res)=>res.json({...apiMonitor.snapshot(),upstreamConnected}));
  app.get('/api/monitor/stream',centerAuth,(req,res)=>{
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});
    const send=()=>{const u=get('SELECT * FROM users WHERE id=?',[req.user.id]);if(!u||u.role!=='center'||!access.active(u.id)||!get('SELECT token FROM sessions WHERE token=? AND expires_at>?',[req.user.token,now()])){res.end();cleanup();return;}if(!res.writableNeedDrain)res.write('data: '+JSON.stringify({...apiMonitor.snapshot(),upstreamConnected})+'\n\n');};
    const unsubscribe=apiMonitor.subscribe(send),ping=setInterval(send,5000);
    const cleanup=()=>{unsubscribe();clearInterval(ping);};req.on('close',cleanup);send();
  });
  competitions=require("./competition-control").create({run,get,all,tx,now,proxy});
  competitions.mount(app,centerAuth);
  access.mount(app);
  const ticketAcceptance=require('./ticket-acceptance').createAcceptance({run,get,tx,now,money});
  ticketAcceptance.mount(app,centerAuth);
  app.get('/api/health',(req,res)=>res.json({ok:true,database:'sqlite/sql.js',apiVersion:'ticket-details-json-v1',settlementVersion:SETTLEMENT_VERSION,startedAt:STARTED_AT,time:now()}));
  for(const [route,upstream] of [['featured','prematchgamesmainleague'],['main-matches','toptenprematchgames'],['home-live','toptenlivegames'],['sports','sports'],['countries/:id','countries'],['leagues/:id','leagues'],['league-games/:id','gamesByLeague']])app.get('/api/sports-catalog/'+route,async(req,res)=>{
    const id=req.params.id;if(id&&!/^\d{1,12}$/.test(id))return jsonError(res,400,'Invalid identifier.');
    try{const r=await proxy('/ajax/'+upstream+(id?'/'+id:''));if(['gamesByLeague','toptenprematchgames','prematchgamesmainleague','toptenlivegames'].includes(upstream)&&r.status===200){const rows=JSON.parse(r.text);if(Array.isArray(rows)){rememberEventIdentities(rows);for(const g of rows){if(prematchLeagueByGame.size>=20000)prematchLeagueByGame.delete(prematchLeagueByGame.keys().next().value);if(g.league_id||id)prematchLeagueByGame.set(String(g.id),String(g.league_id||id));}access.rememberLeagues(rows);}}sendFeedResponse(res,r);}catch(_){jsonError(res,502,'Lista nuk mund të merret nga furnizuesi.');}
  });
  app.get('/api/prematch',async(req,res)=>{try{const r=await proxy('/ajax/prematchgames24hour');rememberFeedIdentities(r);sendFeedResponse(res,r)}catch(e){jsonError(res,502,'Prematch feed unavailable.')}});
  app.get('/api/livegames',async(req,res)=>{try{const r=await proxy('/ajax/livegames?market_type=1');rememberFeedIdentities(r);sendFeedResponse(res,r)}catch(e){jsonError(res,502,'Live feed unavailable.')}});
  app.get('/api/prematchgame/:gameId',async(req,res)=>{try{if(!/^\d+$/.test(String(req.params.gameId)))return jsonError(res,400,'Invalid game id.');const r=await proxy('/ajax/prematchgame/'+encodeURIComponent(req.params.gameId));sendFeedResponse(res,r)}catch(e){jsonError(res,502,'Prematch markets unavailable.')}});
  app.get('/api/livegame/:gameId',async(req,res)=>{try{if(!/^\d+$/.test(String(req.params.gameId)))return jsonError(res,400,'Invalid game id.');const r=await proxy('/ajax/livegame/'+encodeURIComponent(req.params.gameId));sendFeedResponse(res,r)}catch(e){jsonError(res,502,'Live match markets unavailable.')}});
  app.get('/api/live-status',(req,res)=>res.json({upstreamConnected,clients:liveClients.size,reconnectDelay:upstreamReconnectDelay}));
  app.get('/api/livegame/:gameId/timeline',async(req,res)=>{
    if(!/^\d+$/.test(String(req.params.gameId)))return jsonError(res,400,'Invalid game id.');
    try{
      let identity=get('SELECT api_id FROM event_identities WHERE game_id=?',[String(req.params.gameId)]);
      if(!identity){
        const feed=await proxy('/ajax/livegames?market_type=1');
        rememberFeedIdentities(feed);
        identity=get('SELECT api_id FROM event_identities WHERE game_id=?',[String(req.params.gameId)]);
      }
      if(!/^\d+$/.test(String(identity?.api_id??'')))return jsonError(res,502,'Live match timeline identity unavailable.');
      const r=await proxy('/games-timeline/'+encodeURIComponent(identity.api_id)+'.json');
      res.set('Cache-Control','no-store');
      sendFeedResponse(res,r);
    }catch(e){jsonError(res,502,'Live match timeline unavailable.');}
  });
  app.get('/api/livegame/:gameId/stream',auth,async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{
      const id=String(req.params.gameId);if(!/^\d+$/.test(id))return jsonError(res,400,'Invalid game id.');
      const detail=await proxy('/ajax/livegame/'+id);
      if(detail.status!==200)throw Error();
      const rows=JSON.parse(detail.text);const streamId=Array.isArray(rows)?rows.flat().find(r=>r&&/^\d+$/.test(String(r.stream_id||'')))?.stream_id:null;
      if(!streamId)return jsonError(res,404,'Nuk ka transmetim TV për këtë ndeshje.');
      const response=await proxy('/ajax/livestream/'+encodeURIComponent(streamId));
      const data=JSON.parse(response.text);
      if(response.status!==200||data.success!==true||typeof data.url!=='string')throw Error();
      const url=new URL(data.url);if(url.protocol!=='https:'||url.username||url.password)throw Error();
      res.json({url:url.href});
    }catch(_){jsonError(res,502,'Transmetimi TV nuk është i disponueshëm nga furnizuesi. Provo përsëri më vonë.');}
  });
  app.get('/api/notifications/stream',(req,res)=>{
    const token=String(req.query.token||'');
    const session=token&&get(`SELECT s.user_id,u.status FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?`,[token,now()]);
    if(!session||session.status!=='active'||!access.active(session.user_id))return jsonError(res,401,'Authentication required.');
    const userId=Number(session.user_id);res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const clients=notificationClients.get(userId)||new Set();clients.add(res);notificationClients.set(userId,clients);res.write(`event: ready\ndata: ${JSON.stringify({ok:true})}\n\n`);
    const ping=setInterval(()=>{try{if(!get('SELECT token FROM sessions WHERE token=? AND expires_at>?',[token,now()])||!access.active(userId)){clearInterval(ping);clients.delete(res);res.end();return;}res.write(': ping\n\n')}catch(_){clearInterval(ping);clients.delete(res)}},15000);
    req.on('close',()=>{clearInterval(ping);clients.delete(res);if(!clients.size)notificationClients.delete(userId)});
  });
  app.get('/api/live-exposure-stream',permissionAuth('risk.view'),(req,res)=>{
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    let previous=null;
    const send=()=>{try{
      const user=get('SELECT * FROM users WHERE id=?',[req.user.id]);
      if(!user||!get('SELECT token FROM sessions WHERE token=? AND expires_at>?',[req.user.token,now()])||!access.active(user.id)||!hasPermission(user,'risk.view')){res.end();cleanup();return;}
      const data=JSON.stringify({events:access.liveExposure(user)});
      if(data!==previous){res.write('data: '+data+'\n\n');previous=data;}
    }catch(_){res.end();cleanup();}};
    const cleanup=()=>{clearInterval(ping);exposureSubscribers.delete(send);};
    const ping=setInterval(()=>{send();if(!res.writableEnded)res.write(': ping\n\n');},15000);
    exposureSubscribers.add(send);req.on('close',cleanup);send();
  });
  app.get('/api/live-stream',(req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});liveClients.add(res);res.write(`event: status\ndata: ${JSON.stringify({status:upstreamConnected?'connected':'connecting'})}\n\n`);const ping=setInterval(()=>{try{res.write(': ping\n\n')}catch(_){clearInterval(ping);liveClients.delete(res)}},15000);req.on('close',()=>{clearInterval(ping);liveClients.delete(res)})});

  app.post('/api/auth/register',(req,res)=>jsonError(res,403,'Accounts must be created by an agent.'));
  app.post('/api/auth/login',require('./login-guard')(),asyncHandler(async(req,res)=>{const username=normalizeUsername(req.body.username),password=String(req.body.password||'');const u=get('SELECT * FROM users WHERE username=?',[username]);if(!u||u.status!=='active'||!access.active(u.id)||!await verifyLoginPassword(password,u.password_hash)){access.recordLogin(req,u,false);return jsonError(res,401,'Invalid username or password.');}access.recordLogin(req,u,true);try{if(!u.password_hash.startsWith('scrypt$'))run('UPDATE users SET password_hash=? WHERE id=?',[hashPassword(password),u.id]);run('UPDATE users SET last_login=? WHERE id=?',[now(),u.id]);const token=makeToken();run('INSERT INTO sessions(token,user_id,role,expires_at) VALUES(?,?,?,?)',[token,u.id,u.role,new Date(Date.now()+(u.role==='user'?SESSION_DAYS*86400000:STAFF_SESSION_MS)).toISOString()]);saveDb();res.json({token,user:publicUser(get('SELECT * FROM users WHERE id=?',[u.id]))})}catch(e){jsonError(res,500,'Login failed.')}}));
  app.post('/api/auth/logout',auth,(req,res)=>{run('DELETE FROM sessions WHERE token=?',[req.user.token]);saveDb();res.json({ok:true})});
  app.get('/api/me',auth,(req,res)=>{const u=get('SELECT id,username,balance,reserved_balance,role,status,parent_id,business_parent_id,control_parent_id,credit_limit,created_at,last_login FROM users WHERE id=?',[req.user.id]);res.json({user:publicUser(u)})});
  app.get('/api/access/me',auth,(req,res)=>res.json({user:publicUser(get('SELECT * FROM users WHERE id=?',[req.user.id])),permissions:[...permissionsFor(req.user.id,req.user.role)].sort()}));
  app.get('/api/center/governance',centerAuth,(req,res)=>{
    const accounts=all('SELECT id,username,role,status,parent_id,business_parent_id,control_parent_id,balance,reserved_balance,credit_limit,created_at FROM users WHERE id<>? ORDER BY role,id',[req.user.id]).map(publicUser);
    const roleRows=all('SELECT role_key,label,hierarchy_type FROM roles ORDER BY hierarchy_type,role_key');
    res.json({accounts,roles:roleRows,permissions:PERMISSIONS});
  });
  app.put('/api/center/accounts/:id/permissions',centerAuth,(req,res)=>{try{
    const target=get('SELECT * FROM users WHERE id=?',[Number(req.params.id)]);if(!target||!['partner','admin','operator','senior','supermanager','manager','agent'].includes(target.role))return jsonError(res,403,'Llogaria nuk mund të marrë permissions.');
    const grants=Array.isArray(req.body.permissions)?[...new Set(req.body.permissions.map(String))]:null;if(!grants||grants.some(p=>!PERMISSIONS.includes(p)))return jsonError(res,400,'Lista e permissions nuk është e vlefshme.');
    tx(()=>{run('DELETE FROM user_permissions WHERE user_id=?',[target.id]);for(const p of PERMISSIONS)run('INSERT INTO user_permissions(user_id,permission_key,allowed,granted_by) VALUES(?,?,?,?)',[target.id,p,grants.includes(p)?1:0,req.user.id]);run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[req.user.id,'permissions_updated','user',target.id,JSON.stringify({permissions:grants})]);});
    res.json({ok:true,permissions:grants});
  }catch(e){jsonError(res,400,e.message)}});
  app.get('/api/account-finance',auth,(req,res)=>{try{
    if(req.user.role!=='user')return jsonError(res,403,'Player account required.');
    const from=req.query.from?new Date(String(req.query.from)):null,to=req.query.to?new Date(String(req.query.to)):null;
    if((from&&!Number.isFinite(from.getTime()))||(to&&!Number.isFinite(to.getTime()))||(from&&to&&from>to))return jsonError(res,400,'Interval kohor i pavlefshëm.');
    const args=[req.user.id];let where='user_id=?';if(from){where+=' AND datetime(created_at)>=datetime(?)';args.push(from.toISOString());}if(to){where+=' AND datetime(created_at)<datetime(?)';args.push(to.toISOString());}
    const summary=get("SELECT COUNT(*) tickets,COALESCE(SUM(CASE WHEN status IN ('accepted','won','lost','void') THEN stake ELSE 0 END),0) turnover,COALESCE(SUM(CASE WHEN status IN ('won','lost','void') THEN payout ELSE 0 END),0) payout,COALESCE(SUM(CASE WHEN status='pending' THEN stake ELSE 0 END),0) pendingStake,COALESCE(SUM(CASE WHEN status='accepted' THEN stake ELSE 0 END),0) unsettledStake FROM bets WHERE "+where,args);
    const u=get('SELECT * FROM users WHERE id=?',[req.user.id]);res.json({username:u.username,balance:Number(u.balance),reservedBalance:Number(u.reserved_balance||0),summary:{...summary,difference:money(Number(summary.turnover)-Number(summary.payout))},transactions:all('SELECT id,type,amount,balance_after AS balanceAfter,bet_id AS betId,created_at AS createdAt FROM wallet_transactions WHERE '+where+' ORDER BY id DESC LIMIT 200',args)});
  }catch(e){jsonError(res,500,'Financat nuk mund të ngarkohen.');}});
  app.get('/api/wallet',auth,(req,res)=>{const rows=all(`SELECT id,type,amount,balance_after AS balanceAfter,bet_id AS betId,note,created_at AS createdAt FROM wallet_transactions WHERE user_id=? ORDER BY datetime(created_at) DESC,id DESC LIMIT 300`,[req.user.id]);res.json({transactions:rows.map(x=>({...x,id:Number(x.id),amount:Number(x.amount),balanceAfter:Number(x.balanceAfter),betId:x.betId?Number(x.betId):null}))})});
  app.get('/api/my-bets',auth,(req,res)=>{
    const allowed=['pending','accepted','won','lost','cancelled','void','rejected'];
    let ids=[req.user.id];
    if(req.user.role!=='user'){
      if(req.user.role==='center') ids=all("SELECT id FROM users WHERE id<>?",[req.user.id]).map(x=>Number(x.id));
      else if(req.user.role==='operator'){
        ids=all(`WITH RECURSIVE roots(id) AS (SELECT id FROM users WHERE role='admin'), descendants(id) AS (SELECT id FROM roots UNION ALL SELECT u.id FROM users u JOIN descendants d ON u.parent_id=d.id) SELECT id FROM descendants`).map(x=>Number(x.id));
      } else ids=all(`WITH RECURSIVE descendants(id) AS (SELECT id FROM users WHERE parent_id=? UNION ALL SELECT u.id FROM users u JOIN descendants d ON u.parent_id=d.id) SELECT id FROM descendants`,[req.user.id]).map(x=>Number(x.id));
      if(!ids.length) return res.json({bets:[],accounts:[]});
    }
    const placeholders=ids.map(()=>'?').join(',');
    let sql=`SELECT b.*,u.username FROM bets b JOIN users u ON u.id=b.user_id WHERE b.user_id IN (${placeholders})`;
    const args=[...ids];
    if(req.query.userId!==undefined){const selectedId=Number(req.query.userId);if(!Number.isInteger(selectedId)||!ids.includes(selectedId))return jsonError(res,403,'User outside your scope.');sql+=' AND b.user_id=?';args.push(selectedId);}
    if(req.query.status==='unsettled'){sql+=" AND b.status IN ('pending','accepted')";}else if(allowed.includes(req.query.status)){sql+=' AND b.status=?';args.push(req.query.status)}
    for(const key of ['fromTime','toTime']){
      if(req.query[key]!==undefined&&(typeof req.query[key]!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(req.query[key])||!Number.isFinite(Date.parse(req.query[key]))))return jsonError(res,400,'Invalid date range.');
    }
    if(req.query.fromTime){sql+=' AND julianday(b.created_at)>=julianday(?)';args.push(req.query.fromTime)}
    else if(/^\d{4}-\d{2}-\d{2}$/.test(req.query.from||'')){sql+=' AND date(b.created_at)>=date(?)';args.push(req.query.from)}
    if(req.query.toTime){sql+=' AND julianday(b.created_at)<julianday(?)';args.push(req.query.toTime)}
    else if(/^\d{4}-\d{2}-\d{2}$/.test(req.query.to||'')){sql+=' AND date(b.created_at)<=date(?)';args.push(req.query.to)}
    const paginated=req.query.paginated==='1';
    if(paginated&&/^\d+$/.test(String(req.query.before||''))){sql+=' AND b.id<?';args.push(Number(req.query.before));}
    sql+=paginated?' ORDER BY b.id DESC LIMIT 101':' ORDER BY datetime(b.created_at) DESC,b.id DESC LIMIT 500';
    const bets=all(sql,args).map(b=>({...b,id:Number(b.id),user_id:Number(b.user_id),stake:Number(b.stake),total_odds:Number(b.total_odds),potential_win:Number(b.potential_win),payout:Number(b.payout),reserved:Number(b.reserved),selections:all('SELECT game_id AS gameId,coef_id AS coefId,market_id AS marketId,league,home_team AS home,away_team AS away,market,selection,odd,event_time AS eventTime,result_status AS resultStatus,special_value AS specialValue,game_api_id AS gameApiId FROM bet_selections WHERE bet_id=? ORDER BY id',[b.id]).map(x=>({...x,odd:Number(x.odd)}))}));
    const accounts=req.user.role==='user'?[]:all(`SELECT u.id,u.username,u.role,u.balance,u.status,COUNT(b.id) bet_count,COALESCE(SUM(CASE WHEN b.status NOT IN ('cancelled','rejected') THEN b.stake ELSE 0 END),0) turnover FROM users u LEFT JOIN bets b ON b.user_id=u.id WHERE u.id IN (${placeholders}) GROUP BY u.id ORDER BY u.id`,ids).map(x=>({...x,id:Number(x.id),balance:Number(x.balance||0),bet_count:Number(x.bet_count||0),turnover:Number(x.turnover||0)}));
    const hasMore=paginated&&bets.length>100;if(hasMore)bets.pop();
    res.json({bets,accounts,hasMore,nextCursor:hasMore?bets[bets.length-1].id:null});
  });
  app.get('/api/my-bets/:id',auth,(req,res)=>{const b=get('SELECT * FROM bets WHERE id=? AND user_id=?',[Number(req.params.id),req.user.id]);if(!b)return jsonError(res,404,'Bet not found.');b.id=Number(b.id);b.stake=Number(b.stake);b.total_odds=Number(b.total_odds);b.potential_win=Number(b.potential_win);b.payout=Number(b.payout);b.selections=all('SELECT * FROM bet_selections WHERE bet_id=? ORDER BY id',[b.id]).map(s=>({...s,id:Number(s.id),odd:Number(s.odd)}));const offer=get("SELECT * FROM bet_offers WHERE bet_id=? AND status='pending'",[b.id]);b.offer=offer?{id:Number(offer.id),offers:JSON.parse(offer.offers_json||'[]'),totalOdds:Number(offer.total_odds),potentialWin:Number(offer.potential_win),createdAt:offer.created_at}:null;res.json({bet:b})});
  app.post('/api/my-bets/:id/offer-response',auth,(req,res)=>{const accept=req.body.accept===true;try{const out=tx(()=>{const bet=get('SELECT * FROM bets WHERE id=? AND user_id=?',[Number(req.params.id),req.user.id]);if(!bet||bet.status!=='pending')throw Error('Bileta nuk është më në pritje.');const offer=get("SELECT * FROM bet_offers WHERE bet_id=? AND status='pending'",[bet.id]);if(!offer)throw Error('Nuk ka ofertë aktive.');const items=JSON.parse(offer.offers_json||'[]');if(accept){for(const item of items)run('UPDATE bet_selections SET odd=? WHERE id=? AND bet_id=?',[Number(item.odd),Number(item.id),bet.id]);run('UPDATE bets SET total_odds=?,potential_win=? WHERE id=?',[Number(offer.total_odds),Number(offer.potential_win),bet.id])}run("UPDATE bet_offers SET status=?,responded_at=? WHERE id=?",[accept?'accepted':'rejected',now(),offer.id]);run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[req.user.id,accept?'ticket_offer_accepted':'ticket_offer_rejected','bet',bet.id,JSON.stringify({offerId:offer.id})]);return{accepted:accept}});res.json({ok:true,...out})}catch(e){jsonError(res,400,e.message)}});

  app.post('/api/bets',auth,(req,res)=>{
    const requestKey=String(req.headers['idempotency-key']||'');
    if(!/^[a-zA-Z0-9_-]{8,128}$/.test(requestKey))return jsonError(res,400,'Idempotency-Key required.');
    const fingerprint='bet:'+crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
    const respond=out=>res.json({ok:true,betId:out.betId,totalOdds:out.odds,potentialWin:out.potential,status:out.status||'pending',balance:out.balance,reservedBalance:out.reservedBalance,availableBalance:money(out.balance-out.reservedBalance)});
    const replay=get('SELECT * FROM idempotency WHERE actor_id=? AND key=?',[req.user.id,requestKey]);
    if(replay){if(replay.fingerprint!==fingerprint)return jsonError(res,409,'Idempotency key already used.');return respond(JSON.parse(replay.response));}
    const stake=money(req.body.stake),selections=Array.isArray(req.body.selections)?req.body.selections:[];if(req.user.role!=='user')return jsonError(res,403,'Only player accounts can place bets.');if(!Number.isFinite(stake)||stake<.01)return jsonError(res,400,'Minimum stake is 0.01.');if(stake>100000)return jsonError(res,400,'Stake is too large.');if(!selections.length||selections.length>20)return jsonError(res,400,'Bet slip must contain 1-20 selections.');if(selections.some(s=>!s.gameId||String(s.selection||'').trim()===''))return jsonError(res,400,'Invalid selection.');
    const credit=get('SELECT balance,reserved_balance FROM users WHERE id=?',[req.user.id]);
    const availableCredit=money(Number(credit.balance)-Number(credit.reserved_balance));
    if(availableCredit<stake)return jsonError(res,400,'Kredi e pamjaftueshme. Krediti i disponueshëm: '+availableCredit.toFixed(2)+' €.',{code:'INSUFFICIENT_CREDIT',availableBalance:availableCredit});
    validateSelections(selections).then(check=>{if(check.invalid.length)return res.status(409).json({error:'Një ose më shumë koeficientë nuk janë më aktivë.',invalidSelections:check.invalid,oddsChanged:check.changed});if(check.changed.length)return res.status(409).json({error:'Koeficientët kanë ndryshuar.',oddsChanged:check.changed});try{const markets=new Set(check.current.map(s=>JSON.stringify([String(s.gameId),String(s.marketId||s.market),String(s.specialValue??'')])));if(markets.size!==check.current.length)return jsonError(res,400,'Only one selection per market and line is allowed.');const out=tx(()=>{
      if(!get('SELECT token FROM sessions WHERE token=? AND expires_at>?',[req.user.token,now()]))throw Error('Session revoked or expired.');
      const existing=get('SELECT * FROM idempotency WHERE actor_id=? AND key=?',[req.user.id,requestKey]);
      if(existing){if(existing.fingerprint!==fingerprint)throw Error('Idempotency key already used.');return JSON.parse(existing.response);}
      const u=get('SELECT id,balance,reserved_balance,status,parent_id FROM users WHERE id=?',[req.user.id]);if(!u||u.status!=='active')throw Error('Account is not active.');const available=money(Number(u.balance)-Number(u.reserved_balance||0));if(available<stake)throw Error('Kredi e pamjaftueshme. Krediti i disponueshëm: '+available.toFixed(2)+' €.');const totalOdds=check.current.reduce((a,s)=>a*Number(s.odd),1);if(!Number.isFinite(totalOdds)||totalOdds<=1||totalOdds>1000000)throw Error('Invalid combined odds.');const odds=money(totalOdds),potential=money(stake*odds);access.checkBet(u.id,stake,potential,null,check.current);let agentId=null,superId=null;if(u.parent_id){const ag=get('SELECT id,parent_id,role FROM users WHERE id=?',[u.parent_id]);if(ag&&ag.role==='agent'){agentId=Number(ag.id);const sm=get('SELECT id,parent_id,role FROM users WHERE id=?',[ag.parent_id]);if(sm&&sm.role==='supermanager')superId=Number(sm.id)}}run('INSERT INTO bets(user_id,agent_id,supermanager_id,stake,total_odds,potential_win,status,payout,reserved) VALUES(?,?,?,?,?,?,?,?,?)',[req.user.id,agentId,superId,stake,odds,potential,'pending',0,stake]);const createdBetId=lastId();for(const ancestor of access.lineage(u.id)){const col={partner:'partner_id',admin:'administrator_id',senior:'senior_id',supermanager:'senior_id',manager:'manager_id'}[ancestor.role];if(col)run('UPDATE bets SET '+col+'=? WHERE id=?',[ancestor.id,createdBetId]);}for(const sel of check.current)run('INSERT INTO bet_selections(bet_id,game_id,coef_id,market_id,league,home_team,away_team,market,selection,odd,event_time,result_status,special_value,game_api_id,league_id,sport_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[createdBetId,String(sel.gameId),sel.coefId,sel.marketId,sel.league||sel.game?.league||'',sel.home||sel.game?.home_team||'',sel.away||sel.game?.away_team||'',sel.market||'Fulltime Result',String(sel.selection),Number(sel.odd),sel.eventTime||sel.game?.game_time||sel.game?.game_date||'','pending',sel.specialValue||sel.special_value||'',sel.gameApiId||sel.game?.game_api_id||sel.game?.api_id||'',sel.league_id,sel.sport_id??null]);run('UPDATE users SET reserved_balance=reserved_balance+? WHERE id=?',[stake,req.user.id]);run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[req.user.id,'ticket_created','bet',createdBetId,JSON.stringify({stake,odds})]);for(const sel of check.current)run('UPDATE bet_selections SET acceptance_type=? WHERE bet_id=? AND game_id=? AND coef_id=?',[sel.acceptanceType||'unknown',createdBetId,String(sel.gameId),sel.coefId]);const automatic=ticketAcceptance.apply(createdBetId,check.current);const result={betId:createdBetId,odds,potential,status:'pending',balance:Number(u.balance),reservedBalance:money(Number(u.reserved_balance)+stake),...automatic};run('INSERT INTO idempotency(actor_id,key,fingerprint,response) VALUES(?,?,?,?)',[req.user.id,requestKey,fingerprint,JSON.stringify(result)]);return result;});res.json({ok:true,betId:out.betId,totalOdds:out.odds,potentialWin:out.potential,status:out.status||'pending',balance:out.balance,reservedBalance:out.reservedBalance,availableBalance:money(out.balance-out.reservedBalance)})}catch(e){jsonError(res,400,e.message,e.code==='BET_LIMIT_EXCEEDED'?{code:e.code,limitAmount:e.limitAmount,limitKind:e.limitKind}:{})}}).catch(e=>jsonError(res,502,'Could not validate live odds right now.'));});

  app.get('/api/center/stats',centerAuth,(req,res)=>res.json({partners:Number(get("SELECT COUNT(*) n FROM users WHERE role='partner'").n),admins:Number(get("SELECT COUNT(*) n FROM users WHERE role='admin'").n),users:Number(get("SELECT COUNT(*) n FROM users WHERE role='user'").n),activeUsers:Number(get("SELECT COUNT(*) n FROM users WHERE role='user' AND status='active'").n),seniors:Number(get("SELECT COUNT(*) n FROM users WHERE role IN ('senior','supermanager')").n),managers:Number(get("SELECT COUNT(*) n FROM users WHERE role='manager'").n),supermanagers:Number(get("SELECT COUNT(*) n FROM users WHERE role='supermanager'").n),agents:Number(get("SELECT COUNT(*) n FROM users WHERE role='agent'").n),operators:Number(get("SELECT COUNT(*) n FROM users WHERE role='operator'").n),pendingBets:Number(get("SELECT COUNT(*) n FROM bets WHERE status='pending'").n),acceptedBets:Number(get("SELECT COUNT(*) n FROM bets WHERE status='accepted'").n),totalBets:Number(get('SELECT COUNT(*) n FROM bets').n),turnover:Number(get("SELECT COALESCE(SUM(stake),0) n FROM bets WHERE status NOT IN ('rejected','cancelled')").n),pendingStake:Number(get("SELECT COALESCE(SUM(stake),0) n FROM bets WHERE status='pending'").n)}));
  app.post('/api/staff/password',auth,(req,res)=>{
    const oldPassword=String(req.body.oldPassword||''), newPassword=String(req.body.newPassword||'');
    const u=get('SELECT * FROM users WHERE id=?',[req.user.id]);
    if(!u||!verifyPassword(oldPassword,u.password_hash)) return jsonError(res,400,'Password i vjetër nuk është i saktë.');
    if(newPassword.length<6) return jsonError(res,400,'Password duhet të ketë të paktën 6 karaktere.');
    tx(()=>{run('UPDATE users SET password_hash=? WHERE id=?',[hashPassword(newPassword),u.id]);run('DELETE FROM sessions WHERE user_id=? AND token<>?',[u.id,req.user.token]);access.audit(req,'password_changed',u.id,null,{revokedOtherSessions:true});});res.json({ok:true});
  });
  function serializeBet(b){return {...b,id:Number(b.id),user_id:Number(b.user_id),stake:Number(b.stake),total_odds:Number(b.total_odds),potential_win:Number(b.potential_win),payout:Number(b.payout),reserved:Number(b.reserved),selections:all('SELECT id,acceptance_type AS acceptanceType,game_id AS gameId,coef_id AS coefId,market_id AS marketId,league,home_team AS home,away_team AS away,market,selection,odd,event_time AS eventTime,result_status AS resultStatus,special_value AS specialValue,game_api_id AS gameApiId FROM bet_selections WHERE bet_id=? ORDER BY id',[b.id]).map(s=>({...s,id:Number(s.id),odd:Number(s.odd)}))}};
  // Operator center: tickets stay pending until an operator accepts them. Acceptance performs a fresh credit check.
  app.get('/api/operator/tickets',operatorAuth,(req,res)=>{if(!hasPermission(req.user,'bets.view'))return jsonError(res,403,'Permission denied.');const status=['pending','accepted','won','lost','cancelled','rejected'].includes(req.query.status)?req.query.status:null;let sql=`SELECT b.*,u.username,ag.username agent_username,sm.username supermanager_username FROM bets b JOIN users u ON u.id=b.user_id LEFT JOIN users ag ON ag.id=b.agent_id LEFT JOIN users sm ON sm.id=b.supermanager_id WHERE 1=1`;const a=[];if(status){sql+=' AND b.status=?';a.push(status)}else sql+=" AND b.status IN ('pending','accepted')";sql+=' ORDER BY datetime(b.created_at) ASC,b.id ASC LIMIT 500';const tickets=all(sql,a),repeats=require('./ticket-repeats').loadTicketRepeats(tickets,all);res.json({tickets:tickets.map(b=>({...serializeBet(b),repeatCount:repeats.get(Number(b.id))||1,offer:get('SELECT status,total_odds,potential_win FROM bet_offers WHERE bet_id=?',[b.id])||null}))})});
  app.post('/api/operator/tickets/:id/offer',operatorAuth,(req,res)=>{
    if(!hasPermission(req.user,'bets.offer_odds'))return jsonError(res,403,'Permission denied.');
    try{
      const offers=Array.isArray(req.body.offers)?req.body.offers:[];
      const out=tx(()=>{
        const bet=get('SELECT * FROM bets WHERE id=?',[Number(req.params.id)]);
        if(!bet)throw Error('Ticket not found.');if(bet.status!=='pending')throw Error('Oferta mund të bëhet vetëm për biletë në pritje.');
        const selections=all('SELECT id,odd FROM bet_selections WHERE bet_id=? ORDER BY id',[bet.id]);
        if(!offers.length)throw Error('Nuk ka koeficientë për ofertë.');
        const normalized=[];
        for(const offer of offers){const sel=selections.find(s=>Number(s.id)===Number(offer.id)),odd=money(offer.odd);if(!sel||!Number.isFinite(odd)||odd<1.01)throw Error('Koeficient i pavlefshëm.');if(odd>Number(sel.odd))throw Error('Oferta mund vetëm ta ulë koeficientin.');normalized.push({id:Number(sel.id),odd});}
        const total=money(selections.reduce((n,s)=>n*Number(normalized.find(o=>o.id===Number(s.id))?.odd??s.odd),1));if(total<=1)throw Error('Totali i koeficientëve duhet të jetë mbi 1.');
        const potential=money(Number(bet.stake)*total);
        run("INSERT INTO bet_offers(bet_id,offered_by,offers_json,total_odds,potential_win,status,created_at,responded_at) VALUES(?,?,?,?,?,'pending',?,NULL) ON CONFLICT(bet_id) DO UPDATE SET offered_by=excluded.offered_by,offers_json=excluded.offers_json,total_odds=excluded.total_odds,potential_win=excluded.potential_win,status='pending',created_at=excluded.created_at,responded_at=NULL",[bet.id,req.user.id,JSON.stringify(normalized),total,potential,now()]);
        run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[req.user.id,'ticket_odds_offer','bet',bet.id,JSON.stringify({offers:normalized,total,potential})]);
        return {betId:Number(bet.id),userId:Number(bet.user_id),offers:normalized,totalOdds:total,potentialWin:potential};
      });
      notifyUser(out.userId,'ticket-offer',{betId:out.betId,offers:out.offers,totalOdds:out.totalOdds,potentialWin:out.potentialWin});
      res.json({ok:true,totalOdds:out.totalOdds,potentialWin:out.potentialWin});
    }catch(e){jsonError(res,400,e.message)}
  });
  app.post('/api/operator/tickets/:id/accept',operatorAuth,(req,res)=>{try{const out=tx(()=>{const b=get('SELECT * FROM bets WHERE id=?',[Number(req.params.id)]);if(!b)throw Error('Ticket not found.');if(b.status!=='pending')throw Error('Ticket is no longer pending.');access.checkBet(b.user_id,Number(b.stake),Number(b.potential_win),b.id);const u=get('SELECT id,balance,reserved_balance,status FROM users WHERE id=?',[b.user_id]);if(!u||u.status!=='active')throw Error('User account is not active.');if(Number(u.reserved_balance)<Number(b.stake))throw Error('Reserved credit is missing.');if(Number(u.balance)<Number(u.reserved_balance))throw Error('Insufficient credit at acceptance.');const balance=money(Number(u.balance)-Number(b.stake));const reserved=money(Number(u.reserved_balance)-Number(b.stake));run('UPDATE users SET balance=?,reserved_balance=? WHERE id=?',[balance,reserved,u.id]);run('UPDATE bets SET status=\'accepted\',reserved=0,accepted_by=?,accepted_at=? WHERE id=?',[req.user.id,now(),b.id]);run('INSERT INTO wallet_transactions(user_id,type,amount,balance_after,bet_id,note) VALUES(?,?,?,?,?,?)',[u.id,'bet',-Number(b.stake),balance,b.id,'Ticket accepted by operator']);run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[req.user.id,'ticket_accepted','bet',b.id,JSON.stringify({balance})]);return{balance,reservedBalance:reserved}});res.json({ok:true,status:'accepted',...out})}catch(e){jsonError(res,400,e.message)}});
  app.post('/api/operator/tickets/:id/cancel',operatorAuth,(req,res)=>{try{const out=tx(()=>{const b=get('SELECT * FROM bets WHERE id=?',[Number(req.params.id)]);if(!b)throw Error('Ticket not found.');if(!['pending','accepted'].includes(b.status))throw Error('Ticket cannot be cancelled now.');const u=get('SELECT id,balance,reserved_balance FROM users WHERE id=?',[b.user_id]);let balance=Number(u.balance),reserved=Number(u.reserved_balance||0);if(b.status==='pending'){reserved=money(reserved-Number(b.stake));run('UPDATE users SET reserved_balance=? WHERE id=?',[reserved,u.id])}else{balance=money(balance+Number(b.stake));run('UPDATE users SET balance=? WHERE id=?',[balance,u.id]);run('INSERT INTO wallet_transactions(user_id,type,amount,balance_after,bet_id,note) VALUES(?,?,?,?,?,?)',[u.id,'refund',Number(b.stake),balance,b.id,'Ticket cancelled by operator'])}run('UPDATE bets SET status=\'cancelled\',payout=?,reserved=0,cancelled_by=?,cancelled_at=?,settled_at=? WHERE id=?',[b.status==='accepted'?Number(b.stake):0,req.user.id,now(),now(),b.id]);run('UPDATE bet_selections SET result_status=\'cancelled\' WHERE bet_id=?',[b.id]);run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[req.user.id,'ticket_cancelled','bet',b.id,JSON.stringify({previousStatus:b.status})]);return{balance,reservedBalance:reserved}});res.json({ok:true,status:'cancelled',...out})}catch(e){jsonError(res,400,e.message)}});
  app.post('/api/operator/tickets/:id/settle',operatorAuth,(req,res)=>{const status=req.body.status==='won'?'won':req.body.status==='lost'?'lost':null;if(!status)return jsonError(res,400,'Invalid settlement status.');try{const out=tx(()=>{const b=get('SELECT * FROM bets WHERE id=?',[Number(req.params.id)]);if(!b)throw Error('Ticket not found.');if(b.status!=='accepted'&&!(req.user.role==='center'&&['won','lost'].includes(b.status)))throw Error('Only accepted tickets can be settled; final status corrections require Center.');const u=get('SELECT id,balance FROM users WHERE id=?',[b.user_id]);const payout=status==='won'?money(Number(b.potential_win)):0;const adjustment=money(payout-Number(b.payout||0));const balance=money(Number(u.balance)+adjustment);run('UPDATE bets SET status=?,payout=?,settled_at=? WHERE id=?',[status,payout,now(),b.id]);if(status==='won')run("UPDATE bet_selections SET result_status='won' WHERE bet_id=? AND result_status='pending'",[b.id]);if(adjustment!==0){run('UPDATE users SET balance=? WHERE id=?',[balance,u.id]);run('INSERT INTO wallet_transactions(user_id,type,amount,balance_after,bet_id,note) VALUES(?,?,?,?,?,?)',[u.id,adjustment>0?'payout':'adjustment',adjustment,balance,b.id,b.status==='accepted'?'Winning ticket payout':'Center settlement correction'])}run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[req.user.id,'ticket_settled','bet',b.id,JSON.stringify({previousStatus:b.status,previousPayout:Number(b.payout||0),status,payout,adjustment})]);return{payout,balance}});res.json({ok:true,status,...out})}catch(e){jsonError(res,400,e.message)}});
  app.post('/api/admin/bets/:id/settle',centerAuth,(req,res)=>{req.body.status=req.body.status==='void'?'cancelled':req.body.status;const old=req.headers.authorization; // keep backward-compatible admin settlement through operator endpoint logic
    req.url='/api/operator/tickets/'+req.params.id+'/settle'; if(req.body.status==='cancelled')return res.redirect(307,req.url); return res.redirect(307,req.url); });
  // API requests must never fall through to Express's HTML 404/error pages.
  app.use('/api',(req,res)=>jsonError(res,404,'Shërbimi i kërkuar nuk u gjet.',{code:'API_NOT_FOUND'}));
  app.use((err,req,res,next)=>{
    if(!/^\/api(?:\/|$)/.test(req.path))return next(err);
    if(res.headersSent)return next(err);
    const status=err.type==='entity.parse.failed'?400:err.type==='entity.too.large'?413:500;
    if(status===500)console.error('API failure:',req.method,req.path,err.message);
    jsonError(res,status,status===400?'Kërkesa përmban JSON të pavlefshëm.':status===413?'Kërkesa është shumë e madhe.':'Shërbimi nuk mund ta përpunojë kërkesën. Provoni përsëri.',{code:status===500?'API_ERROR':'INVALID_REQUEST'});
  });
  app.listen(PORT,()=>{console.log(`SPORTSBOOK PRO: http://localhost:${PORT}`);if(process.env.DISABLE_UPSTREAM!=='true'){connectUpstream();startSettlementEngine()}});
}
start().catch(e=>{console.error(e);process.exit(1)});
