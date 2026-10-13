'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/euro07.bet/vbet/user/build/main.js','utf8');
function fixture(role='user'){
  const nodes={},calls=[];
  const node=id=>nodes[id]??= {value:'',classList:{add(){},remove(){}},style:{},replaceChildren(){},reset(){for(const id of ['oldPass','newPass','newPass2'])node(id).value='';}};
  const ctx=vm.createContext({user:{role},$:node,JSON,brandLoading(){return '';},document:{body:{classList:{add(){}}}},timer:null,liveLoadSequence:0,clearInterval(){},closeLiveMarkets(){},openSportsHome(){},restoreInlineControl(){},closeControlPoll(){},controlFetch:async(url,opt)=>{calls.push({url,body:JSON.parse(opt.body)});if(ctx.failure)throw Error(ctx.failure);}});
  vm.runInContext(source.slice(source.indexOf('async function openControl('),source.indexOf('function roleVisibleLabel(')),ctx);
  return {ctx,node,calls,submit:()=>node('passwordForm').onsubmit({preventDefault(){}})};
}
test('every account role opens its own password form without staff permissions',async()=>{
  for(const role of ['user','agent','manager','senior','supermanager','admin','partner','operator','center']){
    const f=fixture(role);await f.ctx.openControl(role,'password');
    assert.equal(typeof f.node('passwordForm').onsubmit,'function',role);
    assert.match(f.node('controlApp').innerHTML,/current-password/);
    assert.equal(f.calls.length,0,'opening requires no staff overview request');
  }
});
test('password form rejects missing old password, short password and mismatched confirmation',async()=>{
  const f=fixture();f.ctx.renderOwnPasswordForm();
  await f.submit();assert.equal(f.calls.length,0);
  f.node('oldPass').value='old-password';f.node('newPass').value='short';f.node('newPass2').value='short';
  await f.submit();assert.equal(f.calls.length,0);
  f.node('newPass').value='new-password';f.node('newPass2').value='different-password';
  await f.submit();assert.equal(f.calls.length,0);assert.match(f.node('controlMsg').textContent,/nuk përputhen/);
});
test('save reports server rejection and clears secrets only after successful persistence',async()=>{
  const f=fixture();f.ctx.renderOwnPasswordForm();
  f.node('oldPass').value='old-password';f.node('newPass').value=f.node('newPass2').value='new-password';
  f.ctx.failure='Fjalëkalimi i vjetër nuk është i saktë.';
  await f.submit();assert.equal(f.node('controlMsg').className,'controlMsg error');
  assert.equal(f.node('oldPass').value,'old-password');assert.equal(f.node('saveOwnPassword').disabled,false);
  f.ctx.failure='';await f.submit();
  assert.deepEqual(f.calls[1],{url:'/api/staff/password',body:{oldPassword:'old-password',newPassword:'new-password'}});
  assert.equal(f.node('controlMsg').className,'controlMsg ok');assert.equal(f.node('oldPass').value,'');assert.equal(f.node('newPass2').value,'');
});

test('server verifies the old secret, saves a usable hash and revokes other sessions',()=>{
  const server=fs.readFileSync('server.js','utf8');let handler,stored,revoked=false;
  const ctx=vm.createContext({crypto:require('node:crypto'),Buffer,String,auth(){},app:{post(path,auth,fn){handler=fn;}},
    get:()=>({id:7,password_hash:stored}),jsonError:(res,status,error)=>{res.status=status;res.error=error;},
    tx:fn=>fn(),run:(sql,args)=>{if(sql.startsWith('UPDATE users'))stored=args[0];else{assert.equal(args[0],7);assert.equal(args[1],'current-session');revoked=true;}},access:{audit(){}}});
  vm.runInContext(server.slice(server.indexOf('function hashPassword('),server.indexOf('async function verifyLoginPassword(')),ctx);
  stored=ctx.hashPassword('old-password');
  vm.runInContext(server.slice(server.indexOf("app.post('/api/staff/password'"),server.indexOf('  function serializeBet(')),ctx);
  const request=(oldPassword,newPassword)=>{const res={json(body){this.body=body;}};handler({body:{oldPassword,newPassword},user:{id:7,token:'current-session'}},res);return res;};
  const original=stored;
  assert.equal(request('wrong-password','new-password').status,400);assert.equal(stored,original);
  assert.equal(request('old-password','short').status,400);assert.equal(stored,original);
  assert.equal(request('old-password','new-password').body.ok,true);
  assert.equal(ctx.verifyPassword('new-password',stored),true);assert.equal(ctx.verifyPassword('old-password',stored),false);
  assert.equal(revoked,true);
});
