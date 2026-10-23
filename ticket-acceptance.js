'use strict';
const limits={minEvents:100,maxEvents:100,minSelections:100,maxSelections:100,minOdds:1000000,maxOdds:1000000,minSelectionOdds:1000000,maxSelectionOdds:1000000,minStake:100000000,maxStake:100000000,minPayout:100000000,maxPayout:100000000,maxDailyTickets:100000,maxDailyStake:100000000,maxOpenTickets:100000};
const blank=()=>Object.fromEntries(Object.keys(limits).map(k=>[k,null]));
const defaults=()=>({live:{...blank(),enabled:false,maxStake:50,maxPayout:500,maxOdds:20,maxEvents:5},prematch:{...blank(),enabled:false,maxStake:100,maxPayout:1000,maxOdds:50,maxEvents:10},policy:{allowMixed:true,allowSameEvent:true,blockRepeats:false},blacklist:[]});
function validate(value){
 const out={};for(const kind of ['live','prematch']){const r=value?.[kind];if(!r||typeof r.enabled!=='boolean')throw Error('Konfigurim i pavlefshëm: '+kind);out[kind]={enabled:r.enabled};
 for(const [key,max] of Object.entries(limits)){const n=r[key];if(n==null||n===''){out[kind][key]=null;continue;}if(typeof n!=='number'||!Number.isFinite(n)||n<=0||n>max||(/Events|Selections|Tickets/.test(key)&&!Number.isInteger(n)))throw Error('Limit i pavlefshëm: '+key);out[kind][key]=n;}
 for(const field of ['Events','Selections','Odds','SelectionOdds','Stake','Payout'])if(out[kind]['min'+field]!=null&&out[kind]['max'+field]!=null&&out[kind]['min'+field]>out[kind]['max'+field])throw Error('Minimumi duhet të jetë më i vogël ose i barabartë me maksimumin: '+kind+' / '+field);
 }
 out.policy={...defaults().policy};for(const key of Object.keys(out.policy)){if(value.policy?.[key]!==undefined){if(typeof value.policy[key]!=='boolean')throw Error('Politikë e pavlefshme.');out.policy[key]=value.policy[key];}}
 if(value.blacklist!==undefined&&(!Array.isArray(value.blacklist)||value.blacklist.length>1000||value.blacklist.some(id=>!Number.isSafeInteger(id)||id<=0)))throw Error('Listë e zezë e pavlefshme.');out.blacklist=[...new Set(value.blacklist||[])];return out;
}
function decision(config,selections,stake,payout,odds,context={}){
 if(!selections.length||![stake,payout,odds].every(n=>Number.isFinite(n)&&n>0))return 'Të dhëna të pavlefshme';
 if((context.lineage||[]).some(id=>(config.blacklist||[]).includes(Number(id))))return 'Llogaria ose dega është në listën e zezë';
 const policy={...defaults().policy,...config.policy},types=new Set(selections.map(s=>s.acceptanceType));
 const events=new Set(selections.map((s,i)=>String(s.gameId??s.game_id??('missing-'+i)))).size;
 if(types.size>1&&!policy.allowMixed)return 'Biletat e përziera kalojnë për shqyrtim';
 if(!policy.allowSameEvent&&events<selections.length)return 'Disa markete nga e njëjta ndeshje';
 if(policy.blockRepeats&&context.repeated)return 'Kombinim i përsëritur';
 const names={Events:'ndeshjeve',Selections:'përzgjedhjeve',Odds:'koeficientit total',Stake:'shumës',Payout:'fitimit',maxDailyTickets:'numri ditor i biletave',maxDailyStake:'shuma ditore',maxOpenTickets:'numri i biletave të hapura'};
 const values={Events:events,Selections:selections.length,Odds:odds,Stake:stake,Payout:payout};
 for(const type of types){const r=config[type];if(!r?.enabled)return 'Pranimi automatik është joaktiv për '+String(type);
 for(const [name,n] of Object.entries(values)){if(r['min'+name]!=null&&n<r['min'+name])return type+': nën minimumin '+names[name];if(r['max'+name]!=null&&n>r['max'+name])return type+': mbi maksimumin '+names[name];}
 for(const s of selections){if((r.minSelectionOdds!=null||r.maxSelectionOdds!=null)&&(!Number.isFinite(Number(s.odd))||Number(s.odd)<=1))return type+': koeficient përzgjedhjeje i pavlefshëm';if(r.minSelectionOdds!=null&&Number(s.odd)<r.minSelectionOdds||r.maxSelectionOdds!=null&&Number(s.odd)>r.maxSelectionOdds)return type+': koeficient përzgjedhjeje jashtë intervalit';}
 for(const [key,n] of [['maxDailyTickets',context.dailyTickets],['maxDailyStake',context.dailyStake],['maxOpenTickets',context.openTickets]])if(r[key]!=null&&(!Number.isFinite(n)||n>r[key]))return type+': tejkalohet '+names[key];
 }return null;
}
function eligible(...args){return decision(...args)===null;}
function createAcceptance({run,get,all=()=>[],tx,now,money}){
 run('CREATE TABLE IF NOT EXISTS ticket_acceptance_config(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,updated_at TEXT,updated_by INTEGER)');
 run('INSERT OR IGNORE INTO ticket_acceptance_config(id,config) VALUES(1,?)',[JSON.stringify(defaults())]);
 function read(){const row=get('SELECT * FROM ticket_acceptance_config WHERE id=1');const rules=JSON.parse(row.config);for(const kind of ['live','prematch']){if(!Object.hasOwn(rules[kind],'maxEvents')){rules[kind].maxEvents=rules[kind].maxSelections??null;delete rules[kind].maxSelections;}}return {rules:validate(rules),version:Number(row.version),updatedAt:row.updated_at};}
 function mount(app,operatorConfigAuth){
 app.get('/api/operator/ticket-acceptance/accounts',operatorConfigAuth,(req,res)=>{const q=String(req.query.q||'').trim().slice(0,64);res.json({accounts:q?all("SELECT id,username,role FROM users WHERE role IN ('user','agent','partner') AND (instr(lower(username),lower(?))>0 OR CAST(id AS TEXT)=?) ORDER BY username LIMIT 30",[q,q]):[]});});
 app.get('/api/operator/ticket-acceptance',operatorConfigAuth,(req,res)=>{const data=read();res.json({...data,blockedAccounts:data.rules.blacklist.map(id=>get('SELECT id,username,role FROM users WHERE id=?',[id])).filter(Boolean)});});
 app.put('/api/operator/ticket-acceptance',operatorConfigAuth,(req,res)=>{try{const rules=validate(req.body.rules);for(const id of rules.blacklist){const account=get('SELECT role FROM users WHERE id=?',[id]);if(!account||!['user','agent','partner'].includes(account.role))throw Error('Lista e zezë pranon vetëm user, agjent ose partner ekzistues.');}const result=tx(()=>{const previous=read();if(req.body.version!==previous.version){const e=Error('Konfigurimi ka ndryshuar. Rifresko faqen përpara ruajtjes.');e.status=409;throw e;}run('UPDATE ticket_acceptance_config SET config=?,version=version+1,updated_at=?,updated_by=? WHERE id=1',[JSON.stringify(rules),now(),req.user.id]);run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[req.user.id,'ticket_acceptance_config_changed','configuration',1,JSON.stringify({before:previous.rules,after:rules})]);return read();});res.json(result)}catch(e){res.status(e.status||400).json({error:e.message})}});
 }
 // Called inside the placement transaction, after odds, hierarchy and exposure checks.
 // defer: the ticket qualifies but contains live legs, so the caller re-checks the odds after
 // the live safety delay and calls apply() again before any money moves.
 function apply(betId,selections,{defer=false}={}){const config=read(),b=get('SELECT * FROM bets WHERE id=?',[betId]);if(!b||b.status!=='pending')return null;
 const lineage=[];let account=get('SELECT id,parent_id,business_parent_id FROM users WHERE id=?',[b.user_id]);while(account&&!lineage.includes(Number(account.id))&&lineage.length<40){lineage.push(Number(account.id));account=get('SELECT id,parent_id,business_parent_id FROM users WHERE id=?',[account.business_parent_id??account.parent_id??-1]);}
 const daily=get("SELECT COUNT(*) tickets,COALESCE(SUM(stake),0) stake FROM bets WHERE user_id=? AND id<>? AND date(created_at)=date(?) AND status NOT IN ('cancelled','rejected','void')",[b.user_id,b.id,now()]);
 const open=get("SELECT COUNT(*) n FROM bets WHERE user_id=? AND id<>? AND status IN ('pending','accepted')",[b.user_id,b.id]);
 const signature=items=>JSON.stringify(items.map(s=>[String(s.game_id??s.gameId),String(s.market_id??s.marketId??s.market??''),String(s.selection),String(s.special_value??s.specialValue??'')]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
 let repeated=false;if(config.rules.policy.blockRepeats){const current=signature(selections);for(const other of all("SELECT id FROM bets WHERE user_id=? AND id<>? AND status NOT IN ('cancelled','rejected','void')",[b.user_id,b.id])){if(signature(all('SELECT game_id,market_id,market,selection,special_value FROM bet_selections WHERE bet_id=?',[other.id]))===current){repeated=true;break;}}}
 const reason=decision(config.rules,selections,Number(b.stake),Number(b.potential_win),Number(b.total_odds),{lineage,dailyTickets:Number(daily?.tickets||0)+1,dailyStake:money(Number(daily?.stake||0)+Number(b.stake)),openTickets:Number(open?.n||0)+1,repeated});
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
module.exports={createAcceptance,validate,eligible,decision,defaults};
