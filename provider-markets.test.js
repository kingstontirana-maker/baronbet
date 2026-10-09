const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('server.js','utf8'),ctx={};vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function norm('),source.indexOf('let settlementRunning=')),ctx);
const event=(type_id,team,minute,game_status)=>({type_id:String(type_id),team:String(team),minute,game_status:String(game_status)});
test('first-half markets settle at the confirmed interval while full-match and second-half markets wait',()=>{
  const events=[event(1,1,'48:00',1),event(5,0,'1-0',2)];
  const game={finished:false,score:{home:1,away:0}};
  const evaluate=(market_id,selection,feed=events)=>ctx.evaluateSelection({market_id,market:'Provider market',selection,odd:2},ctx.buildStats(feed,game.score),game,feed);
  assert.equal(evaluate('6576','1').status,'won');
  assert.equal(evaluate('6576','X').status,'lost');
  assert.equal(evaluate('6809','2').status,'won');
  assert.equal(evaluate('6801',"S'ka Gol").status,'won');
  assert.equal(evaluate('6575','1'),null);
  assert.equal(evaluate('6811','2'),null);
  assert.equal(evaluate('6576','1',events.slice(0,1)),null);
  assert.equal(evaluate('6576','1',[...events,event(5,0,'0-0',2)]),null);
});
// First-half added time (48) occurs before a second-half event at 46.
const timeline=[event(1,1,'48:00',1),event(2,1,'48:00',1),event(5,0,'1-0',2),event(1,2,'46:00',3),event(2,2,'46:00',3),event(1,2,'65:00',3),event(2,2,'80:00',3),event(6,0,'1-2',255)];
function result(id,market,selection,special_value,events=timeline){
  return ctx.evaluateSelection({market_id:String(id),market,selection,special_value,odd:2},ctx.buildStats(events,{home:1,away:2}),{finished:true,score:{home:1,away:2}},events);
}
test('real provider market names use the correct period, team, statistic and ordinal',()=>{
  const cases=[
    [6576,'Rezultati Pjesa I','1',null,'won'],
    [6576,'Rezultati Pjesa I','2',null,'lost'],
    [6630,'Sa Gola Shënohen në Pjesën e 1re','Poshte 1.5',null,'won'],
    [6690,'Handikap Aziatik Pjesa 1-rë','1 -0.25','-0.25','won'],
    [6743,'Lart/Poshtë Gola Aziatikë në Pjesën e 1rë','Lart 1.0','1.0','void'],
    [6742,'Lart/Poshtë Gola Aziatikë në Pjesën e 1rë','Lart 0.75','0.75','half_won'],
    [6799,'Rezultati Sakte Pjesa 1 Live','1-0',null,'won'],
    [6800,'Shenon Golin e 1 Pjesa1','1',null,'won'],
    [6801,'Shenon Golin e 2 Pjesa1','2',null,'lost'],
    [6801,'Shenon Golin e 2 Pjesa1',"S'ka Gol te 2",null,'won'],
    ['new','Shenon Golin e 2 Pjesa2','2',null,'won'],
    ['new','Shenon golin e dyte ne pjesen e 1','1',null,'lost'],
    [6811,'Gol / Jo Gol Ne P2','Po',null,'lost'],
    [6811,'Gol / Jo Gol Ne P2','Jo',null,'won'],
    [6809,'Gol JoGol Pjesa 1 Live','Po',null,'lost'],
    ['new','Gol jo gol ne pjesen e 2','Jo',null,'won'],
    [6613,'Lart/Poshtë Korne','Lart 2.5',null,'won'],
    [6781,'Lart/Poshtë Korne Totali','Sakte 3',null,'won'],
    [6847,'Lart/Poshtë Korne Pjesa 1-rë','Poshte 1.5',null,'won'],
    [6924,'Lart/Poshtë Korne Totali Pjesa 1-rë','Sakte 1',null,'won'],
    [9094,'Handikap Live Pjesa Pare (1:0)','1 1:0','1:0','won'],
    [6759,'Sa Gola do shenohen nga ekipi udhetues','Lart 1.5',null,'won'],
    [6763,'Sa Gola do shenohen nga ekipi vendas','Lart 1.5',null,'lost'],
    [6582,'Shenon golin e trete (skuadra)','2',null,'won'],
    [6583,'Shenon golin e katert (skuadra)',"S'ka Gol te 4",null,'won'],
    [6637,'Godet kornen e dyte','2',null,'won'],
    [6638,'Godet kornen e trete','1',null,'lost'],
    [8999,'Rezultati Final Gola 4+','2|4+',null,'lost'],
    [6810,'Rezultati Final Gola 3+','2|3+',null,'won'],
    [6816,'Shenon Pritesi ne P1/P2','Jo',null,'won'],
    [6817,'Shenon Udhetuesi ne P1/P2','Po',null,'lost']
  ];
  for(const [id,name,selection,line,status] of cases)assert.equal(result(id,name,selection,line)?.status,status,`${id}: ${name} / ${selection}`);
});
test('missing periods, unsupported semantics, partial goals and invalid Asian lines never become guessed losses',()=>{
  assert.equal(result(6576,'Rezultati Pjesa I','1',null,timeline.filter(e=>e.type_id!=='5')),null);
  assert.equal(result(6582,'Shenon golin e trete (skuadra)','2',null,timeline.filter(e=>e.minute!=='65:00')),null);
  assert.equal(result(6809,'Gol JoGol Pjesa 1 Live','1').status,'lost');
  assert.equal(result(6665,'Handikap Aziatik','2 -0.25','-0.25'),null);
  assert.equal(result(6711,'Lart/Poshtë Gola Aziatikë','Lart 2.13','2.13'),null);
  assert.equal(result(6575,'Rezultat Final','2',null,[...timeline,event(1,1,'110:00',4)]),null);
  assert.equal(result(6662,'Rezultati i Pjeses se Dyte','2',null,timeline.map(e=>e.type_id==='5'?{...e,minute:'3-0'}:e)),null);
  assert.equal(ctx.extractGameRecord([{id:42,game_status:255,result:'4-0'}],99),null);
});
test('all observed first-half market aliases preserve the first-half scope',()=>{
  const catalog=require('./artifacts/settlement-market-analysis.json');
  const ambiguous=new Set(['6661','6663','6595','6831','6832','6833']);
  for(const market of catalog.markets){
    const selection={market_id:market.id,market:market.name};
    if(ambiguous.has(market.id)){assert.equal(ctx.marketFamily(selection),'unknown');continue;}
    assert.notEqual(ctx.marketFamily(selection),'unknown',market.name);
    if(/pjesa (?:1|i\b|pare)|pjesen e 1|pjesa1/.test(ctx.norm(market.name)))assert.equal(ctx.providerMarket(selection)?.period,'first',market.name);
  }
});

test('captured provider timelines settle scores, corners and first-half totals consistently',()=>{
  const fixtures=require('./fixtures/settlement-timelines.json');
  for(const [id,score,cornerCount,halfGoals] of [['14595016',{home:0,away:0},4,0],['14560190',{home:2,away:3},12,2]]){
    const events=fixtures[id],stats=ctx.buildStats(events,score),game={finished:true,score};
    const evaluate=(market,selection,market_id)=>ctx.evaluateSelection({market,selection,market_id,odd:2},stats,game,events);
    assert.equal(evaluate('Lart/Poshtë Korne Totali','Sakte '+cornerCount,'6781')?.status,'won');
    assert.equal(evaluate('Sa Gola Shënohen në Pjesën e 1re','Poshte '+(halfGoals+0.5),'6630')?.status,'won');
    assert.equal(evaluate('Rezultat Final',score.home===score.away?'X':'2','6575')?.status,'won');
    const incomplete=events.filter(e=>!(e.type_id==='2'&&e.value==='1'));
    assert.equal(ctx.evaluateSelection({market:'Lart/Poshtë Korne',selection:'Poshte 99.5',odd:2},ctx.buildStats(incomplete,score),game,incomplete),null);
  }
});

test('reported finished fixtures resolve period goals without using second-half goals in the first half',()=>{
  const fixtures=require('./fixtures/period-market-timelines.json');
  const events=fixtures['14633085'],score={home:2,away:0},game={finished:true,score};
  const evaluate=selection=>ctx.evaluateSelection({market_id:'6801',market:'Shenon Golin e 2 Pjesa1',selection,odd:2},ctx.buildStats(events,score),game,events);
  assert.equal(evaluate('2').status,'lost');
  assert.equal(evaluate('1').status,'lost','the home goal at 97 minutes is not a first-half goal');
  assert.equal(evaluate('X').status,'won');
  assert.equal(evaluate("S'ka Gol te 2").status,'won');
  const second=fixtures['14632384'],secondScore={home:0,away:1};
  for(const [selection,status] of [['Po','lost'],['Jo','won']]){
    assert.equal(ctx.evaluateSelection({market_id:'6811',market:'Gol / Jo Gol Ne P2',selection,odd:2},ctx.buildStats(second,secondScore),{finished:true,score:secondScore},second).status,status);
  }
  for(const selection of ['1','2'])assert.equal(ctx.evaluateSelection({market_id:'6811',market:'Gol / Jo Gol Ne P2',selection,odd:2},ctx.buildStats(second,secondScore),{finished:true,score:secondScore},second).status,selection==='1'?'lost':'won','confirmed numeric BTTS mapping');
});

test('screenshot button labels resolve by market scope rather than position or odds',()=>{
  const events=require('./fixtures/period-market-timelines.json')['14633085'];
  const score={home:2,away:0},stats=ctx.buildStats(events,score),game={finished:true,score};
  const check=(market_id,market,selection,status)=>{
    for(const odd of [1.07,2,7.5]){
      const outcome=ctx.evaluateSelection({market_id,market,selection,odd},stats,game,events);
      assert.equal(outcome?.status??null,status,`${market}: ${selection}`);
      if(outcome)assert.equal(outcome.factor,status==='won'?odd:0);
    }
  };
  check('6801','Shenon Golin e 2 Pjesa1',"S'ka Gol",'won');
  check('6801','Shenon Golin e 2 Pjesa1','S’ka Gol','won');
  check('6801','Shenon Golin e 2 Pjesa1','1','lost');
  check('6581','Shenon golin e dyte (skuadra)','1','won');
  check('6581','Shenon golin e dyte (skuadra)',"S'ka Gol te 2",'lost');
  check('6780','Gol Jo Gol Live','Po','lost');
  check('6780','Gol Jo Gol Live','Jo','won');
  check('6810','Rezultati Final Gola 3+','1|3+','lost');
  check('8999','Rezultati Final Gola 4+','1|4+','lost');
  check('8999','Rezultati Final Gola 4+','2|4+','lost');
  check('8999','Rezultati Final Gola 4+','1|3+',null);
  check('6801','Shenon Golin e 2 Pjesa1',"S'ka Gol unknown",null);
  for(const id of ['6809','6811'])for(const option of ['1','2'])check(id,'Gol / Jo Gol',option,option==='1'?'lost':'won');
});

test('confirmed numeric BTTS buttons evaluate each half independently for every score pattern',()=>{
  for(const first of [{home:0,away:0},{home:1,away:0},{home:0,away:1},{home:1,away:1}]){
    for(const second of [{home:0,away:0},{home:2,away:0},{home:0,away:2},{home:1,away:2}]){
      const score={home:first.home+second.home,away:first.away+second.away};
      const events=[event(5,0,`${first.home}-${first.away}`,2),event(6,0,`${score.home}-${score.away}`,255)];
      for(const [id,half] of [['6809',first],['6811',second]])for(const selection of ['1','2','Po','Jo']){
        const wantsGoals=selection==='1'||selection==='Po',both=half.home>0&&half.away>0;
        const outcome=ctx.evaluateSelection({market_id:id,market:'Gol / Jo Gol',selection,odd:2.5},ctx.buildStats(events,score),{finished:true,score},events);
        assert.equal(outcome.status,wantsGoals===both?'won':'lost');
        assert.equal(outcome.factor,wantsGoals===both?2.5:0);
      }
    }
  }
  assert.equal(ctx.yesNo('1'),null,'other yes/no markets must not inherit numeric semantics');
});
