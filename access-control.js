'use strict';

// Scope is independent of permissions. Never accept ownership from the browser.
module.exports = function accessControl({get, all, run, tx, now, hashPassword, validateCredentials, publicUser, auth, hasPermission, permissionsFor, jsonError, feedGames, checkCompetitions}) {
  const children = {center:['partner','operator'], partner:['admin'], admin:['senior'], senior:['manager'], supermanager:['manager'], manager:['agent'], agent:['user']};
  const fail = (message, status=403) => { throw Object.assign(new Error(message), {status}); };
  function lineage(id) {
    const rows=[], seen=new Set();
    while(id != null) {
      if(seen.has(Number(id))) fail('Invalid hierarchy.');
      seen.add(Number(id));
      const u=get('SELECT * FROM users WHERE id=?',[Number(id)]);
      if(!u) fail('Invalid hierarchy.');
      rows.push(u); id=u.business_parent_id ?? u.parent_id;
    }
    return rows;
  }
  function active(id) { return lineage(id).every(u=>u.status==='active'); }
  function inside(actor,id,self=true) {
    if(actor.role==='center') return true;
    const target=get('SELECT * FROM users WHERE id=?',[Number(id)]);
    if(!target) return false;
    if(actor.role==='operator'){
      if(['center','operator'].includes(target.role)) return false;
      const partners=delegatedPartners(actor.id);
      return !partners.length||lineage(target.id).some(u=>partners.includes(Number(u.id)));
    }
    if(Number(actor.id)===Number(id)) return self;
    const chain=lineage(id);
    // Control staff must never become business owners through a legacy parent link.
    if(chain.some(u=>u.role==='operator' && Number(u.id)===Number(actor.id))) return false;
    return chain.some(u=>Number(u.id)===Number(actor.id));
  }
  // A centre operator works for the whole network unless the centre delegates it to partners.
  function delegatedPartners(operatorId){try{return all('SELECT partner_id FROM operator_partners WHERE operator_id=? ORDER BY partner_id',[Number(operatorId)]).map(r=>Number(r.partner_id));}catch(_){return [];}}
  let userGroups=null;
  function ids(actor) { return all('SELECT id FROM users ORDER BY id').filter(u=>inside(actor,u.id)).map(u=>Number(u.id)); }
  function scope(actor,column='user_id') {
    const owned=ids(actor); return {sql:`${column} IN (${owned.map(()=>'?').join(',')||'NULL'})`,params:owned};
  }
  function requirePermission(actor,p) { if(!hasPermission(actor,p)) fail('Permission denied.'); }
  function target(actor,id,p,allowSelf=false) {
    requirePermission(actor,p);
    const u=get('SELECT * FROM users WHERE id=?',[Number(id)]);
    if(!u||!inside(actor,id,allowSelf)||(!allowSelf&&Number(actor.id)===Number(id))||u.role==='center') fail('Resource outside your scope.');
    return u;
  }
  const limitKeys=['max_bet','max_payout','max_exposure','max_users','max_agents','max_managers'];
  function limits(id) {
    const result={max_bet:100000,max_payout:100000000,max_exposure:100000000,max_users:1000000,max_agents:100000,max_managers:10000};
    for(const u of lineage(id)) for(const row of all('SELECT key,value FROM account_limits WHERE user_id=?',[u.id])) result[row.key]=Math.min(result[row.key],Number(row.value));
    return result;
  }
  function betLimit(amount,kind,message){throw Object.assign(new Error(message),{status:403,code:'BET_LIMIT_EXCEEDED',limitAmount:Number(amount),limitKind:kind});}
  function checkBet(userId,stake,payout,excludeBet=null,selections=[]) {
    if(!active(userId)) fail('Account or ancestor is not active.');
    const groups=userGroups?userGroups.groupsOf(userId):[];
    const verdict=checkCompetitions?checkCompetitions(excludeBet?all('SELECT game_id,league_id,market FROM bet_selections WHERE bet_id=?',[excludeBet]):selections,stake,payout,userId,excludeBet,{groups}):null;
    if(userGroups)userGroups.checkLimits(userId,stake,payout,excludeBet);
    const effective=limits(userId);
    if(stake>effective.max_bet)betLimit(effective.max_bet,'stake','Bet exceeds inherited limits.');
    if(payout>effective.max_payout)betLimit(effective.max_payout,'payout','Bet exceeds inherited limits.');
    const eventIds=[...new Set((excludeBet?all('SELECT game_id FROM bet_selections WHERE bet_id=?',[excludeBet]):selections).map(s=>String(s.game_id??s.gameId)))];
    const branch=new Set(lineage(userId).map(u=>Number(u.id)));
    for(const eventId of eventIds){
      for(const rule of all('SELECT * FROM event_risk_limits WHERE event_id=?',[eventId])){
        if(rule.scope_id!==0&&!branch.has(Number(rule.scope_id)))continue;
        if(rule.max_stake!==null&&stake>rule.max_stake)betLimit(rule.max_stake,'event_stake','Shuma e bastit tejkalon limitin e eventit '+eventId+'.');
        if(rule.max_payout!==null&&payout>rule.max_payout)betLimit(rule.max_payout,'event_payout','Fitimi potencial tejkalon limitin e eventit '+eventId+'.');
      }
    }
    const leagueRules=all('SELECT r.*,l.name FROM league_risk_limits r JOIN risk_leagues l ON l.league_id=r.league_id').filter(r=>r.scope_id===0||branch.has(Number(r.scope_id)));
    if(leagueRules.length){
      const picks=excludeBet?all('SELECT game_id,league_id FROM bet_selections WHERE bet_id=?',[excludeBet]):selections;
      for(const pick of picks){
        const leagueId=pick.league_id||get('SELECT league_id FROM risk_event_leagues WHERE event_id=?',[String(pick.game_id??pick.gameId)])?.league_id;
        if(!leagueId)fail('Liga e eventit nuk mund të verifikohet. Rifreskoni ligat përpara pranimit.');
        for(const rule of leagueRules.filter(r=>r.league_id===String(leagueId))){
          if(rule.max_stake!==null&&stake>rule.max_stake)betLimit(rule.max_stake,'league_stake','Shuma e bastit tejkalon limitin e ligës '+rule.name+'.');
          if(rule.max_payout!==null&&payout>rule.max_payout)betLimit(rule.max_payout,'league_payout','Fitimi potencial tejkalon limitin e ligës '+rule.name+'.');
        }
      }
    }
    for(const ancestor of lineage(userId)) {
      const own=scope(ancestor,'user_id');
      const exposure=Number(get(`SELECT COALESCE(SUM(potential_win),0) n FROM bets WHERE ${own.sql} AND status IN ('pending','accepted') AND id<>?`,[...own.params,excludeBet??-1]).n);
      if(exposure+payout>limits(ancestor.id).max_exposure) fail('Exposure limit exceeded.');
    }
    return {hold:verdict?.hold||[]};
  }
  function rememberLeagues(games){
    tx(()=>{for(const game of games){
      const id=String(game.league_id??''),name=String(game.league??'').trim(),eventId=String(game.id??game.game_id??'');
      if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||!name||!eventId)continue;
      run('INSERT INTO risk_leagues(league_id,name) VALUES(?,?) ON CONFLICT(league_id) DO UPDATE SET name=excluded.name',[id,name]);
      run('INSERT INTO risk_event_leagues(event_id,league_id) VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET league_id=excluded.league_id',[eventId,id]);
      run('UPDATE bet_selections SET league_id=? WHERE game_id=? AND league_id IS NULL',[id,eventId]);
    }});
  }
  function liveExposure(actor){
    const own=scope(actor,'b.user_id');
    return all(`SELECT x.game_id,COUNT(*) tickets,SUM(x.status='pending') pending,SUM(x.stake) stake,SUM(x.potential_win) liability FROM (SELECT DISTINCT bs.game_id,b.id,b.status,b.stake,b.potential_win FROM bet_selections bs JOIN bets b ON b.id=bs.bet_id WHERE ${own.sql} AND b.status IN ('pending','accepted')) x GROUP BY x.game_id`,own.params);
  }
  function audit(req,action,id,oldValue,newValue,type='user') {
    run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details,actor_role,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?)',[req.user.id,action,type,id,JSON.stringify({old:oldValue,new:newValue}),req.user.role,req.ip,String(req.headers['user-agent']||'').slice(0,500)]);
  }
  function migrate() {
    const add=(table,col,definition)=>{if(!all(`PRAGMA table_info(${table})`).some(c=>c.name===col))run(`ALTER TABLE ${table} ADD COLUMN ${col} ${definition}`);};
    add('users','partner_id','INTEGER');
    run('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL)');
    if(!get("SELECT version FROM schema_migrations WHERE version='operator_explicit_grants_v1'")){
      // Preserve existing operators' grants explicitly; new operators inherit none.
      for(const operator of all("SELECT id FROM users WHERE role='operator'"))for(const p of all("SELECT permission_key FROM role_permissions WHERE role_key='operator'"))run('INSERT OR IGNORE INTO user_permissions(user_id,permission_key,allowed) VALUES(?,?,1)',[operator.id,p.permission_key]);
      run("DELETE FROM role_permissions WHERE role_key='operator'");
      run('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)',['operator_explicit_grants_v1',now()]);
    }
    for(const [col,def] of Object.entries({actor_role:'TEXT',ip_address:'TEXT',user_agent:'TEXT'})) add('audit_log',col,def);
    for(const [col,def] of Object.entries({balance_before:'REAL',created_by:'INTEGER',currency:"TEXT NOT NULL DEFAULT 'EUR'",reference:'TEXT',status:"TEXT NOT NULL DEFAULT 'completed'"})) add('wallet_transactions',col,def);
    for(const col of ['partner_id','administrator_id','senior_id','manager_id']) add('bets',col,'INTEGER');
    add('bets','ticket_code','TEXT');
    add('bet_selections','original_odd','REAL');
    add('users','first_name',"TEXT NOT NULL DEFAULT ''");add('users','last_name',"TEXT NOT NULL DEFAULT ''");add('users','currency',"TEXT NOT NULL DEFAULT 'EUR'");
    add('bet_selections','league_id','TEXT');
    run('CREATE TABLE IF NOT EXISTS risk_leagues(league_id TEXT PRIMARY KEY,name TEXT NOT NULL)');
    run('CREATE TABLE IF NOT EXISTS risk_event_leagues(event_id TEXT PRIMARY KEY,league_id TEXT NOT NULL)');
    run('CREATE TABLE IF NOT EXISTS league_risk_limits(league_id TEXT NOT NULL,scope_id INTEGER NOT NULL DEFAULT 0,max_stake REAL CHECK(max_stake>=0),max_payout REAL CHECK(max_payout>=0),updated_by INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(league_id,scope_id))');
    run('UPDATE bet_selections SET original_odd=odd WHERE original_odd IS NULL');
    run('CREATE TABLE IF NOT EXISTS account_limits(user_id INTEGER NOT NULL REFERENCES users(id),key TEXT NOT NULL,value REAL NOT NULL CHECK(value>=0),PRIMARY KEY(user_id,key))');
    run('CREATE TABLE IF NOT EXISTS event_risk_limits(event_id TEXT NOT NULL,scope_id INTEGER NOT NULL DEFAULT 0,max_stake REAL CHECK(max_stake>=0),max_payout REAL CHECK(max_payout>=0),updated_by INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(event_id,scope_id))');
    run('CREATE TABLE IF NOT EXISTS idempotency(actor_id INTEGER NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(actor_id,key))');
    run('CREATE TABLE IF NOT EXISTS operator_partners(operator_id INTEGER NOT NULL,partner_id INTEGER NOT NULL,PRIMARY KEY(operator_id,partner_id))');
    run('CREATE TABLE IF NOT EXISTS login_history(id INTEGER PRIMARY KEY,user_id INTEGER,username TEXT NOT NULL,success INTEGER NOT NULL,ip_address TEXT,user_agent TEXT,created_at TEXT NOT NULL)');
    run('CREATE INDEX IF NOT EXISTS idx_login_history_user ON login_history(user_id,created_at)');
    run('CREATE INDEX IF NOT EXISTS idx_users_partner ON users(partner_id)');
    run('CREATE INDEX IF NOT EXISTS idx_wallet_user_date ON wallet_transactions(user_id,created_at)');
    run('CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_code ON bets(ticket_code)');
    run('UPDATE wallet_transactions SET balance_before=ROUND(balance_after-amount,2) WHERE balance_before IS NULL');
    run("UPDATE bets SET ticket_code='T-'||id WHERE ticket_code IS NULL");
    // Backfill only derivable ownership; do not invent partners for legacy accounts.
    for(const u of all('SELECT id FROM users')) {
      const partner=lineage(u.id).find(x=>x.role==='partner');
      run('UPDATE users SET partner_id=? WHERE id=?',[partner?.id??null,u.id]);
    }
    run(`CREATE TRIGGER IF NOT EXISTS ledger_metadata AFTER INSERT ON wallet_transactions BEGIN UPDATE wallet_transactions SET balance_before=ROUND(NEW.balance_after-NEW.amount,2) WHERE id=NEW.id AND balance_before IS NULL; END`);
    run(`CREATE TRIGGER IF NOT EXISTS ticket_identity AFTER INSERT ON bets BEGIN UPDATE bets SET ticket_code='T-'||NEW.id,partner_id=(SELECT partner_id FROM users WHERE id=NEW.user_id) WHERE id=NEW.id; END`);
    run('CREATE TRIGGER IF NOT EXISTS selection_snapshot AFTER INSERT ON bet_selections BEGIN UPDATE bet_selections SET original_odd=NEW.odd WHERE id=NEW.id; END');
    run("CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END");
    run("CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'Audit records are immutable'); END");
  }
  const route = fn => async (req,res) => {try {await fn(req,res);} catch(e) {jsonError(res,e.status||400,e.message.includes('UNIQUE')?'Already exists.':e.message);} };
  function mount(app) {
    const attempts=new Map();
    app.use('/api/auth/login',(req,res,next)=>{
      const key=req.ip, time=Date.now();
      for(const [k,v] of attempts) if(v.until<time) attempts.delete(k);
      const record=attempts.get(key)||{count:0,until:time+15*60000};
      if(++record.count>30){res.setHeader('Retry-After',Math.ceil((record.until-time)/1000));return jsonError(res,429,'Too many login attempts.');}
      attempts.set(key,record); next();
    });
    // Centre delegates an operator to one or more partners; none means the whole network.
    app.get('/api/center/operators/:id/partners',auth,route((req,res)=>{
      if(req.user.role!=='center')fail('Center access only.');
      const op=get("SELECT id FROM users WHERE id=? AND role='operator'",[Number(req.params.id)]);if(!op)fail('Operatori nuk ekziston.',404);
      res.json({partnerIds:delegatedPartners(op.id),partners:all("SELECT id,username,status FROM users WHERE role='partner' ORDER BY username")});
    }));
    app.put('/api/center/operators/:id/partners',auth,route((req,res)=>{
      if(req.user.role!=='center')fail('Center access only.');
      const op=get("SELECT id FROM users WHERE id=? AND role='operator'",[Number(req.params.id)]);if(!op)fail('Operatori nuk ekziston.',404);
      const list=Array.isArray(req.body?.partnerIds)?[...new Set(req.body.partnerIds.map(Number))]:null;
      if(!list||list.length>500||list.some(id=>!Number.isSafeInteger(id)||!get("SELECT id FROM users WHERE id=? AND role='partner'",[id])))fail('Zgjidh partnerë ekzistues.',400);
      tx(()=>{const before=delegatedPartners(op.id);run('DELETE FROM operator_partners WHERE operator_id=?',[op.id]);for(const id of list)run('INSERT INTO operator_partners(operator_id,partner_id) VALUES(?,?)',[op.id,id]);audit(req,'operator_partners_updated',op.id,before,list);});
      res.json({partnerIds:delegatedPartners(op.id)});
    }));
    app.get('/api/login-history',auth,route((req,res)=>res.json({logins:all('SELECT success,ip_address,user_agent,created_at FROM login_history WHERE user_id=? ORDER BY id DESC LIMIT 100',[req.user.id])})));
    app.get('/api/sessions',auth,route((req,res)=>res.json({sessions:all('SELECT created_at,expires_at,token=? AS current FROM sessions WHERE user_id=? AND expires_at>?',[req.user.token,req.user.id,now()])})));
    // Every legacy staff route receives a permission check before its handler.
    app.use('/api',(req,res,next)=>{
      if(!/^\/(center|admin|partner|senior|manager|agent|operator|staff)(\/|$)/.test(req.path)||req.path==='/staff/password') return next();
      auth(req,res,()=>{
        if(req.user.role==='user')return jsonError(res,403,'Staff access only.');
        let p='users.view';
        if(/^\/operator\/tickets\/\d+\/selections\/\d+\/status$/.test(req.path))p='bets.settle';
        else if(/^\/operator\/ticket-acceptance(?:\/|$)/.test(req.path))p='bets.accept';
        else if(/permissions/.test(req.path))p='permissions.manage';
        else if(/audit/.test(req.path))p='audit.view';
        else if(/transactions/.test(req.path))p='wallet.view';
        else if(/\/(credit|balance)$/.test(req.path))p=req.body.direction==='debit'?'wallet.debit':'wallet.credit';
        else if(/password$/.test(req.path))p='users.password.reset';
        else if(/status$/.test(req.path))p='users.block';
        else if(/\/(tickets|bets)/.test(req.path)) {
          const action=req.path.split('/').pop(); p=req.method==='GET'?'bets.view':({accept:'bets.accept',cancel:'bets.cancel',settle:'bets.settle',offer:'bets.offer_odds'})[action];
        } else if(/stats|overview/.test(req.path))p='reports.view';
        else if(req.method==='POST')p='users.create';
        if(!p||!hasPermission(req.user,p))return jsonError(res,403,'Permission denied.');
        next();
      });
    });
    const guard=(p,fn)=>[auth,route((req,res)=>{if(req.user.role==='user')fail('Staff access only.');requirePermission(req.user,p);return fn(req,res);})];
    const visibleUsers=actor=>all('SELECT * FROM users ORDER BY id').filter(u=>inside(actor,u.id,false)&&u.id!==actor.id).map(u=>{const row={...publicUser(u),partnerId:u.partner_id};if(!hasPermission(actor,'wallet.view'))for(const k of ['balance','reservedBalance','availableBalance','creditLimit'])delete row[k];return row;});
    app.get('/api/center/accounts/:id/permissions',...guard('permissions.manage',(req,res)=>{
      if(req.user.role!=='center')fail('Center access only.');
      const u=get('SELECT * FROM users WHERE id=?',[Number(req.params.id)]);if(!u)fail('Account not found.',404);
      res.json({permissions:[...permissionsFor(u.id,u.role)],available:all('SELECT permission_key FROM permissions ORDER BY permission_key').map(p=>p.permission_key)});
    }));
    // Resolve old URLs to the same handlers, including mutation validation.
    app.use((req,res,next)=>{
      const aliases={'/api/manager/tree':'/api/network','/api/operator/hierarchy':'/api/network','/api/operator/users':'/api/accounts','/api/admin/users':'/api/accounts','/api/admin/stats':'/api/dashboard','/api/partner/overview':'/api/dashboard','/api/senior/overview':'/api/dashboard','/api/manager/overview':'/api/dashboard','/api/agent/overview':'/api/dashboard'};
      if(req.method==='GET'&&aliases[req.path])req.url=aliases[req.path]+(req.url.includes('?')?req.url.slice(req.url.indexOf('?')):'');
      if(req.method==='POST') {
        const roles={'/api/center/operators':'operator','/api/center/partners':'partner','/api/center/seniors':'senior','/api/partner/admins':'admin','/api/admin/seniors':'senior','/api/admin/supermanagers':'senior','/api/senior/managers':'manager','/api/manager/agents':'agent','/api/agent/users':'user','/api/manager/users':'user'};
        if(roles[req.path]) {req.body.role=roles[req.path];req.url='/api/accounts';}
        else if(['/api/center/accounts','/api/center/users'].includes(req.path)){req.body.parentId=req.body.businessParentId??req.body.parentId;req.url='/api/accounts';}
        else if(/^\/api\/(admin|manager)\/users\/\d+\/(status|password)$/.test(req.path)) req.url=req.path.replace(/^\/api\/(admin|manager)\/users/,'/api/accounts');
        else if(/^\/api\/(admin|manager)\/users\/\d+\/balance$/.test(req.path)) req.url=req.path.replace(/^\/api\/(admin|manager)\/users/,'/api/staff').replace(/balance$/,'credit');
      }
      next();
    });
    app.get('/api/network',...guard('users.view',(req,res)=>res.json({users:visibleUsers(req.user)})));
    app.get('/api/accounts',...guard('users.view',(req,res)=>{const q=String(req.query.q||'').toLowerCase();res.json({users:visibleUsers(req.user).filter(u=>!q||u.username.includes(q)||String(u.id)===q)});}));
    app.get('/api/accounts/:id',...guard('users.view',(req,res)=>{target(req.user,req.params.id,'users.view');res.json({user:visibleUsers(req.user).find(u=>u.id===Number(req.params.id)),limits:limits(req.params.id)});}));
    app.post('/api/accounts',...guard('users.create',(req,res)=>{
      const role=String(req.body.role||''),parentId=req.user.role==='center'?Number(req.body.parentId||req.user.id):req.user.id;
      const parent=get('SELECT * FROM users WHERE id=?',[parentId]);
      if(!parent||!inside(req.user,parentId)||!active(parentId)||!children[parent.role]?.includes(role))fail('Invalid parent or child role.');
      if(req.user.role!=='center'&&req.body.parentId!=null&&Number(req.body.parentId)!==req.user.id)fail('Cannot choose another parent.');
      const username=String(req.body.username||'').trim().toLowerCase(),password=String(req.body.password||'');validateCredentials(username,password);
      for(const ancestor of lineage(parentId)) {
        const key={user:'max_users',agent:'max_agents',manager:'max_managers'}[role];
        if(key&&all('SELECT id FROM users WHERE role=?',[role]).filter(u=>inside(ancestor,u.id)).length>=limits(ancestor.id)[key])fail('Account limit exceeded.');
      }
      const firstName=String(req.body.firstName||'').trim(),lastName=String(req.body.lastName||'').trim(),currency=req.body.currency||'EUR';
      if(firstName.length>100||lastName.length>100||currency!=='EUR')fail('Invalid profile or currency.',400);
      const credit=Number(req.body.initialCredit??0),cents=Math.round(credit*100),key=String(req.headers['idempotency-key']||'');
      if(!Number.isFinite(credit)||credit<0||credit>100000000||Math.abs(credit*100-cents)>0.00001)fail('Invalid initial credit.',400);
      if(credit>0){requirePermission(req.user,'wallet.credit');if(!/^[a-zA-Z0-9_-]{8,128}$/.test(key))fail('Idempotency-Key required.',400);}
      const fingerprint=JSON.stringify({operation:'account_create',username,role,parentId,firstName,lastName,currency,cents,passwordHash:require('crypto').createHash('sha256').update(password).digest('hex')});
      const id=tx(()=>{
        if(credit>0){const replay=get('SELECT * FROM idempotency WHERE actor_id=? AND key=?',[req.user.id,key]);if(replay){if(replay.fingerprint!==fingerprint)fail('Idempotency conflict.',409);return JSON.parse(replay.response).id;}}
        run('INSERT INTO users(username,password_hash,role,status,parent_id,business_parent_id,control_parent_id,partner_id,created_by) VALUES(?,?,?,\'active\',?,?,?,?,?)',[username,hashPassword(password),role,parentId,role==='operator'?null:parentId,role==='operator'?parentId:null,parent.partner_id,req.user.id]);
        const id=Number(get('SELECT last_insert_rowid() id').id);
        if(role==='partner')run('UPDATE users SET partner_id=? WHERE id=?',[id,id]);
        run('UPDATE users SET first_name=?,last_name=?,currency=? WHERE id=?',[firstName,lastName,currency,id]);
        if(credit>0){const actor=get('SELECT * FROM users WHERE id=?',[req.user.id]);if(actor.role!=='center'&&Math.round((Number(actor.balance)-Number(actor.reserved_balance||0))*100)<cents)fail('Kredi e pamjaftueshme për krijimin e llogarisë.',400);
          if(actor.role!=='center'){const remaining=(Math.round(Number(actor.balance)*100)-cents)/100;run('UPDATE users SET balance=? WHERE id=?',[remaining,actor.id]);run('INSERT INTO wallet_transactions(user_id,type,amount,balance_before,balance_after,created_by,currency,reference,note) VALUES(?,?,?,?,?,?,?,?,?)',[actor.id,'transfer_out',-credit,actor.balance,remaining,actor.id,'EUR',key,'Initial account credit']);}
          run('UPDATE users SET balance=? WHERE id=?',[credit,id]);run('INSERT INTO wallet_transactions(user_id,type,amount,balance_before,balance_after,created_by,currency,reference,note) VALUES(?,?,?,?,?,?,?,?,?)',[id,'transfer_in',credit,0,credit,actor.id,'EUR',key,'Initial account credit']);audit(req,'wallet_transfer',id,null,{amount:credit,reference:key,initialCredit:true});run('INSERT INTO idempotency(actor_id,key,fingerprint,response) VALUES(?,?,?,?)',[actor.id,key,fingerprint,JSON.stringify({id})]);
        }
        audit(req,'account_created',id,null,{username,role,parentId});return id;
      });res.status(201).json({user:publicUser(get('SELECT * FROM users WHERE id=?',[id]))});
    }));
    app.patch('/api/accounts/:id',...guard('users.edit',(req,res)=>{
      const u=target(req.user,req.params.id,'users.edit');
      if(Object.keys(req.body).some(k=>k!=='username'))fail('Only username can be edited here.',400);
      const username=String(req.body.username||'').trim().toLowerCase();validateCredentials(username,'validation-only');
      tx(()=>{run('UPDATE users SET username=?,updated_at=? WHERE id=?',[username,now(),u.id]);audit(req,'account_edited',u.id,{username:u.username},{username});});res.json({ok:true});
    }));
    app.post('/api/accounts/:id/status',...guard('users.block',(req,res)=>{
      const u=target(req.user,req.params.id,'users.block'),status=req.body.status;
      if(!['active','disabled','suspended','locked','archived','blocked'].includes(status))fail('Invalid status.',400);
      tx(()=>{run('UPDATE users SET status=?,updated_at=? WHERE id=?',[status,now(),u.id]);if(status!=='active')for(const x of all('SELECT id FROM users').filter(x=>lineage(x.id).some(a=>a.id===u.id)))run('DELETE FROM sessions WHERE user_id=?',[x.id]);audit(req,'account_status',u.id,{status:u.status},{status});});res.json({ok:true});
    }));
    app.post('/api/accounts/:id/password',...guard('users.password.reset',(req,res)=>{
      const u=target(req.user,req.params.id,'users.password.reset'),password=String(req.body.password||'');validateCredentials(u.username,password);
      tx(()=>{run('UPDATE users SET password_hash=? WHERE id=?',[hashPassword(password),u.id]);run('DELETE FROM sessions WHERE user_id=?',[u.id]);audit(req,'password_reset',u.id,null,{revoked:true});});res.json({ok:true});
    }));
    app.post('/api/accounts/:id/logout',...guard('users.password.reset',(req,res)=>{const u=target(req.user,req.params.id,'users.password.reset');tx(()=>{run('DELETE FROM sessions WHERE user_id=?',[u.id]);audit(req,'sessions_revoked',u.id,null,null);});res.json({ok:true});}));
    app.put('/api/accounts/:id/limits',...guard('users.edit',(req,res)=>{
      const u=target(req.user,req.params.id,'users.edit'),parent=u.business_parent_id??u.parent_id,maximum=limits(parent??u.id),updates=req.body;
      if(!updates||Array.isArray(updates)||!Object.keys(updates).length)fail('Limits required.',400);
      for(const [k,v] of Object.entries(updates))if(!limitKeys.includes(k)||typeof v!=='number'||!Number.isFinite(v)||v<0||v>maximum[k]||(['max_users','max_agents','max_managers'].includes(k)&&!Number.isInteger(v)))fail('Limit exceeds parent or is invalid.');
      tx(()=>{const old=limits(u.id);for(const [k,v] of Object.entries(updates))run('INSERT INTO account_limits(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value',[u.id,k,v]);audit(req,'limits_updated',u.id,old,limits(u.id));});res.json({limits:limits(u.id)});
    }));
    app.get('/api/accounts/:id/transactions',...guard('wallet.view',(req,res)=>{const u=target(req.user,req.params.id,'wallet.view');res.json({transactions:all('SELECT * FROM wallet_transactions WHERE user_id=? ORDER BY id DESC LIMIT 500',[u.id])});}));
    app.post('/api/staff/:id/credit',auth,route((req,res)=>{
      const direction=req.body.direction||'credit';if(!['credit','debit'].includes(direction))fail('Invalid direction.',400);
      const u=target(req.user,req.params.id,direction==='credit'?'wallet.credit':'wallet.debit');
      const actor=get('SELECT * FROM users WHERE id=?',[req.user.id]);
      if(actor.role!=='center'&&(Number(u.business_parent_id??u.parent_id)!==actor.id||!children[actor.role]?.includes(u.role)))fail('Only direct business children can receive transfers.');
      if(!active(u.id))fail('Target or ancestor is inactive.');
      const amount=req.body.amount===undefined?NaN:Number(req.body.amount),cents=Math.round(amount*100);
      if(!Number.isFinite(amount)||amount<=0||amount>100000000||Math.abs(amount*100-cents)>0.00001)fail('Invalid amount.',400);
      const key=String(req.headers['idempotency-key']||'');if(!/^[a-zA-Z0-9_-]{8,128}$/.test(key))fail('Idempotency-Key required (8–128 characters).',400);
      const fingerprint=JSON.stringify({target:u.id,cents,direction});
      const out=tx(()=>{
        const replay=get('SELECT * FROM idempotency WHERE actor_id=? AND key=?',[actor.id,key]);
        if(replay){if(replay.fingerprint!==fingerprint)fail('Idempotency key already used for another operation.',409);return JSON.parse(replay.response);}
        const source=direction==='credit'?actor:u,destination=direction==='credit'?u:actor;
        const mint=source.role==='center';
        if(!mint&&Math.round((source.balance-source.reserved_balance)*100)<cents)fail('Insufficient available funds.',400);
        const entries=[];
        if(!mint)entries.push([source,-cents]);
        if(destination.role!=='center')entries.push([destination,cents]);
        for(const [account,delta] of entries){
          const balance=(Math.round(account.balance*100)+delta)/100;
          run('UPDATE users SET balance=? WHERE id=?',[balance,account.id]);
          run('INSERT INTO wallet_transactions(user_id,type,amount,balance_before,balance_after,created_by,currency,reference,note) VALUES(?,?,?,?,?,?,?,?,?)',[account.id,delta>0?'transfer_in':'transfer_out',delta/100,account.balance,balance,actor.id,'EUR',key,`Transfer ${source.id} -> ${destination.id}`]);
        }
        audit(req,'wallet_transfer',u.id,{actorBalance:actor.balance,targetBalance:u.balance},{amount,direction,reference:key});
        const result={ok:true,actorBalance:get('SELECT balance FROM users WHERE id=?',[actor.id]).balance,targetBalance:get('SELECT balance FROM users WHERE id=?',[u.id]).balance};
        run('INSERT INTO idempotency(actor_id,key,fingerprint,response) VALUES(?,?,?,?)',[actor.id,key,fingerprint,JSON.stringify(result)]);return result;
      });res.json(out);
    }));
    app.get('/api/staff/overview',...guard('reports.view',(req,res)=>{
      const accounts=hasPermission(req.user,'users.view')?visibleUsers(req.user):[];
      const fundTargets=hasPermission(req.user,'wallet.credit')?accounts.filter(u=>u.status==='active'&&(req.user.role==='center'||(u.businessParentId??u.parentId)===req.user.id&&children[req.user.role]?.includes(u.role))):[];
      const s=scope(req.user);res.json({profile:publicUser(get('SELECT * FROM users WHERE id=?',[req.user.id])),accounts,fundTargets,pendingTickets:hasPermission(req.user,'bets.view')?Number(get(`SELECT COUNT(*) n FROM bets WHERE ${s.sql} AND status='pending'`,s.params).n):0});
    }));
    app.get('/api/admin/bets',...guard('bets.view',(req,res)=>{
      const s=scope(req.user,'b.user_id');res.json({bets:all(`SELECT b.*,u.username FROM bets b JOIN users u ON u.id=b.user_id WHERE ${s.sql} AND (?='' OR b.status=?) ORDER BY b.id DESC LIMIT 500`,[...s.params,String(req.query.status||''),String(req.query.status||'')]).map(b=>({...b,selections:all('SELECT *,game_id AS gameId,home_team AS home,away_team AS away FROM bet_selections WHERE bet_id=?',[b.id])}))});
    }));
    app.get('/api/admin/bets/:id',...guard('bets.view',(req,res)=>{
      const bet=get('SELECT b.*,u.username FROM bets b JOIN users u ON u.id=b.user_id WHERE b.id=?',[Number(req.params.id)]);
      if(!bet||!inside(req.user,bet.user_id))fail('Resource outside your scope.');
      res.json({bet:{...bet,selections:all('SELECT * FROM bet_selections WHERE bet_id=? ORDER BY id',[bet.id]),offer:get('SELECT * FROM bet_offers WHERE bet_id=?',[bet.id])}});
    }));
    app.get('/api/admin/users/:id/bets',...guard('bets.view',(req,res)=>{
      const u=target(req.user,req.params.id,'bets.view');res.json({bets:all('SELECT * FROM bets WHERE user_id=? ORDER BY id DESC LIMIT 500',[u.id]).map(b=>({...b,selections:all('SELECT * FROM bet_selections WHERE bet_id=?',[b.id])}))});
    }));
    app.get('/api/admin/transactions',...guard('wallet.view',(req,res)=>{const s=scope(req.user,'t.user_id');res.json({transactions:all(`SELECT t.*,u.username FROM wallet_transactions t JOIN users u ON u.id=t.user_id WHERE ${s.sql} ORDER BY t.id DESC LIMIT 500`,s.params)});}));
    app.get('/api/admin/audit',...guard('audit.view',(req,res)=>{
      const logs=all('SELECT * FROM audit_log ORDER BY id DESC').filter(a=>req.user.role==='center'||(a.target_type==='user'&&inside(req.user,a.target_id))||(a.target_type==='bet'&&inside(req.user,get('SELECT user_id FROM bets WHERE id=?',[a.target_id])?.user_id))).slice(0,500);res.json({logs});
    }));
    const dashboard=(req,res)=>{
      const s=scope(req.user,'b.user_id'), params=[...s.params];let where=s.sql;
      for(const [key,op] of [['from','>='],['to','<=']])if(req.query[key]){const date=new Date(req.query[key]);if(!Number.isFinite(date.getTime()))fail('Invalid date.',400);where+=` AND datetime(b.created_at)${op}datetime(?)`;params.push(date.toISOString());}
      const summary=get(`SELECT COUNT(*) totalBets,COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','void','rejected') THEN stake ELSE 0 END),0) turnover,COALESCE(SUM(payout),0) payouts,COALESCE(SUM(CASE WHEN status IN ('pending','accepted') THEN potential_win ELSE 0 END),0) exposure,SUM(status='pending') pendingBets,SUM(status='accepted') openBets,SUM(status='won') wonBets,SUM(status='lost') lostBets,SUM(status='void') voidBets FROM bets b WHERE ${where}`,params);
      const users=all('SELECT id,role,status,balance FROM users').filter(u=>inside(req.user,u.id)&&u.role!=='center');
      const settled=get(`SELECT COALESCE(SUM(stake-payout),0) ggr FROM bets b WHERE ${where} AND status IN ('won','lost')`,params);
      res.json({...summary,ggr:settled.ggr,totalBalances:users.reduce((n,u)=>n+u.balance,0),counts:Object.fromEntries(Object.keys({...children,operator:[],user:[]}).map(r=>[r,users.filter(u=>u.role===r).length])),activeUsers:users.filter(u=>u.role==='user'&&u.status==='active').length});
    };
    app.get('/api/hierarchy-finance',...guard('reports.view',(req,res)=>{
      if(!['partner','admin','senior','supermanager','manager','agent'].includes(req.user.role))fail('Business account required.');
      const from=req.query.from?new Date(String(req.query.from)):null,to=req.query.to?new Date(String(req.query.to)):null;
      if((from&&!Number.isFinite(from.getTime()))||(to&&!Number.isFinite(to.getTime()))||(from&&to&&from>to))fail('Interval kohor i pavlefshëm.',400);
      const accounts=all('SELECT id,username,role,business_parent_id,parent_id FROM users'),direct=accounts.filter(u=>Number(u.business_parent_id??u.parent_id)===Number(req.user.id)&&children[req.user.role]?.includes(u.role));
      const rows=direct.map(u=>({id:Number(u.id),username:u.username,role:u.role,currency:'EUR',turnover:0,payout:0,commission:0,difference:0,pendingStake:0,unsettledStake:0,tickets:0})),byChild=new Map(rows.map(r=>[r.id,r])),owners=new Map();
      for(const account of accounts.filter(u=>u.role==='user')){const chain=lineage(account.id);const index=chain.findIndex(u=>Number(u.id)===Number(req.user.id));if(index>0&&byChild.has(Number(chain[index-1].id)))owners.set(Number(account.id),Number(chain[index-1].id));}
      const owned=[...owners.keys()],args=[...owned];let filter='';if(from){filter+=' AND datetime(created_at)>=datetime(?)';args.push(from.toISOString());}if(to){filter+=' AND datetime(created_at)<datetime(?)';args.push(to.toISOString());}
      const stats=owned.length?all("SELECT user_id,COUNT(*) tickets,COALESCE(SUM(CASE WHEN status IN ('accepted','won','lost','void') THEN stake ELSE 0 END),0) turnover,COALESCE(SUM(CASE WHEN status IN ('won','lost','void') THEN payout ELSE 0 END),0) payout,COALESCE(SUM(CASE WHEN status='pending' THEN stake ELSE 0 END),0) pendingStake,COALESCE(SUM(CASE WHEN status='accepted' THEN stake ELSE 0 END),0) unsettledStake FROM bets WHERE user_id IN ("+owned.map(()=>'?').join(',')+")"+filter+" GROUP BY user_id",args):[];
      for(const stat of stats){const row=byChild.get(owners.get(Number(stat.user_id)));for(const k of ['turnover','payout','pendingStake','unsettledStake','tickets'])row[k]+=Number(stat[k]);}
      const summary={turnover:0,payout:0,commission:0,difference:0,pendingStake:0,unsettledStake:0,tickets:0};for(const row of rows){for(const k of Object.keys(summary)){if(k==='difference')row[k]=Number((row.turnover-row.payout-row.commission).toFixed(2));else if(k!=='tickets')row[k]=Number(row[k].toFixed(2));summary[k]+=row[k];}}for(const k of Object.keys(summary))summary[k]=Number(summary[k].toFixed(2));
      const walletArgs=[req.user.id],walletFilter=filter;if(from)walletArgs.push(from.toISOString());if(to)walletArgs.push(to.toISOString());const me=get('SELECT * FROM users WHERE id=?',[req.user.id]);
      res.json({username:me.username,balance:Number(me.balance),reservedBalance:Number(me.reserved_balance||0),rows,summary,commissionConfigured:false,transactions:hasPermission(req.user,'wallet.view')?all('SELECT id,type,amount,balance_after AS balanceAfter,bet_id AS betId,created_at AS createdAt FROM wallet_transactions WHERE user_id=?'+walletFilter+' ORDER BY id DESC LIMIT 200',walletArgs):[]});
    }));
    app.get('/api/dashboard',...guard('reports.view',dashboard));app.get('/api/reports',...guard('reports.view',dashboard));
    app.get('/api/live-exposure',...guard('risk.view',(req,res)=>res.json({events:liveExposure(req.user)})));
    app.get('/api/risk',...guard('risk.view',(req,res)=>{const s=scope(req.user,'b.user_id');res.json({largestBets:all(`SELECT b.*,u.username FROM bets b JOIN users u ON u.id=b.user_id WHERE ${s.sql} AND b.status IN ('pending','accepted') ORDER BY b.potential_win DESC LIMIT 100`,s.params),markets:all(`SELECT bs.game_id,bs.market_id,bs.selection,MAX(NULLIF(TRIM(bs.home_team),'')) home_team,MAX(NULLIF(TRIM(bs.away_team),'')) away_team,MAX(NULLIF(TRIM(bs.league),'')) league,SUM(b.potential_win) liability FROM bet_selections bs JOIN bets b ON b.id=bs.bet_id WHERE ${s.sql} AND b.status IN ('pending','accepted') GROUP BY bs.game_id,bs.market_id,bs.selection ORDER BY liability DESC LIMIT 100`,s.params)});}));
    function riskEvent(req){
      const eventId=String(req.params.eventId||'');if(!/^[a-zA-Z0-9_-]{1,100}$/.test(eventId))fail('Event i pavlefshëm.',400);
      const s=scope(req.user,'b.user_id');
      if(!get(`SELECT bs.id FROM bet_selections bs JOIN bets b ON b.id=bs.bet_id WHERE bs.game_id=? AND ${s.sql} LIMIT 1`,[eventId,...s.params]))fail('Event jashtë scope-it.');
      return eventId;
    }
    function riskScope(actor,value){
      const id=Number(value);if(!Number.isSafeInteger(id)||id<0)fail('Scope i pavlefshëm.',400);
      if(id===0){if(actor.role!=='center')fail('Vetëm Qendra vendos limite globale.');return id;}
      const u=get('SELECT * FROM users WHERE id=?',[id]);
      if(!u||!inside(actor,id)||['center','operator'].includes(u.role))fail('Llogaria është jashtë scope-it.');return id;
    }
    app.get('/api/risk/events/:eventId/limits',...guard('risk.view',(req,res)=>{
      const eventId=riskEvent(req);
      const rules=all('SELECT r.*,u.username,u.role FROM event_risk_limits r LEFT JOIN users u ON u.id=r.scope_id WHERE r.event_id=?',[eventId]).filter(r=>r.scope_id===0||inside(req.user,r.scope_id)||lineage(req.user.id).some(u=>u.id===r.scope_id));
      const accounts=hasPermission(req.user,'risk.manage')?all("SELECT id,username,role FROM users WHERE role NOT IN ('center','operator') ORDER BY username").filter(u=>inside(req.user,u.id)):[];
      res.json({rules,accounts,canGlobal:req.user.role==='center'});
    }));
    app.put('/api/risk/events/:eventId/limits',...guard('risk.manage',(req,res)=>{
      const eventId=riskEvent(req),scopeId=riskScope(req.user,req.body.scopeId);
      const values=['maxStake','maxPayout'].map(key=>{const v=req.body[key];if(v===null)return null;if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100000000||Math.abs(v*100-Math.round(v*100))>0.00001)fail('Limiti duhet të jetë shumë pozitive në EUR ose bosh.',400);return v;});
      if(values.every(v=>v===null))fail('Vendosni të paktën një limit.',400);
      tx(()=>{const old=get('SELECT * FROM event_risk_limits WHERE event_id=? AND scope_id=?',[eventId,scopeId]);run('INSERT INTO event_risk_limits(event_id,scope_id,max_stake,max_payout,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(event_id,scope_id) DO UPDATE SET max_stake=excluded.max_stake,max_payout=excluded.max_payout,updated_by=excluded.updated_by,updated_at=excluded.updated_at',[eventId,scopeId,...values,req.user.id,now()]);audit(req,'event_risk_updated',scopeId,old,{eventId,scopeId,maxStake:values[0],maxPayout:values[1]},'event_risk');});res.json({ok:true});
    }));
    app.delete('/api/risk/events/:eventId/limits/:scopeId',...guard('risk.manage',(req,res)=>{
      const eventId=riskEvent(req),scopeId=riskScope(req.user,req.params.scopeId);
      tx(()=>{const old=get('SELECT * FROM event_risk_limits WHERE event_id=? AND scope_id=?',[eventId,scopeId]);run('DELETE FROM event_risk_limits WHERE event_id=? AND scope_id=?',[eventId,scopeId]);audit(req,'event_risk_removed',scopeId,old,{eventId,scopeId},'event_risk');});res.json({ok:true});
    }));
    function riskLeague(req){
      const id=String(req.params.leagueId||'');
      if(!get('SELECT league_id FROM risk_leagues WHERE league_id=?',[id]))fail('Liga nuk u gjet në furnizimin e API-së.',404);
      return id;
    }
    app.get('/api/risk/leagues',...guard('risk.view',async(req,res)=>{
      const games=await feedGames();rememberLeagues(games);
      const counts=new Map();for(const g of games){const id=String(g.league_id??'');if(!counts.has(id))counts.set(id,new Set());counts.get(id).add(String(g.id));}
      const leagues=all('SELECT * FROM risk_leagues ORDER BY name').map(l=>({...l,eventCount:counts.get(l.league_id)?.size||0}));
      res.json({leagues,feedAvailable:games.length>0});
    }));
    app.get('/api/risk/leagues/:leagueId/limits',...guard('risk.view',(req,res)=>{
      const leagueId=riskLeague(req);
      const rules=all('SELECT r.*,u.username,u.role FROM league_risk_limits r LEFT JOIN users u ON u.id=r.scope_id WHERE r.league_id=?',[leagueId]).filter(r=>r.scope_id===0||inside(req.user,r.scope_id)||lineage(req.user.id).some(u=>u.id===r.scope_id));
      const accounts=hasPermission(req.user,'risk.manage')?all("SELECT id,username,role FROM users WHERE role NOT IN ('center','operator') ORDER BY username").filter(u=>inside(req.user,u.id)):[];
      res.json({rules,accounts,canGlobal:req.user.role==='center'});
    }));
    app.put('/api/risk/leagues/:leagueId/limits',...guard('risk.manage',(req,res)=>{
      const leagueId=riskLeague(req),scopeId=riskScope(req.user,req.body.scopeId);
      const values=['maxStake','maxPayout'].map(key=>{const v=req.body[key];if(v===null)return null;if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100000000||Math.abs(v*100-Math.round(v*100))>0.00001)fail('Limiti duhet të jetë shumë pozitive në EUR ose bosh.',400);return v;});
      if(values.every(v=>v===null))fail('Vendosni të paktën një limit.',400);
      tx(()=>{const old=get('SELECT * FROM league_risk_limits WHERE league_id=? AND scope_id=?',[leagueId,scopeId]);run('INSERT INTO league_risk_limits(league_id,scope_id,max_stake,max_payout,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(league_id,scope_id) DO UPDATE SET max_stake=excluded.max_stake,max_payout=excluded.max_payout,updated_by=excluded.updated_by,updated_at=excluded.updated_at',[leagueId,scopeId,...values,req.user.id,now()]);audit(req,'league_risk_updated',scopeId,old,{leagueId,scopeId,maxStake:values[0],maxPayout:values[1]},'league_risk');});res.json({ok:true});
    }));
    app.delete('/api/risk/leagues/:leagueId/limits/:scopeId',...guard('risk.manage',(req,res)=>{
      const leagueId=riskLeague(req),scopeId=riskScope(req.user,req.params.scopeId);
      tx(()=>{const old=get('SELECT * FROM league_risk_limits WHERE league_id=? AND scope_id=?',[leagueId,scopeId]);run('DELETE FROM league_risk_limits WHERE league_id=? AND scope_id=?',[leagueId,scopeId]);audit(req,'league_risk_removed',scopeId,old,{leagueId,scopeId},'league_risk');});res.json({ok:true});
    }));
    app.get('/api/search',...guard('users.view',(req,res)=>{
      const q=String(req.query.q||'').trim().slice(0,100);if(!q)return res.json({users:[],bets:[],transactions:[]});
      const s=scope(req.user),like='%'+q+'%';res.json({users:visibleUsers(req.user).filter(u=>u.username.includes(q.toLowerCase())||String(u.id)===q),bets:hasPermission(req.user,'bets.view')?all(`SELECT id,ticket_code,user_id,status FROM bets WHERE ${s.sql} AND (ticket_code LIKE ? OR CAST(id AS TEXT)=?) LIMIT 100`,[...s.params,like,q]):[],transactions:hasPermission(req.user,'wallet.view')?all(`SELECT id,user_id,type,amount FROM wallet_transactions WHERE ${s.sql} AND CAST(id AS TEXT)=? LIMIT 100`,[...s.params,q]):[]});
    }));
  }
  function recordLogin(req,user,success) {tx(()=>run('INSERT INTO login_history(user_id,username,success,ip_address,user_agent,created_at) VALUES(?,?,?,?,?,?)',[user?.id??null,String(req.body.username||'').trim().toLowerCase().slice(0,32),success?1:0,req.ip,String(req.headers['user-agent']||'').slice(0,500),now()]));}
  return {liveExposure,rememberLeagues,children,lineage,active,inside,scope,limits,checkBet,audit,migrate,mount,recordLogin,delegatedPartners,useGroups:g=>{userGroups=g;}};
};
