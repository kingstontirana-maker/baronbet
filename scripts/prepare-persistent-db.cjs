'use strict';
// Run on the VPS BEFORE deploying the commit which removes tracked database files.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
async function main(){
 const args=process.argv.slice(2),value=key=>args[args.indexOf(key)+1];
 if(!args.includes('--server-stopped')||!args.includes('--source')||!args.includes('--target'))throw Error('Stop the application first. Usage: node scripts/prepare-persistent-db.cjs --server-stopped --source /app/sportsbook.db --target /var/lib/baronbet/sportsbook.db');
 const source=path.resolve(value('--source')),target=path.resolve(value('--target')),root=path.resolve(__dirname,'..');
 if(target===root||target.startsWith(root+path.sep))throw Error('Target must be outside the deploy/repository directory.');
 if(fs.existsSync(source+'.lock')){const lock=JSON.parse(fs.readFileSync(source+'.lock','utf8'));let active=true;try{process.kill(lock.pid,0);}catch(e){if(e.code==='ESRCH')active=false;}if(active)throw Error('Source database still has a running owner. Stop the application.');}
 const bytes=fs.readFileSync(source),SQL=await require('sql.js')(),db=new SQL.Database(bytes);
 if(db.exec('PRAGMA integrity_check')[0]?.values[0]?.[0]!=='ok')throw Error('Source database failed integrity check. No data copied.');
 const accounts=db.exec('SELECT COUNT(*) FROM users')[0].values[0][0];db.close();
 const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
 if(fs.existsSync(target)){if(hash(fs.readFileSync(target))!==hash(bytes))throw Error('Target already contains different data. Refusing to overwrite it.');console.log('Existing target matches source; accounts:',accounts);return;}
 fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});const fd=fs.openSync(target,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 if(hash(fs.readFileSync(target))!==hash(bytes))throw Error('Copied data failed verification. Source preserved.');
 fs.copyFileSync(target,target+'.migration-backup',fs.constants.COPYFILE_EXCL);
 console.log('Persistent database verified; accounts:',accounts,'target:',target,'source preserved:',source);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
