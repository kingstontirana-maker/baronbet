const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
async function fixture(){
 const SQL=await require('sql.js')(),db=new SQL.Database();
 db.run("CREATE TABLE event_identities(game_id TEXT PRIMARY KEY,api_id TEXT,sport_id TEXT);CREATE TABLE bet_selections(game_id TEXT,game_api_id TEXT);INSERT INTO bet_selections VALUES('3036903',''),('540300605','')");
 const ctx={console,saveDb(){},run:(sql,args=[])=>db.run(sql,args),get:(sql,args=[])=>{const q=db.prepare(sql);q.bind(args);const row=q.step()?q.getAsObject():null;q.free();return row;}};
 const source=fs.readFileSync('server.js','utf8');vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('function rememberEventIdentities('),source.indexOf('async function feedGames(')),ctx);
 vm.runInContext(source.slice(source.indexOf('function norm('),source.indexOf('function eventTimeSeconds(')),ctx);
 return ctx;
}
test('real nested provider detail uses game_id and game_api_id, never coefficient id or api_id',async()=>{
 const ctx=await fixture(),data=JSON.parse(fs.readFileSync('artifacts/inca-simulation-markets.json','utf8'));
 ctx.rememberEventIdentities(data);
 assert.equal(ctx.get("SELECT api_id FROM event_identities WHERE game_id='3036903'").api_id,'14720052');
 assert.equal(ctx.get("SELECT game_api_id FROM bet_selections WHERE game_id='3036903'").game_api_id,'14720052');
 assert.equal(ctx.get("SELECT game_api_id FROM bet_selections WHERE game_id='540300605'").game_api_id,'');
 assert.equal(ctx.extractGameRecord(data,'3036903').record.game_api_id,14720052);
 assert.equal(ctx.extractGameRecord(data,'540300605'),null);
 ctx.rememberEventIdentities([[{id:99,game_id:88,api_id:1}]]);
 assert.equal(ctx.get("SELECT api_id FROM event_identities WHERE game_id='88'"),null);
});
test('missing historical identity is recovered through prematch detail after empty live detail',async()=>{
 const ctx=await fixture(),calls=[];ctx.feedGames=async()=>[];
 ctx.proxy=async path=>{calls.push(path);return {status:200,text:JSON.stringify(path.includes('/prematchgame/')?[[{id:540300605,game_id:3036903,game_api_id:14720052,api_id:1,api_status:255,result:'1-3'}]]:[])};};
 const game=await ctx.fetchFinalGame('3036903',new Map());
 assert.equal(game.finished,true);assert.equal(game.score.away,3);
 assert.equal(ctx.get("SELECT game_api_id FROM bet_selections WHERE game_id='3036903'").game_api_id,'14720052');
 assert.deepEqual(calls,['/ajax/livegame/3036903','/ajax/prematchgame/3036903']);
});
test('unavailable historical events are not guessed and repeated failed recovery is throttled',async()=>{
 const ctx=await fixture();let calls=0;ctx.feedGames=async()=>[];ctx.proxy=async()=>{calls++;return {status:200,text:'[]'};};
 assert.equal(await ctx.fetchFinalGame('3036903',new Map()),null);
 assert.equal(await ctx.fetchFinalGame('3036903',new Map()),null);
 assert.equal(calls,2);assert.equal(ctx.get("SELECT api_id FROM event_identities WHERE game_id='3036903'"),null);
});
