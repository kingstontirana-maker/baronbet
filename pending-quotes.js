'use strict';
// Re-quotes pending tickets against the provider. The ticket's own odds are never changed
// here: only the player changes them, by accepting an operator offer. The market price is
// kept in bet_selections.current_odd (0 = market closed) so the operator can decide.
module.exports=function({all,get,run,tx,validateSelections}){
  if(!all('PRAGMA table_info(bet_selections)').some(c=>c.name==='current_odd'))run('ALTER TABLE bet_selections ADD COLUMN current_odd REAL');
  const active=new Map();
  async function quote(id){
    if(active.has(id))return active.get(id);
    const work=(async()=>{
      const selections=all('SELECT id,game_id AS gameId,coef_id AS coefId,market_id AS marketId,selection,odd,special_value AS specialValue FROM bet_selections WHERE bet_id=? ORDER BY id',[id]);
      const check=await validateSelections(selections.map(s=>({...s,odd:Number(s.odd)>1?Number(s.odd):1.01})));
      const changes=[];let invalid=false;
      tx(()=>{
        if(get('SELECT status FROM bets WHERE id=?',[id])?.status!=='pending')return;
        for(const s of selections){
          const matches=x=>String(x.gameId)===String(s.gameId)&&String(x.coefId||'')===String(s.coefId||'')&&String(x.selection)===String(s.selection);
          const closed=check.invalid.some(matches),changed=check.changed.find(matches);
          const current=closed?0:Number(changed?.newOdd??s.odd);
          if(closed)invalid=true;
          else if(current!==Number(s.odd))changes.push({betId:id,selectionId:Number(s.id),selection:String(s.selection),odd:Number(s.odd),currentOdd:current});
          run('UPDATE bet_selections SET current_odd=? WHERE id=?',[current,s.id]);
        }
      });
      return {invalid,changes};
    })();
    active.set(id,work);
    try{return await work;}finally{active.delete(id);}
  }
  async function refresh({userId=null,id=null}={}){
    let sql="SELECT id FROM bets WHERE status='pending'";const args=[];
    if(userId!=null){sql+=' AND user_id=?';args.push(userId);}
    if(id!=null){sql+=' AND id=?';args.push(id);}
    const results=await Promise.all(all(sql,args).map(b=>quote(Number(b.id))));
    return {invalid:results.some(r=>r.invalid),changes:results.flatMap(r=>r.changes)};
  }
  return {refresh};
};
