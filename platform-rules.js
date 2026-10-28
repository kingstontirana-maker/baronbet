'use strict';
// Centre-wide rules for what a ticket may contain and how long it may wait for an operator.
const {marketKey}=require('./competition-control');
function defaults(){return {pendingTimeoutMinutes:0,minSelections:1,maxSelections:20,minSelectionOdd:null,minTotalOdds:null,maxTotalOdds:null,sameEvent:'review',liveWithPrematch:'allow',forbiddenPairs:[]};}
function validate(input){
 const c={...defaults(),...(input&&typeof input==='object'?input:{})},fail=m=>{throw Error(m);};
 const int=(v,min,max,label)=>{if(!Number.isInteger(v)||v<min||v>max)fail(label+' duhet të jetë numër i plotë '+min+'-'+max+'.');return v;};
 const odd=(v,label)=>{if(v===null)return null;if(typeof v!=='number'||!Number.isFinite(v)||v<1||v>1000000)fail(label+' duhet të jetë 1-1000000 ose bosh.');return Math.round(v*100)/100;};
 const out={
  pendingTimeoutMinutes:int(c.pendingTimeoutMinutes,0,1440,'Koha maksimale në pritje'),
  minSelections:int(c.minSelections,1,20,'Numri minimal i ndeshjeve'),
  maxSelections:int(c.maxSelections,1,20,'Numri maksimal i ndeshjeve'),
  minSelectionOdd:odd(c.minSelectionOdd,'Koeficienti minimal për ndeshje'),
  minTotalOdds:odd(c.minTotalOdds,'Koeficienti minimal total'),
  maxTotalOdds:odd(c.maxTotalOdds,'Koeficienti maksimal total'),
  sameEvent:['review','forbid'].includes(c.sameEvent)?c.sameEvent:fail('Rregulli për të njëjtën ndeshje është i pavlefshëm.'),
  liveWithPrematch:['allow','forbid'].includes(c.liveWithPrematch)?c.liveWithPrematch:fail('Rregulli live me prematch është i pavlefshëm.'),
  forbiddenPairs:[]
 };
 if(out.minSelections>out.maxSelections)fail('Numri minimal i ndeshjeve nuk mund të jetë mbi maksimumin.');
 if(out.minTotalOdds!==null&&out.maxTotalOdds!==null&&out.minTotalOdds>out.maxTotalOdds)fail('Koeficienti minimal total nuk mund të jetë mbi maksimumin.');
 if(!Array.isArray(c.forbiddenPairs)||c.forbiddenPairs.length>200)fail('Lista e kombinimeve të ndaluara është e pavlefshme.');
 const seen=new Set();
 for(const pair of c.forbiddenPairs){
  if(!Array.isArray(pair)||pair.length!==2)fail('Çdo kombinim i ndaluar ka dy market-e.');
  const [a,b]=pair.map(marketKey).sort();if(!a||!b)fail('Zgjidh dy market-e për çdo kombinim të ndaluar.');
  const key=a+'\n'+b;if(!seen.has(key)){seen.add(key);out.forbiddenPairs.push([a,b]);}
 }
 return out;
}
// Throws with the reason a ticket cannot be placed under these rules.
function checkTicket(rules,selections,totalOdds){
 const fail=m=>{throw Object.assign(Error(m),{status:400,code:'TICKET_RULE'});};
 const n=selections.length;
 if(n<rules.minSelections)fail('Bileta duhet të ketë të paktën '+rules.minSelections+' ndeshje.');
 if(n>rules.maxSelections)fail('Bileta mund të ketë deri në '+rules.maxSelections+' ndeshje.');
 if(rules.minSelectionOdd!==null)for(const s of selections)if(Number(s.odd)<rules.minSelectionOdd)fail('Koeficienti minimal për çdo ndeshje është '+rules.minSelectionOdd.toFixed(2)+'.');
 if(rules.minTotalOdds!==null&&totalOdds<rules.minTotalOdds)fail('Koeficienti total duhet të jetë të paktën '+rules.minTotalOdds.toFixed(2)+'.');
 if(rules.maxTotalOdds!==null&&totalOdds>rules.maxTotalOdds)fail('Koeficienti total mund të jetë deri në '+rules.maxTotalOdds.toFixed(2)+'.');
 const byEvent=new Map();for(const s of selections){const id=String(s.gameId??s.game_id);if(!byEvent.has(id))byEvent.set(id,[]);byEvent.get(id).push(s);}
 if(rules.sameEvent==='forbid'&&[...byEvent.values()].some(list=>list.length>1))fail('Nuk lejohen dy zgjedhje nga e njëjta ndeshje.');
 if(rules.liveWithPrematch==='forbid'){const types=new Set(selections.map(s=>s.acceptanceType==='live'?'live':'prematch'));if(types.size>1)fail('Ndeshjet live nuk kombinohen me ndeshjet prematch.');}
 if(rules.forbiddenPairs.length)for(const list of byEvent.values()){
  const keys=list.map(s=>marketKey(s.market));
  for(const [a,b] of rules.forbiddenPairs){const i=keys.indexOf(a),j=keys.lastIndexOf(b);if(i>=0&&j>=0&&(a!==b||keys.filter(k=>k===a).length>1))fail('Këto market-e nuk kombinohen në të njëjtën ndeshje: '+list[i].market+' + '+list[j].market+'.');}
 }
}
function createPlatformRules({run,get,all,tx,now}){
 run('CREATE TABLE IF NOT EXISTS platform_rules(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,updated_at TEXT,updated_by INTEGER)');
 run('INSERT OR IGNORE INTO platform_rules(id,config) VALUES(1,?)',[JSON.stringify(defaults())]);
 function read(){const row=get('SELECT * FROM platform_rules WHERE id=1');return {rules:validate(JSON.parse(row.config)),version:Number(row.version),updatedAt:row.updated_at};}
 const check=(selections,totalOdds)=>checkTicket(read().rules,selections,totalOdds);
 // Pending tickets older than the configured time are refused and the stake is released.
 function expirePending(onRejected=()=>{}){
  const minutes=read().rules.pendingTimeoutMinutes;if(!minutes)return [];
  const cutoff=new Date(Date.parse(now())-minutes*60000).toISOString();
  const expired=[];
  for(const b of all("SELECT id FROM bets WHERE status='pending' AND datetime(created_at)<=datetime(?) ORDER BY id LIMIT 200",[cutoff])){
   const done=tx(()=>{const bet=get('SELECT * FROM bets WHERE id=?',[b.id]);if(!bet||bet.status!=='pending')return null;
    const u=get('SELECT reserved_balance FROM users WHERE id=?',[bet.user_id]);const reserved=Math.round((Number(u.reserved_balance)-Number(bet.stake))*100)/100;
    run('UPDATE users SET reserved_balance=? WHERE id=?',[Math.max(0,reserved),bet.user_id]);
    run("UPDATE bets SET status='rejected',reserved=0,settled_at=? WHERE id=? AND status='pending'",[now(),bet.id]);
    run("UPDATE bet_selections SET result_status='rejected' WHERE bet_id=?",[bet.id]);
    try{run("UPDATE bet_offers SET status='expired' WHERE bet_id=? AND status='pending'",[bet.id]);}catch(_){}
    run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[null,'ticket_timeout_rejected','bet',bet.id,JSON.stringify({minutes})]);
    return {betId:Number(bet.id),userId:Number(bet.user_id)};});
   if(done){expired.push(done);onRejected(done);}
  }
  return expired;
 }
 function mount(app,auth){
  app.get('/api/center/platform-rules',auth,(req,res)=>{const markets=all("SELECT id,name FROM competition_nodes WHERE kind='market' ORDER BY name");res.json({...read(),markets});});
  app.put('/api/center/platform-rules',auth,(req,res)=>{try{const rules=validate(req.body.rules);const result=tx(()=>{const previous=read();if(req.body.version!==previous.version)throw Object.assign(Error('Konfigurimi ka ndryshuar. Rifresko faqen përpara ruajtjes.'),{status:409});run('UPDATE platform_rules SET config=?,version=version+1,updated_at=?,updated_by=? WHERE id=1',[JSON.stringify(rules),now(),req.user.id]);run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[req.user.id,'platform_rules_changed','configuration',1,JSON.stringify({before:previous.rules,after:rules})]);return read();});res.json(result);}catch(e){res.status(e.status||400).json({error:e.message});}});
 }
 return {mount,read,check,expirePending};
}
module.exports={createPlatformRules,validate,checkTicket,defaults};
