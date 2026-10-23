const assert=require('node:assert/strict');
const init=require('sql.js');
(async()=>{
 const db=new (await init()).Database();
 db.run("CREATE TABLE bets(id INTEGER,status TEXT,stake REAL,total_odds REAL,potential_win REAL,user_id INTEGER); CREATE TABLE bet_selections(id INTEGER,bet_id INTEGER,game_id TEXT,coef_id TEXT,market_id TEXT,selection TEXT,odd REAL,special_value TEXT); CREATE TABLE bet_offers(bet_id INTEGER,status TEXT); INSERT INTO bets VALUES(1,'pending',10,2,20,7),(2,'accepted',10,2,20,7); INSERT INTO bet_selections VALUES(1,1,'g1','c1','m1','1',2,''),(2,2,'g1','c1','m1','1',2,''); INSERT INTO bet_offers VALUES(1,'pending')");
 const all=(sql,args=[])=>{const s=db.prepare(sql);s.bind(args);const rows=[];while(s.step())rows.push(s.getAsObject());s.free();return rows;};
 const get=(...args)=>all(...args)[0],run=(sql,args)=>db.run(sql,args);
 let odd=3;
 const quotes=require('./pending-quotes')({all,get,run,tx:fn=>fn(),validateSelections:async selections=>({current:[],changed:odd>1?selections.map(s=>({...s,newOdd:odd})):[],invalid:odd>1?[]:selections})});
 const ticket=()=>get('SELECT b.total_odds,b.potential_win,s.odd,s.current_odd FROM bets b JOIN bet_selections s ON s.bet_id=b.id WHERE b.id=1');

 // A moved market is reported, never written into the player's ticket.
 let r=await quotes.refresh({userId:7});
 assert.deepEqual(r.changes,[{betId:1,selectionId:1,selection:'1',odd:2,currentOdd:3}]);assert.equal(r.invalid,false);
 assert.deepEqual(ticket(),{total_odds:2,potential_win:20,odd:2,current_odd:3});
 assert.equal(get('SELECT status FROM bet_offers').status,'pending','an operator offer survives a market move');
 assert.equal(get('SELECT current_odd FROM bet_selections WHERE id=2').current_odd,null,'accepted tickets are not re-quoted');

 // A closed market blocks acceptance and is recorded as 0, odds untouched.
 odd=0;r=await quotes.refresh({id:1});
 assert.equal(r.invalid,true);assert.deepEqual(ticket(),{total_odds:2,potential_win:20,odd:2,current_odd:0});

 // Back to the player's own price: nothing to confirm.
 odd=2;r=await quotes.refresh({id:1});
 assert.deepEqual(r.changes,[]);assert.equal(r.invalid,false);
 console.log('Pending quotes: moved and closed markets are reported without rewriting the ticket PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
