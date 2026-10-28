'use strict';
// User groups: a set of players, agents and managers. A player belongs to every group that
// holds the player or one of the player's agents/managers. The group's account limits and its
// Sport & Competitions rules apply to all those players together.
const MEMBER_ROLES=['user','agent','manager'];
const LIMIT_KEYS=['max_bet','max_payout','max_exposure'];
function createUserGroups({run,get,all,tx,now,lineage}){
 run('CREATE TABLE IF NOT EXISTS user_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,created_by INTEGER)');
 run('CREATE TABLE IF NOT EXISTS user_group_members(group_id TEXT NOT NULL,user_id INTEGER NOT NULL,added_at TEXT,added_by INTEGER,PRIMARY KEY(group_id,user_id))');
 run('CREATE TABLE IF NOT EXISTS user_group_limits(group_id TEXT NOT NULL,key TEXT NOT NULL,value REAL NOT NULL CHECK(value>=0),PRIMARY KEY(group_id,key))');
 const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
 const audit=(actor,action,details)=>run('INSERT INTO audit_log(actor_id,action,target_type,details) VALUES(?,?,?,?)',[actor,action,'user_group',JSON.stringify(details)]);
 function groupsOf(userId){
  const chain=lineage(userId).map(u=>Number(u.id));if(!chain.length)return [];
  return all(`SELECT DISTINCT group_id FROM user_group_members WHERE user_id IN (${chain.map(()=>'?').join(',')}) ORDER BY group_id`,chain).map(r=>r.group_id);
 }
 // Every player under the group's members (the members themselves included).
 function players(groupId){
  return all(`WITH RECURSIVE tree(id) AS (SELECT user_id FROM user_group_members WHERE group_id=? UNION SELECT u.id FROM users u JOIN tree t ON COALESCE(u.business_parent_id,u.parent_id)=t.id) SELECT u.id FROM users u JOIN tree t ON t.id=u.id WHERE u.role='user'`,[groupId]).map(r=>Number(r.id));
 }
 const limitsOf=groupId=>Object.fromEntries(all('SELECT key,value FROM user_group_limits WHERE group_id=?',[groupId]).map(r=>[r.key,Number(r.value)]));
 function betLimit(amount,kind,message){throw Object.assign(Error(message),{status:403,code:'BET_LIMIT_EXCEEDED',limitAmount:Number(amount),limitKind:kind});}
 // Called with the other bet limits; excludeBet is the ticket being re-checked, if any.
 function checkLimits(userId,stake,payout,excludeBet=null){
  for(const id of groupsOf(userId)){
   const limits=limitsOf(id);if(!Object.keys(limits).length)continue;
   const name=get('SELECT name FROM user_groups WHERE id=?',[id])?.name||id;
   if(limits.max_bet!=null&&stake>limits.max_bet)betLimit(limits.max_bet,'group_stake','Basti tejkalon limitin e grupit '+name+'.');
   if(limits.max_payout!=null&&payout>limits.max_payout)betLimit(limits.max_payout,'group_payout','Fitimi tejkalon limitin e grupit '+name+'.');
   if(limits.max_exposure!=null){
    const ids=players(id);
    const open=ids.length?Number(get(`SELECT COALESCE(SUM(potential_win),0) n FROM bets WHERE user_id IN (${ids.map(()=>'?').join(',')}) AND status IN ('pending','accepted') AND id<>?`,[...ids,excludeBet??-1]).n):0;
    if(open+payout>limits.max_exposure)betLimit(limits.max_exposure,'group_exposure','Ekspozimi i grupit '+name+' tejkalohet.');
   }
  }
 }
 function summary(g){return {...g,members:Number(get('SELECT COUNT(*) n FROM user_group_members WHERE group_id=?',[g.id]).n),players:players(g.id).length,limits:limitsOf(g.id)};}
 const group=id=>get('SELECT * FROM user_groups WHERE id=?',[String(id)])||fail('Grupi nuk ekziston.',404);
 const name=v=>{const s=String(v??'').trim();if(!s||s.length>100)fail('Emri i grupit duhet të ketë 1-100 karaktere.');return s;};
 function mount(app,auth){
  const route=fn=>(req,res)=>{try{res.json(fn(req));}catch(e){res.status(e.status||400).json({error:e.message});}};
  app.get('/api/center/user-groups',auth,route(()=>({groups:all('SELECT * FROM user_groups ORDER BY name').map(summary)})));
  app.post('/api/center/user-groups',auth,route(req=>{const n=name(req.body.name);if(get('SELECT id FROM user_groups WHERE lower(name)=lower(?)',[n]))fail('Ekziston një grup me këtë emër.');const id=require('crypto').randomUUID();tx(()=>{run('INSERT INTO user_groups(id,name,created_at,created_by) VALUES(?,?,?,?)',[id,n,now(),req.user.id]);audit(req.user.id,'user_group_created',{id,name:n});});return {group:summary(group(id))};}));
  app.put('/api/center/user-groups/:id',auth,route(req=>{const g=group(req.params.id),n=name(req.body.name);if(get('SELECT id FROM user_groups WHERE lower(name)=lower(?) AND id<>?',[n,g.id]))fail('Ekziston një grup me këtë emër.');tx(()=>{run('UPDATE user_groups SET name=? WHERE id=?',[n,g.id]);audit(req.user.id,'user_group_renamed',{id:g.id,before:g.name,after:n});});return {group:summary(group(g.id))};}));
  app.delete('/api/center/user-groups/:id',auth,route(req=>{const g=group(req.params.id);tx(()=>{for(const t of ['user_group_members','user_group_limits','user_group_competition_rules'])run(`DELETE FROM ${t} WHERE group_id=?`,[g.id]);run('DELETE FROM user_groups WHERE id=?',[g.id]);audit(req.user.id,'user_group_deleted',{id:g.id,name:g.name});});return {ok:true};}));
  app.get('/api/center/user-groups/candidates',auth,route(req=>{const q=String(req.query.q||'').trim().slice(0,64);return {accounts:q?all(`SELECT id,username,role FROM users WHERE role IN (${MEMBER_ROLES.map(()=>'?').join(',')}) AND (instr(lower(username),lower(?))>0 OR CAST(id AS TEXT)=?) ORDER BY username LIMIT 30`,[...MEMBER_ROLES,q,q]):[]};}));
  app.get('/api/center/user-groups/:id/members',auth,route(req=>{const g=group(req.params.id);return {group:summary(g),members:all('SELECT u.id,u.username,u.role,u.status,m.added_at FROM user_group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY u.role,u.username',[g.id])};}));
  app.post('/api/center/user-groups/:id/members',auth,route(req=>{const g=group(req.params.id),u=get('SELECT id,username,role FROM users WHERE id=?',[Number(req.body.userId)]);if(!u||!MEMBER_ROLES.includes(u.role))fail('Në grup mund të shtohen vetëm përdorues, agjentë dhe menaxherë.');tx(()=>{run('INSERT OR IGNORE INTO user_group_members(group_id,user_id,added_at,added_by) VALUES(?,?,?,?)',[g.id,u.id,now(),req.user.id]);audit(req.user.id,'user_group_member_added',{id:g.id,userId:u.id,username:u.username,role:u.role});});return {group:summary(g)};}));
  app.delete('/api/center/user-groups/:id/members/:userId',auth,route(req=>{const g=group(req.params.id);tx(()=>{run('DELETE FROM user_group_members WHERE group_id=? AND user_id=?',[g.id,Number(req.params.userId)]);audit(req.user.id,'user_group_member_removed',{id:g.id,userId:Number(req.params.userId)});});return {group:summary(g)};}));
  app.put('/api/center/user-groups/:id/limits',auth,route(req=>{const g=group(req.params.id),body=req.body?.limits||{};
   for(const [k,v] of Object.entries(body))if(!LIMIT_KEYS.includes(k)||(v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100000000)))fail('Limit i pavlefshëm.');
   tx(()=>{const before=limitsOf(g.id);for(const k of LIMIT_KEYS){if(!(k in body))continue;if(body[k]===null)run('DELETE FROM user_group_limits WHERE group_id=? AND key=?',[g.id,k]);else run('INSERT INTO user_group_limits(group_id,key,value) VALUES(?,?,?) ON CONFLICT(group_id,key) DO UPDATE SET value=excluded.value',[g.id,k,body[k]]);}audit(req.user.id,'user_group_limits_updated',{id:g.id,before,after:limitsOf(g.id)});});
   return {group:summary(g)};}));
 }
 return {mount,groupsOf,players,checkLimits};
}
module.exports={createUserGroups,MEMBER_ROLES,LIMIT_KEYS};
