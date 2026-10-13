const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {acquire}=require('./database-storage');
test('container PID reuse in legacy metadata does not block a new writer',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-container-lock-')),file=path.join(dir,'test.db');let store;
 try{fs.writeFileSync(file,'preserved database');fs.writeFileSync(file+'.lock',JSON.stringify({pid:process.pid,token:'old-container'}));store=acquire(file);assert.equal(store.read().toString(),'preserved database');assert.throws(()=>acquire(file),/already in use/);}finally{store?.release();fs.rmSync(dir,{recursive:true,force:true});}
});
test('single database owner, persisted data, backup and external-write protection',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-storage-')),file=path.join(dir,'test.db');let store;
 try{store=acquire(file);store.save(Buffer.from('first'));assert.throws(()=>acquire(file),/already in use/);store.save(Buffer.from('second'));assert.equal(fs.readFileSync(file+'.bak','utf8'),'first');store.release();store=acquire(file);assert.equal(store.read().toString(),'second');fs.writeFileSync(file,'external newer data');assert.throws(()=>store.save(Buffer.from('stale')),/outside this server/);assert.equal(fs.readFileSync(file,'utf8'),'external newer data');}finally{store?.release();fs.rmSync(dir,{recursive:true,force:true});}
});
test('failed main-file replacement leaves committed data intact and retry succeeds',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-storage-failure-')),file=path.join(dir,'test.db');const store=acquire(file),rename=fs.renameSync;
 try{store.save(Buffer.from('committed'));fs.renameSync=(source,target)=>{if(target===file)throw Object.assign(Error('simulated disk error'),{code:'EIO'});return rename(source,target);};assert.throws(()=>store.save(Buffer.from('new data')),/simulated/);assert.equal(fs.readFileSync(file,'utf8'),'committed');fs.renameSync=rename;store.save(Buffer.from('new data'));assert.equal(store.read().toString(),'new data');assert.equal(fs.readFileSync(file+'.bak','utf8'),'committed');assert.equal(fs.readdirSync(file+'.backups').length,1);}finally{fs.renameSync=rename;store.release();fs.rmSync(dir,{recursive:true,force:true});}
});
