const {test}=require('node:test'),assert=require('node:assert/strict');
const {countTicketRepeats}=require('./ticket-repeats');
const selection=(bet_id,user_id,game_id='100',choice='1',line='')=>({bet_id,user_id,game_id,market_id:'6575',selection:choice,special_value:line});
test('same event and market count across outcomes and all tickets, independently per user',()=>{
  const counts=countTicketRepeats([selection(1,10),selection(2,10),selection(3,20),selection(4,10),selection(5,10),selection(6,10,'100','2'),selection(7,10,'101')]);
  assert.deepEqual([...counts.values()],[5,5,1,5,5,5,1]);
});
test('adding a match changes the full ticket while order and outcome changes do not',()=>{
  const counts=countTicketRepeats([selection(1,10),selection(1,10,'200'),selection(2,10,'200'),selection(2,10),selection(3,10),selection(4,10,'100','1','0.5'),selection(5,10,'100','1','1.5')]);
  assert.deepEqual([...counts.values()],[2,2,3,3,3]);
});
test('different markets are separate and one ticket counts once per event and market',()=>{
  const other={...selection(3,10),market_id:'6780'};
  const counts=countTicketRepeats([selection(1,10),selection(1,10,'100','2'),selection(2,10),other]);
  assert.deepEqual([...counts.values()],[1,1,1]);
});
test('nine identical tickets followed by a ticket with another match restart at one',()=>{
  const rows=Array.from({length:9},(_,i)=>selection(i+1,10));
  rows.push(selection(10,10),selection(10,10,'200'));
  const counts=countTicketRepeats(rows);
  for(let id=1;id<=9;id++)assert.equal(counts.get(id),9);
  assert.equal(counts.get(10),1);
});
