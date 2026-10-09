const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
test('disk failure after commit restores pre-transaction memory; retry commits once',async()=>{
 const SQL=await require('sql.js')();let db=new SQL.Database();db.run('CREATE TABLE balance(n);INSERT INTO balance VALUES(100)');
 let fail=true,disk;
 const ctx={db,run:(sql)=>ctx.db.run(sql),saveDb:()=>{if(fail)throw Error('disk failure');disk=ctx.db.export()},queueExposurePush:()=>{}};
 vm.createContext(ctx);const src=fs.readFileSync('server.js','utf8');vm.runInContext(src.slice(src.indexOf('function tx('),src.indexOf('function normalizeUsername')),ctx);
 assert.throws(()=>ctx.tx(()=>ctx.run('UPDATE balance SET n=80')),/disk failure/);
 assert.equal(ctx.db.exec('SELECT n FROM balance')[0].values[0][0],100);
 fail=false;ctx.tx(()=>ctx.run('UPDATE balance SET n=80'));assert.equal(new SQL.Database(disk).exec('SELECT n FROM balance')[0].values[0][0],80);ctx.db.close();
});
test('login limiter rejects repeated attempts and expires its window',()=>{
 let time=0;const guard=require('./login-guard')({clock:()=>time,accountLimit:2});let admitted=0,status;
 const res={setHeader(){},status(s){status=s;return this},json(){}};
 const call=()=>guard({ip:'local',body:{username:'demo'}},res,()=>admitted++);
 call();call();call();assert.equal(admitted,2);assert.equal(status,429);time=60001;call();assert.equal(admitted,3);
});
