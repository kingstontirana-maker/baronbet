'use strict';
function countTicketRepeats(rows){
  const tickets=new Map(),counts=new Map(),result=new Map();
  for(const row of rows){
    if(!tickets.has(Number(row.bet_id)))tickets.set(Number(row.bet_id),{userId:String(row.user_id),selections:[]});
    tickets.get(Number(row.bet_id)).selections.push(row);
  }
  for(const ticket of tickets.values()){
    ticket.keys=new Set(ticket.selections.map(s=>JSON.stringify([ticket.userId,String(s.game_id),String(s.market_id||s.market||'').trim()])));
    for(const key of ticket.keys)counts.set(key,(counts.get(key)||0)+1);
  }
  // A multi ticket shows the highest repetition count among its event/market pairs.
  for(const [id,ticket] of tickets)result.set(id,Math.max(...[...ticket.keys].map(key=>counts.get(key)),1));
  return result;
}
function loadTicketRepeats(tickets,all){
  if(!tickets.length)return new Map();
  const users=[...new Set(tickets.map(b=>Number(b.user_id)))];
  const rows=all(`SELECT b.id AS bet_id,b.user_id,s.game_id,s.market_id,s.market FROM bets b JOIN bet_selections s ON s.bet_id=b.id WHERE b.user_id IN (${users.map(()=>'?').join(',')}) ORDER BY b.id,s.id`,users);
  return countTicketRepeats(rows);
}
module.exports={countTicketRepeats,loadTicketRepeats};
