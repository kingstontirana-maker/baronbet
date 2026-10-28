'use strict';
// Automatic ticket acceptance. Kept deliberately small: per type (Live / Prematch) a switch,
// two mandatory caps (stake, payout) and two optional ones (total odds, matches); for every
// player a daily stake cap; and a blacklist. Fixed rules need no settings:
//  - a mixed Live + Prematch ticket must satisfy both rule sets;
//  - two or more selections from the same match always go to the operator;
//  - live tickets pass the server's live safety delay before money moves.
const KINDS=['live','prematch'];
const LIMITS={maxStake:100000000,maxPayout:100000000,maxOdds:1000000,maxEvents:100};
const REQUIRED=['maxStake','maxPayout'];
const BLACKLIST_ROLES=['partner','admin','senior','supermanager','manager','agent','user'];
const defaults=()=>({live:{enabled:false,maxStake:50,maxPayout:500,maxOdds:20,maxEvents:5},prematch:{enabled:false,maxStake:100,maxPayout:1000,maxOdds:50,maxEvents:10},maxDailyStake:null,blacklist:[]});
const positive=(value,max,integer)=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=max&&(!integer||Number.isInteger(value));

function validate(value){
 const out={};
 for(const kind of KINDS){
  const r=value?.[kind];if(!r||typeof r.enabled!=='boolean')throw Error('Konfigurim i pavlefshëm: '+kind);
  out[kind]={enabled:r.enabled};
  for(const [key,max] of Object.entries(LIMITS)){
   const n=r[key];
   if(n==null||n===''){if(r.enabled&&REQUIRED.includes(key))throw Error((kind==='live'?'Live':'Prematch')+': '+(key==='maxStake'?'shuma maksimale është e detyrueshme.':'fitimi maksimal është i detyrueshëm.'));out[kind][key]=null;continue;}
   if(!positive(n,max,key==='maxEvents'))throw Error('Vlerë e pavlefshme: '+kind+' / '+key);
   out[kind][key]=n;
  }
 }
 const daily=value?.maxDailyStake;
 if(daily==null||daily==='')out.maxDailyStake=null;
 else if(positive(daily,100000000))out.maxDailyStake=daily;
 else throw Error('Kufiri ditor i pavlefshëm.');
 const list=value?.blacklist??[];
 if(!Array.isArray(list)||list.length>1000||list.some(id=>!Number.isSafeInteger(id)||id<=0))throw Error('Listë e zezë e pavlefshme.');
 out.blacklist=[...new Set(list)];
 return out;
}

// Older stored configurations had min/max ranges, policies and per-type daily caps.
// Keep the values that still exist; an enabled type missing a mandatory cap gets the default.
function migrate(stored){
 const base=defaults(),out={maxDailyStake:null,blacklist:Array.isArray(stored?.blacklist)?stored.blacklist:[]};
 const dailies=[];
 for(const kind of KINDS){
  const r=stored?.[kind]||{};
  out[kind]={enabled:r.enabled===true};
  for(const key of Object.keys(LIMITS)){
   let n=key==='maxEvents'?(r.maxEvents??r.maxSelections??null):(r[key]??null);
   if(n!=null&&!positive(n,LIMITS[key],key==='maxEvents'))n=null;
   if(n==null&&out[kind].enabled&&REQUIRED.includes(key))n=base[kind][key];
   out[kind][key]=n;
  }
  if(positive(r.maxDailyStake,100000000))dailies.push(r.maxDailyStake);
 }
 out.maxDailyStake=Object.hasOwn(stored||{},'maxDailyStake')?stored.maxDailyStake:(dailies.length?Math.min(...dailies):null);
 return validate(out);
}

// Start of today in Albania, as a UTC timestamp SQLite can compare.
function albaniaDayStart(nowIso){
 const d=new Date(nowIso),p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Tirane',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(d).map(x=>[x.type,x.value]));
 const offset=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-Math.floor(d.getTime()/1000)*1000;
 return new Date(Date.UTC(+p.year,+p.month-1,+p.day)-offset).toISOString().slice(0,19).replace('T',' ');
}

// Returns null when the ticket may be accepted automatically, otherwise the reason it goes to the operator.
function decision(config,selections,stake,payout,odds,context={}){
 if(!selections.length||![stake,payout,odds].every(n=>Number.isFinite(n)&&n>0))return 'Të dhëna të pavlefshme';
 if((context.lineage||[]).some(id=>(config.blacklist||[]).includes(Number(id))))return 'Llogaria ose dega është në listën e zezë';
 const games=selections.map((s,i)=>String(s.gameId??s.game_id??('missing-'+i))),events=new Set(games).size;
 if(events<selections.length)return 'Disa përzgjedhje nga e njëjta ndeshje';
 const names={maxStake:'shumës maksimale',maxPayout:'fitimit maksimal',maxOdds:'koeficientit maksimal',maxEvents:'numrit të ndeshjeve'};
 const values={maxStake:stake,maxPayout:payout,maxOdds:odds,maxEvents:events};
 for(const type of new Set(selections.map(s=>s.acceptanceType))){
  const r=config[type],label=type==='live'?'Live':type==='prematch'?'Prematch':String(type);
  if(!r?.enabled)return 'Pranimi automatik nuk është aktiv për '+label;
  for(const [key,n] of Object.entries(values))if(r[key]!=null&&n>r[key])return label+': mbi kufirin e '+names[key];
 }
 if(config.maxDailyStake!=null&&!(Number.isFinite(context.dailyStake)&&context.dailyStake<=config.maxDailyStake))return 'Tejkalohet kufiri ditor i lojtarit';
 return null;
}
function eligible(...args){return decision(...args)===null;}

function createAcceptance({run,get,all=()=>[],tx,now,money}){
 run('CREATE TABLE IF NOT EXISTS ticket_acceptance_config(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,updated_at TEXT,updated_by INTEGER)');
 run('INSERT OR IGNORE INTO ticket_acceptance_config(id,config) VALUES(1,?)',[JSON.stringify(defaults())]);
 function read(){const row=get('SELECT * FROM ticket_acceptance_config WHERE id=1');return {rules:migrate(JSON.parse(row.config)),version:Number(row.version),updatedAt:row.updated_at};}
 // visible: whether an operator may see an account; global: whether it may change the network-wide rules.
 function mount(app,operatorConfigAuth,{visible=()=>true,global=()=>true}={}){
 app.get('/api/operator/ticket-acceptance/accounts',operatorConfigAuth,(req,res)=>{const q=String(req.query.q||'').trim().slice(0,64);res.json({accounts:q?all(`SELECT id,username,role FROM users WHERE role IN (${BLACKLIST_ROLES.map(()=>'?').join(',')}) AND (instr(lower(username),lower(?))>0 OR CAST(id AS TEXT)=?) ORDER BY username LIMIT 30`,[...BLACKLIST_ROLES,q,q]).filter(a=>visible(req.user,a.id)):[]});});
 app.get('/api/operator/ticket-acceptance',operatorConfigAuth,(req,res)=>{const data=read();res.json({...data,blockedAccounts:data.rules.blacklist.map(id=>get('SELECT id,username,role FROM users WHERE id=?',[id])).filter(Boolean)});});
 app.put('/api/operator/ticket-acceptance',operatorConfigAuth,(req,res)=>{try{if(!global(req.user))throw Object.assign(Error('Konfigurimi i pranimit vlen për gjithë rrjetin. Vetëm operatorët pa partnerë të deleguar mund ta ndryshojnë.'),{status:403});const rules=validate(req.body.rules);for(const id of rules.blacklist){const account=get('SELECT role FROM users WHERE id=?',[id]);if(!account||!BLACKLIST_ROLES.includes(account.role))throw Error('Lista e zezë pranon vetëm llogari ekzistuese të rrjetit.');}const result=tx(()=>{const previous=read();if(req.body.version!==previous.version){const e=Error('Konfigurimi ka ndryshuar. Rifresko faqen përpara ruajtjes.');e.status=409;throw e;}run('UPDATE ticket_acceptance_config SET config=?,version=version+1,updated_at=?,updated_by=? WHERE id=1',[JSON.stringify(rules),now(),req.user.id]);run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[req.user.id,'ticket_acceptance_config_changed','configuration',1,JSON.stringify({before:previous.rules,after:rules})]);return read();});res.json(result)}catch(e){res.status(e.status||400).json({error:e.message})}});
 }
 // Called inside the placement transaction, after odds, hierarchy and exposure checks.
 // defer: the ticket qualifies but contains live legs, so the caller re-checks the odds after
 // the live safety delay and calls apply() again before any money moves.
 // hold: names of Sport & Competitions elements on hold; such tickets always wait for an operator.
 function apply(betId,selections,{defer=false,hold=[]}={}){const config=read(),b=get('SELECT * FROM bets WHERE id=?',[betId]);if(!b||b.status!=='pending')return null;
 if(hold.length){run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[null,'ticket_auto_review','bet',b.id,JSON.stringify({reason:'Në pritje (hold): '+hold.join(', '),configVersion:config.version})]);return null;}
 const lineage=[];let account=get('SELECT id,parent_id,business_parent_id FROM users WHERE id=?',[b.user_id]);while(account&&!lineage.includes(Number(account.id))&&lineage.length<40){lineage.push(Number(account.id));account=get('SELECT id,parent_id,business_parent_id FROM users WHERE id=?',[account.business_parent_id??account.parent_id??-1]);}
 const daily=get("SELECT COALESCE(SUM(stake),0) stake FROM bets WHERE user_id=? AND id<>? AND datetime(created_at)>=datetime(?) AND status NOT IN ('cancelled','rejected','void')",[b.user_id,b.id,albaniaDayStart(now())]);
 const reason=decision(config.rules,selections,Number(b.stake),Number(b.potential_win),Number(b.total_odds),{lineage,dailyStake:money(Number(daily?.stake||0)+Number(b.stake))});
 if(reason){run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[null,'ticket_auto_review','bet',b.id,JSON.stringify({reason,configVersion:config.version})]);return null;}
 if(defer){run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[null,'ticket_auto_delayed','bet',b.id,JSON.stringify({configVersion:config.version})]);return {deferred:true};}

 const u=get('SELECT id,balance,reserved_balance,status FROM users WHERE id=?',[b.user_id]);if(!u||u.status!=='active'||Number(u.reserved_balance)<Number(b.stake)||Number(u.balance)<Number(u.reserved_balance))throw Error('Krediti nuk lejon pranimin e biletës.');
 const balance=money(Number(u.balance)-Number(b.stake)),reservedBalance=money(Number(u.reserved_balance)-Number(b.stake));
 run('UPDATE users SET balance=?,reserved_balance=? WHERE id=?',[balance,reservedBalance,u.id]);run("UPDATE bets SET status='accepted',reserved=0,accepted_by=NULL,accepted_at=? WHERE id=? AND status='pending'",[now(),b.id]);
 run('INSERT INTO wallet_transactions(user_id,type,amount,balance_after,bet_id,note) VALUES(?,?,?,?,?,?)',[u.id,'bet',-Number(b.stake),balance,b.id,'Ticket automatically accepted']);
 run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[null,'ticket_auto_accepted','bet',b.id,JSON.stringify({configVersion:config.version,types:[...new Set(selections.map(s=>s.acceptanceType))],rules:config.rules})]);return {status:'accepted',balance,reservedBalance};
 }
 return {mount,apply,read};
}
module.exports={createAcceptance,validate,migrate,eligible,decision,defaults,albaniaDayStart};
