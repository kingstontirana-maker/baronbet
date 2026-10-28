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
  const image=await get(logo);assert.equal(image.status,200);assert.match(image.type,logo.endsWith('bb.png')?/image\/webp/:/image\/png/);assert.ok(image.text.length>1000,'EscoBet logo served for '+logo);
 }
 assert.match(office.text,/<span class="brand-symbol">EB<span>●<\/span><\/span><span>ESCO<span class="brand-number">BET<\/span>/,'sidebar mark');
 // Blue theme: every stylesheet is served with its greens moved to blue.
 for(const [url,file] of [['/euro07.bet/vbet/user/build/main.css?v=1','euro07.bet/vbet/user/build/main.css'],['/backoffice.css','backoffice.css'],['/center.css','center.css'],['/operator.css','operator.css']]){
  const css=await get(url);assert.equal(css.status,200);assert.match(css.type,/text\/css/);
  const original=fs.readFileSync(path.join(__dirname,'public',file),'utf8');
  if(/#138360/i.test(original))assert.doesNotMatch(css.text,/#138360/i,url+' still green');
  assert.equal(css.text.length>original.length*0.98,true,url+' kept its rules');
  assert.equal(css.text.trimEnd().endsWith(require('./brand').BRANDS.escobet.siteCss),file==='euro07.bet/vbet/user/build/main.css',url+': header logo fit only on the player site');
 }
 assert.equal((await get('/../server.js')).status,404,'no path traversal through the theme');
});

test('the blue theme keeps contrast, alpha and selectors exactly',()=>{
 const {recolorCss,luminance,shiftColor}=require('./brand');
 const out=recolorCss('#add,.a:hover #fade{color:#138360;background:linear-gradient(135deg,#138360,#0c6048);border-color:#00664d55;box-shadow:0 0 0 1px rgba(16,36,31,.93);outline-color:#ffe500;fill:#666}',216);
 assert.match(out,/^#add,\.a:hover #fade\{/,'selectors untouched');
 assert.match(out,/outline-color:#ffe500;fill:#666\}/,'yellow accents and greys untouched');
 assert.match(out,/border-color:#[0-9a-f]{6}55;/,'alpha kept');
 assert.match(out,/rgba\(\d+,\d+,\d+,\.93\)/);
 for(const hex of ['138360','00d99a','101817','83efd0']){
  const rgb=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)),blue=shiftColor(...rgb,216);
  assert.ok(Math.abs(luminance(...rgb)-luminance(...blue))<0.006,hex+' keeps its contrast');
  assert.ok(blue[2]>blue[1],hex+' becomes blue');
 }
});

test('without BRAND the platform is served exactly as written (Baronbet)',async t=>{
 const get=await boot(t,{BRAND:''});
 const page=await get('/');
 assert.equal(page.text,fs.readFileSync(path.join(__dirname,'public','index.html'),'utf8'));
 assert.equal((await get('/backoffice.js')).text,fs.readFileSync(path.join(__dirname,'public','backoffice.js'),'utf8'));
 const logo=await get('/assets/brand/bb.png');assert.match(logo.type,/image\/png/);
 assert.equal((await get('/backoffice.css')).text,fs.readFileSync(path.join(__dirname,'public','backoffice.css'),'utf8'),'Baronbet stays green');
});
