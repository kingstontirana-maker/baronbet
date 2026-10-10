const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/euro07.bet/vbet/user/build/main.js','utf8');
function setup(fetch){
  const elements={authMsg:{},controlModal:{classList:{remove(){}}}};
  const ctx=vm.createContext({token:'old',user:{id:1,balance:500},pendingTicket:{id:12},lastBetRequest:{},pendingPoll:null,mode:'mybets',fetch,clearInterval,
    $:id=>elements[id],closeControlPoll(){},setAuthState(u){ctx.user=u;ctx.balanceVisible=!!u;},showMyBets(){ctx.mode='home';}});
  vm.runInContext(source.slice(source.indexOf('function expireSession('),source.indexOf('let walletRefreshTimer=')),ctx);
  return {ctx,elements};
}
test('expired authenticated requests clear cached account and credit and return to login',async()=>{
  const {ctx,elements}=setup(async()=>({status:401}));
  await assert.rejects(ctx.sessionFetch('/api/my-bets'),e=>e.status===401);
  assert.equal(ctx.token,'');assert.equal(ctx.user,null);assert.equal(ctx.pendingTicket,null);assert.equal(ctx.lastBetRequest,null);assert.equal(ctx.balanceVisible,false);assert.equal(ctx.mode,'home');
  assert.match(elements.authMsg.textContent,/Sesioni ka skaduar/);
});
test('a late response for an old token cannot log out a newly signed-in account',async()=>{
  let resolve;const {ctx}=setup(()=>new Promise(r=>resolve=r));
  const request=ctx.sessionFetch('/api/me');ctx.token='new';ctx.user={id:2,balance:100};resolve({status:401});
  await assert.rejects(request);assert.equal(ctx.token,'new');assert.equal(ctx.user.id,2);
});
test('temporary server or network failures preserve a valid login',async()=>{
  const {ctx}=setup(async()=>({status:503}));assert.equal((await ctx.sessionFetch('/api/me')).status,503);assert.equal(ctx.token,'old');
  ctx.fetch=async()=>{throw Error('offline');};await assert.rejects(ctx.sessionFetch('/api/me'));assert.equal(ctx.token,'old');assert.equal(ctx.user.balance,500);
});
test('periodic wallet validation detects expired sessions for both players and staff',async()=>{
  for(const role of ['user','agent']){
    const {ctx}=setup(async()=>({status:401}));ctx.user.role=role;ctx.document={hidden:false};ctx.setTimeout=setTimeout;ctx.clearTimeout=clearTimeout;
    vm.runInContext(source.slice(source.indexOf('let walletRefreshTimer='),source.indexOf("document.addEventListener('click',scheduleWalletRefresh")),ctx);
    await ctx.refreshWalletBalance();assert.equal(ctx.token,'');assert.equal(ctx.user,null);
  }
});
