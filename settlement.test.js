const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync(__dirname+'/server.js','utf8');
const a=src.indexOf('function norm('), b=src.indexOf('async function settleAcceptedBets()',a);
if(a<0||b<0) throw new Error('Settlement section not found');
const code=src.slice(a,b)+'\nthis.api={norm,num,normalizeFinalScore,buildStats,evaluateSelection,finalishTimeline};';
const ctx={console,Date,Math,Number,String,Array,Object,Map,JSON};vm.createContext(ctx);vm.runInContext(code,ctx);
const {buildStats,evaluateSelection}=ctx.api;
function ev(type,team,minute,type_id){return {type,team:String(team),minute, type_id:String(type_id),game_status:type_id==='6'?'255':'3'};}
function game(score='2-2'){return {finished:true,score:ctx.normalizeFinalScore(score)};}
function test(sel,timeline,score='2-2',expected){const stats=buildStats(timeline,ctx.normalizeFinalScore(score));const out=evaluateSelection(sel,stats,game(score),timeline);assert.strictEqual(JSON.stringify(out),JSON.stringify(expected),`${sel.market} ${sel.selection}: ${JSON.stringify(out)} != ${JSON.stringify(expected)}`);}
const finished=[
 ev('Goal',1,'18:00','1'),ev('Goal',1,'23:00','1'),ev('Goal',2,'69:00','1'),ev('Goal',2,'73:00','1'),
 ev('Corner',1,'15:00','2'),ev('Corner',2,'60:00','2'),ev('Corner',2,'69:00','2'),ev('Corner',1,'85:00','2'),
 ev('Yellow card',1,'66:00','4'),ev('Yellow card',2,'70:00','4'),ev('Yellow card',1,'71:00','4'),ev('Yellow card',2,'91:00','4'),
 {type:'End of the match',type_id:'6',team:'0',minute:'2-2',game_status:'255'}
];
test({market_id:'6575',market:'Rezultat Final',selection:'X',odd:2},finished,'2-2',{status:'won',factor:2});
test({market_id:'6577',market:'Numri i Golave ne Ndeshje',selection:'Lart 3.5',odd:1.5},finished,'2-2',{status:'won',factor:1.5});
test({market_id:'6620',market:'Lart/Poshte Korne',selection:'Poshte 4.5',odd:1.67},finished,'2-2',{status:'won',factor:1.67});
test({market_id:'6757',market:'Tek/Cift Live',selection:'Cift',odd:1.4},finished,'2-2',{status:'won',factor:1.4});
test({market_id:'6780',market:'Gol Jo Gol Live',selection:'Po',odd:1.5},finished,'2-2',{status:'won',factor:1.5});
test({market_id:'6581',market:'Shenon golin e dyte (skuadra)',selection:'2',odd:3},finished,'2-2',{status:'lost',factor:0});
test({market_id:'6648',market:'Godet kornen e trembedhjete',selection:'1',odd:3},finished,'2-2',null);
test({market_id:'6660',market:'Godet kornen e fundit',selection:'1',odd:2},finished,'2-2',{status:'won',factor:2});
test({market_id:'6657',market:'Gara e Korneve',selection:'X 3',special_value:'3',odd:2},finished,'2-2',{status:'won',factor:2});
const asian=[ev('Goal',2,'10:00','1'),ev('Goal',1,'20:00','1'),{type:'End of the match',type_id:'6',team:'0',minute:'1-1',game_status:'255'}];
test({market_id:'6665',market:'Handikap Aziatik',selection:'1 -0.25',special_value:'-0.25',odd:2},asian,'1-1',{status:'half_lost',factor:0.5});
test({market_id:'6677',market:'Handikap Aziatik',selection:'1 +0.25',special_value:'+0.25',odd:2},asian,'1-1',{status:'half_won',factor:1.5});
const asianTotal=[ev('Goal',1,'10:00','1'),ev('Goal',2,'20:00','1'),{type:'End of the match',type_id:'6',team:'0',minute:'1-1',game_status:'255'}];
test({market_id:'6711',market:'Lart/Poshte Gola Aziatike',selection:'Lart 1.75',special_value:'1.75',odd:2},asianTotal,'1-1',{status:'half_won',factor:1.5});
const sh=[ev('Goal',1,'20:00','1'),{type:'End of the first half',type_id:'5',team:'0',minute:'1-0',game_status:'2'},ev('Goal',2,'70:00','1'),{type:'End of the match',type_id:'6',team:'0',minute:'1-1',game_status:'255'}];
test({market_id:'6662',market:'Rezultati i Pjeses se Dyte',selection:'2',odd:3},sh,'1-1',{status:'won',factor:3});
test({market_id:'6819',market:'Shenon Udhetuesi ne P2',selection:'Po',odd:2},sh,'1-1',{status:'won',factor:2});
// Named variants use the same authoritative score, including period-specific markets.
for(const [market,selection,expected] of [
 ['Total Goals','Over 3.5','won'],['Both Teams To Score','Yes','won'],
 ['Away Team Total Goals','Under 1.5','lost'],['Correct Score','2-2','won'],
 ['Shansi i dyfishtë','1X','won'],['Total Goals Odd/Even','Even','won']
])test({market,selection,odd:2},finished,'2-2',{status:expected,factor:expected==='won'?2:0});
for(const [market,selection,expected] of [
 ['First Half - Match Result','1','won'],['Second Half - Match Result','2','won'],
 ['First Half - Both Teams To Score','No','won'],['Second Half - Total Goals','Over 1.5','lost'],
 ['Correct Score - First Half','1-0','won'],['Pjesa e dytë - Gol Jo Gol','Jo','won']
])test({market,selection,odd:2},sh,'1-1',{status:expected,factor:expected==='won'?2:0});
test({market:'Total Goals',selection:'Over',special_value:'3.5',odd:2},finished,'2-2',{status:'won',factor:2});
test({market:'First Half - Match Result',selection:'1',odd:2},finished,'2-2',null);
test({market:'Total Cards',selection:'Over 2.5',odd:2},finished,'2-2',null);
test({market_id:'6832',market:'Penalty shootout winner',selection:'1',odd:2},finished,'2-2',null);
// Final score is sufficient for score markets; missing event data is never treated as zero corners.
test({market:'Fulltime Result',selection:'1',odd:2},null,'2-0',{status:'won',factor:2});
test({market_id:'6620',market:'Lart/Poshte Korne',selection:'Under 2.5',odd:2},null,'2-0',null);
test({market_id:'6578',market:'First Goal',selection:'1',odd:2},[finished[finished.length-1]],'2-2',null);
test({market:'Fulltime Result',selection:'Home',odd:2},null,'2-0',{status:'won',factor:2});
test({market:'Double Chance',selection:'1 / X',odd:2},finished,'2-2',{status:'won',factor:2});
test({market_id:'6840',market:'FT / BTTS',selection:'X | GG',odd:2},finished,'2-2',{status:'won',factor:2});
test({market_id:'6840',market:'FT / BTTS',selection:'X | unknown',odd:2},finished,'2-2',null);
console.log('settlement tests: PASS');
