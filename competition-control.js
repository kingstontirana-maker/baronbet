'use strict';
// Every element (event, market, tournament, tournament group, centre group) has one of four
// statuses. hold: tickets wait for an operator; blocked: shown with locked odds; closed: hidden.
const STATUSES=['active','hold','blocked','closed'];
const RANK={active:0,hold:1,blocked:2,closed:3};
const worst=(...list)=>list.reduce((a,b)=>RANK[b||'active']>RANK[a]?b:a,'active');
// Live and prematch use different market ids for the same market, so markets are keyed by name.
const marketKey=name=>String(name||'').trim().replace(/\s+/g,' ').toLowerCase().slice(0,120);
const statusOf=r=>STATUSES.includes(r?.status)?r.status:r?.blocked?'blocked':'active';
const KINDS=['sport','custom-group','group','tournament','event','market','event-market','group-market','custom-group-market','tournament-market'];
// Ticket limits per ticket type; "all" applies where a type has no value of its own.
const TICKET_TYPES=['all','preSingle','preMulti','liveSingle','liveMulti'];
const LIMIT_KEYS=['maxWin','maxBet','minBet','sameTicket','sameTicketHold','holdStake','holdWin'];
// Element settings: [min,max,integer].
const SETTINGS={daysToOffer:[0,365,true],maxCombinations:[1,50,true],minSelections:[1,50,true],processingSeconds:[0,600,true],minOdd:[1,100000],maxOdd:[1,100000],maxOddGenerated:[1,100000],payoutFactor:[50,100],oddFactor:[-50,50]};
const ODDS_KEYS=['minOdd','maxOdd','maxOddGenerated','payoutFactor','oddFactor'];
// Live may override the status and the element settings; days to offer only concerns prematch.
const LIVE_KEYS=Object.keys(SETTINGS).filter(k=>k!=='daysToOffer');
function validateParams(input){
  const src=input&&typeof input==='object'?input:{},out={limits:{}};
  const num=(v,min,max,int,label)=>{if(v===null||v===undefined||v==='')return null;if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(int&&!Number.isInteger(v)))throw Error('Vlerë e pavlefshme: '+label+'.');return int?v:Math.round(v*100)/100;};
  for(const t of TICKET_TYPES){out.limits[t]={};for(const k of LIMIT_KEYS){const count=k.startsWith('same');out.limits[t][k]=num(src.limits?.[t]?.[k],count?1:0,count?1000:100000000,count,t+' '+k);}
   const l=out.limits[t];if(l.minBet!==null&&l.maxBet!==null&&l.minBet>l.maxBet)throw Error('Basti minimal nuk mund të jetë mbi bastin maksimal ('+t+').');}
  for(const [k,[min,max,int]] of Object.entries(SETTINGS))out[k]=num(src[k],min,max,int,k);
  if(out.minOdd!==null&&out.maxOdd!==null&&out.minOdd>out.maxOdd)throw Error('Koeficienti minimal nuk mund të jetë mbi maksimalin.');
  if(out.minSelections!==null&&out.maxCombinations!==null&&out.minSelections>out.maxCombinations)throw Error('Numri minimal i ndeshjeve nuk mund të jetë mbi maksimumin.');
  const live=src.live&&typeof src.live==='object'?src.live:{};
  if(live.status!=null&&!STATUSES.includes(live.status))throw Error('Status live i pavlefshëm.');
  out.live={status:live.status??null};for(const k of LIVE_KEYS){const [min,max,int]=SETTINGS[k];out.live[k]=num(live[k],min,max,int,'live '+k);}
  if(out.live.minOdd!==null&&out.live.maxOdd!==null&&out.live.minOdd>out.live.maxOdd)throw Error('Koeficienti minimal live nuk mund të jetë mbi maksimalin.');
  return out;
}
// Stored parameters of a rule row; the older max_stake/max_payout columns are the "all" limits.
function paramsOf(r){
  let p;try{p=validateParams(r?.params?JSON.parse(r.params):{});}catch(_){p=validateParams({});}
  if(p.limits.all.maxBet===null&&r?.max_stake!=null)p.limits.all.maxBet=Number(r.max_stake);
  if(p.limits.all.maxWin===null&&r?.max_payout!=null)p.limits.all.maxWin=Number(r.max_payout);
  return p;
}
function validateRule(body){
  const status=body.status!==undefined?body.status:typeof body.blocked==='boolean'?(body.blocked?'blocked':'active'):undefined;
  if(!STATUSES.includes(status))throw Error('Status i pavlefshëm.');
  const out={status,blocked:RANK[status]>=RANK.blocked};
  for(const k of ['maxStake','maxPayout']){const n=body[k]??null;if(n!==null&&(typeof n!=='number'||!Number.isFinite(n)||n<0||n>100000000))throw Error('Limit i pavlefshëm.');out[k]=n;}
  const total=body.maxUserTotal??null;if(total!==null&&(typeof total!=='number'||!Number.isFinite(total)||total<0||total>100000000))throw Error('Limit total i pavlefshëm.');out.maxUserTotal=total;
  out.params=validateParams(body.params);
  if(body.params===undefined){out.params.limits.all.maxBet=out.maxStake;out.params.limits.all.maxWin=out.maxPayout;}
  out.maxStake=out.params.limits.all.maxBet;out.maxPayout=out.params.limits.all.maxWin;
  return out;
}
// The status and settings of a rule for prematch or live selections.
function modeView(r,live){
  const p=paramsOf(r);if(!live)return {status:statusOf(r),p};
  const merged={...p};for(const k of LIVE_KEYS)if(p.live[k]!==null)merged[k]=p.live[k];
  return {status:p.live.status||statusOf(r),p:merged};
}
const eur=v=>Number(v).toFixed(2)+' €';
const ticketType=picks=>(picks.some(p=>(p.acceptanceType??p.acceptance_type)==='live')?'live':'pre')+(picks.length===1?'Single':'Multi');
// Statuses: the most specific level that has a status wins (an event over its tournament, a
// tournament over its groups and sport; an event market over the tournament's market, and so on).
// Levels at the same depth (several centre groups) take the strictest. The element and the market
// are resolved separately and the stricter of the two applies.
const ELEMENT_ORDER=['event','tournament','custom-group','group','sport'];
const MARKET_ORDER=['event-market','tournament-market','custom-group-market','group-market','market'];
function resolveStatus(entries,order){
  for(const kind of order){const at=entries.filter(e=>e.kind===kind&&e.status);if(at.length)return at.reduce((a,b)=>RANK[b.status]>RANK[a.status]?b:a);}
  return null;
}
function enforceStatus(entries){
  const hold=[];
  for(const e of [resolveStatus(entries,ELEMENT_ORDER),resolveStatus(entries,MARKET_ORDER)]){
   if(!e)continue;
   if(e.status==='closed')throw Error(e.name+' nuk ofrohet më për baste.');
   if(e.status==='blocked')throw Error('Bastet janë bllokuar për '+e.name+'.');
   if(e.status==='hold')hold.push(e.name);
  }
  return hold;
}
// The limits of every rule apply to the whole ticket (the strictest wins). Returns the reasons the
// ticket must wait for an operator and the processing delay in seconds.
function enforce(rules,stake,payout,{type='preSingle',picks=[],pick=null,repeats=()=>1}={}){
  const hold=[];let delay=0;
  for(const r of rules){
   const {p}=modeView(r,(pick?.acceptanceType??pick?.acceptance_type)==='live'),name=r.name;
   const v=k=>p.limits[type][k]??p.limits.all[k];
   if(v('maxBet')!==null&&stake>v('maxBet'))throw Error('Basti tejkalon limitin për '+name+' ('+eur(v('maxBet'))+').');
   if(v('minBet')!==null&&stake<v('minBet'))throw Error('Basti minimal për '+name+' është '+eur(v('minBet'))+'.');
   if(v('maxWin')!==null&&payout>v('maxWin'))throw Error('Fitimi tejkalon limitin për '+name+' ('+eur(v('maxWin'))+').');
   if(v('sameTicket')!==null&&repeats()>v('sameTicket'))throw Error('Kjo biletë mund të luhet deri në '+v('sameTicket')+' herë ('+name+').');
   if(v('holdStake')!==null&&stake>v('holdStake'))hold.push(name+': bast mbi '+eur(v('holdStake')));
   if(v('holdWin')!==null&&payout>v('holdWin'))hold.push(name+': fitim mbi '+eur(v('holdWin')));
   if(v('sameTicketHold')!==null&&repeats()>v('sameTicketHold'))hold.push(name+': biletë e përsëritur '+repeats()+' herë');
   if(p.maxCombinations!==null&&picks.length>p.maxCombinations)throw Error(name+' lejon deri në '+p.maxCombinations+' ndeshje në një biletë.');
   if(p.minSelections!==null&&picks.length<p.minSelections)throw Error(name+' luhet vetëm me të paktën '+p.minSelections+' ndeshje në biletë.');
   const odd=Number(pick?.odd);
   if(Number.isFinite(odd)&&p.minOdd!==null&&odd<p.minOdd)throw Error('Koeficienti minimal për '+name+' është '+p.minOdd.toFixed(2)+'.');
   if(Number.isFinite(odd)&&p.maxOdd!==null&&odd>p.maxOdd)throw Error('Koeficienti maksimal për '+name+' është '+p.maxOdd.toFixed(2)+'.');
   if(p.processingSeconds)delay=Math.max(delay,p.processingSeconds);
  }
  return {hold,delay};
}
// Odds settings move every price of one market line together: the payout factor rescales the
// line to a target payout, the correction factor adds a percentage; a raise never pushes the
// line above 100% payout. Prices outside the playable range are locked (null).
function adjustOdds(s,odds){
  const valid=odds.filter(o=>o>1),payout=valid.length>=2?1/valid.reduce((a,o)=>a+1/o,0):null;
  let m=1;
  if(s.payoutFactor!==null&&payout)m*=s.payoutFactor/100/payout;
  if(s.oddFactor!==null)m*=1+s.oddFactor/100;
  if(m>1&&payout&&payout*m>1)m=Math.max(1,1/payout);
  return {m,values:odds.map(o=>priceOne(s,o,m))};
}
function priceOne(s,o,m){
  if(!(o>1))return o;
  let v=m===1?o:Math.max(1.01,Math.floor(o*m*100+1e-6)/100);
  if(s.maxOddGenerated!==null)v=Math.min(v,s.maxOddGenerated);
  if(s.minOdd!==null&&v<s.minOdd)return null;
  if(s.maxOdd!==null&&v>s.maxOdd)return null;
  return v;
}
function create({run,get,all,tx,now,proxy}){
 run('CREATE TABLE IF NOT EXISTS competition_nodes(kind TEXT,id TEXT,parent_id TEXT,name TEXT NOT NULL,PRIMARY KEY(kind,id))');
 run('CREATE TABLE IF NOT EXISTS competition_rules(kind TEXT,id TEXT,blocked INTEGER NOT NULL,max_stake REAL,max_payout REAL,updated_at TEXT,updated_by INTEGER,PRIMARY KEY(kind,id))');
 if(!all('PRAGMA table_info(competition_rules)').some(c=>c.name==='max_user_total'))run('ALTER TABLE competition_rules ADD COLUMN max_user_total REAL');
 if(!all('PRAGMA table_info(competition_rules)').some(c=>c.name==='status')){run('ALTER TABLE competition_rules ADD COLUMN status TEXT');run("UPDATE competition_rules SET status=CASE WHEN blocked=1 THEN 'blocked' ELSE 'active' END");}
 run('CREATE TABLE IF NOT EXISTS competition_group_members(group_id TEXT,tournament_id TEXT,PRIMARY KEY(group_id,tournament_id))');
 // The same rules for one user group only; they apply on top of the network-wide rules.
 run('CREATE TABLE IF NOT EXISTS user_group_competition_rules(group_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,max_stake REAL,max_payout REAL,max_user_total REAL,updated_at TEXT,updated_by INTEGER,PRIMARY KEY(group_id,kind,id))');
 for(const table of ['competition_rules','user_group_competition_rules'])for(const column of ['params','template_id'])if(!all('PRAGMA table_info('+table+')').some(c=>c.name===column))run('ALTER TABLE '+table+' ADD COLUMN '+column+' TEXT');
 // Saved models: a status and parameters, ready to apply to any event, tournament or group.
 run('CREATE TABLE IF NOT EXISTS competition_templates(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,status TEXT NOT NULL,params TEXT NOT NULL,max_user_total REAL,created_at TEXT,created_by INTEGER,updated_at TEXT)');
 // Per-market rules of the element the model was saved from, keyed by market: {key:{name,status,params}}.
 if(!all('PRAGMA table_info(competition_templates)').some(c=>c.name==='markets'))run('ALTER TABLE competition_templates ADD COLUMN markets TEXT');
 // A model assigned to an account (a player, or an agent for every player under it) or to a user group.
 run('CREATE TABLE IF NOT EXISTS competition_template_assignments(target_type TEXT NOT NULL,target_id TEXT NOT NULL,template_id TEXT NOT NULL,created_at TEXT,created_by INTEGER,PRIMARY KEY(target_type,target_id))');
 let cache=null;const knownMarkets=new Map(all("SELECT id,parent_id FROM competition_nodes WHERE kind='market'").map(r=>[r.id,r.parent_id])),coefMarkets=new Map();
 const put=(kind,id,parent,name)=>{if(id!=null&&String(id)){run("INSERT INTO competition_nodes VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET parent_id=COALESCE(excluded.parent_id,competition_nodes.parent_id),name=COALESCE(NULLIF(excluded.name,''),competition_nodes.name)",[kind,String(id),parent==null?null:String(parent),String(name||'')]);if(kind==='tournament'&&cache)for(const c of Object.values(cache))c.memo.clear();}};
 // Markets are keyed by name; the provider id is kept (in parent_id) to show it in the centre.
 function rememberMarket(name,marketId){const key=marketKey(name),id=marketId==null||marketId===''?null:String(marketId);if(key&&(!knownMarkets.has(key)||(id&&!knownMarkets.get(key)))){knownMarkets.set(key,id||knownMarkets.get(key)||null);put('market',key,id,String(name).trim().slice(0,120));}return key;}
 const marketIdOf=key=>knownMarkets.get(key)||null;
 function remember(games){for(const g of games){const league=g.league_id,group=g.tournament_group_id??g.country_id;put('group',group,g.sport_id,g.tournament_group??g.country);put('tournament',league,group,g.league);put('event',g.id??g.game_id,league,(g.home_team||g.home||'')+' — '+(g.away_team||g.away||''));}}
 // Stake a player already has inside a competition scope; a ticket counts once however many
 // of its selections fall in the scope. Cancelled, rejected and void tickets do not count.
 const LEAGUE_OF='COALESCE(s.league_id,e.parent_id,l.league_id)';
 const scopes={
  tournament:id=>[`${LEAGUE_OF}=?`,[id]],
  group:id=>[`${LEAGUE_OF} IN (SELECT t.id FROM competition_nodes t WHERE t.kind='tournament' AND t.parent_id=?)`,[id]],
  sport:id=>[`${LEAGUE_OF} IN (SELECT t.id FROM competition_nodes t JOIN competition_nodes g ON g.kind='group' AND g.id=t.parent_id WHERE t.kind='tournament' AND g.parent_id=?)`,[id]],
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
   const sport=(group&&get("SELECT parent_id FROM competition_nodes WHERE kind='group' AND id=?",[group])?.parent_id)||(p.sport_id!=null&&p.sport_id!==''?String(p.sport_id):null);if(sport)out.push(['sport',sport]);
  }else if(p.sport_id!=null&&p.sport_id!=='')out.push(['sport',String(p.sport_id)]);
  const market=marketKey(p.market);if(market){for(const [kind,id] of [...out])if(['group','custom-group','tournament'].includes(kind))out.push([kind+'-market',id+'|'+market]);out.push(['market',market],['event-market',event+'|'+market]);}
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
 // Models assigned to the player, its agent and managers (accounts) and its user groups. Each acts
 // like its own scope for every selection: the model's parameters for the whole ticket, its market
 // configuration for the markets it names.
 function assignedModels(accounts,groups){
  const targets=[...accounts.map(id=>['account',String(id)]),...groups.map(id=>['user-group',String(id)])];if(!targets.length)return [];
  return all(`SELECT a.target_type,a.target_id,t.* FROM competition_template_assignments a JOIN competition_templates t ON t.id=a.template_id WHERE ${targets.map(()=>'(a.target_type=? AND a.target_id=?)').join(' OR ')}`,targets.flat());
 }
 function modelRules(models,p){
  const key=marketKey(p.market),out=[];
  for(const m of models){
   const scope='model:'+m.target_type+':'+m.target_id,label=m.name;
   out.push({kind:'sport',id:'*',name:label,status:m.status,params:m.params,max_stake:null,max_payout:null,max_user_total:null,group_id:scope});
   let markets={};try{markets=JSON.parse(m.markets||'{}')||{};}catch(_){}
   const mk=key&&markets[key];if(mk)out.push({kind:'market',id:key,name:label+' · '+(mk.name||key),status:mk.status,params:JSON.stringify(mk.params||{}),max_stake:null,max_payout:null,max_user_total:null,group_id:scope});
  }
  return out;
 }
 function check(picks,stake,payout,userId,excludeBet=null,{groups=[],accounts=[]}={}){
  const hold=[];let delay=0;
  const models=assignedModels(accounts,groups);
  if(!models.length&&!get('SELECT id FROM competition_rules LIMIT 1')&&!(groups.length&&get(`SELECT id FROM user_group_competition_rules WHERE group_id IN (${groups.map(()=>'?').join(',')}) LIMIT 1`,groups)))return {hold,delay};
  // How many times this player has played the same events and markets, this ticket included.
  let repeatCount=null;
  const repeats=()=>{
   if(repeatCount!==null)return repeatCount;
   const keyOf=list=>JSON.stringify(list.map(s=>JSON.stringify([String(s.game_id??s.gameId),String(s.market_id||s.marketId||s.market||'').trim()])).sort());
   const own=keyOf(picks),first=String(picks[0]?.game_id??picks[0]?.gameId),tickets=new Map();
   for(const row of all("SELECT b.id,s.game_id,s.market_id,s.market FROM bets b JOIN bet_selections s ON s.bet_id=b.id WHERE b.user_id=? AND b.id<>? AND b.status NOT IN ('cancelled','rejected','void') AND EXISTS(SELECT 1 FROM bet_selections f WHERE f.bet_id=b.id AND f.game_id=?)",[userId,excludeBet??-1,first])){if(!tickets.has(row.id))tickets.set(row.id,[]);tickets.get(row.id).push(row);}
   return repeatCount=1+[...tickets.values()].filter(list=>keyOf(list)===own).length;
  };
  const type=ticketType(picks);
  for(const p of picks){
   const rules=[...rulesFor(p,groups),...modelRules(models,p)],live=(p.acceptanceType??p.acceptance_type)==='live';
   for(const scope of new Set(['',...groups,...rules.map(r=>String(r.group_id??''))])){
    const entries=rules.filter(r=>String(r.group_id??'')===String(scope)).map(r=>({kind:r.kind,name:r.name,status:modeView(r,live).status}));
    for(const reason of enforceStatus(entries))if(!hold.includes(reason))hold.push(reason);
   }
   const verdict=enforce(rules,stake,payout,{type,picks,pick:p,repeats});
   for(const reason of verdict.hold)if(!hold.includes(reason))hold.push(reason);
   delay=Math.max(delay,verdict.delay);
   for(const r of rules)enforceUserTotal(r,stake,userId,excludeBet);
  }
  return {hold,delay};
 }
 // Network-wide closed/blocked elements, kept in memory for filtering the player feeds.
 // Built separately for prematch and live, since live may override statuses and settings.
 function policy(mode='pre'){
  const old=cache?.[mode];if(old&&Date.now()-old.built<60000)return old;
  const p={any:false,restricted:false,status:new Map(),odds:new Map(),days:new Map(),prices:new Map(),memo:new Map()};
  for(const r of all('SELECT * FROM competition_rules')){
   const {status,p:params}=modeView(r,mode==='live');if(ODDS_KEYS.some(k=>params[k]!==null)){p.any=true;p.odds.set(r.kind+'|'+r.id,params);}
   if(mode==='pre'&&params.daysToOffer!==null){p.any=true;p.days.set(r.kind+'|'+r.id,params.daysToOffer);}
   // Active statuses are kept too: an active league overrides a blocked group above it.
   p.status.set(r.kind+'|'+r.id,status);
   if(RANK[status]>=RANK.blocked){p.any=true;p.restricted=true;}
  }
  p.built=Date.now();if(old?.prices)p.prices=old.prices;
  cache={...cache,[mode]:p};return p;
 }
 // Prematch events further away than the shortest "days to offer" of their elements are hidden.
 const startOf=g=>{for(const k of ['game_time','game_date','start_time','date','time']){const v=g?.[k];if(v==null||v==='')continue;const n=Number(v);const t=Number.isFinite(n)&&n>1e9?(n<1e12?n*1000:n):Date.parse(String(v).replace(' ','T'));if(Number.isFinite(t))return t;}return null;};
 function tooFar(p,g,id,league){
  if(!p.days.size)return false;const start=startOf(g);if(start===null)return false;
  const limits=elements({game_id:id,league_id:league}).map(([kind,i])=>p.days.get(kind+'|'+i)).filter(v=>v!=null);
  return limits.length>0&&start>Date.now()+Math.min(...limits)*86400000;
 }
 // The odds settings of a market line: the most specific factor wins, ranges take the narrowest.
 const SPECIFIC=['event-market','event','tournament-market','tournament','custom-group-market','custom-group','group-market','group','sport','market'];
 function oddsSettings(p,event,key,league){
  if(!p.odds.size)return null;
  const memo=p.memo,id='odds|'+event+'|'+key+'|'+(league??'');
  if(memo.has(id))return memo.get(id);
  const found=elements({game_id:event,market:key,league_id:league}).map(([kind,i])=>[SPECIFIC.indexOf(kind),p.odds.get(kind+'|'+i)]).filter(([,s])=>s).sort((a,b)=>a[0]-b[0]).map(([,s])=>s);
  let s=null;
  if(found.length){
   const first=k=>found.find(x=>x[k]!==null)?.[k]??null,range=(k,f)=>{const v=found.map(x=>x[k]).filter(x=>x!==null);return v.length?f(...v):null;};
   s={payoutFactor:first('payoutFactor'),oddFactor:first('oddFactor'),minOdd:range('minOdd',Math.max),maxOdd:range('maxOdd',Math.min),maxOddGenerated:range('maxOddGenerated',Math.min)};
  }
  if(memo.size>=40000)memo.clear();
  memo.set(id,s);return s;
 }
 // lines: [{coef,key,line,odd}] of one event. Returns coef → adjusted price (null = locked).
 function priceLines(p,event,lines,league){
  const out=new Map();if(!p.odds.size)return out;
  const byLine=new Map();for(const l of lines){if(!l.key)continue;const g=l.key+'#'+l.line;if(!byLine.has(g))byLine.set(g,[]);byLine.get(g).push(l);}
  for(const list of byLine.values()){
   const s=oddsSettings(p,event,list[0].key,league);if(!s)continue;
   const {m,values}=adjustOdds(s,list.map(l=>Number(l.odd)));
   list.forEach((l,i)=>{out.set(String(l.coef),values[i]);if(p.prices.size>=50000)p.prices.delete(p.prices.keys().next().value);p.prices.set(String(l.coef),{m,s});});
  }
  return out;
 }
 const detailLines=rows=>{const lines=[],walk=list=>{for(const row of list){if(Array.isArray(row))walk(row);else if(row&&typeof row==='object'&&row.market!=null)lines.push({coef:row.id??row.market_option_id,key:marketKey(row.market),line:String(row.market_id??'')+'|'+String(row.special_value??''),odd:row.odd});}};walk(Array.isArray(rows)?rows:[]);return lines;};
 const summaryLines=text=>String(text||'').split(',').map(part=>part.split('|')).filter(f=>f.length>=5).map(f=>({coef:f[0],key:marketKey(f[4]),line:String(f[3]),odd:f[1]}));
 // Authoritative adjusted price of one coefficient, from the same feed rows the player saw.
 const price={
  detail(rows,event,coef,mode='pre'){const out=priceLines(policy(mode),String(event),detailLines(rows),leagueOf(event));return out.has(String(coef))?out.get(String(coef)):undefined;},
  summary(game,coef){const event=String(game?.id??game?.game_id),out=priceLines(policy(modeOf(game)),event,summaryLines(game?.odd),game?.league_id);return out.has(String(coef))?out.get(String(coef)):undefined;}
 };
 const modeOf=g=>g?.current_minute!=null&&g.current_minute!==''?'live':'pre';
 const leagueOf=id=>get("SELECT parent_id FROM competition_nodes WHERE kind='event' AND id=?",[String(id)])?.parent_id||(()=>{try{return get('SELECT league_id FROM risk_event_leagues WHERE event_id=?',[String(id)])?.league_id;}catch(_){return null;}})();
 // Feed statuses, resolved like at bet time and memoised per policy.
 function resolved(p,key,list,order){
  if(!p.restricted)return 'active';
  if(p.memo.has(key))return p.memo.get(key);
  const status=resolveStatus(list().map(([kind,i])=>({kind,status:p.status.get(kind+'|'+i)})),order)?.status||'active';
  if(p.memo.size>=40000)p.memo.clear();
  p.memo.set(key,status);return status;
 }
 const gameStatus=(p,id,league)=>resolved(p,'game|'+id+'|'+(league??''),()=>elements({game_id:id,league_id:league}),ELEMENT_ORDER);
 const marketStatus=(p,event,key)=>resolved(p,'market|'+event+'|'+key,()=>elements({game_id:event,market:key}),MARKET_ORDER);
 const tournamentStatus=(p,id)=>resolved(p,'tournament|'+id,()=>elements({game_id:'\u0000',league_id:id}).filter(([k])=>k!=='event'),ELEMENT_ORDER);
 const groupStatus=(p,id)=>resolved(p,'group|'+id,()=>{const sport=get("SELECT parent_id FROM competition_nodes WHERE kind='group' AND id=?",[String(id)])?.parent_id;return [['group',String(id)],...(sport?[['sport',sport]]:[])];},ELEMENT_ORDER);
 const noteCoef=(coef,key)=>{if(coef==null||!key)return;if(coefMarkets.size>=50000)coefMarkets.delete(coefMarkets.keys().next().value);coefMarkets.set(String(coef),key);};
 // "coefId|odd|selection|marketId|market" parts of a game row.
 function oddString(p,text,event,base,league){
  const priced=priceLines(p,String(event),summaryLines(text),league);
  return String(text).split(',').map(part=>{const f=part.split('|');const key=f.length>=5?marketKey(f[4]):'';noteCoef(f[0],key);const status=worst(base,key?marketStatus(p,event,key):undefined);if(status==='closed')return null;if(status==='blocked'&&f.length>=2)f[1]='-';else if(priced.has(String(f[0]))){const v=priced.get(String(f[0]));f[1]=v===null?'-':v.toFixed(2);}return f.join('|');}).filter(x=>x!==null).join(',');
 }
 function games(rows,league,mode){
  return rows.flatMap(g=>{
   if(!g||typeof g!=='object')return [g];
   const live=(mode||modeOf(g))==='live',p=policy(live?'live':'pre');
   const id=g.id??g.game_id,status=gameStatus(p,id,g.league_id??league);
   if(status==='closed'||(!live&&tooFar(p,g,id,g.league_id??league)))return [];
   return [typeof g.odd==='string'?{...g,odd:oddString(p,g.odd,id,status,g.league_id??league)}:g];
  });
 }
 // One game's market rows, possibly nested in arrays.
 function markets(rows,event,mode='pre'){
  const p=policy(mode),league=leagueOf(event),base=gameStatus(p,event,league);
  if(base==='closed')return [];
  const priced=priceLines(p,String(event),detailLines(rows),league);
  const walk=list=>list.flatMap(row=>{
   if(Array.isArray(row)){const inner=walk(row);return inner.length?[inner]:[];}
   if(!row||typeof row!=='object'||row.market==null)return [row];
   const key=rememberMarket(row.market,row.market_id);noteCoef(row.id,key);
   const status=worst(base,marketStatus(p,event,key));
   if(status==='closed')return [];
   if(status==='blocked')return [{...row,odd:'-'}];
   const coef=String(row.id??row.market_option_id);
   if(priced.has(coef)){const v=priced.get(coef);return [{...row,odd:v===null?'-':typeof row.odd==='string'?v.toFixed(2):v}];}
   return [row];
  });
  return walk(rows);
 }
 function catalog(kind,rows){
  const p=policy('pre');if(!p.any)return rows;
  if(kind==='countries')return rows.filter(r=>groupStatus(p,r?.id)!=='closed');
  if(kind==='leagues')return rows.filter(r=>tournamentStatus(p,r?.id)!=='closed');
  return rows;
 }
 // Live socket price updates: {game_id,coefs:[{coef_id,odd}]}. null drops the message.
 function coefs(payload){
  const p=policy('live');if(!p.any||!payload||payload.game_id==null)return payload;
  const base=gameStatus(p,payload.game_id,leagueOf(payload.game_id));
  if(base==='closed')return null;
  const list=(payload.coefs||[]).flatMap(c=>{const key=coefMarkets.get(String(c?.coef_id));const status=worst(base,key?marketStatus(p,payload.game_id,key):undefined);if(status==='closed')return [];if(status==='blocked')return [{...c,odd:'-'}];
   // A single price update reuses the last factor computed for its whole line.
   const known=p.prices.get(String(c?.coef_id));if(known&&Number(c.odd)>1){const v=priceOne(known.s,Number(c.odd),known.m);return [{...c,odd:v===null?'-':typeof c.odd==='string'?v.toFixed(2):v}];}
   return [c];});
  return {...payload,coefs:list};
 }
 const groupExists=id=>{try{return !!get('SELECT id FROM user_groups WHERE id=?',[id]);}catch(_){return false;}};
 const ruleTable=groupId=>groupId?['SELECT r.*,n.name FROM user_group_competition_rules r LEFT JOIN competition_nodes n ON n.kind=r.kind AND n.id=r.id WHERE r.group_id=?',[groupId]]:['SELECT r.*,n.name FROM competition_rules r LEFT JOIN competition_nodes n ON n.kind=r.kind AND n.id=r.id WHERE 1=1',[]];
 function ruleOf(groupId,kind,id){const [sql,args]=ruleTable(groupId);const r=get(sql+' AND r.kind=? AND r.id=?',[...args,kind,id]);return r?{...r,status:statusOf(r),params:paramsOf(r)}:null;}
 function ruleList(groupId){const [sql,args]=ruleTable(groupId);return all(sql+' ORDER BY r.kind,n.name',args).map(r=>({...r,name:r.name||r.id,status:statusOf(r),params:paramsOf(r)}));}
 async function eventMarkets(event){
  // A prematch event need not wait for a slow live endpoint (or vice versa).
  try{return await Promise.any(['/ajax/livegame/','/ajax/prematchgame/'].map(async path=>{
   const feed=await proxy(path+encodeURIComponent(event));if(feed.status!==200)throw Error('Market feed unavailable');
   const names=new Map(),walk=list=>{for(const row of list){if(Array.isArray(row))walk(row);else if(row&&row.market!=null){const key=marketKey(row.market);if(key&&!names.has(key))names.set(key,{name:String(row.market).trim(),id:row.market_id});}}};
   const data=JSON.parse(feed.text);if(Array.isArray(data))walk(data);if(!names.size)throw Error('Empty market feed');return [...names].map(([key,m])=>({key,name:m.name,id:m.id}));
  }));}catch(_){return [];}
 }
 async function optionalLiveFeed(){let timer;try{return await Promise.race([proxy('/ajax/livegames?market_type=1'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Live catalog timeout')),1500);})]);}finally{clearTimeout(timer);}}
 function mount(app,auth){
  const scopeOf=req=>{const g=String(req.query.groupId||req.body?.groupId||'');if(g&&!groupExists(g))throw Error('Grupi i përdoruesve nuk ekziston.');return g;};
  app.post('/api/center/competition-groups',auth,(req,res)=>{try{const name=String(req.body.name||'').trim(),sport=String(req.body.sportId||''),ids=[...new Set(Array.isArray(req.body.tournamentIds)?req.body.tournamentIds.map(String):[])];if(!name||name.length>100||!ids.length||ids.length>500)throw Error('Vendos emrin dhe zgjidh të paktën një turnament.');if(!get("SELECT id FROM competition_nodes WHERE kind='sport' AND id=?",[sport]))throw Error('Sport i pavlefshëm.');for(const id of ids)if(!get("SELECT t.id FROM competition_nodes t JOIN competition_nodes c ON c.kind='group' AND c.id=t.parent_id WHERE t.kind='tournament' AND t.id=? AND c.parent_id=?",[id,sport]))throw Error('Turnamenti nuk i përket këtij sporti.');const id=require('crypto').randomUUID();tx(()=>{put('custom-group',id,sport,name);for(const tournament of ids)run('INSERT INTO competition_group_members VALUES(?,?)',[id,tournament]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_group_created','competition',JSON.stringify({id,name,sport,ids})]);});cache=null;res.json({ok:true,id});}catch(e){res.status(400).json({error:e.message});}});

  // Copy Model: replace the rules of one model (the network or a user group) with another's.
  app.post('/api/center/competitions/copy',auth,(req,res)=>{try{
   const from=String(req.body.from||''),to=String(req.body.to||'');
   if(from===to)throw Error('Zgjidh një model tjetër për kopjim.');
   for(const g of [from,to])if(g&&!groupExists(g))throw Error('Grupi i përdoruesve nuk ekziston.');
   const [sql,args]=ruleTable(from),rows=all(sql,args);
   tx(()=>{
    if(to)run('DELETE FROM user_group_competition_rules WHERE group_id=?',[to]);else run('DELETE FROM competition_rules');
    for(const r of rows){const status=statusOf(r);
     if(to)run('INSERT INTO user_group_competition_rules(group_id,kind,id,status,max_stake,max_payout,max_user_total,updated_at,updated_by,params) VALUES(?,?,?,?,?,?,?,?,?,?)',[to,r.kind,r.id,status,r.max_stake,r.max_payout,r.max_user_total,now(),req.user.id,r.params]);
     else run('INSERT INTO competition_rules(kind,id,blocked,max_stake,max_payout,updated_at,updated_by,max_user_total,status,params) VALUES(?,?,?,?,?,?,?,?,?,?)',[r.kind,r.id,RANK[status]>=RANK.blocked?1:0,r.max_stake,r.max_payout,now(),req.user.id,r.max_user_total,status,r.params]);}
    run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_model_copied','competition',JSON.stringify({from:from||null,to:to||null,rules:rows.length})]);
   });
   cache=null;res.json({ok:true,copied:rows.length});
  }catch(e){res.status(400).json({error:e.message});}});
  app.get('/api/center/competitions',auth,async(req,res)=>{try{const kind=String(req.query.kind||'sport'),parent=String(req.query.parent||''),groupId=scopeOf(req),rule=(k,id)=>ruleOf(groupId,k,id),rules=ruleList(groupId);
   // What is being played now: live matches of the sport, their tournaments and groups.
   if(kind==='live'){
    const sport=String(req.query.sport||'');
    const feed=await proxy('/ajax/livegames?market_type=1');if(feed.status!==200)throw Error('Feed-i live nuk është i disponueshëm.');
    let rows=JSON.parse(feed.text);if(!Array.isArray(rows))throw Error('Përgjigje e pavlefshme nga API.');
    rows=rows.filter(g=>g&&typeof g==='object'&&(!sport||g.sport_id==null||String(g.sport_id)===sport));
    tx(()=>remember(rows));
    const events=rows.map(g=>{const id=String(g.id??g.game_id);return {id,name:(g.home_team||g.home||'')+' — '+(g.away_team||g.away||''),league_id:String(g.league_id),minute:g.current_minute??null,result:g.result??null,rule:rule('event',id)};});
    const leagues=[...new Set(events.map(e=>e.league_id))];
    const tournaments=leagues.map(id=>{const t=get("SELECT t.*,c.name countryName FROM competition_nodes t LEFT JOIN competition_nodes c ON c.kind='group' AND c.id=t.parent_id WHERE t.kind='tournament' AND t.id=?",[id]);return {id,name:t?.name||rows.find(g=>String(g.league_id)===id)?.league||id,countryName:t?.countryName||'',parent_id:t?.parent_id||null,live:events.filter(e=>e.league_id===id).length,rule:rule('tournament',id)};}).sort((a,b)=>(a.countryName+a.name).localeCompare(b.countryName+b.name));
    const groupIds=[...new Set(tournaments.map(t=>t.parent_id).filter(Boolean))];
    const customGroupIds=leagues.length?all(`SELECT DISTINCT group_id FROM competition_group_members WHERE tournament_id IN (${leagues.map(()=>'?').join(',')})`,leagues).map(r=>r.group_id):[];
    return res.json({events,tournaments,groupIds,customGroupIds});
   }
   if(kind==='workspace'){
    const sport=String(req.query.sport||'');
    const sports=all("SELECT * FROM competition_nodes WHERE kind='sport' ORDER BY CASE WHEN id='1' THEN 0 ELSE 1 END,CAST(id AS INTEGER),name").map(n=>({...n,rule:rule('sport',n.id)}));
    const selectedSport=sport||sports[0]?.id||'';
    const groups=all("SELECT n.*, (SELECT COUNT(*) FROM competition_group_members m WHERE m.group_id=n.id) memberCount FROM competition_nodes n WHERE n.kind IN ('group','custom-group') AND n.parent_id=? ORDER BY n.name",[selectedSport]).map(n=>({...n,custom:n.kind==='custom-group',rule:rule(n.kind,n.id)}));
    const tournaments=all("SELECT t.*,c.name countryName FROM competition_nodes t JOIN competition_nodes c ON c.kind='group' AND c.id=t.parent_id WHERE t.kind='tournament' AND c.parent_id=? ORDER BY c.name,t.name",[selectedSport]).map(t=>({...t,rule:rule('tournament',t.id)}));
    return res.json({sports,groups,tournaments,markets:all("SELECT * FROM competition_nodes WHERE kind='event-market' AND parent_id=? ORDER BY name",[String(req.query.event||'')]).map(n=>({...n,market:n.id.slice(n.id.indexOf('|')+1),marketId:marketIdOf(n.id.slice(n.id.indexOf('|')+1)),rule:rule('event-market',n.id),globalRule:rule('market',n.id.slice(n.id.indexOf('|')+1))})),events:all("SELECT * FROM competition_nodes WHERE kind='event' AND parent_id=? ORDER BY name",[String(req.query.tournament||'')]).map(e=>({...e,rule:rule('event',e.id)})),rules});
   }
   if(kind==='market'&&req.query.scopeKind){
    const scopeKind=String(req.query.scopeKind),scopeId=String(req.query.scopeId||'');
    if(!['group','custom-group','tournament'].includes(scopeKind)||!get('SELECT id FROM competition_nodes WHERE kind=? AND id=?',[scopeKind,scopeId]))return res.status(400).json({error:'Grup ose turnament i pavlefshëm.'});
    const nodes=all("SELECT * FROM competition_nodes WHERE kind='market' ORDER BY name"),scoped=scopeKind+'-market';
    tx(()=>{for(const n of nodes)put(scoped,scopeId+'|'+n.id,scopeId,n.name);});
    return res.json({items:nodes.map(n=>({id:scopeId+'|'+n.id,name:n.name,market:n.id,marketId:n.parent_id,rule:rule(scoped,scopeId+'|'+n.id),globalRule:rule('market',n.id)})),rules});
   }
   if(kind==='market'){
    if(!parent)return res.json({items:all("SELECT * FROM competition_nodes WHERE kind='market' ORDER BY name").map(n=>({id:n.id,name:n.name,market:n.id,marketId:n.parent_id,rule:rule('market',n.id)})),rules});
    if(!/^\d{1,12}$/.test(parent))return res.status(400).json({error:'Parametra të pavlefshëm.'});
    const list=await eventMarkets(parent);tx(()=>{for(const m of list){rememberMarket(m.name,m.id);put('event-market',parent+'|'+m.key,parent,m.name);}});
    return res.json({items:list.map(m=>({id:parent+'|'+m.key,name:m.name,market:m.key,marketId:marketIdOf(m.key),rule:rule('event-market',parent+'|'+m.key),globalRule:rule('market',m.key)})),rules});
   }
   if(kind==='tournament'&&get("SELECT id FROM competition_nodes WHERE kind='custom-group' AND id=?",[parent])){return res.json({items:all("SELECT t.* FROM competition_group_members m JOIN competition_nodes t ON t.kind='tournament' AND t.id=m.tournament_id WHERE m.group_id=? ORDER BY t.name",[parent]).map(t=>({...t,rule:rule('tournament',t.id)})),rules});}
   if(!['sport','group','tournament','event'].includes(kind)||(kind!=='sport'&&!/^\d{1,12}$/.test(parent)))return res.status(400).json({error:'Parametra të pavlefshëm.'});const path={sport:'sports',group:'countries',tournament:'leagues',event:'gamesByLeague'}[kind];const feed=await proxy('/ajax/'+path+(kind==='sport'?'':'/'+parent));if(feed.status!==200)throw Error('API nuk është e disponueshme.');let rows=JSON.parse(feed.text);if(!Array.isArray(rows))throw Error('Përgjigje e pavlefshme nga API.');if(kind==='event'){try{const live=await optionalLiveFeed();const games=JSON.parse(live.text);if(live.status===200&&Array.isArray(games)){const merged=new Map(rows.map(g=>[String(g.id??g.game_id),g]));for(const g of games)if(String(g.league_id)===parent)merged.set(String(g.id??g.game_id),g);rows=[...merged.values()];}}catch{}}tx(()=>{if(kind==='event')remember(rows.map(g=>({...g,league_id:parent})));for(const row of rows)put(kind,row.id??row.game_id,kind==='sport'?null:parent,kind==='event'?(row.home_team||row.home||'')+' — '+(row.away_team||row.away||''):row.name);});res.json({items:[...(kind==='group'?all("SELECT n.*, (SELECT COUNT(*) FROM competition_group_members m WHERE m.group_id=n.id) memberCount FROM competition_nodes n WHERE n.kind='custom-group' AND n.parent_id=? ORDER BY n.name",[parent]).map(n=>({...n,custom:true,rule:rule('custom-group',n.id)})):[]),...rows.map(row=>{const id=String(row.id??row.game_id);return {...row,id,name:get('SELECT name FROM competition_nodes WHERE kind=? AND id=?',[kind,id]).name,rule:rule(kind,id)};})],rules});}catch(e){res.status(e.message.includes('Grupi')?400:502).json({error:e.message});}});
  // Writes one element's rule; templateId records the saved model it came from (null = edited by hand).
  async function saveRule(groupId,kind,id,r,userId,templateId=null){
   if(!KINDS.includes(kind)||!get('SELECT id FROM competition_nodes WHERE kind=? AND id=?',[kind,id]))throw Error('Zgjidh një element nga API.');
   let leagues=[];if(kind==='group'){const feed=await proxy('/ajax/leagues/'+encodeURIComponent(id));if(feed.status!==200)throw Error('API nuk lejon verifikimin e turnamenteve të grupit.');leagues=JSON.parse(feed.text);if(!Array.isArray(leagues))throw Error('Lista e turnamenteve është e pavlefshme.');}
   const total=['sport','tournament','group','custom-group'].includes(kind)?r.maxUserTotal:null,params=JSON.stringify(r.params);
   tx(()=>{for(const l of leagues)put('tournament',l.id,id,l.name);
    if(groupId)run('INSERT INTO user_group_competition_rules(group_id,kind,id,status,max_stake,max_payout,max_user_total,updated_at,updated_by,params,template_id) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id,kind,id) DO UPDATE SET status=excluded.status,max_stake=excluded.max_stake,max_payout=excluded.max_payout,max_user_total=excluded.max_user_total,updated_at=excluded.updated_at,updated_by=excluded.updated_by,params=excluded.params,template_id=excluded.template_id',[groupId,kind,id,r.status,r.maxStake,r.maxPayout,total,now(),userId,params,templateId]);
    else run('INSERT INTO competition_rules(kind,id,blocked,max_stake,max_payout,updated_at,updated_by,max_user_total,status,params,template_id) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET blocked=excluded.blocked,max_stake=excluded.max_stake,max_payout=excluded.max_payout,updated_at=excluded.updated_at,updated_by=excluded.updated_by,max_user_total=excluded.max_user_total,status=excluded.status,params=excluded.params,template_id=excluded.template_id',[kind,id,r.blocked?1:0,r.maxStake,r.maxPayout,now(),userId,total,r.status,params,templateId]);
    run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[userId,templateId?'competition_model_applied':'competition_limit_updated','competition',JSON.stringify({kind,id,groupId:groupId||null,templateId,...r})]);});
   cache=null;
  }
  app.put('/api/center/competitions/:kind/:id',auth,async(req,res)=>{try{const {kind,id}=req.params,groupId=scopeOf(req);const r=validateRule(req.body);
   // Status-only edits from the compact view keep the element's other parameters.
   if(req.body.params===undefined){const prev=ruleOf(groupId,kind,id);if(prev)r.params={...prev.params,limits:{...prev.params.limits,all:{...prev.params.limits.all,maxBet:r.maxStake,maxWin:r.maxPayout}}};}
   await saveRule(groupId,kind,id,r,req.user.id);res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
  // The rules of the levels above an element (group, centre group, sport) that restrict it:
  // a closed/blocked/hold parent applies to everything inside it.
  function parentsOf(kind,id){
   if(kind==='event')return elements({game_id:id}).filter(([k])=>!['event','market','event-market'].includes(k)&&!k.endsWith('-market'));
   if(kind==='tournament')return elements({game_id:'\u0000',league_id:id}).filter(([k])=>['group','custom-group','sport'].includes(k));
   if(kind==='group'||kind==='custom-group'){const sport=get('SELECT parent_id FROM competition_nodes WHERE kind=? AND id=?',[kind,id])?.parent_id;return sport?[['sport',sport]]:[];}
   return [];
  }
  app.get('/api/center/competitions/inherited',auth,(req,res)=>{try{
   const groupId=scopeOf(req),kind=String(req.query.kind||''),id=String(req.query.id||'');
   // The nearest level above with a status decides for the element until it has a status of its own.
   const out=[];
   for(const g of groupId?['',groupId]:['']){
    const found=parentsOf(kind,id).map(([k,i])=>{const r=ruleOf(g,k,i);return r?{kind:k,id:i,name:r.name||get('SELECT name FROM competition_nodes WHERE kind=? AND id=?',[k,i])?.name||i,status:r.status,liveStatus:r.params?.live?.status||null,groupId:g||null}:null;}).filter(Boolean);
    for(const mode of ['pre','live']){const near=resolveStatus(found.map(f=>({...f,status:mode==='live'?f.liveStatus||f.status:f.status})),ELEMENT_ORDER);if(near&&!out.some(o=>o.kind===near.kind&&o.id===near.id&&o.groupId===near.groupId))out.push(found.find(f=>f.kind===near.kind&&f.id===near.id));}
   }
   res.json({parents:out});
  }catch(e){res.status(400).json({error:e.message});}});
  // Saved models.
  // The market rules that belong to an element: event → event-market, tournament/group → <kind>-market.
  const MARKET_KIND={event:'event-market',tournament:'tournament-market',group:'group-market','custom-group':'custom-group-market'};
  function elementMarkets(groupId,kind,id){
   const mk=MARKET_KIND[kind];if(!mk)return {};
   const [sql,args]=ruleTable(groupId),out={};
   for(const r of all(sql+' AND r.kind=? AND r.id LIKE ?',[...args,mk,id+'|%'])){const key=r.id.slice(String(id).length+1);out[key]={name:get("SELECT name FROM competition_nodes WHERE kind='market' AND id=?",[key])?.name||r.name||key,status:statusOf(r),params:paramsOf(r)};}
   return out;
  }
  const marketsOf=t=>{try{const m=JSON.parse(t.markets||'{}');return m&&typeof m==='object'&&!Array.isArray(m)?m:{};}catch(_){return {};}};
  const templateOut=t=>({id:t.id,name:t.name,status:t.status,params:paramsOf(t),max_user_total:t.max_user_total,updatedAt:t.updated_at,markets:Object.entries(marketsOf(t)).map(([key,m])=>({key,name:m.name,status:m.status,params:m.params})),uses:Number(get('SELECT COUNT(*) n FROM competition_rules WHERE template_id=?',[t.id]).n)+Number(get('SELECT COUNT(*) n FROM user_group_competition_rules WHERE template_id=?',[t.id]).n)});
  const templateName=v=>{const name=String(v||'').trim();if(!name||name.length>80)throw Error('Vendos emrin e modelit (deri në 80 shkronja).');return name;};
  app.get('/api/center/competition-templates',auth,(req,res)=>res.json({templates:all('SELECT * FROM competition_templates ORDER BY name').map(templateOut)}));
  app.post('/api/center/competition-templates',auth,(req,res)=>{try{
   const name=templateName(req.body.name);
   // The element's own parameters come from the values sent (the open form) or from its saved rule;
   // with fromKind/fromId the configuration of each of its markets is saved too.
   const scope=scopeOf(req),fromKind=String(req.body.fromKind||''),fromId=String(req.body.fromId||'');
   const src=fromKind?ruleOf(scope,fromKind,fromId):null,markets=fromKind?elementMarkets(scope,fromKind,fromId):{};
   let r;if(req.body.params!==undefined){const v=validateRule(req.body);r={status:v.status,params:v.params,maxUserTotal:v.maxUserTotal};}
   else if(src)r={status:src.status,params:src.params,maxUserTotal:src.max_user_total??null};
   else if(Object.keys(markets).length)r={status:'active',params:validateParams({}),maxUserTotal:null};
   else throw Error('Ky element nuk ka ende parametra për t\'u ruajtur si model.');
   if(get('SELECT id FROM competition_templates WHERE name=?',[name]))throw Error('Ekziston një model me këtë emër.');
   const id=require('crypto').randomUUID();
   tx(()=>{run('INSERT INTO competition_templates(id,name,status,params,max_user_total,created_at,created_by,updated_at,markets) VALUES(?,?,?,?,?,?,?,?,?)',[id,name,r.status,JSON.stringify(r.params),r.maxUserTotal,now(),req.user.id,now(),JSON.stringify(markets)]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_model_saved','competition',JSON.stringify({id,name,from:fromKind?{kind:fromKind,id:fromId}:null,markets:Object.keys(markets).length})]);});
   res.json({template:templateOut(get('SELECT * FROM competition_templates WHERE id=?',[id]))});
  }catch(e){res.status(400).json({error:e.message});}});
  app.put('/api/center/competition-templates/:id',auth,(req,res)=>{try{
   const t=get('SELECT * FROM competition_templates WHERE id=?',[req.params.id]);if(!t)throw Error('Modeli nuk ekziston.');
   const name=templateName(req.body.name??t.name);if(get('SELECT id FROM competition_templates WHERE name=? AND id<>?',[name,t.id]))throw Error('Ekziston një model me këtë emër.');
   const v=req.body.params!==undefined?validateRule(req.body):null;
   tx(()=>{run('UPDATE competition_templates SET name=?,status=?,params=?,max_user_total=?,updated_at=? WHERE id=?',[name,v?v.status:t.status,v?JSON.stringify(v.params):t.params,v?v.maxUserTotal:t.max_user_total,now(),t.id]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_model_updated','competition',JSON.stringify({id:t.id,name})]);});
   res.json({template:templateOut(get('SELECT * FROM competition_templates WHERE id=?',[t.id]))});
  }catch(e){res.status(400).json({error:e.message});}});
  app.delete('/api/center/competition-templates/:id',auth,(req,res)=>{try{
   const t=get('SELECT * FROM competition_templates WHERE id=?',[req.params.id]);if(!t)throw Error('Modeli nuk ekziston.');
   // Elements keep their parameters; they are simply no longer linked to the model.
   tx(()=>{run('UPDATE competition_rules SET template_id=NULL WHERE template_id=?',[t.id]);run('DELETE FROM competition_template_assignments WHERE template_id=?',[t.id]);run('UPDATE user_group_competition_rules SET template_id=NULL WHERE template_id=?',[t.id]);run('DELETE FROM competition_templates WHERE id=?',[t.id]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_model_deleted','competition',JSON.stringify({id:t.id,name:t.name})]);});
   res.json({ok:true});
  }catch(e){res.status(400).json({error:e.message});}});
  // Models assigned to accounts and user groups.
  const ASSIGN_ROLES=['user','agent','manager'];
  app.get('/api/center/competition-templates/assignments',auth,(req,res)=>res.json({assignments:all('SELECT a.*,t.name template_name FROM competition_template_assignments a JOIN competition_templates t ON t.id=a.template_id ORDER BY a.created_at DESC').map(a=>({type:a.target_type,targetId:a.target_id,templateId:a.template_id,templateName:a.template_name,createdAt:a.created_at,target:a.target_type==='account'?(()=>{const u=get('SELECT id,username,role FROM users WHERE id=?',[Number(a.target_id)]);return u?{name:u.username,role:u.role}:{name:'#'+a.target_id,role:''};})():{name:(()=>{try{return get('SELECT name FROM user_groups WHERE id=?',[a.target_id])?.name;}catch(_){return null;}})()||a.target_id,role:'group'}}))}));
  app.post('/api/center/competition-templates/:id/assign',auth,(req,res)=>{try{
   const t=get('SELECT * FROM competition_templates WHERE id=?',[req.params.id]);if(!t)throw Error('Modeli nuk ekziston.');
   const type=String(req.body.type||''),targetId=String(req.body.targetId||'');
   if(type==='account'){const u=get('SELECT id,username,role FROM users WHERE id=?',[Number(targetId)]);if(!u||!ASSIGN_ROLES.includes(u.role))throw Error('Zgjidh një përdorues, agjent ose menaxher ekzistues.');}
   else if(type==='user-group'){if(!groupExists(targetId))throw Error('Grupi i përdoruesve nuk ekziston.');}
   else throw Error('Lloj i pavlefshëm.');
   tx(()=>{run('INSERT INTO competition_template_assignments(target_type,target_id,template_id,created_at,created_by) VALUES(?,?,?,?,?) ON CONFLICT(target_type,target_id) DO UPDATE SET template_id=excluded.template_id,created_at=excluded.created_at,created_by=excluded.created_by',[type,targetId,t.id,now(),req.user.id]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_model_assigned','competition',JSON.stringify({templateId:t.id,type,targetId})]);});
   res.json({ok:true});
  }catch(e){res.status(400).json({error:e.message});}});
  app.delete('/api/center/competition-templates/assignments/:type/:targetId',auth,(req,res)=>{try{
   tx(()=>{run('DELETE FROM competition_template_assignments WHERE target_type=? AND target_id=?',[req.params.type,req.params.targetId]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_model_unassigned','competition',JSON.stringify(req.params)]);});
   res.json({ok:true});
  }catch(e){res.status(400).json({error:e.message});}});
  // One click: the model's status and parameters replace those of every chosen element.
  app.post('/api/center/competition-templates/:id/apply',auth,async(req,res)=>{try{
   const t=get('SELECT * FROM competition_templates WHERE id=?',[req.params.id]);if(!t)throw Error('Modeli nuk ekziston.');
   const groupId=scopeOf(req),targets=Array.isArray(req.body.targets)?req.body.targets:[];
   if(!targets.length||targets.length>500)throw Error('Zgjidh 1-500 elemente.');
   const r=validateRule({status:t.status,params:paramsOf(t),maxUserTotal:t.max_user_total??null}),markets=marketsOf(t);
   const failed=[];let applied=0,marketRules=0;
   for(const target of targets){try{
    const kind=String(target?.kind),id=String(target?.id);
    await saveRule(groupId,kind,id,r,req.user.id,t.id);
    const mk=MARKET_KIND[kind];
    if(mk&&Object.keys(markets).length){
     tx(()=>{
      if(groupId)run('DELETE FROM user_group_competition_rules WHERE group_id=? AND kind=? AND id LIKE ?',[groupId,mk,id+'|%']);else run('DELETE FROM competition_rules WHERE kind=? AND id LIKE ?',[mk,id+'|%']);
      for(const [key,m] of Object.entries(markets)){
       const mr=validateRule({status:m.status,params:m.params}),mid=id+'|'+key,params=JSON.stringify(mr.params);
       if(!knownMarkets.has(key))rememberMarket(m.name||key);
       put(mk,mid,id,m.name||key);
       if(groupId)run('INSERT INTO user_group_competition_rules(group_id,kind,id,status,max_stake,max_payout,max_user_total,updated_at,updated_by,params,template_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[groupId,mk,mid,mr.status,mr.maxStake,mr.maxPayout,null,now(),req.user.id,params,t.id]);
       else run('INSERT INTO competition_rules(kind,id,blocked,max_stake,max_payout,updated_at,updated_by,max_user_total,status,params,template_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[mk,mid,mr.blocked?1:0,mr.maxStake,mr.maxPayout,now(),req.user.id,null,mr.status,params,t.id]);
       marketRules++;
      }
     });
     cache=null;
    }
    applied++;
   }catch(e){failed.push({kind:target?.kind,id:target?.id,error:e.message});}}
   res.status(applied?200:400).json({applied,marketRules,failed,...(applied?{}:{error:failed[0]?.error||'Asnjë element nuk u përditësua.'})});
  }catch(e){res.status(400).json({error:e.message});}});
  app.delete('/api/center/competitions/:kind/:id',auth,(req,res)=>{try{const groupId=scopeOf(req);tx(()=>{if(groupId)run('DELETE FROM user_group_competition_rules WHERE group_id=? AND kind=? AND id=?',[groupId,req.params.kind,req.params.id]);else run('DELETE FROM competition_rules WHERE kind=? AND id=?',[req.params.kind,req.params.id]);run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[req.user.id,'competition_limit_removed','competition',JSON.stringify({...req.params,groupId:groupId||null})]);});cache=null;res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
 }
 return {mount,remember,check,price,filter:{games,markets,catalog,coefs},invalidate:()=>{cache=null;}};
}
module.exports={create,validateRule,validateParams,paramsOf,adjustOdds,enforce,marketKey,STATUSES,TICKET_TYPES,LIMIT_KEYS};
