'use strict';
// Every element (event, market, tournament, tournament group, centre group) has one of four
// statuses. hold: tickets wait for an operator; blocked: shown with locked odds; closed: hidden.
const STATUSES=['active','hold','blocked','closed'];
const RANK={active:0,hold:1,blocked:2,closed:3};
const worst=(...list)=>list.reduce((a,b)=>RANK[b||'active']>RANK[a]?b:a,'active');
// Live and prematch use different market ids for the same market, so markets are keyed by name.
const marketKey=name=>String(name||'').trim().replace(/\s+/g,' ').toLowerCase().slice(0,120);
const statusOf=r=>STATUSES.includes(r?.status)?r.status:r?.blocked?'blocked':'active';
const KINDS=['custom-group','group','tournament','event','market','event-market'];
function validateRule(body){
  const status=body.status!==undefined?body.status:typeof body.blocked==='boolean'?(body.blocked?'blocked':'active'):undefined;
  if(!STATUSES.includes(status))throw Error('Status i pavlefshëm.');
  const out={status,blocked:RANK[status]>=RANK.blocked};
  for(const k of ['maxStake','maxPayout']){const n=body[k]??null;if(n!==null&&(typeof n!=='number'||!Number.isFinite(n)||n<0||n>100000000))throw Error('Limit i pavlefshëm.');out[k]=n;}
  const total=body.maxUserTotal??null;if(total!==null&&(typeof total!=='number'||!Number.isFinite(total)||total<0||total>100000000))throw Error('Limit total i pavlefshëm.');out.maxUserTotal=total;
  return out;
}
function enforce(rules,stake,payout){for(const r of rules){const status=statusOf(r);if(status==='closed')throw Error(r.name+' nuk ofrohet më për baste.');if(status==='blocked')throw Error('Bastet janë bllokuar për '+r.name+'.');if(r.max_stake!==null&&r.max_stake!==undefined&&stake>r.max_stake)throw Error('Basti tejkalon limitin për '+r.name+'.');if(r.max_payout!==null&&r.max_payout!==undefined&&payout>r.max_payout)throw Error('Fitimi tejkalon limitin për '+r.name+'.');}}
function create({run,get,all,tx,now,proxy}){
 run('CREATE TABLE IF NOT EXISTS competition_nodes(kind TEXT,id TEXT,parent_id TEXT,name TEXT NOT NULL,PRIMARY KEY(kind,id))');
 run('CREATE TABLE IF NOT EXISTS competition_rules(kind TEXT,id TEXT,blocked INTEGER NOT NULL,max_stake REAL,max_payout REAL,updated_at TEXT,updated_by INTEGER,PRIMARY KEY(kind,id))');
 if(!all('PRAGMA table_info(competition_rules)').some(c=>c.name==='max_user_total'))run('ALTER TABLE competition_rules ADD COLUMN max_user_total REAL');
 if(!all('PRAGMA table_info(competition_rules)').some(c=>c.name==='status')){run('ALTER TABLE competition_rules ADD COLUMN status TEXT');run("UPDATE competition_rules SET status=CASE WHEN blocked=1 THEN 'blocked' ELSE 'active' END");}
 run('CREATE TABLE IF NOT EXISTS competition_group_members(group_id TEXT,tournament_id TEXT,PRIMARY KEY(group_id,tournament_id))');
 // The same rules for one user group only; they apply on top of the network-wide rules.
 run('CREATE TABLE IF NOT EXISTS user_group_competition_rules(group_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,max_stake REAL,max_payout REAL,max_user_total REAL,updated_at TEXT,updated_by INTEGER,PRIMARY KEY(group_id,kind,id))');
 let cache=null;const knownMarkets=new Set(all("SELECT id FROM competition_nodes WHERE kind='market'").map(r=>r.id)),coefMarkets=new Map();
 const put=(kind,id,parent,name)=>{if(id!=null&&String(id)){run("INSERT INTO competition_nodes VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET parent_id=COALESCE(excluded.parent_id,competition_nodes.parent_id),name=COALESCE(NULLIF(excluded.name,''),competition_nodes.name)",[kind,String(id),parent==null?null:String(parent),String(name||'')]);if(kind==='tournament'&&cache?.group.has(String(parent)))cache=null;}};
 function rememberMarket(name){const key=marketKey(name);if(key&&!knownMarkets.has(key)){knownMarkets.add(key);put('market',key,null,String(name).trim().slice(0,120));}return key;}
 function remember(games){for(const g of games){const league=g.league_id,group=g.tournament_group_id??g.country_id;put('group',group,g.sport_id,g.tournament_group??g.country);put('tournament',league,group,g.league);put('event',g.id??g.game_id,league,(g.home_team||g.home||'')+' — '+(g.away_team||g.away||''));}}
 // Stake a player already has inside a competition scope; a ticket counts once however many
 // of its selections fall in the scope. Cancelled, rejected and void tickets do not count.
 const LEAGUE_OF='COALESCE(s.league_id,e.parent_id,l.league_id)';
 const scopes={
  tournament:id=>[`${LEAGUE_OF}=?`,[id]],
  group:id=>[`${LEAGUE_OF} IN (SELECT t.id FROM competition_nodes t WHERE t.kind='tournament' AND t.parent_id=?)`,[id]],
  'custom-group':id=>[`${LEAGUE_OF} IN (SELECT tournament_id FROM competition_group_members WHERE group_id=?)`,[id]]
 };
 function enforceUserTotal(r,stake,userId,excludeBet){
  if(r.max_user_total==null||!scopes[r.kind])return;
  const [where,args]=scopes[r.kind](r.id);
  const used=Number(get(`SELECT COALESCE(SUM(b.stake),0) total FROM bets b WHERE b.user_id=? AND b.id<>? AND b.status NOT IN ('cancelled','rejected','void') AND EXISTS (SELECT 1 FROM bet_selections s LEFT JOIN competition_nodes e ON e.kind='event' AND e.id=s.game_id LEFT JOIN risk_event_leagues l ON l.event_id=s.game_id WHERE s.bet_id=b.id AND ${where})`,[userId,excludeBet??-1,...args]).total);
  if(Math.round((used+stake)*100)>Math.round(Number(r.max_user_total)*100))throw Error('Limiti total për përdoruesin në '+r.name+' është '+Number(r.max_user_total).toFixed(2)+' €. Janë luajtur '+used.toFixed(2)+' €.');
 }
 // The elements a selection belongs to, from the event up to its groups, plus its market.
 function elements(p){
  const event=String(p.game_id??p.gameId),out=[['event',event]];
  const league=get("SELECT parent_id FROM competition_nodes WHERE kind='event' AND id=?",[event])?.parent_id||(p.league_id!=null&&p.league_id!==''?String(p.league_id):null);
  if(league){
   out.push(['tournament',league]);
   const group=get("SELECT parent_id FROM competition_nodes WHERE kind='tournament' AND id=?",[league])?.parent_id;if(group)out.push(['group',group]);
   for(const m of all('SELECT group_id FROM competition_group_members WHERE tournament_id=?',[league]))out.push(['custom-group',m.group_id]);
  }
  const market=marketKey(p.market);if(market)out.push(['market',market],['event-market',event+'|'+market]);
  return out;
 }
 function rulesFor(p,groups=[]){
  const rules=[];
  for(const [kind,id] of elements(p)){
   const r=get('SELECT r.*,n.name FROM competition_rules r LEFT JOIN competition_nodes n ON n.kind=r.kind AND n.id=r.id WHERE r.kind=? AND r.id=?',[kind,id]);if(r)rules.push({...r,name:r.name||id});
   for(const g of groups){const gr=get('SELECT r.*,n.name FROM user_group_competition_rules r LEFT JOIN competition_nodes n ON n.kind=r.kind AND n.id=r.id WHERE r.group_id=? AND r.kind=? AND r.id=?',[g,kind,id]);if(gr)rules.push({...gr,name:gr.name||id});}
  }
  return rules;
 }
 // Throws for closed/blocked elements and broken limits. Returns the names of elements on
 // hold, whose tickets must wait for an operator.
 function check(picks,stake,payout,userId,excludeBet=null,{groups=[]}={}){
  const hold=[];
  if(!get('SELECT id FROM competition_rules LIMIT 1')&&!(groups.length&&get(`SELECT id FROM user_group_competition_rules WHERE group_id IN (${groups.map(()=>'?').join(',')}) LIMIT 1`,groups)))return {hold};
  for(const p of picks){
   const rules=rulesFor(p,groups);
   enforce(rules,stake,payout);
   for(const r of rules){enforceUserTotal(r,stake,userId,excludeBet);if(statusOf(r)==='hold'&&!hold.includes(r.name))hold.push(r.name);}
  }
  return {hold};
 }
 // Network-wide closed/blocked elements, kept in memory for filtering the player feeds.
 function policy(){
  if(cache)return cache;
  const p={any:false,event:new Map(),tournament:new Map(),group:new Map(),market:new Map(),eventMarket:new Map()};
  const raise=(map,key,status)=>{if(RANK[status]>RANK[map.get(String(key))||'active'])map.set(String(key),status);};
  for(const r of all('SELECT * FROM competition_rules')){
   const status=statusOf(r);if(RANK[status]<RANK.blocked)continue;p.any=true;
   if(r.kind==='event')raise(p.event,r.id,status);
   else if(r.kind==='tournament')raise(p.tournament,r.id,status);
   else if(r.kind==='group'){raise(p.group,r.id,status);for(const t of all("SELECT id FROM competition_nodes WHERE kind='tournament' AND parent_id=?",[r.id]))raise(p.tournament,t.id,status);}
   else if(r.kind==='custom-group')for(const t of all('SELECT tournament_id id FROM competition_group_members WHERE group_id=?',[r.id]))raise(p.tournament,t.id,status);
   else if(r.kind==='market')raise(p.market,r.id,status);
   else if(r.kind==='event-market')raise(p.eventMarket,r.id,status);
  }
  return cache=p;
 }
 const leagueOf=id=>get("SELECT parent_id FROM competition_nodes WHERE kind='event' AND id=?",[String(id)])?.parent_id||(()=>{try{return get('SELECT league_id FROM risk_event_leagues WHERE event_id=?',[String(id)])?.league_id;}catch(_){return null;}})();
 const gameStatus=(p,id,league)=>worst(p.event.get(String(id)),league!=null?p.tournament.get(String(league)):undefined);
 const marketStatus=(p,event,key)=>worst(p.market.get(key),p.eventMarket.get(String(event)+'|'+key));
 const noteCoef=(coef,key)=>{if(coef==null||!key)return;if(coefMarkets.size>=50000)coefMarkets.delete(coefMarkets.keys().next().value);coefMarkets.set(String(coef),key);};
 // "coefId|odd|selection|marketId|market" parts of a game row.
 function oddString(p,text,event,base){
  return String(text).split(',').map(part=>{const f=part.split('|');const key=f.length>=5?marketKey(f[4]):'';noteCoef(f[0],key);const status=worst(base,key?marketStatus(p,event,key):undefined);if(status==='closed')return null;if(status==='blocked'&&f.length>=2)f[1]='-';return f.join('|');}).filter(x=>x!==null).join(',');
 }
 function games(rows,league){
  const p=policy();
  return rows.flatMap(g=>{
   if(!g||typeof g!=='object')return [g];
   const id=g.id??g.game_id,status=gameStatus(p,id,g.league_id??league);
   if(status==='closed')return [];
   return [typeof g.odd==='string'?{...g,odd:oddString(p,g.odd,id,status)}:g];
  });
 }
 // One game's market rows, possibly nested in arrays.
 function markets(rows,event){
  const p=policy(),base=gameStatus(p,event,leagueOf(event));
  if(base==='closed')return [];
  const walk=list=>list.flatMap(row=>{
   if(Array.isArray(row)){const inner=walk(row);return inner.length?[inner]:[];}
   if(!row||typeof row!=='object'||row.market==null)return [row];
   const key=rememberMarket(row.market);noteCoef(row.id,key);
   const status=worst(base,marketStatus(p,event,key));
   if(status==='closed')return [];
   return [status==='blocked'?{...row,odd:'-'}:row];
  });
  return walk(rows);
 }
 function catalog(kind,rows){
  const p=policy();if(!p.any)return rows;
  if(kind==='countries')return rows.filter(r=>p.group.get(String(r?.id))!=='closed');
  if(kind==='leagues')return rows.filter(r=>p.tournament.get(String(r?.id))!=='closed');
  return rows;
 }
 // Live socket price updates: {game_id,coefs:[{coef_id,odd}]}. null drops the message.
 function coefs(payload){
  const p=policy();if(!p.any||!payload||payload.game_id==null)return payload;
  const base=gameStatus(p,payload.game_id,leagueOf(payload.game_id));
  if(base==='closed')return null;
  const list=(payload.coefs||[]).flatMap(c=>{const key=coefMarkets.get(String(c?.coef_id));const status=worst(base,key?marketStatus(p,payload.game_id,key):undefined);if(status==='closed')return [];return [status==='blocked'?{...c,odd:'-'}:c];});
  return {...payload,coefs:list};
 }
 const groupExists=id=>{try{return !!get('SELECT id FROM user_groups WHERE id=?',[id]);}catch(_){return false;}};
 const ruleTable=groupId=>groupId?['SELECT r.*,n.name FROM user_group_competition_rules r LEFT JOIN competition_nodes n ON n.kind=r.kind AND n.id=r.id WHERE r.group_id=?',[groupId]]:['SELECT r.*,n.name FROM competition_rules r LEFT JOIN competition_nodes n ON n.kind=r.kind AND n.id=r.id WHERE 1=1',[]];
 function ruleOf(groupId,kind,id){const [sql,args]=ruleTable(groupId);const r=get(sql+' AND r.kind=? AND r.id=?',[...args,kind,id]);return r?{...r,status:statusOf(r)}:null;}
 function ruleList(groupId){const [sql,args]=ruleTable(groupId);return all(sql+' ORDER BY r.kind,n.name',args).map(r=>({...r,name:r.name||r.id,status:statusOf(r)}));}
 async function eventMarkets(event){
  const names=new Map();
  for(const path of ['/ajax/livegame/','/ajax/prematchgame/']){
   try{const feed=await proxy(path+encodeURIComponent(event));if(feed.status!==200)continue;const walk=list=>{for(const row of list){if(Array.isArray(row))walk(row);else if(row&&row.market!=null){const key=marketKey(row.market);if(key&&!names.has(key))names.set(key,String(row.market).trim());}}};const data=JSON.parse(feed.text);if(Array.isArray(data))walk(data);if(names.size)break;}catch(_){}
  }
  return [...names].map(([key,name])=>({key,name}));
 }
 function mount(app,auth){
  const scopeOf=req=>{const g=String(req.query.groupId||req.body?.groupId||'');if(g&&!groupExists(g))throw Error('Grupi i përdoruesve nuk ekziston.');return g;};
  app.post('/api/center/competition-groups',auth,(req,res)=>{try{const name=String(req.body.name||'').trim(),sport=String(req.body.sportId||''),ids=[...new Set(Array.isArray(req.body.tournamentIds)?req.body.tournamentIds.map(String):[])];if(!name||name.length>100||!ids.length||ids.length>500)throw Error('Vendos emrin dhe zgjidh të paktën një turnament.');if(!get("SELECT id FROM competition_nodes WHERE kind='sport' AND id=?",[sport]))throw Error('Sport i pavlefshëm.');for(const id of ids)if(!get("SELECT t.id FROM competition_nodes t JOIN competition_nodes c ON c.kind='group' AND c.id=t.parent_id WHERE t.kind='tournament' AND t.id=? AND c.parent_id=?",[id,sport]))throw Error('Turnamenti nuk i përket këtij sporti.');const id=require('crypto').randomUUID();tx(()=>{put('custom-group',id,sport,name);for(const tournament of ids)run('INSERT INTO competition_group_members VALUES(?,?)',[id,tournament]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_group_created','competition',JSON.stringify({id,name,sport,ids})]);});cache=null;res.json({ok:true,id});}catch(e){res.status(400).json({error:e.message});}});

  app.get('/api/center/competitions',auth,async(req,res)=>{try{const kind=String(req.query.kind||'sport'),parent=String(req.query.parent||''),groupId=scopeOf(req),rule=(k,id)=>ruleOf(groupId,k,id),rules=ruleList(groupId);
   if(kind==='market'){
    if(!parent)return res.json({items:all("SELECT * FROM competition_nodes WHERE kind='market' ORDER BY name").map(n=>({id:n.id,name:n.name,rule:rule('market',n.id)})),rules});
    if(!/^\d{1,12}$/.test(parent))return res.status(400).json({error:'Parametra të pavlefshëm.'});
    const list=await eventMarkets(parent);tx(()=>{for(const m of list){rememberMarket(m.name);put('event-market',parent+'|'+m.key,parent,m.name);}});
    return res.json({items:list.map(m=>({id:parent+'|'+m.key,name:m.name,market:m.key,rule:rule('event-market',parent+'|'+m.key),globalRule:rule('market',m.key)})),rules});
   }
   if(kind==='tournament'&&get("SELECT id FROM competition_nodes WHERE kind='custom-group' AND id=?",[parent])){return res.json({items:all("SELECT t.* FROM competition_group_members m JOIN competition_nodes t ON t.kind='tournament' AND t.id=m.tournament_id WHERE m.group_id=? ORDER BY t.name",[parent]).map(t=>({...t,rule:rule('tournament',t.id)})),rules});}
   if(!['sport','group','tournament','event'].includes(kind)||(kind!=='sport'&&!/^\d{1,12}$/.test(parent)))return res.status(400).json({error:'Parametra të pavlefshëm.'});const path={sport:'sports',group:'countries',tournament:'leagues',event:'gamesByLeague'}[kind];const feed=await proxy('/ajax/'+path+(kind==='sport'?'':'/'+parent));if(feed.status!==200)throw Error('API nuk është e disponueshme.');let rows=JSON.parse(feed.text);if(!Array.isArray(rows))throw Error('Përgjigje e pavlefshme nga API.');if(kind==='event'){try{const live=await proxy('/ajax/livegames?market_type=1');const games=JSON.parse(live.text);if(live.status===200&&Array.isArray(games)){const merged=new Map(rows.map(g=>[String(g.id??g.game_id),g]));for(const g of games)if(String(g.league_id)===parent)merged.set(String(g.id??g.game_id),g);rows=[...merged.values()];}}catch{}}tx(()=>{if(kind==='event')remember(rows.map(g=>({...g,league_id:parent})));for(const row of rows)put(kind,row.id??row.game_id,kind==='sport'?null:parent,kind==='event'?(row.home_team||row.home||'')+' — '+(row.away_team||row.away||''):row.name);});res.json({items:[...(kind==='group'?all("SELECT n.*, (SELECT COUNT(*) FROM competition_group_members m WHERE m.group_id=n.id) memberCount FROM competition_nodes n WHERE n.kind='custom-group' AND n.parent_id=? ORDER BY n.name",[parent]).map(n=>({...n,custom:true,rule:rule('custom-group',n.id)})):[]),...rows.map(row=>{const id=String(row.id??row.game_id);return {...row,id,name:get('SELECT name FROM competition_nodes WHERE kind=? AND id=?',[kind,id]).name,rule:rule(kind,id)};})],rules});}catch(e){res.status(e.message.includes('Grupi')?400:502).json({error:e.message});}});
  app.put('/api/center/competitions/:kind/:id',auth,async(req,res)=>{try{const {kind,id}=req.params,groupId=scopeOf(req);if(!KINDS.includes(kind)||!get('SELECT id FROM competition_nodes WHERE kind=? AND id=?',[kind,id]))throw Error('Zgjidh një element nga API.');const r=validateRule(req.body);let leagues=[];if(kind==='group'){const feed=await proxy('/ajax/leagues/'+encodeURIComponent(id));if(feed.status!==200)throw Error('API nuk lejon verifikimin e turnamenteve të grupit.');leagues=JSON.parse(feed.text);if(!Array.isArray(leagues))throw Error('Lista e turnamenteve është e pavlefshme.');}
   const total=['tournament','group','custom-group'].includes(kind)?r.maxUserTotal:null;
   tx(()=>{for(const l of leagues)put('tournament',l.id,id,l.name);
    if(groupId)run('INSERT INTO user_group_competition_rules(group_id,kind,id,status,max_stake,max_payout,max_user_total,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id,kind,id) DO UPDATE SET status=excluded.status,max_stake=excluded.max_stake,max_payout=excluded.max_payout,max_user_total=excluded.max_user_total,updated_at=excluded.updated_at,updated_by=excluded.updated_by',[groupId,kind,id,r.status,r.maxStake,r.maxPayout,total,now(),req.user.id]);
    else run('INSERT INTO competition_rules(kind,id,blocked,max_stake,max_payout,updated_at,updated_by,max_user_total,status) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET blocked=excluded.blocked,max_stake=excluded.max_stake,max_payout=excluded.max_payout,updated_at=excluded.updated_at,updated_by=excluded.updated_by,max_user_total=excluded.max_user_total,status=excluded.status',[kind,id,r.blocked?1:0,r.maxStake,r.maxPayout,now(),req.user.id,total,r.status]);
    run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_limit_updated','competition',JSON.stringify({kind,id,groupId:groupId||null,...r})]);});
   cache=null;res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
  app.delete('/api/center/competitions/:kind/:id',auth,(req,res)=>{try{const groupId=scopeOf(req);tx(()=>{if(groupId)run('DELETE FROM user_group_competition_rules WHERE group_id=? AND kind=? AND id=?',[groupId,req.params.kind,req.params.id]);else run('DELETE FROM competition_rules WHERE kind=? AND id=?',[req.params.kind,req.params.id]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_limit_removed','competition',JSON.stringify({...req.params,groupId:groupId||null})]);});cache=null;res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
 }
 return {mount,remember,check,filter:{games,markets,catalog,coefs},invalidate:()=>{cache=null;}};
}
module.exports={create,validateRule,enforce,marketKey,STATUSES};
