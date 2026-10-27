'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const {spawn}=require('child_process');

async function boot(t,env){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'euro97-brand-'));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:String(port),DB_FILE:path.join(dir,'test.db'),CENTER_PASSWORD:'Test-only-root-917!',DISABLE_UPSTREAM:'true',...env},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 t.after(async()=>{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+port;
 for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));if(i===299)throw Error('Startup timeout: '+output);}
 return async url=>{const r=await fetch(base+url);return {status:r.status,type:r.headers.get('content-type')||'',csp:r.headers.get('content-security-policy'),text:await r.text()};};
}

test('BRAND=escobet serves the EscoBet name and logos from the same code',async t=>{
 const get=await boot(t,{BRAND:'escobet'});
 for(const url of ['/','/index.html']){
  const page=await get(url);
  assert.equal(page.status,200);assert.match(page.type,/text\/html/);
  assert.match(page.text,/aria-label="EscoBet — Faqja kryesore"/);assert.match(page.text,/<p class="login-brand">ESCOBET<\/p>/);
  assert.doesNotMatch(page.text,/Baronbet|BARONBET/,'only the logo file path keeps its name; it is served as the EscoBet logo below');
  assert.match(page.csp,/default-src 'self'/,'security headers still apply');
 }
 const office=await get('/backoffice.html');assert.match(office.text,/EscoBet/);assert.doesNotMatch(office.text,/EURO97/);
 const script=await get('/backoffice.js');assert.match(script.type,/javascript/);assert.match(script.text,/document\.title='EscoBet · '/);
 for(const logo of ['/assets/brand/baronbet.png','/assets/brand/bb.png']){
  const image=await get(logo);assert.equal(image.status,200);assert.match(image.type,/image\/svg\+xml/);assert.match(image.text,/EscoBet/);
 }
});

test('without BRAND the platform is served exactly as written (Baronbet)',async t=>{
 const get=await boot(t,{BRAND:''});
 const page=await get('/');
 assert.equal(page.text,fs.readFileSync(path.join(__dirname,'public','index.html'),'utf8'));
 assert.equal((await get('/backoffice.js')).text,fs.readFileSync(path.join(__dirname,'public','backoffice.js'),'utf8'));
 const logo=await get('/assets/brand/bb.png');assert.match(logo.type,/image\/png/);
});
