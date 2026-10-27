'use strict';
function validateRule(body){
  if(typeof body.blocked!=='boolean')throw Error('Status i pavlefshëm.');
  const out={blocked:body.blocked};
  for(const k of ['maxStake','maxPayout']){const n=body[k];if(n!==null&&(typeof n!=='number'||!Number.isFinite(n)||n<0||n>100000000))throw Error('Limit i pavlefshëm.');out[k]=n;}
  const total=body.maxUserTotal??null;if(total!==null&&(typeof total!=='number'||!Number.isFinite(total)||total<0||total>100000000))throw Error('Limit total i pavlefshëm.');out.maxUserTotal=total;
  return out;
}
function enforce(rules,stake,payout){for(const r of rules){if(r.blocked)throw Error('Bastet janë bllokuar për '+r.name+'.');if(r.max_stake!==null&&stake>r.max_stake)throw Error('Basti tejkalon limitin për '+r.name+'.');if(r.max_payout!==null&&payout>r.max_payout)throw Error('Fitimi tejkalon limitin për '+r.name+'.');}}
function create({run,get,all,tx,now,proxy}){
 run('CREATE TABLE IF NOT EXISTS competition_nodes(kind TEXT,id TEXT,parent_id TEXT,name TEXT NOT NULL,PRIMARY KEY(kind,id))');
 run('CREATE TABLE IF NOT EXISTS competition_rules(kind TEXT,id TEXT,blocked INTEGER NOT NULL,max_stake REAL,max_payout REAL,updated_at TEXT,updated_by INTEGER,PRIMARY KEY(kind,id))');
 if(!all('PRAGMA table_info(competition_rules)').some(c=>c.name==='max_user_total'))run('ALTER TABLE competition_rules ADD COLUMN max_user_total REAL');
 run('CREATE TABLE IF NOT EXISTS competition_group_members(group_id TEXT,tournament_id TEXT,PRIMARY KEY(group_id,tournament_id))');
 const put=(kind,id,parent,name)=>{if(id!=null&&String(id))run("INSERT INTO competition_nodes VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET parent_id=COALESCE(excluded.parent_id,competition_nodes.parent_id),name=COALESCE(NULLIF(excluded.name,''),competition_nodes.name)",[kind,String(id),parent==null?null:String(parent),String(name||'')]);};
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
 function check(picks,stake,payout,userId,excludeBet=null){
  if(!get('SELECT id FROM competition_rules LIMIT 1'))return;
  for(const p of picks){
   let kind='event',id=String(p.game_id??p.gameId);const rules=[];
   while(id){
    const node=get('SELECT * FROM competition_nodes WHERE kind=? AND id=?',[kind,id]);
    const r=get('SELECT r.*,n.name FROM competition_rules r JOIN competition_nodes n ON n.kind=r.kind AND n.id=r.id WHERE r.kind=? AND r.id=?',[kind,id]);
    if(r)rules.push(r);
    if(kind==='tournament')rules.push(...all("SELECT r.*,n.name FROM competition_group_members m JOIN competition_rules r ON r.kind='custom-group' AND r.id=m.group_id JOIN competition_nodes n ON n.kind=r.kind AND n.id=r.id WHERE m.tournament_id=?",[id]));
    if(kind==='group')break;
    id=node?.parent_id||(kind==='event'?p.league_id:null);kind=kind==='event'?'tournament':'group';
   }
   enforce(rules,stake,payout);
   for(const r of rules)enforceUserTotal(r,stake,userId,excludeBet);
  }
 }
 function mount(app,auth){
  app.post('/api/center/competition-groups',auth,(req,res)=>{try{const name=String(req.body.name||'').trim(),sport=String(req.body.sportId||''),ids=[...new Set(Array.isArray(req.body.tournamentIds)?req.body.tournamentIds.map(String):[])];if(!name||name.length>100||!ids.length||ids.length>500)throw Error('Vendos emrin dhe zgjidh të paktën një turnament.');if(!get("SELECT id FROM competition_nodes WHERE kind='sport' AND id=?",[sport]))throw Error('Sport i pavlefshëm.');for(const id of ids)if(!get("SELECT t.id FROM competition_nodes t JOIN competition_nodes c ON c.kind='group' AND c.id=t.parent_id WHERE t.kind='tournament' AND t.id=? AND c.parent_id=?",[id,sport]))throw Error('Turnamenti nuk i përket këtij sporti.');const id=require('crypto').randomUUID();tx(()=>{put('custom-group',id,sport,name);for(const tournament of ids)run('INSERT INTO competition_group_members VALUES(?,?)',[id,tournament]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_group_created','competition',JSON.stringify({id,name,sport,ids})]);});res.json({ok:true,id});}catch(e){res.status(400).json({error:e.message});}});
 
  app.get('/api/center/competitions',auth,async(req,res)=>{try{const kind=String(req.query.kind||'sport'),parent=String(req.query.parent||'');if(kind==='tournament'&&get("SELECT id FROM competition_nodes WHERE kind='custom-group' AND id=?",[parent])){return res.json({items:all("SELECT t.* FROM competition_group_members m JOIN competition_nodes t ON t.kind='tournament' AND t.id=m.tournament_id WHERE m.group_id=? ORDER BY t.name",[parent]).map(t=>({...t,rule:get('SELECT * FROM competition_rules WHERE kind=? AND id=?',['tournament',t.id])||null})),rules:all('SELECT r.*,n.name FROM competition_rules r JOIN competition_nodes n ON n.kind=r.kind AND n.id=r.id')});}if(!['sport','group','tournament','event'].includes(kind)|| (kind!=='sport'&&!/^\d{1,12}$/.test(parent)))return res.status(400).json({error:'Parametra të pavlefshëm.'});const path={sport:'sports',group:'countries',tournament:'leagues',event:'gamesByLeague'}[kind];const feed=await proxy('/ajax/'+path+(kind==='sport'?'':'/'+parent));if(feed.status!==200)throw Error('API nuk është e disponueshme.');let rows=JSON.parse(feed.text);if(!Array.isArray(rows))throw Error('Përgjigje e pavlefshme nga API.');if(kind==='event'){try{const live=await proxy('/ajax/livegames?market_type=1');const games=JSON.parse(live.text);if(live.status===200&&Array.isArray(games)){const merged=new Map(rows.map(g=>[String(g.id??g.game_id),g]));for(const g of games)if(String(g.league_id)===parent)merged.set(String(g.id??g.game_id),g);rows=[...merged.values()];}}catch{}}tx(()=>{if(kind==='event')remember(rows.map(g=>({...g,league_id:parent})));for(const row of rows)put(kind,row.id??row.game_id,kind==='sport'?null:parent,kind==='event'?(row.home_team||row.home||'')+' — '+(row.away_team||row.away||''):row.name);});res.json({items:[...(kind==='group'?all("SELECT n.*, (SELECT COUNT(*) FROM competition_group_members m WHERE m.group_id=n.id) memberCount FROM competition_nodes n WHERE n.kind='custom-group' AND n.parent_id=? ORDER BY n.name",[parent]).map(n=>({...n,custom:true,rule:get('SELECT * FROM competition_rules WHERE kind=? AND id=?',['custom-group',n.id])||null})):[]),...rows.map(row=>{const id=String(row.id??row.game_id);return {...row,id,name:get('SELECT name FROM competition_nodes WHERE kind=? AND id=?',[kind,id]).name,rule:get('SELECT * FROM competition_rules WHERE kind=? AND id=?',[kind,id])||null};})],rules:all('SELECT r.*,n.name FROM competition_rules r JOIN competition_nodes n ON n.kind=r.kind AND n.id=r.id ORDER BY r.kind,n.name')});}catch(e){res.status(502).json({error:e.message});}});
  app.put('/api/center/competitions/:kind/:id',auth,async(req,res)=>{try{const {kind,id}=req.params;if(!['custom-group','group','tournament','event'].includes(kind)||!get('SELECT id FROM competition_nodes WHERE kind=? AND id=?',[kind,id]))throw Error('Zgjidh një element nga API.');const r=validateRule(req.body);let leagues=[];if(kind==='group'){const feed=await proxy('/ajax/leagues/'+encodeURIComponent(id));if(feed.status!==200)throw Error('API nuk lejon verifikimin e turnamenteve të grupit.');leagues=JSON.parse(feed.text);if(!Array.isArray(leagues))throw Error('Lista e turnamenteve është e pavlefshme.');}tx(()=>{for(const l of leagues)put('tournament',l.id,id,l.name);run('INSERT INTO competition_rules(kind,id,blocked,max_stake,max_payout,updated_at,updated_by,max_user_total) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET blocked=excluded.blocked,max_stake=excluded.max_stake,max_payout=excluded.max_payout,updated_at=excluded.updated_at,updated_by=excluded.updated_by,max_user_total=excluded.max_user_total',[kind,id,r.blocked?1:0,r.maxStake,r.maxPayout,now(),req.user.id,['tournament','group','custom-group'].includes(kind)?r.maxUserTotal:null]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_limit_updated','competition',JSON.stringify({kind,id,...r})]);});res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
  app.delete('/api/center/competitions/:kind/:id',auth,(req,res)=>{tx(()=>{run('DELETE FROM competition_rules WHERE kind=? AND id=?',[req.params.kind,req.params.id]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_limit_removed','competition',JSON.stringify(req.params)]);});res.json({ok:true});});
 }
 return {mount,remember,check};
}
module.exports={create,validateRule,enforce};
