'use strict';
module.exports=function({all,get,run,tx,validateSelections,money}){
  const active=new Map();
  async function quote(id){
    if(active.has(id))return active.get(id);
    const work=(async()=>{
      const selections=all('SELECT id,game_id AS gameId,coef_id AS coefId,market_id AS marketId,selection,odd,special_value AS specialValue FROM bet_selections WHERE bet_id=? ORDER BY id',[id]);
      const check=await validateSelections(selections.map(s=>({...s,odd:Number(s.odd)>1?Number(s.odd):1.01})));
      let invalid=check.invalid.length>0;
      tx(()=>{
        if(get('SELECT status FROM bets WHERE id=?',[id])?.status!=='pending')return;
        for(const s of selections){
          const matches=x=>String(x.gameId)===String(s.gameId)&&String(x.coefId||'')===String(s.coefId||'')&&String(x.selection)===String(s.selection);
          const closed=check.invalid.some(matches),changed=check.changed.find(matches),current=check.current.find(x=>Number(x.id)===Number(s.id));
          const odd=closed?0:Number(changed?.newOdd??current?.odd??s.odd);
          if(odd!==Number(s.odd))run('UPDATE bet_selections SET odd=? WHERE id=?',[odd,s.id]);
        }
        const total=invalid?0:money(all('SELECT odd FROM bet_selections WHERE bet_id=?',[id]).reduce((n,s)=>n*Number(s.odd),1));
        const bet=get('SELECT stake,total_odds FROM bets WHERE id=?',[id]);
        if(Number(bet.total_odds)!==total){
          run('UPDATE bets SET total_odds=?,potential_win=? WHERE id=?',[total,money(Number(bet.stake)*total),id]);
          // An offer based on an older quote must be reviewed again.
          run("UPDATE bet_offers SET status='expired' WHERE bet_id=? AND status='pending'",[id]);
        }
      });
      return {invalid};
    })();
    active.set(id,work);
    try{return await work;}finally{active.delete(id);}
  }
  async function refresh({userId=null,id=null}={}){
    let sql="SELECT id FROM bets WHERE status='pending'";const args=[];
    if(userId!=null){sql+=' AND user_id=?';args.push(userId);}
    if(id!=null){sql+=' AND id=?';args.push(id);}
    const results=await Promise.all(all(sql,args).map(b=>quote(Number(b.id))));
    return {invalid:results.some(r=>r.invalid)};
  }
  return {refresh};
};
