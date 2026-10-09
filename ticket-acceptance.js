'use strict';
const defaults=()=>({live:{enabled:false,maxStake:50,maxPayout:500,maxOdds:20,maxSelections:5},prematch:{enabled:false,maxStake:100,maxPayout:1000,maxOdds:50,maxSelections:10}});
function validate(value){
 const out={};for(const kind of ['live','prematch']){const r=value?.[kind];if(!r||typeof r.enabled!=='boolean')throw Error('Konfigurim i pavlefshëm: '+kind);out[kind]={enabled:r.enabled};
 for(const [key,max] of Object.entries({maxStake:100000000,maxPayout:100000000,maxOdds:1000000,maxSelections:100})){const n=r[key];if(n===null||n===''){out[kind][key]=null;continue;}if(typeof n!=='number'||!Number.isFinite(n)||n<=0||n>max||(key==='maxSelections'&&!Number.isInteger(n)))throw Error('Limit i pavlefshëm: '+key);out[kind][key]=n;}}
 return out;
}
function eligible(config,selections,stake,payout,odds){
 if(!selections.length)return false;
 return selections.every(s=>{const r=config[s.acceptanceType];return r?.enabled===true&&(r.maxStake===null||stake<=r.maxStake)&&(r.maxPayout===null||payout<=r.maxPayout)&&(r.maxOdds===null||odds<=r.maxOdds)&&(r.maxSelections===null||selections.length<=r.maxSelections)});
}
function createAcceptance({run,get,tx,now,money}){
 run('CREATE TABLE IF NOT EXISTS ticket_acceptance_config(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,updated_at TEXT,updated_by INTEGER)');
 run('INSERT OR IGNORE INTO ticket_acceptance_config(id,config) VALUES(1,?)',[JSON.stringify(defaults())]);
 function read(){const row=get('SELECT * FROM ticket_acceptance_config WHERE id=1');return {rules:JSON.parse(row.config),version:Number(row.version),updatedAt:row.updated_at};}
 function mount(app,centerAuth){
 app.get('/api/center/ticket-acceptance',centerAuth,(req,res)=>res.json(read()));
 app.put('/api/center/ticket-acceptance',centerAuth,(req,res)=>{try{const rules=validate(req.body.rules);const result=tx(()=>{const previous=read();if(req.body.version!==previous.version){const e=Error('Konfigurimi ka ndryshuar. Rifresko faqen përpara ruajtjes.');e.status=409;throw e;}run('UPDATE ticket_acceptance_config SET config=?,version=version+1,updated_at=?,updated_by=? WHERE id=1',[JSON.stringify(rules),now(),req.user.id]);run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[req.user.id,'ticket_acceptance_config_changed','configuration',1,JSON.stringify({before:previous.rules,after:rules})]);return read();});res.json(result)}catch(e){res.status(e.status||400).json({error:e.message})}});
 }
 // Called inside the placement transaction, after odds, hierarchy and exposure checks.
 function apply(betId,selections){const config=read(),b=get('SELECT * FROM bets WHERE id=?',[betId]);if(!b||b.status!=='pending'||!eligible(config.rules,selections,Number(b.stake),Number(b.potential_win),Number(b.total_odds)))return null;
 const u=get('SELECT id,balance,reserved_balance,status FROM users WHERE id=?',[b.user_id]);if(!u||u.status!=='active'||Number(u.reserved_balance)<Number(b.stake)||Number(u.balance)<Number(u.reserved_balance))throw Error('Krediti nuk lejon pranimin e biletës.');
 const balance=money(Number(u.balance)-Number(b.stake)),reservedBalance=money(Number(u.reserved_balance)-Number(b.stake));
 run('UPDATE users SET balance=?,reserved_balance=? WHERE id=?',[balance,reservedBalance,u.id]);run("UPDATE bets SET status='accepted',reserved=0,accepted_by=NULL,accepted_at=? WHERE id=? AND status='pending'",[now(),b.id]);
 run('INSERT INTO wallet_transactions(user_id,type,amount,balance_after,bet_id,note) VALUES(?,?,?,?,?,?)',[u.id,'bet',-Number(b.stake),balance,b.id,'Ticket automatically accepted']);
 run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[null,'ticket_auto_accepted','bet',b.id,JSON.stringify({configVersion:config.version,types:[...new Set(selections.map(s=>s.acceptanceType))],rules:config.rules})]);return {status:'accepted',balance,reservedBalance};
 }
 return {mount,apply,read};
}
module.exports={createAcceptance,validate,eligible,defaults};
