const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('public/euro07.bet/vbet/user/build/main.js','utf8');
test('timeline route resolves the local game ID to the provider API ID',async()=>{
  const server=fs.readFileSync('server.js','utf8');
  for(const initiallyKnown of [true,false]){
    let handler,known=initiallyKnown;
    const calls=[],response={set(){}};
    const ctx=vm.createContext({app:{get(path,callback){handler=callback;}},get:()=>known?{api_id:'14720180'}:null,
      proxy:async path=>{calls.push(path);return {status:200,text:'[]'};},
      rememberFeedIdentities:()=>{known=true;},sendFeedResponse:(res,data)=>{res.data=data;},jsonError:()=>assert.fail('unexpected route error')});
    vm.runInContext(server.slice(server.indexOf("  app.get('/api/livegame/:gameId/timeline'"),server.indexOf("  app.get('/api/livegame/:gameId/stream'")),ctx);
    await handler({params:{gameId:'3037009'}},response);
    assert.equal(calls.at(-1),'/games-timeline/14720180.json');
    assert(!calls.includes('/games-timeline/3037009.json'));
    assert.equal(calls.length,initiallyKnown?1:2);
    assert.equal(response.data.status,200);
  }
});
function context(){
  const ctx=vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('const liveCornerScores='),source.indexOf('async function refreshLiveCorners(')),ctx);
  return ctx;
}
test('provider timeline counts home and away corners independently of goals and cards',()=>{
  const ctx=context(),fixtures=require('./fixtures/settlement-timelines.json');
  const score=ctx.cornerScoreFromTimeline(fixtures['14560190']);
  assert.equal(score.home+score.away,12);
  const events=[{type_id:2,team:1},{type:'Corner',team:'2'},{type_id:1,team:1},{type_id:3,team:2}];
  assert.equal(JSON.stringify(ctx.cornerScoreFromTimeline(events)),JSON.stringify({home:1,away:1}));
  assert.equal(ctx.cornerScoreFromTimeline(null),null);
  assert.equal(ctx.cornerScoreFromTimeline([{type_id:2,team:0}]),null);
});
test('each corner market title shows current API score, including zero, without changing other titles',()=>{
  const ctx=context();
  assert.equal(ctx.cornerMarketSuffix({market:'Lart/Poshtë Korne'},77),'');
  vm.runInContext("liveCornerScores.set('77',{home:4,away:3})",ctx);
  for(const market of ['Lart/Poshtë Korne','Lart/Poshtë Korne Totali','Godet kornen e dyte']){
    assert.equal(ctx.cornerMarketSuffix({market},77),' (4:3)');
  }
  assert.equal(ctx.cornerMarketSuffix({market:'Handikap',mainCategory:'Kornet'},77),' (4:3)');
  assert.equal(ctx.cornerMarketSuffix({market:'Rezultat Final'},77),'');
  assert.equal(ctx.cornerMarketSuffix({market:'Korne'},88),'');
  vm.runInContext("liveCornerScores.set('77',{home:0,away:0})",ctx);
  assert.equal(ctx.cornerMarketSuffix({market:'Korne'},77),' (0:0)');
});
