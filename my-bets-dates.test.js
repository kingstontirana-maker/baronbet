'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const initSqlJs=require('sql.js');
process.env.TZ='Europe/Tirane';
const client=fs.readFileSync('public/euro07.bet/vbet/user/build/main.js','utf8');
const server=fs.readFileSync('server.js','utf8');
const context=vm.createContext({Date,URLSearchParams});
vm.runInContext(client.slice(client.indexOf('function myBetsDateParams('),client.indexOf('async function loadMyBets(')),context);
vm.runInContext(client.slice(client.indexOf('function formatBetDate('),client.indexOf('function betStatusLabel(')),context);

test('local day filters include midnight tickets and exclude the next local day',async()=>{
  const SQL=await initSqlJs(),db=new SQL.Database();
  try{
    db.run('CREATE TABLE bets(id INTEGER,created_at TEXT)');
    ['2026-09-27 21:59:59','2026-09-27 22:00:00','2026-09-28 21:59:59','2026-09-28 22:00:00'].forEach((date,i)=>db.run('INSERT INTO bets VALUES (?,?)',[i+1,date]));
    const start=server.indexOf("    for(const key of ['fromTime','toTime'])");
    const filter=server.slice(start,server.indexOf('    const paginated=',start));
    function ids(from,to){
      const query=Object.fromEntries(context.myBetsDateParams(from,to));
      const ctx=vm.createContext({req:{query},sql:'SELECT b.id FROM bets b WHERE 1=1',args:[]});
      vm.runInContext('(function(){'+filter+'})()',ctx);
      return db.exec(ctx.sql,ctx.args)[0]?.values.flat()||[];
    }
    assert.deepEqual(ids('2026-09-28','2026-09-28'),[2,3]);
    assert.deepEqual(ids('2026-09-27','2026-09-27'),[1]);
    assert.deepEqual(ids('2026-09-27','2026-09-28'),[1,2,3]);
    assert.deepEqual(ids('',''),[1,2,3,4]);
    assert.equal(context.formatBetDate('2026-09-27 22:00:00'),'28-09-2026');
    assert.equal(context.formatBetTime('2026-09-27 22:00:00'),'00:00:00');
  }finally{db.close();}
});

test('local day boundaries follow daylight saving changes',()=>{
  for(const [date,hours] of [['2026-03-29',23],['2026-10-25',25]]){
    const params=context.myBetsDateParams(date,date);
    assert.equal((Date.parse(params.get('toTime'))-Date.parse(params.get('fromTime')))/3600000,hours);
  }
});

test('old server date parameters and client filtering preserve the exact local day',async()=>{
  const SQL=await initSqlJs(),db=new SQL.Database();
  try{
    db.run('CREATE TABLE bets(created_at TEXT)');
    const dates=['2026-09-27 21:59:59','2026-09-27 22:00:00','2026-09-28 21:59:59','2026-09-28 22:00:00'];
    dates.forEach(date=>db.run('INSERT INTO bets VALUES (?)',[date]));
    const params=context.myBetsDateParams('2026-09-28','2026-09-28');
    const oldResponse=db.exec('SELECT created_at FROM bets WHERE date(created_at)>=date(?) AND date(created_at)<=date(?)',[params.get('from'),params.get('to')])[0].values;
    assert.equal(oldResponse.length,4);
    assert.deepEqual(oldResponse.map(([created_at])=>({created_at})).filter(b=>context.myBetInDateRange(b,params)).map(b=>b.created_at),dates.slice(1,3));
    assert.equal(context.myBetInDateRange({created_at:'invalid'},params),false);
  }finally{db.close();}
});
