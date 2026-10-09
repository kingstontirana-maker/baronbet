'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {defaults,validate,eligible}=require('./ticket-acceptance');
test('automatic acceptance requires every applicable rule and rejects unknown event types',()=>{
 const c=defaults(),live=[{acceptanceType:'live'}],pre=[{acceptanceType:'prematch'}],mixed=[...live,...pre];
 assert.equal(eligible(c,live,1,2,2),false);c.live.enabled=true;
 assert.equal(eligible(c,live,50,500,20),true);
 for(const values of [[50.01,500,20],[50,500.01,20],[50,500,20.01]])assert.equal(eligible(c,live,...values),false);
 assert.equal(eligible(c,Array(6).fill(live[0]),1,2,2),false);
 assert.equal(eligible(c,mixed,1,2,2),false);c.prematch.enabled=true;
 assert.equal(eligible(c,pre,100,1000,50),true);assert.equal(eligible(c,mixed,50,500,20),true);
 assert.equal(eligible(c,mixed,51,500,20),false);
 assert.equal(eligible(c,[{acceptanceType:'unknown'}],1,2,2),false);assert.equal(eligible(c,[],1,2,2),false);
 for(const bad of [NaN,Infinity,-1,0,'20'])assert.throws(()=>validate({...c,live:{...c.live,maxStake:bad}}));
 assert.throws(()=>validate({...c,live:{...c.live,maxSelections:1.5}}));
 assert.deepEqual(validate(c),c);
});

test('blank limits are independent, persist as null and do not remove other restrictions',()=>{
 const c=defaults();c.live={enabled:true,maxStake:null,maxPayout:100,maxOdds:'',maxSelections:null};
 const clean=validate(c);assert.equal(clean.live.maxOdds,null);
 assert.equal(eligible(clean,[{acceptanceType:'live'}],50,100,40),true);
 assert.equal(eligible(clean,[{acceptanceType:'live'}],50,101,40),false);
 clean.live.maxPayout=null;assert.equal(eligible(clean,Array(12).fill({acceptanceType:'live'}),1000,5000,100),true);
 clean.live.enabled=false;assert.equal(eligible(clean,[{acceptanceType:'live'}],1,2,2),false);
});
