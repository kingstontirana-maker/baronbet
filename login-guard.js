// Bounded in-memory rate limit; deploy one writer process for sql.js.
module.exports=function loginGuard({clock=Date.now,windowMs=60000,ipLimit=60,accountLimit=10}={}){
  const buckets=new Map();
  return (req,res,next)=>{
    const now=clock();
    for(const [key,value] of buckets)if(value.until<=now)buckets.delete(key);
    const keys=[['ip:'+req.ip,ipLimit],['account:'+String(req.body?.username||'').trim().toLowerCase(),accountLimit]];
    for(const [key,limit] of keys){const bucket=buckets.get(key);if(bucket&&bucket.count>=limit){res.setHeader('Retry-After',String(Math.ceil((bucket.until-now)/1000)));return res.status(429).json({error:'Shumë tentativa hyrjeje. Provo përsëri pas pak.',code:'LOGIN_RATE_LIMIT'});}}
    if(buckets.size>10000)return res.status(429).json({error:'Provo përsëri pas pak.',code:'LOGIN_RATE_LIMIT'});
    for(const [key] of keys){const bucket=buckets.get(key)||{until:now+windowMs,count:0};bucket.count++;buckets.set(key,bucket);}next();
  };
};
