'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const writerLock=require('proper-lockfile');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function acquire(filename){
 const file=path.resolve(filename),lock=file+'.lock',token=crypto.randomUUID();
 fs.mkdirSync(path.dirname(file),{recursive:true});
 let compromised=false,released=false,unlock;
 try{unlock=writerLock.lockSync(file,{realpath:false,lockfilePath:file+'.writer-lock',stale:30000,update:10000,onCompromised:()=>{compromised=true;}});}catch(error){if(error.code==='ELOCKED')throw Error('Database is already in use by another writer. Wait for the previous container to stop.');throw error;}
 // PID is diagnostic only: container namespaces routinely reuse the same PID.
 try{const fd=fs.openSync(lock,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token,protocol:'filesystem-lease-v2'}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch(error){unlock();throw error;}
 const read=()=>fs.existsSync(file)?fs.readFileSync(file):null;
 let expected=digest(read()||Buffer.alloc(0));
 function atomicWrite(target,bytes){
  const temporary=target+'.'+token+'.tmp',fd=fs.openSync(temporary,'w',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.renameSync(temporary,target);}catch(e){try{fs.unlinkSync(temporary);}catch{}throw e;}
 }
 function save(bytes){
  if(compromised||released)throw Error('Database writer lease lost; refusing to overwrite data.');
  const owner=JSON.parse(fs.readFileSync(lock,'utf8'));if(owner.token!==token)throw Error('Database ownership changed; refusing to overwrite data.');
  const previous=read();if(digest(previous||Buffer.alloc(0))!==expected)throw Error('Database changed outside this server; refusing to overwrite newer data. Restart the server.');
  if(previous){
   atomicWrite(file+'.bak',previous);
   const folder=file+'.backups';fs.mkdirSync(folder,{recursive:true,mode:0o700});
   const snapshot=path.join(folder,new Date().toISOString().slice(0,13).replace(/:/g,'-')+'.db');
   if(!fs.existsSync(snapshot))atomicWrite(snapshot,previous);
  }
  atomicWrite(file,bytes);expected=digest(bytes);
 }
 function release(){if(released)return;released=true;try{if(JSON.parse(fs.readFileSync(lock,'utf8')).token===token)fs.unlinkSync(lock);}catch{}try{unlock();}catch{}}
 process.once('exit',release);
 return {read,save,release,file};
}
module.exports={acquire};
