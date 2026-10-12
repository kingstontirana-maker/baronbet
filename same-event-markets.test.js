const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ui=fs.readFileSync('public/euro07.bet/vbet/user/build/main.js','utf8');
function setup(){const ctx={user:{role:'user'},slip:[],mode:'prematch',cache:[],renderSlip(){},render(){},renderLive(){},lock:v=>!Number.isFinite(Number(v))||Number(v)<=1,parseOdds:()=>({'1':{odd:2,coefId:'10',marketId:'1'},'2':{odd:3,coefId:'11',marketId:'1'}})};vm.createContext(ctx);vm.runInContext(ui.slice(ui.indexOf('function addPick('),ui.indexOf('function normalizeLiveMarkets(')),ctx);return ctx;}
test('same-event markets coexist, individual picks toggle, and same-market outcomes replace',()=>{
 const c=setup(),g={id:77},pick=(id,market_id,special_value='')=>c.addMarketPick(g,{market_option_id:id,market_id,special_value,market_option:'Over',odd:2});
 c.addPick(g,'1',2);pick('20','2','2.5');assert.equal(c.slip.length,2);
 c.addPick(g,'2',3);assert.equal(c.slip.length,2);assert.equal(c.slip[0].coefId,'20');
 pick('21','2','2.5');assert.equal(c.slip.length,2);assert.equal(c.slip[1].coefId,'21');
 pick('22','2','3.5');assert.equal(c.slip.length,3);
 pick('21','2','2.5');assert.equal(c.slip.length,2);assert(c.slip.some(s=>s.coefId==='22'));
 c.addMarketPick(g,{market_option_id:'10',market_id:'1',market_option:'1',odd:2});assert.equal(c.slip.length,2);assert(c.slip.some(s=>s.coefId==='10'));
});
test('server accepts different markets and rejects duplicate canonical market lines',()=>{
 const source=fs.readFileSync('server.js','utf8'),start=source.indexOf('const markets=new Set(check.current'),end=source.indexOf('const out=tx(',start);
 assert(start>=0);const guard=source.slice(start,end);
 function check(current){const ctx={check:{current},res:{},jsonError:(_res,status,error)=>({status,error})};vm.createContext(ctx);return vm.runInContext('(function(){'+guard+'return null;})()',ctx);}
 const a={gameId:'77',marketId:'1',specialValue:''},b={gameId:'77',marketId:'2',specialValue:'2.5'};
 assert.equal(check([a,b]),null);assert.equal(check([b,{...b,specialValue:'3.5'}]),null);
 assert.equal(check([a,{...a,coefId:'other'}]).status,400);assert.equal(check([b,{...b}]).status,400);
});
