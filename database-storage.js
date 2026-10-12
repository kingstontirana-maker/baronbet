'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function acquire(filename){
 const file=path.resolve(filename),lock=file+'.lock',token=crypto.randomUUID();
 fs.mkdirSync(path.dirname(file),{recursive:true});
 for(let attempt=0;attempt<3;attempt++){
  try{const fd=fs.openSync(lock,'wx');try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}break;}
  catch(e){if(e.code!=='EEXIST')throw e;let owner;try{owner=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{throw Error('Database lock cannot be verified: '+lock);}
   let alive=true;try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
   if(alive)throw Error('Database is already in use by process '+owner.pid+'. Stop that server before starting another.');
   try{fs.unlinkSync(lock);}catch(error){if(error.code!=='ENOENT')throw error;}if(attempt===2)throw Error('Could not acquire database lock.');
  }
 }
 const read=()=>fs.existsSync(file)?fs.readFileSync(file):null;
 let expected=digest(read()||Buffer.alloc(0));
 function save(bytes){
  const owner=JSON.parse(fs.readFileSync(lock,'utf8'));if(owner.token!==token)throw Error('Database ownership changed; refusing to overwrite data.');
  const previous=read();if(digest(previous||Buffer.alloc(0))!==expected)throw Error('Database changed outside this server; refusing to overwrite newer data. Restart the server.');
  if(previous){const backup=file+'.bak.tmp';fs.writeFileSync(backup,previous);fs.renameSync(backup,file+'.bak');}
  const temporary=file+'.'+token+'.tmp',fd=fs.openSync(temporary,'w');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,file);expected=digest(bytes);
 }
 function release(){try{if(JSON.parse(fs.readFileSync(lock,'utf8')).token===token)fs.unlinkSync(lock);}catch{}}
 process.once('exit',release);
 return {read,save,release,file};
}
module.exports={acquire};
