const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('server.js','utf8');
async function check(live,closed){
 const calls=[],game={id:77,league_id:9,sport_id:1,odd:'123|2|X|1|Rezultat Final'};
 const row={id:123,game_id:77,market_id:1,market_option:'X',odd:closed?0:2};
 const ctx={console,Map,Set,JSON,Number,String,Array,Math,Promise,prematchLeagueByGame:new Map(live?[['77','9']]:[]),rememberEventIdentities(){},access:{rememberLeagues(){}},proxy:async path=>{calls.push(path);let data=[];if(path.includes('livegames?'))data=live?[game]:[];else if(path.includes('prematchgames24hour')||path.includes('gamesByLeague'))data=[game];else if(path===(live?'/ajax/livegame/77':'/ajax/prematchgame/77'))data=[[row]];return {status:200,text:JSON.stringify(data)}}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function feedGames()'),source.indexOf('// ---- Automatic settlement engine')),ctx);
 const result=await ctx.validateSelections([{gameId:'77',coefId:'123',marketId:'1',selection:'X',odd:2,specialValue:'',marketType:'summary'}]);
 assert(calls.includes(live?'/ajax/livegame/77':'/ajax/prematchgame/77'));
 assert.equal(result.invalid.length,closed?1:0);assert.equal(result.changed.length,0);
}
(async()=>{await check(false,false);await check(true,false);await check(false,true);console.log('Prematch/live routing and closed odds: PASS')})().catch(e=>{console.error(e);process.exitCode=1});
