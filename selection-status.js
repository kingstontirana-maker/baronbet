'use strict';
module.exports=function({all,get,run,tx,now,money}){
 if(!all('PRAGMA table_info(bet_selections)').some(c=>c.name==='manual_result'))run('ALTER TABLE bet_selections ADD COLUMN manual_result TEXT');
 function update(betId,selectionId,status,actor){
  if(!['won','pending','lost'].includes(status))throw Error('Status i pavlefshëm.');
  return tx(()=>{
   const bet=get('SELECT * FROM bets WHERE id=?',[betId]);
   if(!bet||!['pending','accepted','won','lost','void'].includes(bet.status))throw Error('Bileta nuk mund të ndryshohet.');
   const selection=get('SELECT * FROM bet_selections WHERE id=? AND bet_id=?',[selectionId,betId]);
   if(!selection)throw Error('Përzgjedhja nuk u gjet në këtë biletë.');
   run('UPDATE bet_selections SET result_status=?,manual_result=? WHERE id=? AND bet_id=?',[status,status,selectionId,betId]);
   let ticketStatus=bet.status,payout=Number(bet.payout||0),adjustment=0;
   if(bet.status!=='pending'){
    const selections=all('SELECT odd,result_status FROM bet_selections WHERE bet_id=?',[betId]);
    const factor=s=>s.result_status==='won'?Number(s.odd):s.result_status==='void'?1:s.result_status==='half_won'?(Number(s.odd)+1)/2:s.result_status==='half_lost'?0.5:0;
    const complete=selections.every(s=>['won','lost','void','half_won','half_lost'].includes(s.result_status));
    ticketStatus=selections.some(s=>s.result_status==='lost')?'lost':complete?(selections.every(s=>s.result_status==='void')?'void':'won'):'accepted';
    payout=complete&&ticketStatus!=='lost'?money(Number(bet.stake)*selections.reduce((n,s)=>n*factor(s),1)):0;
    adjustment=money(payout-Number(bet.payout||0));
    if(adjustment){
     const user=get('SELECT balance FROM users WHERE id=?',[bet.user_id]);
     const balance=money(Number(user.balance)+adjustment);
     run('UPDATE users SET balance=? WHERE id=?',[balance,bet.user_id]);
     run('INSERT INTO wallet_transactions(user_id,type,amount,balance_after,bet_id,note) VALUES(?,?,?,?,?,?)',[bet.user_id,adjustment>0?'payout':'adjustment',adjustment,balance,betId,'Manual selection result correction']);
    }
    run('UPDATE bets SET status=?,payout=?,settled_at=? WHERE id=?',[ticketStatus,payout,ticketStatus==='accepted'?null:now(),betId]);
   }
   run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)',[actor.id,'selection_status_changed','bet_selection',selectionId,JSON.stringify({betId,previous:selection.result_status,status,previousTicketStatus:bet.status,ticketStatus,payout,adjustment})]);
   return {status,ticketStatus,payout,adjustment};
  });
 }
 function mount(app,guard){app.post('/api/operator/tickets/:id/selections/:selectionId/status',guard,(req,res)=>{try{res.json({ok:true,...update(Number(req.params.id),Number(req.params.selectionId),req.body.status,req.user)});}catch(e){res.status(400).json({error:e.message});}});}
 return {update,mount};
};
