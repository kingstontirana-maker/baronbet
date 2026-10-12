const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {acquire}=require('./database-storage');
test('single database owner, persisted data, backup and external-write protection',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-storage-')),file=path.join(dir,'test.db');let store;
 try{store=acquire(file);store.save(Buffer.from('first'));assert.throws(()=>acquire(file),/already in use/);store.save(Buffer.from('second'));assert.equal(fs.readFileSync(file+'.bak','utf8'),'first');store.release();store=acquire(file);assert.equal(store.read().toString(),'second');fs.writeFileSync(file,'external newer data');assert.throws(()=>store.save(Buffer.from('stale')),/outside this server/);assert.equal(fs.readFileSync(file,'utf8'),'external newer data');}finally{store?.release();fs.rmSync(dir,{recursive:true,force:true});}
});
