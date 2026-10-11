function brandLoading(extra=''){return '<div class="brand-loading '+extra+'" role="status" aria-label="Duke ngarkuar" aria-busy="true"><span class="brand-loading-mark"><img src="/assets/brand/bb.png" width="64" height="64" alt=""></span></div>';}
localStorage.removeItem('sportsbook_token'); // Discard legacy persistent credentials.
const $=id=>document.getElementById(id), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
let mode='home',timer=null,cache=[],selectedSport='soccer',query='',activeLeague='',lastOdds={},slip=[],pendingTicket=null,token=sessionStorage.getItem('sportsbook_token')||'',user=null,liveStream=null,openLiveGameId=null,liveMarketsCache=new Map(),myBetsReturnMode='home',liveMatchSportId='1';
const liveClockState=new Map();
const liveClockRevision=new Map();
let liveLoadSequence=0;
let selectedPrematchLeague='';
const sportsPageCache=new Map();
const liveMarketRequestSeq=new Map();
// A live match can be refreshed by the timer, stream and route change at once.
// Keep one request per match so those updates cannot race each other or overload
// the provider while the player is trying to open the markets.
const liveMarketRequests=new Map();
function isNewLiveActivation(e,id){
  // The browser emits click after a completed tap and cancels it for scrolling.
  // Never select an odd at the beginning of a touch/drag gesture.
  return e.type==='click' && (e.button==null || e.button===0);
}
function clockToSeconds(v){const m=String(v??'').match(/^(\d{1,3}):(\d{2})$/);return m?Number(m[1])*60+Number(m[2]):null}
function secondsToClock(sec){sec=Math.max(0,Math.floor(sec));return String(Math.floor(sec/60)).padStart(2,'0')+':'+String(sec%60).padStart(2,'0')}
function liveClockRunning(g){
  const status=g?.api_status??g?.game_status;
  if(status==null||status==='')return true;
  return String(status)==='1';
}
// Interpolate only briefly between provider samples. Repeated samples never
// reset the anchor: a frozen or disconnected feed cannot run indefinitely.
function syncLiveClock(g){
  const raw=g.current_minute??g.game_time,sec=clockToSeconds(raw),key=String(g.id),at=Date.now();
  const prev=liveClockState.get(key),status=g.api_status??g.game_status;
  const paused=status!=null&&status!==''&&String(status)!=='1';
  const football=g.sport_id==null||String(g.sport_id)==='1';
  const boundary=football&&sec!==null&&[2700,5400,6300,7200].includes(sec);
  if(sec===null){liveClockState.set(key,{text:String(raw||'LIVE')});return String(raw||'LIVE');}
  if(!prev||prev.api!==sec||prev.explicitPaused!==paused){
    let base=sec;
    if(prev&&prev.api!==undefined&&!paused&&!boundary&&!prev.paused&&sec>prev.api){
      const predicted=prev.base+Math.min(12,Math.max(0,(at-prev.at)/1000));
      // Small delivery jitter must not skip or repeat a displayed second.
      if(Math.abs(predicted-sec)<=2&&![2700,5400,6300,7200].some(n=>prev.api<=n&&sec>n))base=predicted;
    }
    liveClockState.set(key,{api:sec,base,at,paused:paused||boundary,explicitPaused:paused,football});
  }
  return getLiveClock(g);
}
function getLiveClock(g){
  const st=liveClockState.get(String(g.id));if(!st)return syncLiveClock(g);
  if(st.text!==undefined)return st.text;
  let sec=st.base+(st.paused?0:Math.min(12,Math.max(0,(Date.now()-st.at)/1000)));
  if(st.football){const boundary=[2700,5400,6300,7200].find(n=>st.api<=n);if(boundary!==undefined)sec=Math.min(sec,boundary);}
  return secondsToClock(sec);
}
function tickLiveClocks(){if(mode!=='live'&&mode!=='livematch')return;document.querySelectorAll('[data-live-clock]').forEach(el=>{const g=cache.find(x=>String(x.id)===String(el.dataset.liveClock));const clock=el.querySelector('.live-clock-value');if(g&&clock)clock.textContent=getLiveClock(g)});if(mode==='livematch'){const g=findLiveGame(openLiveGameId);if(g)document.querySelectorAll('.live-detail-score small,.live-pitch-status strong').forEach(el=>{if(/^[0-9]+:[0-9]{2}$/.test(el.textContent))el.textContent=getLiveClock(g)})}const modalClock=$('liveMarketsOverlay')?.querySelector('[data-live-modal-clock]');if(modalClock){const g=cache.find(x=>String(x.id)===String(modalClock.dataset.liveModalClock));if(g)modalClock.textContent=getLiveClock(g)}}
function sportIdForGame(game){
  const raw=String(game?.sport_id??game?.sportId??'');
  if(/^\d+$/.test(raw))return raw;
  const sport=sportOf(game);
  return ({soccer:'1',basketball:'2',tennis:'5',american:'12',baseball:'3',pingpong:'18'}[sport]||'1');
}
function liveGameId(game){return String(game?.game_id??game?.id??'')}
function findLiveGame(id){const key=String(id??'');return cache.find(x=>String(x.id)===key||String(x.game_id)===key)||null}
function setHashForMode(m){const target=m==='live'?'#/InPlay':m==='mybets'?'#/MyBets':'#/';if(location.hash!==target)history.pushState({mode:m},'',target)}
function setHashForLiveMatch(game){const id=liveGameId(game);if(!/^\d+$/.test(id))return;const target=`#/livematch/${id}?sportId=${sportIdForGame(game)}`;if(location.hash!==target)history.pushState({mode:'livematch',gameId:id},'',target)}
function parseLiveMatchHash(){const m=String(location.hash||'').match(/^#\/livematch\/(\d+)(?:\?sportId=(\d+))?\/?$/i);return m?{gameId:m[1],sportId:m[2]||'1'}:null}
function modeFromHash(){if(parseLiveMatchHash())return'livematch';if(/^#\/MyBets\/?$/i.test(location.hash))return'mybets';return /^#\/InPlay\/?$/i.test(location.hash)?'live':'home'}
function sportIcon(sport,fallback){
  const icon=({soccer:['Soccer','⚽'],1:['Soccer','⚽'],basketball:['Basketball','🏀'],2:['Basketball','🏀']})[String(sport)];
  return icon?`<img class="sport-category-icon" src="https://www.bet365.com/home/images/Home/imgs/LeagueLogo/zClass_26_${icon[0]}.svg" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${icon[1]}'))">`:fallback;
}
const sports=[['★','Favourites','all'],['🔥','Popular','popular'],['⚽','Football','soccer'],['🎾','Tennis','tennis'],['🏈','American Football','american'],['⚾','Baseball','baseball'],['🏀','Basketball','basketball'],['🥊','Boxing','boxing'],['🏏','Cricket','cricket'],['🎯','Darts','darts'],['🎮','eSports','esports'],['🐕','Greyhounds','greyhounds']];
$('sportsbar').innerHTML=sports.map((s,i)=>`<button class="sport ${s[2]==='soccer'?'active':''}" data-sport="${s[2]}"><span class="ico">${sportIcon(s[2],s[0])}</span><span>${s[1]}</span></button>`).join('');
const sideSports=['Home','Futboll','Basketboll','Tenis','Futboll Amerikan','Badminton','Futsal','Volleyball','Darts','Cricket','Ping Pong','Aussie rules','Rugby','Box','Floorball','Handball'];
$('sideList').innerHTML=sideSports.map((x,i)=>`<div class="sideRow ${i===0?'home':''}"><span>${x}</span>${i===0?'':'<span class="star">☆</span>'}</div>`).join('');
let eventSearchText='';
function searchText(value){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();}
function applySidebarSearch(){const q=searchText($('sideSearch').value);document.querySelectorAll('.sideRow').forEach(r=>r.hidden=!!q&&!searchText(r.textContent).includes(q));}
function applyCategorySearch(){const q=searchText(eventSearchText);document.querySelectorAll('#categoryBody .sports-category-row,#categoryBody .sports-fixture').forEach(r=>r.hidden=!!q&&!searchText(r.textContent).includes(q));}
function setEventSearch(value){
  eventSearchText=value;query=searchText(value);$('search').value=value;
  if(mode==='home'&&sportsHomeTab==='category'){applyCategorySearch();return;}
  if(mode==='home'||mode==='live')render(cache,false);
}
function bindLiveSearch(){const input=$('liveSearchInput');if(!input)return;if(input.value!==eventSearchText)input.value=eventSearchText;input.oninput=e=>setEventSearch(e.target.value);}
function updateLiveList(html){
  const content=$('content'),table=content.querySelector('.live-table');
  if(table&&$('liveSearchInput')){
    const template=document.createElement('template');template.innerHTML=html;
    const nextTable=template.content.querySelector('.live-table');
    // Keep unchanged event nodes; a single price update must not rebuild the list.
    const rows=new Map(Array.from(table.querySelectorAll('[data-live-game]'),row=>[row.dataset.liveGame,row]));
    for(const next of nextTable.querySelectorAll('[data-live-game]')){
      const current=rows.get(next.dataset.liveGame);
      if(current&&current.isEqualNode(next))next.replaceWith(current);
    }
    table.replaceChildren(...nextTable.childNodes);
  }else content.innerHTML=html;
  // Keep the input node in place: keyboard deletion, selection and composition
  // must survive both filtering and incoming live updates.
  bindLiveSearch();
}
$('sideSearch').oninput=e=>{applySidebarSearch();if(mode==='home'||mode==='live')setEventSearch(e.target.value);};
// Replace the decorative mobile A-Z label with an accessible drawer control.
const sportsSidebar=document.querySelector('.sidebar');
sportsSidebar.id='sportsSidebar';
const sportsMenuButton=document.createElement('button');
sportsMenuButton.id='sportsMenuButton';sportsMenuButton.type='button';
sportsMenuButton.textContent='☰  A-Z';
sportsMenuButton.setAttribute('aria-controls','sportsSidebar');
sportsMenuButton.setAttribute('aria-expanded','false');
document.querySelector('.top').appendChild(sportsMenuButton);
const sportsMenuBackdrop=document.createElement('button');
sportsMenuBackdrop.id='sportsMenuBackdrop';sportsMenuBackdrop.type='button';
sportsMenuBackdrop.setAttribute('aria-label','Mbyll listën e sporteve');
sportsMenuBackdrop.hidden=true;document.body.appendChild(sportsMenuBackdrop);
const sportsMenuClose=document.createElement('button');
sportsMenuClose.id='sportsMenuClose';sportsMenuClose.type='button';
sportsMenuClose.textContent='×  A-Z';sportsMenuClose.setAttribute('aria-label','Mbyll listën e sporteve');
sportsSidebar.appendChild(sportsMenuClose);
function setSportsDrawer(open,restoreFocus=false){
  sportsSidebar.classList.toggle('sports-drawer',open);
  document.body.classList.toggle('sports-menu-open',open);
  sportsMenuBackdrop.hidden=!open;
  sportsMenuButton.setAttribute('aria-expanded',String(open));
  if(open)sportsMenuClose.focus({preventScroll:true});
  else if(restoreFocus)sportsMenuButton.focus({preventScroll:true});
}
sportsMenuButton.onclick=()=>setSportsDrawer(!sportsSidebar.classList.contains('sports-drawer'));
sportsMenuClose.onclick=sportsMenuBackdrop.onclick=()=>setSportsDrawer(false,true);
sportsSidebar.addEventListener('click',e=>{if(e.target.closest('.sideRow,.sideTool'))setSportsDrawer(false);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&sportsSidebar.classList.contains('sports-drawer'))setSportsDrawer(false,true);});
window.addEventListener('resize',()=>{if(window.innerWidth>1100)setSportsDrawer(false);});
function parseOdds(s){const o={1:null,X:null,2:null};if(typeof s!=='string')return o;for(const x of s.split(',')){const p=x.split('|');if(p.length>=4&&['1','X','2'].includes(String(p[2])))o[String(p[2])]={odd:Number(p[1]),coefId:String(p[0]),marketId:String(p[3])}}return o}
function oddsLockIcon(){return '<svg class="odds-lock-icon" viewBox="0 0 24 24" role="img" aria-label="Koeficient i bllokuar"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg>'}
function lock(v){const n=Number(v);return v==null||v===''||v==='-'||!Number.isFinite(n)||n<=1}
function hasLiveSummaryOdds(g){return Object.values(parseOdds(g?.odd)).some(info=>info&&!lock(info.odd))}
function sportOf(g){const s=((g.sport_name||g.sport||g.category||'')+'').toLowerCase();if(/basket/.test(s))return'basketball';if(/tennis/.test(s))return'tennis';if(/baseball/.test(s))return'baseball';if(/american/.test(s))return'american';if(/ping|table tennis/.test(s))return'pingpong';return'soccer'}
function visible(g){const t=searchText((g.name||'')+' '+(g.home_team||'')+' '+(g.away_team||'')+' '+(g.league||''));return(!query||t.includes(query))&&(!activeLeague||String(g.league||'')===activeLeague)&&(selectedSport==='all'||selectedSport==='popular'||sportOf(g)===selectedSport)}
function updateLeagues(data){const ls=[...new Set((data||[]).map(g=>g.league||'Competition'))].sort();$('leagueFilter').innerHTML='<option value="">All competitions</option>'+ls.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');$('leagueFilter').value=activeLeague}
function addPick(g,key,val){
  const info=parseOdds(g.odd)[key];
  const odd=info?Number(info.odd):Number(val);
  if(lock(odd))return;
  const id=String(g.id)+'|'+key;
  const i=slip.findIndex(x=>String(x.gameId)===String(g.id)&&(info?.coefId?String(x.coefId)===String(info.coefId):x.id===id));
  if(i>=0){
    slip.splice(i,1);
  }else{
    slip=slip.filter(x=>String(x.gameId)!==String(g.id)||String(x.marketId)!==String(info?.marketId||'')||String(x.specialValue??'')!=='');
    slip.push({id,gameId:g.id,gameApiId:g.game_api_id||g.api_id||'',key,odd,currentOdd:odd,coefId:info?.coefId||'',marketId:info?.marketId||'',market:'Fulltime Result',marketType:'summary',specialValue:'',oddsChanged:false,invalid:false,league:g.league||'',home:g.home_team||g.name||'',away:g.away_team||'',eventTime:g.game_time||g.game_date||''});
  }
  renderSlip();
  if(mode==='live'){
    if(openLiveGameId) renderLiveMarketPanel(g,liveMarketsCache.get(String(g.id))||[],false);
    else renderLive(cache,false);
  }else{
    render(cache,false);
  }
}

function addMarketPick(g, option){
  const odd=Number(option.odd);
  if(lock(odd))return;
  const coefId=String(option.market_option_id??option.id??'');
  const marketId=String(option.market_id??'');
  const key=`${marketId}|${coefId}`;
  const id=String(g.id)+'|'+key;
  const i=slip.findIndex(x=>String(x.gameId)===String(g.id)&&String(x.marketId)===marketId&&String(x.coefId)===coefId&&String(x.specialValue??'')===String(option.special_value??option.specialValue??''));
  if(i>=0){slip.splice(i,1)}else{
    slip=slip.filter(x=>String(x.gameId)!==String(g.id)||String(x.marketId)!==marketId||String(x.specialValue??'')!==String(option.special_value??option.specialValue??''));
    slip.push({id,gameId:g.id,gameApiId:g.game_api_id||g.api_id||'',key:option.market_option||'',odd, currentOdd:odd,coefId,marketId,market:option.market||'Market',marketType:'detail',specialValue:option.special_value??option.specialValue??'',oddsChanged:false,invalid:false,league:g.league||'',home:g.home_team||g.name||'',away:g.away_team||'',eventTime:g.game_time||g.game_date||''});
  }
  renderSlip();
  renderLive(cache);
}

function normalizeLiveMarkets(data){
  const groups=[];
  if(Array.isArray(data)){
    for(const item of data){
      if(Array.isArray(item)&&item.length)groups.push(item.filter(Boolean));
      else if(item&&typeof item==='object')groups.push([item]);
    }
  }
  return groups.filter(g=>g.length&&g[0].market_id!=null);
}
function refreshDetailSlipState(groups,gameId){
  const options=(groups||[]).flat();
  for(const p of slip){
    if(p.marketType!=='detail'||String(p.gameId)!==String(gameId))continue;
    const option=options.find(x=>String(x.market_option_id??x.id??'')===String(p.coefId)&&String(x.market_id??'')===String(p.marketId));
    const current=Number(option?.odd);
    p.invalid=!Number.isFinite(current)||current<=1;p.invalidReason=p.invalid?'Koeficienti nuk është aktiv.':'';
    if(p.invalid||Math.abs(current-Number(p.odd))<=0.0001)continue;
    p.previousOdd=Number(p.odd);
    p.odd=Number(current.toFixed(2));
    p.currentOdd=p.odd;
    p.oddsChanged=true;
  }
}
function marketOrderValue(v){return v==null||v===''?9999999:Number(v)||9999999}
let displayedLiveDetailId=null,liveMarketCategory='Kryesore';
function liveTrackerHtml(game){
  const id=String(game.id||'');
  const sport=String(game.sport_id||liveMatchSportId||'1');
  const page=({'1':'a','2':'c','5':'b'})[sport];
  if(!page||!/^\d+$/.test(id))return '<div class="live-tracker-unavailable">Vizualizimi live nuk është i disponueshëm për këtë ndeshje.</div>';
  const src='https://euro07.bet/betting_p2p/'+page+'.html?id='+encodeURIComponent(id)+'&lng=en';
  return '<div class="live-tracker-wrap'+(sport==='1'?' football-pitch-only':'')+'"><iframe class="live-match-tracker" data-game-id="'+id+'" src="'+src+'" title="Ecuria live e ndeshjes" scrolling="no" sandbox="allow-scripts allow-same-origin" referrerpolicy="strict-origin-when-cross-origin"></iframe><a class="live-tracker-link" href="'+src+'" target="_blank" rel="noopener noreferrer">Hap fushën live ↗</a></div>';
}
function liveMediaHtml(game,groups){
  const hasTV=!!(groups.flat().some(row=>/^\d+$/.test(String(row.stream_id||''))));
  const pitch='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M3 9h4v6H3m18-6h-4v6h4"/><circle cx="12" cy="12" r="3"/></svg>';
  const tv='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>';
  return '<section class="live-media" data-media-game="'+esc(game.id)+'"><div class="live-media-controls" role="group" aria-label="Pamja e ndeshjes"><button type="button" data-live-view="field" aria-pressed="true" title="Fusha">'+pitch+'<span>Fusha</span></button><button type="button" data-live-view="tv" aria-pressed="false" '+(hasTV?'':'disabled')+' title="'+(hasTV?'Shiko transmetimin live':'Nuk ka transmetim për këtë ndeshje')+'">'+tv+'<span>TV</span></button></div><div class="live-field-view">'+liveTrackerHtml(game)+'</div><div class="live-tv-view" hidden></div></section>';
}
async function switchLiveView(button){
  const media=button.closest('.live-media');if(!media||button.disabled)return;
  const tv=media.querySelector('.live-tv-view'),field=media.querySelector('.live-field-view');
  const showTV=button.dataset.liveView==='tv';
  media.querySelectorAll('[data-live-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
  field.hidden=showTV;tv.hidden=!showTV;
  if(!showTV){media.streamRequest?.abort();media.streamRequest=null;tv.replaceChildren();sizeLivePitch();return;}
  if(media.streamRequest||tv.querySelector('iframe'))return;
  tv.innerHTML=brandLoading();const controller=new AbortController();media.streamRequest=controller;
  const timeout=setTimeout(()=>controller.abort(),25000);
  try{
    const r=await fetch('/api/livegame/'+encodeURIComponent(media.dataset.mediaGame)+'/stream',{headers:{Authorization:'Bearer '+token},signal:controller.signal});
    const d=await SportsbookApi.readJson(r);if(!r.ok)throw Error(d.error||'Transmetimi nuk është i disponueshëm.');
    const url=new URL(d.url);if(url.protocol!=='https:')throw Error('Transmetim i pavlefshëm.');
    if(!media.isConnected||tv.hidden||media.streamRequest!==controller)return;
    const frame=document.createElement('iframe');frame.src=url.href;frame.title='Transmetimi live i ndeshjes';frame.className='live-tv-frame';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-presentation');frame.allow='autoplay; fullscreen; picture-in-picture';frame.allowFullscreen=true;frame.referrerPolicy='strict-origin-when-cross-origin';tv.replaceChildren(frame);
  }catch(error){if(media.isConnected&&!tv.hidden&&media.streamRequest===controller){tv.innerHTML='<div class="live-tv-error" role="status"></div>';tv.firstChild.textContent=error.name==='AbortError'?'Transmetimi po vonon. Provo sërish butonin TV.':error.message;}}
  finally{clearTimeout(timeout);if(media.streamRequest===controller)media.streamRequest=null;}
}
const liveCornerScores=new Map(),liveCornerRequests=new Map();
function cornerScoreFromTimeline(events){
  if(!Array.isArray(events))return null;
  let home=0,away=0;
  for(const event of events){
    if(String(event.type_id)!=='2'&&String(event.type||'').toLowerCase()!=='corner')continue;
    if(String(event.team)==='1')home++;
    else if(String(event.team)==='2')away++;
    else return null;
  }
  return {home,away};
}
function cornerMarketSuffix(market,gameId){
  if(!/korn|corner/i.test(String(market.market||'')+' '+String(market.mainCategory||'')))return '';
  const score=liveCornerScores.get(String(gameId));
  return score?` (${score.home}:${score.away})`:'';
}
async function refreshLiveCorners(game){
  const id=liveGameId(game);
  if(liveCornerRequests.has(id))return liveCornerRequests.get(id);
  const request=(async()=>{
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),7000);
    try{
      const response=await fetch('/api/livegame/'+encodeURIComponent(id)+'/timeline?ts='+Date.now(),{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error('Timeline unavailable');
      const score=cornerScoreFromTimeline(await SportsbookApi.readJson(response));
      if(!score)throw Error('Invalid timeline');
      liveCornerScores.set(id,score);
    }catch(_){liveCornerScores.delete(id);}
    finally{clearTimeout(timeout);}
    if(openLiveGameId===id){const current=findLiveGame(id),groups=liveMarketsCache.get(id);if(current&&groups?.length)renderLiveMarketPanel(current,groups,false);}
  })();
  liveCornerRequests.set(id,request);
  try{await request}finally{liveCornerRequests.delete(id);}
}
function prematchHeader(game){
 const sport=game.sport_name||({soccer:'Soccer',basketball:'Basketball',tennis:'Tennis',american:'American Football',baseball:'Baseball',pingpong:'Table Tennis'}[sportOf(game)]||'Sport');
 const title=[sport,game.league,(game.home_team||game.name||'')+' vs '+(game.away_team||'')].filter(Boolean).join(' / ');
 const kickoff=[game.game_date,String(game.game_time||'').slice(0,5)].filter(Boolean).join(' ');
 return '<div class="prematch-match-header"><button type="button" class="prematch-header-back" data-live-detail-back="1" aria-label="Kthehu te ndeshjet">‹</button><span class="prematch-match-title">'+esc(title)+'</span><time class="prematch-match-date">'+esc(kickoff)+'</time></div>';
}
function renderLiveMarketPanel(game, groups, loading=false, error=''){
  const detailId=String(game.id);
  if(displayedLiveDetailId!==detailId){displayedLiveDetailId=detailId;requestAnimationFrame(()=>{if(displayedLiveDetailId===detailId&&document.body.classList.contains('live-markets-open')){window.scrollTo({top:0,left:0,behavior:'instant'});}});}
  const target=$('content');
  if(!target)return;
  document.body.classList.add('live-markets-open');
  const sb=$('sportsbar');if(sb)sb.style.display='none';
  const status=game?.api_status??game?.game_status;
  const result=String(game?.result||'').split('-');
  const homeScore=game.isPrematch?String(game.game_time||'').slice(0,5):(result[0]||'0'), awayScore=game.isPrematch?'':(result[1]||'0');
  const running=liveClockRunning(game);
  const activeClock=getLiveClock(game);
  if(loading){
    target.innerHTML=`<div class="live-detail${game.isPrematch?' prematch-detail':''}">${game.isPrematch?prematchHeader(game):`<div class="live-detail-scorebar"><button class="live-detail-back" data-live-detail-back="1">‹</button><div class="live-detail-team">${esc(game.home_team||game.name||'')}</div><div class="live-detail-score"><b>${esc(homeScore)}</b><span>:</span><b>${esc(awayScore)}</b></div><div class="live-detail-team away">${esc(game.away_team||'')}</div></div>`}${brandLoading("market-loading-stage")}</div>`;
    bindLiveDetail();
    return;
  }
  if(error){
    target.innerHTML=`<div class="live-detail${game.isPrematch?' prematch-detail':''}">${game.isPrematch?prematchHeader(game):`<div class="live-detail-scorebar"><button class="live-detail-back" data-live-detail-back="1">‹</button><div class="live-detail-team">${esc(game.home_team||game.name||'')}</div><div class="live-detail-score"><b>${esc(homeScore)}</b><span>:</span><b>${esc(awayScore)}</b></div><div class="live-detail-team away">${esc(game.away_team||'')}</div></div>`}<div class="live-detail-error">Marketet nuk u ngarkuan.<button class="live-markets-retry" data-retry-live-markets="${esc(game.id)}">Provo përsëri</button></div></div>`;
    bindLiveDetail();
    return;
  }

  const cleanGroups=(groups||[]).filter(Boolean).map(g=>g.filter(Boolean)).filter(g=>g.length);
  if(!cleanGroups.length){
    target.innerHTML=`<div class="live-detail${game.isPrematch?' prematch-detail':''}">${game.isPrematch?prematchHeader(game):`<div class="live-detail-scorebar"><button class="live-detail-back" data-live-detail-back="1">‹</button><div class="live-detail-team">${esc(game.home_team||game.name||'')}</div><div class="live-detail-score"><b>${esc(homeScore)}</b><span>:</span><b>${esc(awayScore)}</b></div><div class="live-detail-team away">${esc(game.away_team||'')}</div></div>`}<div class="live-markets-empty live-detail-empty">Nuk ka markets aktive për këtë ndeshje.</div></div>`;
    bindLiveDetail();
    return;
  }

  const sections={};
  cleanGroups.forEach(group=>{
    const first=group[0]||{};
    const category=String(first.mainCategory||'Të tjera').trim()||'Të tjera';
    (sections[category]??=[]).push(group);
  });
  const cats=Object.keys(sections);if(game.isPrematch){const order=['Kryesore','45/90','Golat','Gol/JoGol','RS/DSH','Minuta','Kartona','Golashenues','Gola VIP','Azian'];cats.sort((a,b)=>{const rank=c=>{const i=order.indexOf(c);return i<0?order.length:i;};return rank(a)-rank(b);});}
  if(!cats.includes(liveMarketCategory))liveMarketCategory=cats[0]||'Kryesore';
  const tabs=cats.map(c=>`<button class="live-detail-tab ${c===liveMarketCategory?'active':''}" data-live-category="${esc(c)}">${esc(c)}</button>`).join('');
  let html='';
  const marketGroups=sections[liveMarketCategory]||[];
  marketGroups.sort((a,b)=>marketOrderValue(a[0]?.market_order)-marketOrderValue(b[0]?.market_order));
  for(const group of marketGroups){
    const m=group[0]||{};
    const marketName=(String(m.market||'Market').trim()||'Market')+cornerMarketSuffix(m,game.id);
    const opts=group.filter(x=>x&&Number.isFinite(Number(x.odd))&&Number(x.odd)>1);
    if(!opts.length)continue;
    const columns=Math.min(Math.max(opts.length,1),3);
    html+=`<section class="live-detail-market"><div class="live-detail-market-head"><span>${esc(marketName)}</span>${m.special_value!=null&&m.special_value!==''?`<em>${esc(m.special_value)}</em>`:''}</div><div class="live-detail-options" style="grid-template-columns:repeat(${columns},minmax(0,1fr))">`;
    for(const option of opts){
      const selected=slip.some(x=>String(x.gameId)===String(game.id)&&String(x.coefId)===String(option.market_option_id));
      html+=`<button class="live-detail-option ${selected?'selected':''}" data-live-market-game="${esc(game.id)}" data-live-market-option="${esc(option.market_option_id??'')}" data-live-market-id="${esc(option.market_id??'')}"><span>${esc(String(option.market_option||'').trim()||'—')}</span><strong>${Number(option.odd).toFixed(2)}</strong></button>`;
    }
    html+='</div></section>';
  }

  const pause=status==='2';
  const panelHtml=`<div class="live-detail${game.isPrematch?' prematch-detail':''}">${game.isPrematch?prematchHeader(game):`<div class="live-detail-scorebar"><button class="live-detail-back" data-live-detail-back="1">‹</button><div class="live-detail-team">${esc(game.home_team||game.name||'')}</div><div class="live-detail-score"><b>${esc(homeScore)}</b><span>${pause?'':' '}</span><b>${esc(awayScore)}</b></div><div class="live-detail-team away">${esc(game.away_team||'')}</div></div>`}${game.isPrematch?'':liveMediaHtml(game,cleanGroups)}<div class="live-detail-tabs">${tabs}</div><div class="live-detail-body">${html||'<div class="live-markets-empty live-detail-empty">Nuk ka markets aktive për këtë kategori.</div>'}</div></div>`;
  const tracker=target.querySelector('.live-match-tracker');
  if(tracker && tracker.dataset.gameId===String(game.id)){
    const template=document.createElement('template');template.innerHTML=panelHtml;

    for(const selector of ['.live-detail-scorebar','.live-detail-tabs','.live-detail-body']){
      const old=target.querySelector(selector),next=template.content.querySelector(selector);
      if(old&&next&&!old.isEqualNode(next))old.replaceWith(next);
    }
  }else target.innerHTML=panelHtml;
  bindLiveDetail();
}
let pitchResizeObserver=null;
function sizeLivePitch(){
  if(pitchResizeObserver)pitchResizeObserver.disconnect();
  const wrap=document.querySelector('.football-pitch-only');if(!wrap)return;
  const resize=()=>wrap.style.setProperty('--pitch-scale',String(wrap.clientWidth/200));
  resize();pitchResizeObserver=new ResizeObserver(resize);pitchResizeObserver.observe(wrap);
}
function bindLiveDetail(){
  sizeLivePitch();
  const content=$('content');if(!content)return;
  const handle=e=>{
    const mediaButton=e.target.closest('[data-live-view]');
    if(mediaButton){
      e.preventDefault();
      if(isNewLiveActivation(e,'media:'+mediaButton.dataset.liveView))switchLiveView(mediaButton);
      return;
    }
    const back=e.target.closest('[data-live-detail-back]');
    if(back){if(!isNewLiveActivation(e,'live-back'))return;e.preventDefault();const g=findLiveGame(openLiveGameId);if(g?.isPrematch){closeLiveMarkets();openSportsHome();}else setMode('live');return;}
    const retry=e.target.closest('[data-retry-live-markets]');
    if(retry){const action='live-retry:'+retry.dataset.retryLiveMarkets;if(!isNewLiveActivation(e,action))return;e.preventDefault();const g=findLiveGame(retry.dataset.retryLiveMarkets);if(g)fetchLiveMarkets(g,true);return;}
    const tab=e.target.closest('[data-live-category]');
    if(tab){const action='live-category:'+tab.dataset.liveCategory;if(!isNewLiveActivation(e,action))return;e.preventDefault();liveMarketCategory=tab.dataset.liveCategory||'Kryesore';const g=findLiveGame(openLiveGameId);const groups=liveMarketsCache.get(String(openLiveGameId))||[];if(g)renderLiveMarketPanel(g,groups,false);return;}
    const optionBtn=e.target.closest('[data-live-market-option]');
    if(optionBtn){
      const action='live-option:'+optionBtn.dataset.liveMarketGame+':'+optionBtn.dataset.liveMarketId+':'+optionBtn.dataset.liveMarketOption;
      if(!isNewLiveActivation(e,action))return;
      e.preventDefault();e.stopPropagation();
      const g=findLiveGame(optionBtn.dataset.liveMarketGame);
      const groups=liveMarketsCache.get(String(optionBtn.dataset.liveMarketGame))||[];
      const option=groups.flat().find(x=>String(x.market_option_id)===String(optionBtn.dataset.liveMarketOption)&&String(x.market_id)===String(optionBtn.dataset.liveMarketId));
      if(g&&option)addMarketPick(g,option);
    }
  };
  content.onclick=handle;
  content.onpointerdown=null;
}

function bindLiveMarketsOverlay(){return;}

function closeLiveMarkets(){
  openLiveGameId=null;
  stopOpenMarketsRefresh();
  const overlay=$('liveMarketsOverlay');
  if(overlay){overlay.classList.remove('show');overlay.innerHTML='';overlay.setAttribute('aria-hidden','true')}
  const sb=$('sportsbar');if(sb)sb.style.display='flex';
  document.body.classList.remove('live-markets-open');
  displayedLiveDetailId=null;
}

async function fetchLiveMarkets(game,force=false,silent=false){
  const id=liveGameId(game);
  const cached=liveMarketsCache.get(id);
  if(!force && Array.isArray(cached) && cached.length){
    renderLiveMarketPanel(game,cached,false);
    // Refresh in the background without replacing a valid panel with an empty response.
    refreshLiveMarkets(game,true);
    return cached;
  }
  if(!silent)renderLiveMarketPanel(game,[],true);
  return refreshLiveMarkets(game,true);
}
async function refreshLiveMarkets(game,force=false){
  const id=liveGameId(game);
  const activeRequest=liveMarketRequests.get(id);
  if(activeRequest)return activeRequest;
  if(!game.isPrematch)void refreshLiveCorners(game);
  const seq=(liveMarketRequestSeq.get(id)||0)+1;
  liveMarketRequestSeq.set(id,seq);
  const request=(async()=>{
    for(let attempt=0;attempt<3;attempt++){
      try{
        const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),7000);
        let r;
        try{r=await fetch((game.isPrematch?'/api/prematchgame/':'/api/livegame/')+encodeURIComponent(id)+'?ts='+Date.now(),{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',Pragma:'no-cache'}})}finally{clearTimeout(timeout)}
        if(!r.ok)throw Error('HTTP '+r.status);
        const data=await SportsbookApi.readJson(r); const groups=normalizeLiveMarkets(data);
        if(liveMarketRequestSeq.get(id)!==seq)return liveMarketsCache.get(id)||null;
        // Empty/partial responses are transient; never replace known-good markets with them.
        if(Array.isArray(data)){
          liveMarketsCache.set(id,groups);
          refreshDetailSlipState(groups,id);
          renderSlip();
          if(openLiveGameId===id)renderLiveMarketPanel(game,groups,false);
          return groups;
        }
        throw Error('Empty live market response');
      }catch(e){if(attempt<2)await new Promise(res=>setTimeout(res,250*(attempt+1)));}
    }
    // Do not leave unverified prices actionable after failed refreshes.
    liveMarketsCache.delete(id);refreshDetailSlipState([],id);renderSlip();
    const knownGood=null;
    if(openLiveGameId===id){
      if(knownGood?.length)renderLiveMarketPanel(game,knownGood,false);
      else renderLiveMarketPanel(game,[],false,'retry');
    }
    return knownGood||null;
  })();
  liveMarketRequests.set(id,request);
  try{return await request}finally{if(liveMarketRequests.get(id)===request)liveMarketRequests.delete(id)}
}
function startOpenMarketsRefresh(){
  clearInterval(window.liveMarketsTicker);
  window.liveMarketsTicker=setInterval(()=>{
    if(document.hidden||(mode!=='live'&&mode!=='livematch')||!openLiveGameId)return;
    const g=findLiveGame(openLiveGameId);
    if(g)refreshLiveMarkets(g,true);
  },2000);
}
function stopOpenMarketsRefresh(){clearInterval(window.liveMarketsTicker);window.liveMarketsTicker=null}
async function toggleLiveMarkets(game){
  const id=liveGameId(game);
  if(!/^\d+$/.test(id))return;
  if(openLiveGameId===id && mode==='livematch')return;
  openLiveGameId=id;
  liveMatchSportId=sportIdForGame(game);
  liveMarketCategory='Kryesore';
  // Show feedback immediately; the route transition then keeps this panel alive
  // while the first (deduplicated) market request is in progress.
  const cached=liveMarketsCache.get(id)||[];
  renderLiveMarketPanel(game,cached,!cached.length);
  setHashForLiveMatch(game);
  // The reference site navigates through a real match link. Do the equivalent
  // synchronously here instead of waiting for a later hashchange task.
  setMode('livematch',{fromHash:true});
}
async function openLiveMatchFromRoute(route){
  const id=String(route?.gameId||'');
  if(!/^\d+$/.test(id))return;
  liveMatchSportId=String(route.sportId||'1');
  openLiveGameId=id;
  const game=findLiveGame(id);
  if(game){
    const cached=liveMarketsCache.get(id);
    if(cached?.length)renderLiveMarketPanel(game,cached,false);
    else renderLiveMarketPanel(game,[],true);
    await fetchLiveMarkets(game,false,true);
    startOpenMarketsRefresh();
    return;
  }
  await load();
  const found=findLiveGame(id);
  if(found){
    const cached=liveMarketsCache.get(id);
    if(cached?.length)renderLiveMarketPanel(found,cached,false);
    else renderLiveMarketPanel(found,[],true);
    await fetchLiveMarkets(found,false,true);
    startOpenMarketsRefresh();
  }else{
    setMode('live');
  }
}

function refreshSlipState(){
  for(const p of slip){
    if(p.marketType==='detail'||p.serverQuoted)continue;
    const g=cache.find(x=>String(x.id)===String(p.gameId));
    if(!g) continue;
    const info=parseOdds(g.odd)[p.key];
    if(!info||lock(info.odd)){p.invalid=true;p.invalidReason='Koeficienti është i bllokuar.';continue;}
    const current=Number(info.odd);
    p.currentOdd=Number(current.toFixed(2));
    p.invalid=false;p.invalidReason='';
    if(!Number.isFinite(Number(p.odd))){p.odd=current;p.coefId=info.coefId||p.coefId;p.marketId=info.marketId||p.marketId;p.oddsChanged=false;continue}
    if(Math.abs(current-Number(p.odd))>0.0001){
      // Keep an audit trail for the player, but automatically use the latest
      // live price. This replaces the accept/reject interruption.
      p.previousOdd=Number(p.odd);
      p.odd=Number(current.toFixed(2));
      p.oddsChanged=true;
    }
  }
}

function showSlipMessage(message,kind='error'){
 let box=$('slipMessageAlert');
 if(!box){box=document.createElement('div');box.id='slipMessageAlert';box.setAttribute('role','status');box.setAttribute('aria-live','polite');const text=document.createElement('p');text.className='slip-message-text';const close=document.createElement('button');close.type='button';close.textContent='Në rregull';close.onclick=()=>{box.hidden=true;$('betslip').classList.remove('has-message-notice');};box.append(text,close);$('betslip').appendChild(box);}
 box.querySelector('p').textContent=message;box.dataset.kind=kind;box.hidden=false;$('betslip').classList.add('has-message-notice','mobile-open');requestAnimationFrame(syncMobileSlipViewport);
}
let slipLimitNotice=null;
function showSlipLimit(amount,kind){
  if(slipLimitNotice)clearTimeout(slipLimitNotice.timer);
  const rejected=new Set(slip),owner=token;
  const descriptions={stake:'Shuma e bastit kalon limitin maksimal',payout:'Fitimi i mundshëm kalon limitin maksimal',event_stake:'Shuma e bastit kalon limitin e eventit',event_payout:'Fitimi i mundshëm kalon limitin e eventit',league_stake:'Shuma e bastit kalon limitin e ligës',league_payout:'Fitimi i mundshëm kalon limitin e ligës'};
  const message=(descriptions[kind]||'Basti kalon limitin maksimal')+' ('+Number(amount).toLocaleString('sq-AL',{minimumFractionDigits:2,maximumFractionDigits:2})+' €)';
  slipLimitNotice={message,timer:setTimeout(()=>{
    slipLimitNotice=null;
    if(token===owner&&!pendingTicket){slip=slip.filter(p=>!rejected.has(p));if(!slip.length)$('stake').value='';lastBetRequest=null;}
    renderSlip();
  },3000)};
  renderSlip();
}
function renderSlipLimitNotice(){
  let notice=$('slipLimitAlert');
  if(!notice){notice=document.createElement('div');notice.id='slipLimitAlert';notice.className='slip-limit-notice';notice.setAttribute('role','alert');notice.setAttribute('aria-live','assertive');$('betslip').appendChild(notice);}
  notice.hidden=!slipLimitNotice;
  $('betslip').classList.toggle('has-limit-notice',!!slipLimitNotice);
  if(slipLimitNotice){notice.textContent=slipLimitNotice.message;$('betslip').classList.add('mobile-open');}
}
function syncPendingBrand(){
  const source=document.querySelector('.top .brand'),host=document.querySelector('#slipPendingNotice .slip-pending-logo');
  if(!source||!host)return;
  const logo=source.cloneNode(true);logo.removeAttribute('id');logo.querySelectorAll('[id]').forEach(node=>node.removeAttribute('id'));host.replaceChildren(logo);
}
const navbarBrandObserver=new MutationObserver(syncPendingBrand);
const navbarBrandRoot=document.querySelector('.top');
if(navbarBrandRoot)navbarBrandObserver.observe(navbarBrandRoot,{subtree:true,childList:true,characterData:true,attributes:true});
let oddsConfirmationRequested=false;
function renderOddsAcceptance(){
  let notice=$('slipOddsNotice');
  if(!notice){
    notice=document.createElement('div');notice.id='slipOddsNotice';notice.setAttribute('role','region');notice.setAttribute('aria-label','Koeficientët ndryshuan');
    notice.innerHTML='<strong>Koeficientët ndryshuan</strong><p>Prano koeficientët e rinj në skedinë.</p><div class="changed-odds-list"></div><button type="button">Prano dhe vendos bastin</button><button type="button" class="cancel-odds-confirmation">Kthehu</button>';
    $('betslip').appendChild(notice);
    notice.querySelector('button').onclick=()=>{
      if($('place').dataset.busy==='1')return;
      slip.forEach(p=>{if(!p.invalid)p.oddsChanged=false;});
      oddsConfirmationRequested=false;notice.hidden=true;placeBet();
    };
  }
  notice.querySelector('.cancel-odds-confirmation').onclick=()=>{oddsConfirmationRequested=false;notice.hidden=true;};
  const changed=slip.filter(p=>p.oddsChanged);
  if(!changed.length||pendingTicket)oddsConfirmationRequested=false;
  notice.hidden=!oddsConfirmationRequested||!changed.length||!!pendingTicket||!!slipLimitNotice||slip.some(p=>p.invalid);
  notice.querySelector('.changed-odds-list').innerHTML=changed.map(p=>'<div><span>'+esc(p.home)+' – '+esc(p.away)+' · '+esc(p.key)+'</span><b>'+Number(p.previousOdd).toFixed(2)+' → '+Number(p.odd).toFixed(2)+'</b></div>').join('');
  notice.querySelector('button').disabled=$('place').dataset.busy==='1';
}
function syncSelectedMarketButtons(){
  document.querySelectorAll('[data-live-market-option],.odd[data-game],.live-odd[data-game]').forEach(button=>{
    const detail=button.dataset.liveMarketOption!==undefined;
    const selected=slip.some(p=>String(p.gameId)===String(detail?button.dataset.liveMarketGame:button.dataset.game)&&
      (detail?String(p.marketId)===String(button.dataset.liveMarketId)&&String(p.coefId)===String(button.dataset.liveMarketOption):p.key===button.dataset.key));
    button.classList.toggle('selected',selected);
    button.setAttribute('aria-pressed',String(selected));
  });
}
function renderSlip(){
  syncSelectedMarketButtons();
  refreshSlipState();
  const validSlip=slip.filter(x=>!x.invalid&&Number.isFinite(Number(x.odd))&&Number(x.odd)>1),total=validSlip.reduce((a,x)=>a*Number(x.odd),1),has=slip.length>0,hasInvalid=slip.some(x=>x.invalid),hasChanged=slip.some(x=>x.oddsChanged);
  $('slipcount').textContent=slip.length;$('selCount').textContent=slip.length;$('totalOdds').textContent=validSlip.length?total.toFixed(2):'0.00';$('slipTopOdds').textContent=validSlip.length?total.toFixed(2):'0.00';$('mobileSlipCount').textContent=slip.length;$('mobileSlipOdds').textContent=validSlip.length?total.toFixed(2):'0.00';$('mobileSlipBar').classList.toggle('show',has||!!pendingTicket);
  $('betslip').classList.toggle('betslip-empty',!has&&!pendingTicket);const systemTab=$('systemSlipTab'),modeTabs=$('slipModeTabs');if(systemTab)systemTab.hidden=slip.length<3;if(modeTabs)modeTabs.classList.toggle('has-system',slip.length>=3);
  const placeLabel=$('place').firstChild;if(placeLabel?.nodeType===3)placeLabel.nodeValue='Vendos ';
  updatePotential();$('place').classList.toggle('enabled',has&&!!user&&!hasInvalid&&!pendingTicket);
  $('betMsg').textContent=pendingTicket?`Biletë #${pendingTicket.id} është në pritje të pranimit nga Qendra.`:(hasChanged?'Koeficientët ndryshuan. Prano vlerat e reja për të vendosur bastin.':(hasInvalid?'Një ose më shumë koeficientë nuk janë më aktivë.':(user?'Vendos shumën dhe luaj bastin.':'Kyçu për të luajtur bastin.')));
  $('betMsg').className='notice'+(hasInvalid?' error':'')+(hasChanged?' odds-updated':'');
  renderSlipLimitNotice();
  renderOddsAcceptance();
  let waiting=$('slipPendingNotice');
  if(!waiting){waiting=document.createElement('div');waiting.id='slipPendingNotice';waiting.setAttribute('role','status');waiting.setAttribute('aria-live','polite');waiting.innerHTML='<div class="slip-pending-logo" aria-hidden="true"></div><strong>Në Pritje</strong>';$('betslip').appendChild(waiting);syncPendingBrand();}
  const showWaiting=!!pendingTicket&&!pendingTicket.offer&&!slipLimitNotice;
  waiting.hidden=!showWaiting;$('betslip').classList.toggle('has-pending-notice',showWaiting);

  let body='';
  if(pendingTicket){const offer=pendingTicket.offer;body+=`<div class="pick ticketPending"><div class="leagueName">Biletë #${pendingTicket.id} • NË PRITJE</div>${pendingTicket.selections.map(p=>{const proposed=offer?.offers?.find(x=>Number(x.id)===Number(p.id));const odds=proposed?`<span class="offerOdds"><span class="oldOfferOdd">${Number(p.odd).toFixed(2)}</span><span class="newOfferOdd">${Number(proposed.odd).toFixed(2)}</span></span>`:`<span class="pickodd">${Number(p.odd).toFixed(2)}</span>`;return `<div class="game">${esc(p.home)}<br>${esc(p.away)} ${odds}</div><div class="marketName">${esc(p.market||'Fulltime Result')} • ${esc(p.key||p.selection||'')}</div>`}).join('')}${offer?`<div class="offerBox"><b>Qendra ka bërë ofertë të re</b><br>Odds: ${Number(offer.totalOdds).toFixed(2)} · Fitimi i mundshëm: €${Number(offer.potentialWin).toFixed(2)}<div><button data-user-offer="accept">Prano ofertën</button><button data-user-offer="reject">Refuzo ofertën</button></div></div>`:''}<div class="reservedNote">Shuma €${Number(pendingTicket.stake).toFixed(2)} është rezervuar deri në pranimin ose anulimin e biletës.</div></div>`}
  if(has)body+=slip.map((p,i)=>{
    const odds=p.invalid?oddsLockIcon():(p.oddsChanged?`<span class="oldOdd">${Number(p.previousOdd).toFixed(2)}</span><span class="pickodd updatedOdd">${Number(p.odd).toFixed(2)}</span>`:`<span class="pickodd">${Number(p.odd).toFixed(2)}</span>`);
    return `<div class="pick ${p.invalid?'invalidPick':''} ${p.oddsChanged?'oddsChangedPick':''}"><button type="button" class="remove" data-remove="${i}" aria-label="Hiq ${esc(p.home||'ndeshjen')} nga skedina">×</button><div class="leagueName">${esc(p.league)}</div><div class="game">${esc(p.home)}<br>${esc(p.away)} <span class="pickOdds">${odds}</span>${p.invalid?'<span class="invalidMark">✕</span>':''}</div><div class="marketName">${esc(p.market||'Fulltime Result')} • ${esc(p.key)}${p.invalid?` · ${esc(p.invalidReason)}`:''}</div></div>`
  }).join('');
  if(!body)body='<div class="emptySlip" aria-label="Skedina është bosh."></div>';
  if($('slipbody')._renderedBody!==body){$('slipbody').innerHTML=body;$('slipbody')._renderedBody=body;}
  syncMobileSlipViewport();

  document.querySelectorAll('[data-user-offer]').forEach(b=>b.onclick=async()=>{try{await controlFetch('/api/my-bets/'+pendingTicket.id+'/offer-response',{method:'POST',body:JSON.stringify({accept:b.dataset.userOffer==='accept'})});pendingTicket.offer=null;renderSlip();pollPendingTicket(pendingTicket.id)}catch(e){showSlipMessage(e.message)}});
}

// Delegate to the stable slip container: live odds renders replace its children.
let lastSlipRemovePointer=-Infinity;
function removeSlipSelection(event){
  const button=event.target.closest('[data-remove]');if(!button||!$('slipbody').contains(button))return;
  if(event.type==='pointerdown'){
    if(event.button!==0)return;
    lastSlipRemovePointer=performance.now();event.preventDefault();
  }else if(event.detail!==0&&performance.now()-lastSlipRemovePointer<800){event.preventDefault();return;}
  const index=Number(button.dataset.remove);if(!Number.isInteger(index)||index<0||index>=slip.length)return;
  event.stopPropagation();slip.splice(index,1);renderSlip();render(cache,false);
}
$('slipbody').addEventListener('pointerdown',removeSlipSelection);
$('slipbody').addEventListener('click',removeSlipSelection);

function updatePotential(){const stake=Number($('stake').value||0),valid=slip.filter(x=>!x.invalid),odds=valid.reduce((a,x)=>a*Number(x.odd),1),potential=stake>0&&valid.length?(stake*odds).toFixed(2):'0.00';$('potential').textContent=potential;const placePotential=$('placePotential');if(placePotential)placePotential.textContent=stake>0&&valid.length?`Fitimi ${potential}`:''}
function oddHtml(g,key,val,old){const raw=val&&typeof val==='object'?val.odd:val;const l=lock(raw),sel=slip.some(x=>String(x.gameId)===String(g.id)&&x.key===key&&String(x.marketId)===String(parseOdds(g.odd)[key]?.marketId||''));return `<button class="odd ${l?'locked':''} ${sel?'selected':''}" ${l?'disabled':''} data-game="${esc(g.id)}" data-key="${key}" data-odd="${esc(raw??'')}">${l?oddsLockIcon():Number(raw).toFixed(2)}</button>`}
let sportsCatalogRows=[],homeExtras={featured:[],main:[],live:[]},sportsHomeTab='home';
async function sportsList(path){const r=await fetch('/api/sports-catalog/'+path,{signal:AbortSignal.timeout(15000)}),d=await SportsbookApi.readJson(r);if(!r.ok||!Array.isArray(d))throw Error(d.error||'Lista nuk u ngarkua.');return d;}
function openSportsHome(){document.querySelector('.sidebar').classList.remove('sports-drawer');selectedPrematchLeague='';sportsHomeTab='home';activeLeague='';query='';$('search').value='';setMode('home');}
document.querySelector('.top .brand').addEventListener('click',event=>{
  if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  event.preventDefault();openSportsHome();
});
function drawSportsNavigation(){
  $('sportsbar').innerHTML=sportsCatalogRows.map(r=>'<button class="sport" data-category="'+esc(r.id)+'"><span class="ico">'+sportIcon(r.id,({1:'⚽',2:'🏀',5:'🎾',16:'🏈',31:'🏸',29:'⚽',23:'🏐',22:'🎯',21:'🏏'}[r.id]||'◉'))+'</span><span>'+esc(r.name)+'</span></button>').join('');
  document.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>openSportsCategory(b.dataset.category));
}
let sportsCategorySequence=0,selectedCountryContext=null;
function sportsCategoryHeader(title,back){
  $('content').innerHTML='<div class="sports-category-header"><button id="categoryBack" aria-label="Kthehu">‹</button><strong>'+esc(title)+'</strong><button id="categoryLive">Live <b>InPlay</b> →</button></div><div id="categoryBody">'+brandLoading()+'</div>';
  $('categoryBack').onclick=back;$('categoryLive').onclick=()=>setMode('live');
}
const formatPrematchKickoff=g=>{const d=String(g.game_date||'').match(/^\d{4}-(\d{2})-(\d{2})/);return (d?d[2]+'-'+d[1]:String(g.game_date||''))+(g.game_time?', '+String(g.game_time).slice(0,5):'');};
async function openSportsCategory(id){
  if(mode!=='home')setMode('home');
  const sequence=++sportsCategorySequence;++liveLoadSequence;clearInterval(timer);timer=null;
  sportsHomeTab='category';selectedPrematchLeague='';query='';activeLeague='';eventSearchText='';$('search').value='';$('sideSearch').value='';applySidebarSearch();
  document.querySelector('.sidebar').classList.remove('sports-drawer');$('sportsbar').style.display='none';
  const name=sportsCatalogRows.find(r=>String(r.id)===String(id))?.name||'Sport';
  sportsCategoryHeader(name,openSportsHome);
  const valid=()=>sequence===sportsCategorySequence&&mode==='home'&&sportsHomeTab==='category';
  try{
    const countries=await sportsList('countries/'+id);if(!valid())return;const main=homeExtras.main;
    const fixtures=main.filter(g=>String(g.sport_id??1)===String(id));cache=fixtures;
    const cards=fixtures.map(g=>{const o=parseOdds(g.odd);return '<article class="sports-fixture" data-home-match="'+esc(g.id)+'" tabindex="0"><div class="sports-fixture-teams"><span>'+esc(g.home_team||g.name)+'</span><span>'+esc(g.away_team||'')+'</span></div><div class="sports-fixture-meta">'+esc(formatPrematchKickoff(g))+'<span>'+esc(g.count_options||'')+' ›</span></div><div class="sports-fixture-odds">'+oddHtml(g,'1',o['1'])+oddHtml(g,'X',o.X)+oddHtml(g,'2',o['2'])+'</div></article>';}).join('');
    $('categoryBody').innerHTML='<div class="sports-section-title">Ndeshjet Kryesore</div><div class="sports-card-strip">'+(cards||'<p class="sports-category-empty">Nuk ka ndeshje kryesore për këtë sport.</p>')+'</div><div class="sports-section-title">Countries</div>'+countries.map(c=>'<button class="sports-category-row" data-open-country="'+esc(c.id)+'" data-country-name="'+esc(c.name)+'"><span>'+esc(c.name)+'</span><span>→</span></button>').join('');bindOdds();applyCategorySearch();
    document.querySelectorAll('[data-open-country]').forEach(btn=>btn.onclick=()=>openSportsCountry(id,btn.dataset.openCountry,btn.dataset.countryName));
  }catch(e){if(valid())$('categoryBody').textContent=e.message;}
}
async function openSportsCountry(sportId,countryId,name){
  ++liveLoadSequence;clearInterval(timer);timer=null;sportsHomeTab='category';
  selectedCountryContext={sportId,countryId,name};
  const sequence=++sportsCategorySequence;
  sportsCategoryHeader(name,()=>openSportsCategory(sportId));
  try{const leagues=await sportsList('leagues/'+countryId);if(sequence!==sportsCategorySequence||mode!=='home'||sportsHomeTab!=='category')return;
    $('categoryBody').innerHTML='<div class="sports-section-title">Leagues</div>'+leagues.map(l=>'<button class="sports-category-row" data-league="'+esc(l.id)+'"><span>'+esc(l.name)+'</span><span>'+esc(l.count_leagues)+' →</span></button>').join('');
    applyCategorySearch();document.querySelectorAll('[data-league]').forEach(btn=>btn.onclick=()=>{++sportsCategorySequence;selectedPrematchLeague=btn.dataset.league;sportsHomeTab='league';activeLeague='';query='';eventSearchText='';$('search').value='';$('sideSearch').value='';applySidebarSearch();clearInterval(timer);load();timer=setInterval(load,15000);});
  }catch(e){if(sequence===sportsCategorySequence&&sportsHomeTab==='category')$('categoryBody').textContent=e.message;}
}
function ensureSportsCatalog(){
  $('sportsCatalog')?.remove();
  if(sportsCatalogRows.length){drawSportsNavigation();return;}
  if(ensureSportsCatalog.loading)return;ensureSportsCatalog.loading=true;
  sportsList('sports').then(rows=>{sportsCatalogRows=rows;$('sideList').innerHTML='<button class="sideRow home" id="sportsHome">Home</button>'+rows.map(r=>'<button class="sideRow" data-side-category="'+esc(r.id)+'"><span>'+esc(r.name)+'</span><span>›</span></button>').join('');$('sportsHome').onclick=openSportsHome;document.querySelectorAll('[data-side-category]').forEach(b=>b.onclick=()=>openSportsCategory(b.dataset.sideCategory));applySidebarSearch();if(mode==='home')drawSportsNavigation();}).catch(e=>{$('status').textContent=e.message;}).finally(()=>ensureSportsCatalog.loading=false);
}
async function openHomeMatch(id){const g=findLiveGame(id);if(!g)return;clearInterval(timer);++liveLoadSequence;g.isPrematch=true;openLiveGameId=String(id);liveMarketCategory='Kryesore';await fetchLiveMarkets(g);}
function homeLiveRow(g){
 const odds=parseOdds(g.odd),score=String(g.result||'').split(/[-:]/),home=score[0]||'—',away=score[1]||'—';
 return '<div class="sports-live-row"><button type="button" class="home-live-meta" data-home-live="'+esc(g.id)+'"><span class="home-live-clock">'+(g.stream_id?'<span class="home-live-tv" aria-label="Transmetim">▱</span>':'')+esc(g.current_minute||'LIVE')+'</span><span class="home-live-markets">'+esc(g.count_options??'')+' ›</span></button><button type="button" class="sports-live-teams" data-home-live="'+esc(g.id)+'"><span>'+esc(g.home_team||g.name)+'</span><span>'+esc(g.away_team||'')+'</span></button><button type="button" class="home-live-score" data-home-live="'+esc(g.id)+'"><span>'+esc(home)+'</span><span>'+esc(away)+'</span></button>'+oddHtml(g,'1',odds['1'])+oddHtml(g,'X',odds.X)+oddHtml(g,'2',odds['2'])+'</div>';
}
function renderSportsHome(today){
  const cardOdd=(g,k,o)=>oddHtml(g,k,o).replace(/(<button[^>]*>)/,'$1<span class="home-odd-label">'+k+'</span>');

  const cards=rows=>'<div class="sports-card-strip">'+rows.map(g=>{const o=parseOdds(g.odd);return '<article class="sports-fixture"><button type="button" class="home-match-open" data-home-match="'+esc(g.id)+'" aria-label="Hap marketet: '+esc((g.home_team||g.name)+' – '+(g.away_team||''))+'"><span class="sports-fixture-teams"><span>'+esc(g.home_team||g.name)+'</span><span>'+esc(g.away_team||'')+'</span></span><span class="sports-fixture-meta">'+esc(formatPrematchKickoff(g))+'<span>'+esc(g.count_options||'')+' ›</span></span></button><div class="sports-fixture-odds">'+cardOdd(g,'1',o['1'])+cardOdd(g,'X',o.X)+cardOdd(g,'2',o['2'])+'</div></article>';}).join('')+'</div>';
  const highlighted=homeExtras.featured.length?homeExtras.featured:today.filter(g=>g.home_team&&g.away_team&&Object.values(parseOdds(g.odd)).some(o=>Number(o?.odd)>1));const first=highlighted[0]?.league,featured=highlighted.filter(g=>g.league===first);const main=homeExtras.main.filter(g=>g.home_team&&g.away_team&&Object.values(parseOdds(g.odd)).some(o=>Number(o?.odd)>1));
  $('content').innerHTML='<section class="sports-home-section"><button class="sports-section-title" id="sportsToday">Ndeshjet Sot <span>Te Gjitha Ndeshjet ›</span></button>'+(featured.length?'<div class="sports-league-title">'+esc(first)+'</div>'+cards(featured):'<p>Nuk ka ndeshje.</p>')+'</section><section class="sports-home-section"><div class="sports-section-title">Ndeshjet Kryesore</div>'+cards(main)+'</section><section class="sports-home-section"><button class="sports-section-title sports-live-title" id="sportsAllLive">NË KOHË REALE <span>Te Gjitha Ndeshjet ›</span></button><div class="sports-home-live-head"><span>Futboll</span><span>1</span><span>X</span><span>2</span></div><div class="sports-live-list">'+homeExtras.live.map(homeLiveRow).join('')+'</div></section>';
  $('content').onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-home-match]')){e.preventDefault();openHomeMatch(e.target.dataset.homeMatch);}};
  cache=[...today,...homeExtras.featured,...homeExtras.main,...homeExtras.live].filter((g,i,all)=>all.findIndex(x=>String(x.id)===String(g.id))===i);bindOdds();
  $('sportsToday').onclick=()=>{sportsHomeTab='today';selectedPrematchLeague='';selectedSport='all';load();};$('sportsAllLive').onclick=()=>setMode('live');
  document.querySelectorAll('[data-home-live]').forEach(b=>b.onclick=()=>{location.hash='/livematch/'+b.dataset.homeLive+'?sportId=1';});
}
function render(data,reset=true){
  if(mode==='mybets'||mode==='livematch')return;
  if(mode==='home'&&sportsHomeTab==='category')return;
  if(reset){cache=data||[];if(mode!=='live')updateLeagues(cache)}
  if(mode==='live') return renderLive(data);
  ensureSportsCatalog();
  if(mode==='home'&&sportsHomeTab==='home'&&!selectedPrematchLeague&&!query&&!activeLeague){renderSportsHome(data||[]);return;}
  const arr=(data||[]).filter(g=>selectedPrematchLeague?(!query||searchText(JSON.stringify(g)).includes(query)):visible(g)).slice().sort((a,b)=>Number(a.order??0)-Number(b.order??0));
  if(!arr.length){$('content').innerHTML='<div class="emptySlip">No events found for this filter.</div>';return}
  const groups={};arr.forEach(g=>(groups[g.league||'Competition']??=[]).push(g));
  let html='<div class="dayhead">'+(selectedPrematchLeague?'Ndeshjet e ligës':'Ndeshjet · 24 orët e ardhshme')+'</div>';
  for(const [league,items] of Object.entries(groups)){
    html+=`<section class="league"><div class="leaguehead"><div class="name">${esc(league)}</div></div><div class="matchgrid">`;
    for(const g of items){
      const o=parseOdds(g.odd),time=[g.game_date,g.game_time].filter(Boolean).join(' ');
      html+=`<div class="match"><div class="matchinfo"><div class="teams"><div class="team">${esc(g.home_team||g.name||'')}</div><div class="team">${esc(g.away_team||'')}</div></div><div class="meta"><span>${esc(time)}</span><span>${esc(g.count_options?g.count_options+' >':'')}</span></div></div>${oddHtml(g,'1',o['1'])}${oddHtml(g,'X',o.X)}${oddHtml(g,'2',o['2'])}</div>`
    }
    html+='</div></section>'
  }
  $('content').innerHTML=(selectedPrematchLeague&&selectedCountryContext?'<button class="sports-section-title" id="leagueBack">‹ Kthehu te ligat · '+esc(selectedCountryContext.name)+'</button>':'')+html;
  if($('leagueBack'))$('leagueBack').onclick=()=>{const c=selectedCountryContext;openSportsCountry(c.sportId,c.countryId,c.name);};
  bindOdds();
  document.querySelectorAll('.leaguehead').forEach(h=>h.onclick=()=>{activeLeague=activeLeague===h.querySelector('.name').textContent?'':h.querySelector('.name').textContent;$('leagueFilter').value=activeLeague;render(cache,false)})
}
function bindOdds(){
  const content=$('content');
  if(!content)return;
  content.onclick=e=>{
    const b=e.target.closest('.odd:not(.locked),.live-odd:not(.locked)');
    if(!b){const card=e.target.closest('[data-home-match]');if(card)openHomeMatch(card.dataset.homeMatch);return;}
    e.preventDefault();e.stopPropagation();
    const g=cache.find(x=>String(x.id)===String(b.dataset.game));
    if(g)addPick(g,b.dataset.key,b.dataset.odd);
  };
}

function renderLive(data,reset=false){
  if(mode!=='live')return;
  if(openLiveGameId){
    const g=findLiveGame(openLiveGameId);
    const groups=liveMarketsCache.get(String(openLiveGameId))||[];
    if(g&&groups.length){renderLiveMarketPanel(g,groups,false);return;}
  }
  const arr=(data||[]).filter(g=>{
    const t=searchText((g.name||'')+' '+(g.home_team||'')+' '+(g.away_team||'')+' '+(g.league||''));
    return (g.id!=null && !!(g.home_team||g.name)) && (!query||t.includes(query)) && (selectedSport==='all'||selectedSport==='popular'||sportOf(g)===selectedSport);
  });
  let html=`<div class="live-mobile-dayhead"><span>Ndeshjet Sot</span><span>⌄</span></div><div class="live-toolbar"><label class="live-search"><span class="glass">⌕</span><input id="liveSearchInput" value="${esc(query)}" placeholder="Kerko Ndeshjen"></label><div class="live-result">Rezultat Final</div></div><div class="live-table">`;
  if(!arr.length){html+='<div class="live-empty">Nuk ka ndeshje live për momentin.</div></div>';updateLiveList(html);bindOdds();return}
  const groups={};arr.forEach(g=>(groups[g.league||'Competition']??=[]).push(g));
  for(const [league,items] of Object.entries(groups)){
    html+=`<section class="live-league"><div class="live-league-head"><span class="lname">${esc(league)}</span><span>1</span><span>X</span><span>2</span></div>`;
    for(const g of items){
      const o=parseOdds(g.odd), result=String(g.result||'').split('-'), homeScore=result[0]||'', awayScore=result[1]||'';
      const time=getLiveClock(g);
      html+=`<div class="live-row" data-live-game="${esc(liveGameId(g))}"><div class="live-info"><span class="live-monitor" aria-label="TV"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg></span><div class="live-time" data-live-clock="${esc(g.id)}"><span class="live-clock-value">${esc(time)}</span><span class="live-market-count">${g.count_options?esc(g.count_options)+' &gt;':''}</span></div><div class="live-teams"><div class="live-team">${esc(g.home_team||g.name||'')}</div><div class="live-team">${esc(g.away_team||'')}</div></div><div class="live-score"><div>${esc(homeScore)}</div><div>${esc(awayScore)}</div></div></div>${liveOddHtml(g,'1',o['1'])}${liveOddHtml(g,'X',o.X)}${liveOddHtml(g,'2',o['2'])}</div>`;
    }
    html+='</section>';
  }
  html+='</div>';
  updateLiveList(html);
  bindLiveSearch();
  // Wait for a completed click so touching a row to scroll cannot select odds.
  const content=$('content');
  const handle=e=>{
    const odd=e.target.closest('.live-odd:not(.locked)');
    if(odd){const action='live-odd:'+odd.dataset.game+':'+odd.dataset.key;if(!isNewLiveActivation(e,action))return;e.preventDefault();e.stopPropagation();const g=findLiveGame(odd.dataset.game);if(g)addPick(g,odd.dataset.key,odd.dataset.odd);return;}
    const row=e.target.closest('[data-live-game]');
    if(row){const action='live-game:'+row.dataset.liveGame;if(!isNewLiveActivation(e,action))return;e.preventDefault();const g=findLiveGame(row.dataset.liveGame);if(g)toggleLiveMarkets(g);}
  };
  content.onclick=handle;
  content.onpointerdown=null;
}

function liveOddHtml(g,key,val){const raw=val&&typeof val==='object'?val.odd:val;const l=lock(raw),sel=slip.some(x=>String(x.gameId)===String(g.id)&&x.key===key&&String(x.marketId)===String(parseOdds(g.odd)[key]?.marketId||''));return `<button class="live-odd ${l?'locked':''} ${sel?'selected':''}" ${l?'disabled':''} data-game="${esc(g.id)}" data-key="${key}" data-odd="${esc(raw??'')}">${l?oddsLockIcon():Number(raw).toFixed(2)}</button>`}

let pageLoad=null,livePaintTimer=null;
let liveSnapshot=null,livePrefetch=null;
function rememberLiveSnapshot(rows){liveSnapshot={at:Date.now(),rows:rows.map(row=>({...row}))};}
function warmLiveSnapshot(){
  if(!user||document.hidden||livePrefetch||(liveSnapshot&&Date.now()-liveSnapshot.at<15000))return;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  livePrefetch=fetch('/api/livegames',{signal:controller.signal}).then(async response=>{
    if(!response.ok)return;const rows=await SportsbookApi.readJson(response);
    if(Array.isArray(rows)&&mode==='home')rememberLiveSnapshot(rows);
  }).catch(()=>{}).finally(()=>{clearTimeout(timeout);livePrefetch=null});
}
function cancelPageLoad(){if(pageLoad){pageLoad.controller.abort();pageLoad=null;}clearTimeout(livePaintTimer);livePaintTimer=null;}
function load(){
  if(mode==='mybets'||(mode==='home'&&sportsHomeTab==='category'))return Promise.resolve();
  const key=[mode,selectedPrematchLeague,sportsHomeTab].join(':');
  if(pageLoad?.key===key)return pageLoad.promise;
  if(pageLoad)pageLoad.controller.abort();
  const controller=new AbortController(),request={key,controller};
  pageLoad=request;const timeout=setTimeout(()=>controller.abort(),15000);
  request.promise=loadOnce(controller.signal).finally(()=>{clearTimeout(timeout);if(pageLoad===request)pageLoad=null;});
  return request.promise;
}
// Apply every push to the model, but paint a burst once instead of rebuilding
// hundreds of rows for each individual coefficient message.
function pruneLiveCaches(){
  const keep=new Set(cache.map(g=>String(g.id)));if(openLiveGameId)keep.add(String(openLiveGameId));
  for(const pick of slip)keep.add(String(pick.gameId));
  for(const map of [liveClockState,liveClockRevision,liveMarketsCache])for(const key of map.keys())if(!keep.has(String(key)))map.delete(key);
}
function queueLivePaint(){
  if(livePaintTimer!==null)return;
  livePaintTimer=setTimeout(()=>{
    livePaintTimer=null;if(document.hidden||!['live','livematch'].includes(mode))return;
    // Market polling handles detail odds; unrelated event pushes need no full panel render.
    if(mode==='livematch')tickLiveClocks();
    else renderLive(cache);
    renderSlip();
  },250);
}
async function loadOnce(signal){if(mode==='mybets')return;const sequence=++liveLoadSequence,revisions=new Map(liveClockRevision);try{const liveMode=mode==='live'||mode==='livematch';const pageKey=selectedPrematchLeague||'today';const extras=!liveMode&&!selectedPrematchLeague&&sportsHomeTab==='home'?Promise.allSettled([sportsList('main-matches'),sportsList('home-live'),sportsList('featured')]):null;const r=await fetch(liveMode?'/api/livegames?ts='+Date.now():(selectedPrematchLeague?'/api/sports-catalog/league-games/'+selectedPrematchLeague:'/api/prematch')+'?ts='+Date.now(),{signal});if(!r.ok)throw Error('HTTP '+r.status);const d=await SportsbookApi.readJson(r);const rows=Array.isArray(d)?d:[];if(sequence!==liveLoadSequence)return;if(liveMode){for(const row of rows){const id=String(row.id),latest=findLiveGame(id);if(latest&&(liveClockRevision.get(id)||0)!==(revisions.get(id)||0)){row.current_minute=latest.current_minute??latest.game_time;row.result=latest.result;}}rows.forEach(g=>syncLiveClock(g,true));cache=rows;rememberLiveSnapshot(rows);pruneLiveCaches();updateLeagues(cache);if(mode==='livematch'){const g=findLiveGame(openLiveGameId);if(g){const existing=liveMarketsCache.get(String(openLiveGameId));if(existing?.length)renderLiveMarketPanel(g,existing,false);refreshLiveMarkets(g,true);}}else{renderLive(cache,false)}}else{sportsPageCache.set(pageKey,rows);render(rows);warmLiveSnapshot();if(extras)extras.then(extra=>{if(sequence!==liveLoadSequence||mode!=='home'||sportsHomeTab!=='home')return;homeExtras={featured:extra[2].status==='fulfilled'?extra[2].value:homeExtras.featured,main:extra[0].status==='fulfilled'?extra[0].value:homeExtras.main,live:extra[1].status==='fulfilled'?extra[1].value:homeExtras.live};render(rows);renderSlip();})}renderSlip();if(!liveMode)$('status').textContent='PREMATCH • '+new Date().toLocaleTimeString('sq-AL');else if(mode==='livematch')$('status').textContent='LIVE MATCH • Real-time'}catch(e){if(sequence!==liveLoadSequence)return;if($('content').querySelector('.sports-loading')){$('content').innerHTML='<div class="emptySlip" role="status">Lidhja me furnizimin po vonon. <button id="retryFeed" type="button">Provo përsëri</button></div>';$('retryFeed').onclick=()=>load();}$('status').textContent=(mode==='live'||mode==='livematch')?'LIVE • Feed offline':'Feed error'}}
function applyLiveCoefs(payload){if(mode!=='live'&&mode!=='livematch')return;if(!payload||payload.game_id==null)return;const g=findLiveGame(payload.game_id);if(!g)return;const map={};(payload.coefs||[]).forEach(c=>{map[String(c.coef_id)]=String(c.odd)});if(typeof g.odd==='string'){g.odd=g.odd.split(',').map(part=>{const p=part.split('|');if(p.length>=4&&map[String(p[0])]!==undefined)p[1]=map[String(p[0])];return p.join('|')}).join(',')}if(payload.current_result!=null)g.result=payload.current_result;if(payload.current_minute!=null){g.current_minute=payload.current_minute;syncLiveClock(g);liveClockRevision.set(String(g.id),(liveClockRevision.get(String(g.id))||0)+1);}queueLivePaint()}
function applyLiveGame(payload){
  if(mode!=='live'&&mode!=='livematch')return;
  if(!payload)return;
  const item=payload.game||payload;
  if(Array.isArray(item)){item.forEach(applyLiveGame);return}
  if(item.id==null)return;
  const key=liveGameId(item);
  if(item.current_minute!=null||item.game_time!=null)liveClockRevision.set(String(item.id),(liveClockRevision.get(String(item.id))||0)+1);
  const i=cache.findIndex(x=>liveGameId(x)===key);
  if(i<0){const added={...item,current_minute:item.current_minute??item.game_time};cache.push(added);syncLiveClock(added)}
  else{
    const prev=cache[i];
    const merged={...prev,...item};
    // The socket often announces a game before its three summary coefficients.
    // Preserve missing fields, but respect explicit empty/suspended odds.
    if(!Object.prototype.hasOwnProperty.call(item,'odd'))merged.odd=prev.odd;
    // Push game_time is elapsed match time, not the scheduled kickoff.
    if(item.current_minute==null&&item.game_time!=null){merged.current_minute=item.game_time;merged.game_time=prev.game_time;}
    cache[i]=merged;
    syncLiveClock(merged);
  }
  queueLivePaint();
  // The dedicated market poll refreshes the open event at a bounded rate.
}
let apiStatusRequest=null;
async function refreshApiStatus(){
  if(document.hidden||apiStatusRequest)return;
  const controller=new AbortController();apiStatusRequest=controller;
  const timeout=setTimeout(()=>controller.abort(),8000);
  try{
    const response=await fetch('/api/live-status',{signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw Error('Status unavailable');
    const data=await SportsbookApi.readJson(response);
    $('status').textContent=data.upstreamConnected?'API • Lidhja aktive':'API • Rilidhje me furnizuesin';
  }catch(_){$('status').textContent='API • Lidhja nuk mund të verifikohet';}
  finally{clearTimeout(timeout);apiStatusRequest=null;}
}
setInterval(refreshApiStatus,15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshApiStatus()});
window.addEventListener('online',refreshApiStatus);
window.addEventListener('offline',()=>{$('status').textContent='API • Pa lidhje interneti'});
refreshApiStatus();
function startLiveStream(){if(mode!=='live'&&mode!=='livematch')return;if(liveStream){try{liveStream.close()}catch(_){}}liveStream=new EventSource('/api/live-stream');liveStream.onopen=()=>{refreshApiStatus()};liveStream.addEventListener('status',e=>{try{const d=JSON.parse(e.data);$('status').textContent=d.status==='connected'?'LIVE • Real-time':(d.status==='reconnecting'?'LIVE • Feed offline':'LIVE • Rilidhje me furnizuesin')}catch(_){}});liveStream.addEventListener('coefs',e=>{try{applyLiveCoefs(JSON.parse(e.data))}catch(_){}});liveStream.addEventListener('game',e=>{try{applyLiveGame(JSON.parse(e.data))}catch(_){}});liveStream.onerror=()=>{$('status').textContent='LIVE • Feed offline'}}
function stopLiveStream(){if(liveStream){try{liveStream.close()}catch(_){}}liveStream=null}
let ticketNotificationStream=null;
function stopTicketNotifications(){if(ticketNotificationStream){try{ticketNotificationStream.close()}catch(_){}}ticketNotificationStream=null}
async function applyTicketOfferRealtime(event){
  if(!user||user.role!=='user'||!event||!event.betId)return;
  if(!pendingTicket||Number(pendingTicket.id)!==Number(event.betId)){
    try{const r=await sessionFetch('/api/my-bets/'+event.betId,{headers:{Authorization:'Bearer '+token}});if(!r.ok)return;const b=(await SportsbookApi.readJson(r)).bet;pendingTicket={id:b.id,stake:b.stake,selections:(b.selections||[]).map(s=>({...s,home:s.home_team||s.home,away:s.away_team||s.away,key:s.selection,market:s.market})),offer:b.offer||null};}catch(_){return;}
  }else pendingTicket.offer={offers:event.offers||[],totalOdds:Number(event.totalOdds),potentialWin:Number(event.potentialWin)};
  if(!pendingTicket.offer)pendingTicket.offer={offers:event.offers||[],totalOdds:Number(event.totalOdds),potentialWin:Number(event.potentialWin)};
  renderSlip();
}
function startTicketNotifications(){
  if(!user||user.role!=='user'||!token)return stopTicketNotifications();
  stopTicketNotifications();ticketNotificationStream=new EventSource('/api/notifications/stream?token='+encodeURIComponent(token));
  ticketNotificationStream.addEventListener('ticket-offer',e=>{try{applyTicketOfferRealtime(JSON.parse(e.data))}catch(_){}});
  ticketNotificationStream.onerror=()=>{};
}
function setMode(m,{fromHash=false}={}){
  if(m==='mybets'){showMyBets(true,{fromHash});return;}
  cancelPageLoad();++sportsCategorySequence;++liveLoadSequence;
  const content=$('content');content.onclick=null;content.onpointerdown=null;
  content.innerHTML=brandLoading('sports-loading');
  cache=[];
  if(m==='home'&&mode!=='home'){sportsHomeTab='home';selectedPrematchLeague='';}
  if($('sportsCatalog'))$('sportsCatalog').hidden=m==='live'||m==='livematch';
  mode=m;activeLeague='';lastOdds={};selectedSport='soccer';query='';
  if(m!=='livematch')closeLiveMarkets();
  if(!fromHash && m==='livematch'){const g=findLiveGame(openLiveGameId);if(g)setHashForLiveMatch(g);}
  else if(!fromHash)setHashForMode(m);
  $('homeBtn').classList.toggle('active',m==='home');
  $('liveBtn').classList.toggle('active',m==='live'||m==='livematch');
  document.body.classList.toggle('live-page',m==='live'||m==='livematch');
  document.body.classList.remove('mybets-page');$('myTopBtn').classList.remove('active');$('search').value='';$('sideSearch').value='';eventSearchText='';applySidebarSearch();
  document.querySelectorAll('.sideTool').forEach((b,i)=>b.classList.toggle('active',(m==='live'||m==='livematch')?i===1:i===0));
  clearInterval(timer);timer=null;stopLiveStream();clearInterval(window.liveClockTicker);window.liveClockTicker=null;stopOpenMarketsRefresh();
  if(m==='live'){
    $('sportsbar').style.display='flex';
    $('sportsbar').innerHTML=[['⚽','Futboll','soccer'],['🏀','Basketboll','basketball'],['🎾','Tenis','tennis'],['🏈','Futboll Amerikan','american'],['🏸','Badminton','badminton']].map(s=>`<button class="sport ${s[2]==='soccer'?'active':''}" data-sport="${s[2]}"><span class="ico">${sportIcon(s[2],s[0])}</span><span>${s[1]}</span></button>`).join('');
    document.querySelectorAll('.sport').forEach(b=>b.onclick=()=>{document.querySelectorAll('.sport').forEach(x=>x.classList.remove('active'));b.classList.add('active');selectedSport=b.dataset.sport;renderLive(cache)});
    if(liveSnapshot&&Date.now()-liveSnapshot.at<15000){
      cache=liveSnapshot.rows.map(row=>({...row}));renderLive(cache);$('status').textContent='LIVE • Po përditësohen koeficientët…';
    }
    startLiveStream();startOpenMarketsRefresh();load();timer=setInterval(()=>{if(!document.hidden)load();},5000);window.liveClockTicker=setInterval(tickLiveClocks,1000);
  }else if(m==='livematch'){
    $('sportsbar').style.display='none';
    load().then(()=>{if(mode!=='livematch')return;const route=parseLiveMatchHash();if(route)openLiveMatchFromRoute(route);startLiveStream();startOpenMarketsRefresh()});
    timer=setInterval(()=>{if(!document.hidden)load();},5000);window.liveClockTicker=setInterval(tickLiveClocks,1000);
  }else{
    $('sportsbar').style.display='flex';
    $('sportsbar').innerHTML=sports.map(s=>`<button class="sport ${s[2]==='soccer'?'active':''}" data-sport="${s[2]}"><span class="ico">${sportIcon(s[2],s[0])}</span><span>${s[1]}</span></button>`).join('');
    document.querySelectorAll('.sport').forEach(b=>b.onclick=()=>{document.querySelectorAll('.sport').forEach(x=>x.classList.remove('active'));b.classList.add('active');selectedSport=b.dataset.sport;activeLeague='';$('leagueFilter').value='';render(cache,false)});
    const previous=sportsPageCache.get(selectedPrematchLeague||'today');
    if(previous){render(previous);$('status').textContent='Po përditësohen koeficientët…';}
    else{$('content').innerHTML=brandLoading('sports-loading');ensureSportsCatalog();}
    load();timer=setInterval(load,15000);
  }
}


function staffRoleLabel(role){return ({center:'Qendra',operator:'Operator',partner:'Partner',admin:'Administrator',senior:'Senior',manager:'Manager',supermanager:'Senior (legacy)',agent:'Agjent'})[role]||role}
function staffCreateRoles(role){return ({center:[['operator','Operator'],['partner','Partner']],partner:[['admin','Administrator']],admin:[['senior','Senior']],senior:[['manager','Manager']],supermanager:[['manager','Manager']],manager:[['agent','Agjent']],agent:[['user','User']]}[role]||[])}
function staffAccountLabel(role){return ({center:'Numri i qendrës',operator:'Numri i operatorit',partner:'Numri i partnerit',admin:'Numri i administratorit',senior:'Numri i seniorit',manager:'Numri i menaxherit',supermanager:'Numri i seniorit',agent:'Numri i agjentit'})[role]||'Numri'}
function formatCredit(value){
  return Number(value||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function setAuthState(u){
  user=u;
  if(u||!token)document.documentElement.classList.remove('session-restoring');
  document.body.classList.toggle('auth-required',!u);
  $('authModal').classList.toggle('show',!u);
  let managementLink=document.getElementById('hierarchyManagementLink');
  if(managementLink)managementLink.remove();
  if(u&&u.role!=='user'&&u.role!=='center'){
    managementLink=document.createElement('a');managementLink.id='hierarchyManagementLink';managementLink.href='/backoffice.html';managementLink.textContent='Administrimi · '+staffRoleLabel(u.role);
    managementLink.style.cssText='position:fixed;right:18px;bottom:32px;z-index:100001;padding:12px 18px;background:#163952;color:white;border-radius:8px;text-decoration:none;box-shadow:0 2px 12px #0003';document.body.appendChild(managementLink);
  }
  const myTop=$('myTopBtn');
  if(myTop)myTop.hidden=!u;
  if(token)sessionStorage.setItem('sportsbook_token',token);else sessionStorage.removeItem('sportsbook_token');
  if(user){
    if(user.role==='operator'){location.replace('/backoffice.html#/ticket-accept');return;}if(['partner','admin'].includes(user.role)){location.replace('/backoffice.html#/dashboard');return;}
    if(user.role!=='user')stopTicketNotifications();
    if(!['partner','admin'].includes(user.role))hideAdminWorkspace();
    if(user.role==='center'){
      hideUserMenu();$('actions').innerHTML='<div class="account"><button id="panelB" class="staffAccountButton">Control Center</button></div>';
      $('panelB').onclick=showCenterDashboard;$('slipHead').style.display='none';$('slipView').style.display='none';$('staffView').style.display='none';showCenterDashboard();renderSlip();return;
    }
    const staff=user.role!=='user';
    if(staff){
      $('actions').innerHTML='<div class="account"><button id="panelB" class="staffAccountButton">Partner</button></div>';
      $('panelB').onclick=()=>toggleStaffMenu(true);
      $('slipHead').style.display='none';$('slipView').style.display='none';$('staffView').style.display='block';toggleStaffMenu(true);
      if(['partner','admin'].includes(user.role))setTimeout(()=>openControl(user.role,'directory'),0);
    }else{
      $('actions').innerHTML=`<div class="account userAccount"><div class="balance"><b>${formatCredit(user.balance)} €</b></div><button id="userAvatar" class="userAvatar" aria-label="Hap menunë e llogarisë"></button></div>`;
      $('slipHead').style.display='flex';$('slipView').style.display='block';$('staffView').style.display='none';
      $('userAvatar').onclick=e=>{e.stopPropagation();toggleUserMenu()};
      startTicketNotifications();
      restoreUserPendingTicket();
    }
  }else{
    stopTicketNotifications();
    hideUserMenu();
    hideCenterDashboard();
    hideAdminWorkspace();
    $('actions').innerHTML='<button id="loginB">Log In</button>';$('loginB').onclick=openAuth;
    $('slipHead').style.display='flex';$('slipView').style.display='block';$('staffView').style.display='none';
  }
  renderSlip();
}
function hideUserMenu(){const menu=$('userMenu');if(menu)menu.remove()}
function toggleUserMenu(){
  if(!user||user.role!=='user')return;
  let menu=$('userMenu');if(menu){hideUserMenu();return}
  menu=document.createElement('div');menu.id='userMenu';menu.className='userMenu';
  menu.innerHTML=`<div class="userMenuHead"><b>${esc(user.username)}</b><strong>${formatCredit(user.balance)}</strong><em>EUR</em></div><button data-user-menu="chat">Chat</button><button data-user-menu="rules">Rregullore</button><button data-user-menu="bets">My Bets</button><button data-user-menu="finance">Financa</button><button data-user-menu="password">Ndrysho Fjalëkalimin</button><button data-user-menu="logout">Largohu</button>`;
  document.body.appendChild(menu);menu.classList.add('show');
  menu.querySelectorAll('[data-user-menu]').forEach(b=>b.onclick=()=>{const action=b.dataset.userMenu;hideUserMenu();if(action==='bets'||action==='finance'){showMyBets(true);return}if(action==='logout'){logout();return}if(action==='chat')alert('Chat do të lidhet me modulin e komunikimit.');else if(action==='rules')alert('Rregullorja e platformës.');else alert('Ndryshimi i fjalëkalimit do të jetë i disponueshëm së shpejti.');});
}
async function renderStaffMenu(){
  if(!user||user.role==='user')return;
  try{
    const d=await controlFetch('/api/staff/overview');
    const cRoles=staffCreateRoles(user.role);
    const items=[['directory','Lista e Përdoruesve',String(d.accounts.length)]];
    cRoles.forEach(r=>items.push(['create:'+r[0],'Krijo '+r[1],'']));
    if(user.role==='center'||user.role==='operator')items.push(['tickets','Biletat',d.pendingTickets?`${d.pendingTickets} në pritje`:'']);
    items.push(['password','Ndrysho Fjalëkalimin',''],['chat','Chat',''],['rules','Rregullore',''],['logout','Largohu','']);
    const moneyBlock=user.role==='center' ? `<div class="staffMoney"><div class="staffMoneyRow"><div class="currency">STATUS</div><strong>UNLIMITED</strong></div></div>` : `<div class="staffMoney"><div class="staffMoneyRow"><div class="currency">EUR</div><strong>${formatCredit(user.balance)} EUR</strong></div><div class="staffMoneyRow"><div class="currency">LEK</div><strong>0.00 LEK</strong></div><div class="staffMoneyRow"><div class="currency">USD</div><strong>0.00 USD</strong></div></div>`;
    $('staffView').innerHTML=`<div class="staffSummary"><div class="label">${staffAccountLabel(user.role)}</div><div class="agentNo">${String(user.id).padStart(6,'0')}</div></div>${moneyBlock}${items.map(x=>`<button class="staffMenuItem ${x[0]==='logout'?'logout':''}" data-staff-action="${x[0]}">${esc(x[1])}${x[2]?`<span class="staffPill">${esc(x[2])}</span>`:''}</button>`).join('')}`;
    document.querySelectorAll('[data-staff-action]').forEach(b=>b.onclick=()=>handleStaffAction(b.dataset.staffAction));
  }catch(e){
    if(!user)return;
    $('staffView').innerHTML=`<div class="staffSummary"><div class="label">${staffRoleLabel(user.role)}</div><div class="agentNo">${String(user.id).padStart(6,'0')}</div></div>${user.role==='center'?'<div class="staffMoney"><div class="staffMoneyRow"><div class="currency">STATUS</div><strong>UNLIMITED</strong></div></div>':''}<button class="staffMenuItem" data-staff-action="directory">Lista e Përdoruesve</button><button class="staffMenuItem" data-staff-action="logout">Largohu</button>`;
    document.querySelectorAll('[data-staff-action]').forEach(b=>b.onclick=()=>handleStaffAction(b.dataset.staffAction));
  }
}
function toggleStaffMenu(on){
  if(!user||user.role==='user')return;
  $('staffView').style.display=on?'block':'none';
  $('slipView').style.display=on?'none':'block';
  $('slipHead').style.display=on?'none':'flex';
  if(on)renderStaffMenu();
}
// Keep wallet display current without rebuilding the slip or account controls.
function expireSession(requestToken){
  if(!requestToken||token!==requestToken)return;
  token='';pendingTicket=null;lastBetRequest=null;
  clearInterval(pendingPoll);pendingPoll=null;
  closeControlPoll();$('controlModal').classList.remove('show');
  setAuthState(null);
  if(mode==='mybets')showMyBets(false);
  $('authMsg').textContent='Sesioni ka skaduar. Hyni përsëri në llogari.';
}
async function sessionFetch(url,options={}){
  const requestToken=token;
  const response=await fetch(url,{...options,headers:{...options.headers,Authorization:'Bearer '+requestToken}});
  if(response.status===401){
    expireSession(requestToken);
    const error=new Error('Sesioni ka skaduar. Hyni përsëri në llogari.');error.status=401;throw error;
  }
  return response;
}
let walletRefreshTimer=null,walletRefreshInFlight=false,walletRefreshAgain=false;
function scheduleWalletRefresh(){
  clearTimeout(walletRefreshTimer);
  walletRefreshTimer=setTimeout(refreshWalletBalance,150);
}
async function refreshWalletBalance(){
  if(!token||!user||document.hidden)return;
  if(walletRefreshInFlight){walletRefreshAgain=true;return;}
  walletRefreshInFlight=true;
  const sessionToken=token,account=user,previousBalance=user.balance,previousReserved=user.reservedBalance;
  try{
    const response=await sessionFetch('/api/me',{cache:'no-store'});
    if(response.status===403){expireSession(sessionToken);return;}
    if(!response.ok)return;
    const data=await SportsbookApi.readJson(response),fresh=data.user;
    if(token!==sessionToken||user!==account||!fresh||String(fresh.id)!==String(user.id))return;
    // A placement response may have updated the wallet while this read was pending.
    if(user.balance!==previousBalance||user.reservedBalance!==previousReserved){walletRefreshAgain=true;return;}
    if(!Number.isFinite(Number(fresh.balance)))return;
    user.balance=fresh.balance;user.reservedBalance=fresh.reservedBalance||0;
    const balance=document.querySelector('#actions .balance b');
    if(balance)balance.textContent=formatCredit(user.balance)+' €';
    const menuBalance=document.querySelector('#userMenu .userMenuHead strong');
    if(menuBalance)menuBalance.textContent=formatCredit(user.balance);
  }catch(_){/* Keep the last confirmed balance; retry on the next interaction. */}
  finally{walletRefreshInFlight=false;if(walletRefreshAgain){walletRefreshAgain=false;scheduleWalletRefresh();}}
}
document.addEventListener('click',scheduleWalletRefresh,true);
window.addEventListener('hashchange',scheduleWalletRefresh);
window.addEventListener('focus',scheduleWalletRefresh);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleWalletRefresh();});
setInterval(scheduleWalletRefresh,15000);
async function restore(){if(!token){document.documentElement.classList.remove('session-restoring');return}const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);try{const r=await fetch('/api/me',{headers:{Authorization:'Bearer '+token},signal:controller.signal,cache:'no-store'});if(!r.ok)throw Error();user=(await SportsbookApi.readJson(r)).user;setAuthState(user)}catch(e){token='';setAuthState(null)}finally{clearTimeout(timeout);document.documentElement.classList.remove('session-restoring')}}
async function logout(){await fetch('/api/auth/logout',{method:'POST',headers:{Authorization:'Bearer '+token}}).catch(()=>{});token='';user=null;setAuthState(null);showMyBets(false);closeControlPoll()}
function openAuth(){$('authModal').classList.add('show');$('authMsg').textContent='';$('username').focus()}
async function authSubmit(e){
  e.preventDefault();const button=$('authSubmit');if(button.disabled)return;
  button.disabled=true;button.textContent='Duke hyrë…';$('authMsg').textContent='';
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try{const r=await fetch('/api/auth/login',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('username').value,password:$('password').value})});const d=await SportsbookApi.readJson(r);if(!r.ok)throw Error(d.error||'Hyrja dështoi. Kontrollo të dhënat.');token=d.token;user=d.user;setAuthState(user);$('password').value='';$('authModal').classList.remove('show')}
  catch(e){$('authMsg').textContent=e.name==='AbortError'?'Lidhja po vonon. Provo përsëri.':e.message;$('authMsg').className='adminMsg error'}
  finally{clearTimeout(timeout);button.disabled=false;button.innerHTML='Hyr në llogari <span aria-hidden="true">→</span>'}
}
function localISODate(date=new Date()){
  const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,'0'),day=String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function formatBetDate(v){
  const raw=String(v||'').replace('T',' ');
  const d=new Date(raw.includes('Z')?raw:raw+'Z');
  if(Number.isNaN(d.getTime()))return raw.slice(0,10)||'';
  return `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
}
function formatBetTime(v){
  const raw=String(v||'').replace('T',' ');
  const d=new Date(raw.includes('Z')?raw:raw+'Z');
  return Number.isNaN(d.getTime())?'':d.toLocaleTimeString('sq-AL',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
}
function betStatusLabel(status){
  return ({pending:'',accepted:'',won:'Fituese',lost:'Humbese',cancelled:'Te anuluara',void:'Te anuluara',rejected:'Te anuluara'})[status]??status;
}
let myBetsStatus='all';
function myBetsShell(){
  return `<div class="mybetsPage">
    <div class="mybetsFilters">
      <div class="mybetsDateRow">
        <input id="fromDate" type="date">
        <span>-</span>
        <input id="toDate" type="date">
        <button id="myBetsFilter">Filtro</button>
      </div>
      <div class="mybetsYears">
        <button data-year="2022">2022</button><button data-year="2023">2023</button>
        <button data-year="today">Sot</button><button data-year="yesterday">Dje</button>
        <button data-year="month">Shtator</button><button data-year="august">Gusht</button>
      </div>
      <div class="mybetsStatusTabs">
        <button data-status="all" class="active">Te gjitha</button>
        <button data-status="won">Fituese</button>
        <button data-status="lost">Humbese</button>
        <button data-status="pending">Në pritje</button>
        <button data-status="cancelled">Te anuluara</button>
      </div>
    </div>
    <div id="myBetsSummary"></div>
    <div id="betsList"></div>
    <div class="wallet" id="walletArea"><strong>Historiku i kreditit</strong><div id="walletList"></div></div>
  </div>`;
}
function setMyBetsDates(from,to){
  if($('fromDate'))$('fromDate').value=from||'';
  if($('toDate'))$('toDate').value=to||'';
}
function presetMyBets(kind){
  const now=new Date(), today=localISODate(now);
  if(kind==='today')return setMyBetsDates(today,today);
  if(kind==='yesterday'){const d=new Date(now);d.setDate(d.getDate()-1);const x=localISODate(d);return setMyBetsDates(x,x)}
  if(kind==='month'){return setMyBetsDates(`${now.getFullYear()}-09-01`,`${now.getFullYear()}-09-${new Date(now.getFullYear(),9,0).getDate()}`)}
  if(kind==='august'){return setMyBetsDates(`${now.getFullYear()}-08-01`,`${now.getFullYear()}-08-31`)}
  if(/^\d{4}$/.test(kind))return setMyBetsDates(`${kind}-01-01`,`${kind}-12-31`);
}
function showMyBets(on,{fromHash=false}={}){
  if(on){
    if(!user){openAuth();return}
    if(mode!=='mybets')myBetsReturnMode=mode==='live'?'live':'home';
    cancelPageLoad();++liveLoadSequence;++sportsCategorySequence;
    $('content').onclick=null;$('content').onpointerdown=null;
    mode='mybets'; clearInterval(timer);timer=null;stopLiveStream();clearInterval(window.liveClockTicker);window.liveClockTicker=null;stopOpenMarketsRefresh();closeLiveMarkets();
    if(!fromHash)setHashForMode('mybets');
    $('homeBtn').classList.remove('active');$('liveBtn').classList.remove('active');$('myTopBtn').classList.add('active');
    document.body.classList.remove('live-page');document.body.classList.add('mybets-page');
    $('sportsbar').style.display='none';$('staffView').style.display='none';$('slipHead').style.display='flex';$('slipView').style.display='block';renderSlip();
    $('content').innerHTML=myBetsShell();
    myBetsStatus='all';
    // Start with the current day only when it actually has bets; otherwise load all.
    setMyBetsDates('','');
    document.querySelectorAll('[data-year]').forEach(b=>b.onclick=()=>{
      document.querySelectorAll('[data-year]').forEach(x=>x.classList.remove('active'));b.classList.add('active');
      presetMyBets(b.dataset.year);loadMyBets();
    });
    document.querySelectorAll('.mybetsStatusTabs [data-status]').forEach(b=>b.onclick=()=>{
      document.querySelectorAll('.mybetsStatusTabs [data-status]').forEach(x=>x.classList.remove('active'));b.classList.add('active');
      myBetsStatus=b.dataset.status;
      loadMyBets();
    });
    $('myBetsFilter').onclick=loadMyBets;
    loadMyBets();
    timer=setInterval(()=>{if(mode==='mybets'&&!document.hidden)loadMyBets({silent:true});},10000);
  }else{
    const next=myBetsReturnMode||'home';document.body.classList.remove('mybets-page');$('myTopBtn').classList.remove('active');$('sportsbar').style.display='flex';
    if(user&&user.role!=='user')toggleStaffMenu(true);else{$('slipView').style.display='block';$('staffView').style.display='none';$('slipHead').style.display='flex'}
    setMode(next,{fromHash:false});
  }
}
function selectionResultView(selection){
  const raw=String(selection.resultStatus||selection.result_status||'pending').toLowerCase();
  const states={won:['Fituese','✓'],lost:['Humbëse','×'],void:['E anuluar / rimbursim','–'],cancelled:['E anuluar','–'],rejected:['E refuzuar','–'],half_won:['Gjysmë fituese','½'],half_lost:['Gjysmë humbëse','½'],pending:['','']};
  const status=Object.hasOwn(states,raw)?raw:'pending';
  return {status,label:states[status][0],symbol:states[status][1]};
}
function renderMyBetCard(b){
  const status=String(b.status||'').toLowerCase();
  const selections=Array.isArray(b.selections)?b.selections:[];
  const details=selections.map(s=>{
    const home=esc(s.home||'');const away=esc(s.away||'');
    const market=esc(s.market||'Market');const sel=esc(s.selection||'');
    const odd=Number(s.odd||0).toFixed(2),result=selectionResultView(s);
    return `<div class="mybetSelection ${result.status}">
      <div class="mybetSelectionMain">${result.label?`<span class="mybetLiveMark ${result.status}" aria-label="${result.label}">${result.symbol}</span>`:''}<div><div class="mybetMatch">${home} - ${away}</div><div class="mybetEventTime">${esc(s.eventTime||'')}</div></div></div>
      <div class="mybetMarket">${market}${s.specialValue?` <b>${esc(s.specialValue)}</b>`:''} - ${sel}</div>
      ${result.label?`<div class="mybetResult ${result.status}" role="status">${result.label}</div>`:''}
      <div class="mybetOdd">${odd}</div>
    </div>`;
  }).join('');
  const payout=Number(b.payout||0),potential=Number(b.potential_win||0);
  return `<article class="betcard" data-bet-card="${b.id}">
    <button class="bethead" type="button" data-bet-open="${b.id}">
      <span class="betUser">${esc(b.username||user.username||'')}</span>
      <span class="betNumber">${b.id} - ${formatBetTime(b.created_at)}</span>
      <span class="betStatus ${status}">${betStatusLabel(status)}</span>
      <span class="betStake">EURO ${Number(b.stake||0).toFixed(2)}</span>
      <span class="betChevron">⌄</span>
    </button>
    <div class="betbody">
      ${details}
      <div class="mybetTotals">
        <div><span>Shuma</span><strong>EURO ${Number(b.stake||0).toFixed(2)}</strong></div>
        <div><span>${status==='won'?'Fitimi':'Fitimi'}</span><strong>${status==='won'?payout.toFixed(2):potential.toFixed(2)}</strong></div>
      </div>
      <div class="mybetActions">
        <button type="button" class="repeatBet" data-repeat="${b.id}">Perserit</button>
        
      </div>
    </div>
  </article>`;
}
let myBetsLoadSequence=0,myBetsPageCount=1;
function myBetsDateParams(from,to){
  const params=new URLSearchParams();
  if(from){
    const start=new Date(from+'T00:00:00').toISOString();
    params.set('fromTime',start);
    // Older running servers accept only UTC calendar dates.
    params.set('from',start.slice(0,10));
  }
  if(to){
    const end=new Date(to+'T00:00:00');
    end.setDate(end.getDate()+1);
    params.set('toTime',end.toISOString());
    params.set('to',new Date(end.getTime()-1).toISOString().slice(0,10));
  }
  return params;
}
function myBetInDateRange(bet,params){
  if(!params.has('fromTime')&&!params.has('toTime'))return true;
  const raw=String(bet.created_at||'').replace(' ','T');
  const time=Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)?raw:raw+'Z');
  return Number.isFinite(time)&&(!params.has('fromTime')||time>=Date.parse(params.get('fromTime')))&&(!params.has('toTime')||time<Date.parse(params.get('toTime')));
}
async function loadMyBets({silent=false,more=false}={}){
  if(more)myBetsPageCount++;else if(!silent)myBetsPageCount=1;
  if(!user)return;
  const from=$('fromDate')?.value||'',to=$('toDate')?.value||'';
  const p=myBetsDateParams(from,to);
  if(myBetsStatus==='pending')p.set('status','unsettled');
  else if(['won','lost','cancelled'].includes(myBetsStatus))p.set('status',myBetsStatus);
  const list=$('betsList');if(!list)return;
  const requestId=++myBetsLoadSequence;
  const openCards=new Set([...list.querySelectorAll('.betcard.open')].map(card=>card.dataset.betCard));
  if(!silent)list.innerHTML=brandLoading('mybetsLoading');
  try{
    p.set('paginated','1');
    const responses=[];
    for(let page=0;page<myBetsPageCount;page++){
      const r=await sessionFetch('/api/my-bets?'+p.toString());
      const data=await SportsbookApi.readJson(r);if(!r.ok)throw Error(data.error||'Could not load bets');responses.push(data);
      if(!data.hasMore||!data.nextCursor)break;p.set('before',data.nextCursor);
    }
    if(requestId!==myBetsLoadSequence||mode!=='mybets'||$('betsList')!==list)return;
    const uniqueBets=new Map();
    for(const response of responses)for(const bet of response.bets||[])if(myBetInDateRange(bet,p)&&!uniqueBets.has(String(bet.id)))uniqueBets.set(String(bet.id),bet);
    const data={...responses[0],bets:[...uniqueBets.values()].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))||Number(b.id)-Number(a.id))};
    if(user.role!=='user'&&Array.isArray(data.accounts))$('myBetsSummary').innerHTML=data.accounts.map(a=>`<div class="mybetAccountRow"><span>${esc(a.username)} <small>(${a.bet_count})</small></span><strong>${Number(a.turnover||0).toFixed(2)}</strong></div>`).join('');
    const bets=Array.isArray(data.bets)?data.bets:[];
    if(!bets.length){
      list.innerHTML='<div class="mybetsEmpty">Nuk ka bileta për filtrin e zgjedhur.</div>';
    }else{
      const groups={};
      bets.forEach(b=>{const key=formatBetDate(b.created_at)||'Data';(groups[key]??=[]).push(b)});
      list.innerHTML=Object.entries(groups).map(([date,items])=>`<section class="mybetDay"><div class="mybetDayTitle">${date}</div>${items.map(renderMyBetCard).join('')}</section>`).join('');
      if(responses[responses.length-1]?.hasMore){const more=document.createElement('button');more.type='button';more.className='loadMoreBets';more.textContent='Ngarko më shumë';more.onclick=()=>{more.disabled=true;loadMyBets({more:true});};list.appendChild(more);}
      list.querySelectorAll('.betcard').forEach(card=>{if(openCards.has(card.dataset.betCard))card.classList.add('open');});
      document.querySelectorAll('[data-bet-open]').forEach(btn=>btn.onclick=()=>{
        const card=document.querySelector(`[data-bet-card="${btn.dataset.betOpen}"]`);if(card)card.classList.toggle('open');
      });
      document.querySelectorAll('[data-repeat]').forEach(btn=>btn.onclick=()=>{
        const b=bets.find(x=>String(x.id)===String(btn.dataset.repeat));if(!b)return;
        (b.selections||[]).forEach(s=>{
          const odd=Number(s.odd);if(!Number.isFinite(odd)||odd<=1)return;
          slip=slip.filter(x=>String(x.gameId)!==String(s.gameId));
          slip.push({id:String(s.gameId)+'|repeat|'+String(s.coefId||s.selection),gameId:s.gameId,gameApiId:s.gameApiId||'',key:String(s.coefId||s.selection),odd,currentOdd:odd,coefId:s.coefId||'',marketId:s.marketId||'',market:s.market||'Market',marketType:'detail',specialValue:s.specialValue||'',oddsChanged:false,invalid:false,league:s.league||'',home:s.home||'',away:s.away||'',eventTime:s.eventTime||''});
        });
        renderSlip();$('betslip').classList.add('mobile-open');
      });
    }
    if(user.role==='user')loadWallet();
  }catch(e){if(silent||requestId!==myBetsLoadSequence||$('betsList')!==list)return;list.innerHTML=`<div class="mybetsEmpty error">${esc(e.message||'Nuk u ngarkuan bastet.')}</div>`}
}
async function loadWallet(){
  try{const r=await sessionFetch('/api/wallet',{headers:{Authorization:'Bearer '+token}}),d=await SportsbookApi.readJson(r);if(!$('walletList'))return;
    $('walletList').innerHTML=(d.transactions||[]).map(t=>`<div class="tx"><span>${esc(t.type)} · ${new Date(String(t.createdAt).replace(' ','T')+'Z').toLocaleString('sq-AL')}</span><span class="${Number(t.amount)>=0?'credit':'debit'}">${Number(t.amount)>=0?'+':''}€${Number(t.amount||0).toFixed(2)}</span></div>`).join('')||'<div class="noBets">Nuk ka transaksione.</div>';
  }catch(_){}
}

let lastBetRequest=null;
async function placeBet(){
  if(slipLimitNotice||pendingTicket)return;
  if(!slip.length)return;if(!user){openAuth('login');return}
  const placeBtn=$('place');if(placeBtn?.dataset.busy==='1')return;
  if(slip.some(p=>p.oddsChanged)){const amount=Number($('stake').value);if(!Number.isFinite(amount)||amount<.01){showSlipMessage('Vendos një shumë të vlefshme.');return;}oddsConfirmationRequested=true;renderOddsAcceptance();return;}
  // Do not re-read the browser cache immediately before submission. The source
  // Bet Slip submits the coefficient captured at click time. Live/feed validation
  // is authoritative on the server and any invalid selection is returned there.
  if(slip.some(x=>!Number.isFinite(Number(x.odd))||Number(x.odd)<=1)){renderSlip();return}
  const stake=Number($('stake').value);if(!Number.isFinite(stake)||stake<.01){showSlipMessage('Vendos një shumë të vlefshme.');return}
  if(placeBtn){placeBtn.dataset.busy='1';placeBtn.disabled=true;placeBtn.setAttribute('aria-busy','true');}
  renderOddsAcceptance();
  const requestBody=JSON.stringify({stake,selections:slip.map(p=>({gameId:p.gameId,gameApiId:p.gameApiId||'',league:p.league,home:p.home,away:p.away,market:p.market||'Fulltime Result',marketType:p.marketType||'',marketId:p.marketId||'',specialValue:p.specialValue||'',selection:p.key,coefId:p.coefId,odd:p.odd,eventTime:p.eventTime}))});
  if(!lastBetRequest||lastBetRequest.body!==requestBody)lastBetRequest={body:requestBody,key:crypto.randomUUID()};
  try{const r=await sessionFetch('/api/bets',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'Idempotency-Key':lastBetRequest.key},body:requestBody});const d=await SportsbookApi.readJson(r);if(!r.ok){if(d.code==='BET_LIMIT_EXCEEDED'&&Number.isFinite(d.limitAmount)){showSlipLimit(d.limitAmount,d.limitKind);return;}if(Array.isArray(d.invalidSelections)){for(const inv of d.invalidSelections){const p=slip.find(x=>String(x.gameId)===String(inv.gameId)&&(inv.coefId?String(x.coefId)===String(inv.coefId):String(x.key)===String(inv.selection)));if(p){p.invalid=true;p.invalidReason=inv.reason||'Koeficienti nuk është më aktiv.'}}}if(Array.isArray(d.oddsChanged)){for(const ch of d.oddsChanged){const p=slip.find(x=>String(x.gameId)===String(ch.gameId)&&(ch.coefId?String(x.coefId)===String(ch.coefId):String(x.key)===String(ch.selection)));if(p){p.previousOdd=Number(p.odd);p.odd=Number(ch.newOdd);p.currentOdd=Number(ch.newOdd);p.serverQuoted=true;p.oddsChanged=true;p.invalid=false;p.invalidReason=''}}}if(d.oddsChanged?.length&&!d.invalidSelections?.length)oddsConfirmationRequested=true;renderSlip();if(d.oddsChanged?.length&&!d.invalidSelections?.length)return;throw Error(d.error||'Koeficienti u përditësua. Luaje bastin përsëri me vlerën e re.')}lastBetRequest=null;user.balance=d.balance;user.reservedBalance=d.reservedBalance||0;pendingTicket=d.status==='accepted'?null:{id:d.betId,stake,odds:d.totalOdds,selections:slip.map(p=>({...p}))};slip=[];$('stake').value='';setAuthState(user);renderSlip();if(d.status==='accepted')showSlipMessage(`Biletë #${d.betId} u pranua automatikisht.`,'ok');if(d.status!=='accepted')pollPendingTicket(d.betId)}catch(e){showSlipMessage(e.message)}finally{if(placeBtn){placeBtn.dataset.busy='0';placeBtn.disabled=false;placeBtn.removeAttribute('aria-busy');}renderOddsAcceptance();}
}

let pendingPoll=null;async function pollPendingTicket(id){if(pendingPoll)clearInterval(pendingPoll);const check=async()=>{if(!user||!pendingTicket||pendingTicket.id!==id)return;try{const r=await sessionFetch('/api/my-bets/'+id,{headers:{Authorization:'Bearer '+token}});if(!r.ok)return;const d=await SportsbookApi.readJson(r),st=d.bet.status;if(st==='pending'){pendingTicket.stake=d.bet.stake;pendingTicket.selections=(d.bet.selections||[]).map(s=>({...s,home:s.home_team||s.home,away:s.away_team||s.away,key:s.selection,market:s.market}));const previousOffer=!!pendingTicket.offer;pendingTicket.offer=d.bet.offer||null;if(previousOffer!==!!pendingTicket.offer||pendingTicket.offer)renderSlip();return}pendingTicket=null;if(st==='accepted'||st==='cancelled'){const mr=await fetch('/api/me',{headers:{Authorization:'Bearer '+token}});if(mr.ok)user=(await SportsbookApi.readJson(mr)).user;setAuthState(user)}renderSlip();showSlipMessage(st==='accepted'?`Biletë #${id} u pranua nga Qendra.`:`Biletë #${id} u anulua nga Qendra.`,st==='accepted'?'ok':'error');clearInterval(pendingPoll);pendingPoll=null}catch(_){}};await check();pendingPoll=setInterval(check,2500)}
async function restoreUserPendingTicket(){if(!user||user.role!=='user'||pendingTicket)return;try{const r=await sessionFetch('/api/my-bets?status=pending',{headers:{Authorization:'Bearer '+token}});if(!r.ok)return;const d=await SportsbookApi.readJson(r),bet=(d.bets||[]).find(x=>x.status==='pending');if(!bet)return;pendingTicket={id:bet.id,stake:bet.stake,selections:bet.selections||[],offer:null};renderSlip();pollPendingTicket(bet.id)}catch(_){}}

async function controlFetch(url,opt={}){opt.headers={...(opt.headers||{}),Authorization:'Bearer '+token,'Content-Type':'application/json'};if(opt.method==='POST'&&/\/(credit|balance)$/.test(url)&&!opt.headers['Idempotency-Key'])opt.headers['Idempotency-Key']=crypto.randomUUID();const r=await sessionFetch(url,opt);const d=await SportsbookApi.readJson(r);if(!r.ok)throw Error(d.error||'Request failed');return d}
let controlPoll=null;function closeControlPoll(){if(controlPoll){clearInterval(controlPoll);controlPoll=null}}
// Center has one dedicated workspace; legacy calls use the same destination.
function hideCenterDashboard(){document.getElementById('centerDashboard')?.remove();}
function showCenterDashboard(){if(user?.role==='center')location.replace('/backoffice.html#/dashboard');}

async function handleStaffAction(action){
  if(action==='logout'){await logout();return}
  if(action==='chat'){alert('Chat do të lidhet me modulin e komunikimit.');return}
  if(action==='rules'){alert('Rregullorja e platformës.');return}
  if(action==='directory'){openControl(user.role,'directory');return}
  if(action==='finance'){if(user.role==='center')return;openControl(user.role,'finance');return}
  if(action==='tickets'){openControl(user.role,'tickets');return}
  if(action==='password'){openControl(user.role,'password');return}
  if(action.startsWith('create:')){openControl(user.role,'create',action.split(':')[1]);return}
}
async function openControl(role,view='directory',createRole=''){
  if(!user)return;
  if(view==='password'){
    closeControlPoll();
    $('controlModal').classList.add('show');
    $('controlTitle').textContent='Ndrysho Fjalëkalimin';
    renderOwnPasswordForm();
    return;
  }
  if(user.role==='user')return;
  if(['partner','admin'].includes(user?.role)){location.replace('/backoffice.html#/'+({directory:'accounts',password:'security/password',tickets:'bets',transactions:'finance'}[view]||'accounts'));return;}
  $('controlModal').classList.add('show');
  $('controlTitle').textContent=staffRoleLabel(role);
  closeControlPoll();
  if(view==='tickets'){await renderOperatorControl();controlPoll=setInterval(()=>renderOperatorControl(true),2500);return}
  await renderManagementView(view,createRole);
}
function renderOwnPasswordForm(){
  $('controlApp').innerHTML=`<div class="controlSection"><h3>Ndrysho Fjalëkalimin</h3><form id="passwordForm" class="controlForm"><label>Fjalëkalimi i vjetër<input id="oldPass" type="password" autocomplete="current-password" required></label><label>Fjalëkalimi i ri<input id="newPass" type="password" autocomplete="new-password" minlength="6" required></label><label>Përsërit fjalëkalimin e ri<input id="newPass2" type="password" autocomplete="new-password" minlength="6" required></label><button id="saveOwnPassword" type="submit">Ruaj</button></form><div id="controlMsg" class="controlMsg" role="status" aria-live="polite"></div></div>`;
  const form=$('passwordForm'),button=$('saveOwnPassword'),message=$('controlMsg');
  form.onsubmit=async e=>{
    e.preventDefault();if(button.disabled)return;
    message.className='controlMsg error';
    if(!$('oldPass').value){message.textContent='Vendos fjalëkalimin e vjetër.';return;}
    if($('newPass').value.length<6){message.textContent='Fjalëkalimi i ri duhet të ketë të paktën 6 karaktere.';return;}
    if($('newPass').value!==$('newPass2').value){message.textContent='Fjalëkalimet e reja nuk përputhen.';return;}
    button.disabled=true;message.textContent='Duke ruajtur…';
    try{
      await controlFetch('/api/staff/password',{method:'POST',body:JSON.stringify({oldPassword:$('oldPass').value,newPassword:$('newPass').value})});
      form.reset();message.textContent='Fjalëkalimi u ruajt me sukses.';message.className='controlMsg ok';
    }catch(err){message.textContent=err.message;message.className='controlMsg error';}
    finally{button.disabled=false;}
  };
}
function roleVisibleLabel(role){return ({center:'Qendra',operator:'Operator',partner:'Partner',admin:'Administrator',senior:'Senior',manager:'Manager',supermanager:'Senior (legacy)',agent:'Agjent',user:'User'})[role]||role}
function hideAdminWorkspace(){document.getElementById('adminWorkspace')?.remove()}
function showAdminWorkspace(){if(user&&['partner','admin'].includes(user.role))location.replace('/backoffice.html#/accounts');}
async function renderManagementView(view,createRole=''){
  if(view==='password'){renderOwnPasswordForm();return;}
  try{
    const d=await controlFetch('/api/staff/overview');
    if(view==='directory'){
      if(user.role==='admin'){
        const all=await controlFetch('/api/admin/users');
        $('controlApp').innerHTML=`<div class="controlTabs"><button class="active">Users</button></div><div class="controlSection"><h3>Users në hierarkinë tënde</h3><div class="cc-table-wrap"><table class="controlTable"><thead><tr><th>User</th><th>Roli</th><th>Kredi</th><th>Status</th><th>Veprime</th></tr></thead><tbody>${all.users.map(x=>`<tr><td><b>${esc(x.username)}</b><br><small>#${x.id}</small></td><td>${esc(x.role)}</td><td>€${Number(x.balance).toFixed(2)}<div class="rowCredit"><input data-admin-amount="${x.id}" type="number" min="0.01" step="0.01" placeholder="Shuma"></div></td><td>${esc(x.status)}</td><td><div class="ticketActions"><button data-admin-action="credit" data-id="${x.id}">+ Kredit</button><button class="lost" data-admin-action="debit" data-id="${x.id}">− Tërhiq</button><button class="cancel" data-admin-action="status" data-id="${x.id}" data-status="${x.status}">${x.status==='active'?'Blloko':'Aktivizo'}</button><button data-admin-action="password" data-id="${x.id}">Password</button><button data-admin-action="bets" data-id="${x.id}" data-name="${esc(x.username)}">Biletat</button></div></td></tr>`).join('')}</tbody></table></div><div id="adminUsersMsg" class="controlMsg"></div></div>`;
        document.querySelectorAll('[data-admin-action]').forEach(b=>b.onclick=async()=>{const id=b.dataset.id,action=b.dataset.adminAction,msg=$('adminUsersMsg');try{if(action==='bets'){const r=await controlFetch('/api/admin/users/'+id+'/bets');msg.innerHTML=`<b>Biletat e ${esc(b.dataset.name)}:</b><br>${r.bets.length?r.bets.map(x=>`#${x.id} · €${Number(x.stake).toFixed(2)} · ${esc(x.status)} · ${Number(x.total_odds).toFixed(2)}`).join('<br>'):'Nuk ka bileta.'}`;return}if(action==='password'){const password=prompt('Password i ri (minimum 6 karaktere):');if(!password)return;await controlFetch('/api/admin/users/'+id+'/password',{method:'POST',body:JSON.stringify({password})})}else if(action==='status')await controlFetch('/api/admin/users/'+id+'/status',{method:'POST',body:JSON.stringify({status:b.dataset.status==='active'?'blocked':'active'})});else{const amount=document.querySelector(`[data-admin-amount="${id}"]`).value;await controlFetch('/api/admin/users/'+id+'/balance',{method:'POST',body:JSON.stringify({amount,direction:action})})}await renderManagementView('directory')}catch(e){msg.textContent=e.message;msg.className='controlMsg error'}});return;
      }
      const title=({center:'Operatorët, Partnerët dhe Seniorët',operator:'Hierarkia e platformës',partner:'Administratorët e mi',admin:'Aktiviteti i administratorit',senior:'Managerët e mi',supermanager:'Managerët e mi',manager:'Agjentët e mi',agent:'User-at e mi'}[user.role]||'Llogaritë e mia');
      const creditCard=user.role==='center'?['Status','UNLIMITED']:['Credit','€'+formatCredit(user.balance)];
      const canFundRow = x => x.status==='active' && ((user.role==='center') || (user.role==='partner' && x.role==='admin') || ((user.role==='senior'||user.role==='supermanager') && x.role==='manager') || (user.role==='manager' && x.role==='agent') || (user.role==='agent' && x.role==='user'));
      $('controlApp').innerHTML=`<div class="controlTabs"><button class="active">Lista e Përdoruesve</button></div><div class="controlGrid">${[['Roli',roleVisibleLabel(user.role)],creditCard,['Llogari',d.accounts.length],['Bileta në pritje',d.pendingTickets]].map(x=>`<div class="controlCard"><small>${x[0]}</small><b>${x[1]}</b></div>`).join('')}</div><div class="controlSection"><h3>${title}</h3>${d.accounts.length?`<table class="controlTable"><thead><tr><th>ID</th><th>Username</th><th>Role</th><th>Credit</th><th>Status</th><th>Veprimi</th></tr></thead><tbody>${d.accounts.map(x=>`<tr><td>${x.id}</td><td>${esc(x.username)}</td><td><span class="roleBadge">${esc(x.role)}</span></td><td class="listBalance">€${Number(x.balance).toFixed(2)}</td><td>${esc(x.status)}</td><td>${canFundRow(x)?`<div class="rowCredit"><input data-list-credit-amount="${x.id}" type="number" min="0.01" step="0.01" placeholder="Shuma"><button class="controlBtn" data-list-credit="${x.id}">Shto kredit</button></div>`:'<span style="color:#888;font-size:11px">—</span>'}</td></tr>`).join('')}</tbody></table>`:'<div class="noBets">Nuk ka llogari.</div>'}<div id="directoryMsg" class="controlMsg"></div></div>`;
      document.querySelectorAll('[data-list-credit]').forEach(b=>b.onclick=async()=>{const id=b.dataset.listCredit,field=document.querySelector(`[data-list-credit-amount="${id}"]`),amount=field?field.value:'';try{await controlFetch('/api/staff/'+id+'/credit',{method:'POST',body:JSON.stringify({amount,direction:'credit'})});$('directoryMsg').textContent='Krediti u shtua me sukses.';$('directoryMsg').className='controlMsg ok';if(field)field.value='';const nd=await controlFetch('/api/staff/overview');const target=nd.accounts.find(a=>Number(a.id)===Number(id));const me=(await fetch('/api/me',{headers:{Authorization:'Bearer '+token}}).then(r=>SportsbookApi.readJson(r))).user;setAuthState(me);await renderManagementView('directory');}catch(e){$('directoryMsg').textContent=e.message;$('directoryMsg').className='controlMsg error';}});
      return;
    }
    if(view==='create'){
      const valid=staffCreateRoles(user.role).find(x=>x[0]===createRole);
      if(!valid){$('controlApp').innerHTML='<div class="controlSection">Kjo llogari nuk mund të krijohet nga ky rol.</div>';return}
      $('controlApp').innerHTML=`<div class="controlTabs"><button class="active">Krijo ${esc(valid[1])}</button></div><div class="controlSection"><h3>Krijo ${esc(valid[1])}</h3><form id="createChild" class="controlForm"><input id="childUser" placeholder="Username" required><input id="childPass" type="password" placeholder="Password" required><input value="${esc(valid[1])}" disabled><button>Krijo</button></form><div id="controlMsg" class="controlMsg"></div></div>`;
      $('createChild').onsubmit=async e=>{e.preventDefault();try{const endpoint=({partner:'/api/partner/admins',admin:'/api/admin/seniors',senior:'/api/senior/managers',supermanager:'/api/senior/managers',manager:'/api/manager/agents',agent:'/api/agent/users'})[user.role];if(!endpoint)throw Error('Ky rol nuk krijon llogari të reja.');await controlFetch(endpoint,{method:'POST',body:JSON.stringify({username:$('childUser').value,password:$('childPass').value})});$('controlMsg').textContent='Account u krijua me sukses.';$('controlMsg').className='controlMsg ok';await renderManagementView('directory')}catch(e){$('controlMsg').textContent=e.message;$('controlMsg').className='controlMsg error'}};
      return;
    }
    if(view==='finance'){
      $('controlApp').innerHTML=`<div class="controlTabs"><button class="active">Financa</button></div><div class="controlSection"><h3>Transferim krediti</h3><p style="color:#666;font-size:12px;margin-top:0">Ky ekran lejon vetëm transferim sipas hierarkisë së platformës.</p>${d.fundTargets.length?`<table class="controlTable"><thead><tr><th>Username</th><th>Role</th><th>Credit</th><th>Veprimi</th></tr></thead><tbody>${d.fundTargets.map(x=>`<tr><td>${esc(x.username)}</td><td>${esc(x.role)}</td><td>€${Number(x.balance).toFixed(2)}</td><td><div style="display:flex;gap:5px;align-items:center"><input data-fin-amount="${x.id}" type="number" min="0.01" step="0.01" placeholder="Shuma" style="width:90px;height:32px"><button class="controlBtn" data-fin="${x.id}" data-dir="credit">Shto</button><button class="controlBtn gray" data-fin="${x.id}" data-dir="debit">Merr</button></div></td></tr>`).join('')}</tbody></table>`:'<div class="noBets">Nuk ka llogari që mund të financohen.</div>'}<div id="financeMsg" class="controlMsg"></div></div>`;
      document.querySelectorAll('[data-fin]').forEach(b=>b.onclick=async()=>{const id=b.dataset.fin,amount=document.querySelector(`[data-fin-amount="${id}"]`).value;try{await controlFetch('/api/staff/'+id+'/credit',{method:'POST',body:JSON.stringify({amount,direction:b.dataset.dir})});$('financeMsg').textContent='Transferimi u krye.';$('financeMsg').className='controlMsg ok';setAuthState({...user,balance:(await fetch('/api/me',{headers:{Authorization:'Bearer '+token}}).then(r=>SportsbookApi.readJson(r))).user.balance});await renderManagementView('finance');}catch(e){$('financeMsg').textContent=e.message;$('financeMsg').className='controlMsg error'}});
      return;
    }
  }catch(e){$('controlApp').innerHTML=`<div class="controlSection controlMsg error">${esc(e.message)}</div>`}
}
// Mobile keyboards shrink/pan the visual viewport without resizing the layout.
// Keep the stake footer above the keyboard; only the selections list shrinks.
function syncMobileSlipViewport(){
  const panel=$('betslip');
  if(window.innerWidth>1100){
    panel.style.removeProperty('--mobile-slip-height');
    panel.style.removeProperty('--mobile-slip-top');
    return;
  }
  const viewport=window.visualViewport;
  const visibleHeight=viewport?viewport.height:window.innerHeight;
  // Measure natural content, not the list stretched by the previous panel height.
  panel.style.removeProperty('--mobile-slip-height');
  panel.style.removeProperty('--mobile-slip-top');
  if(panel.getClientRects&&panel.getClientRects().length===0)return;
  const contentHeight=['.sliphead','.slipModeTabs','.slipbody','.betfooter'].reduce((total,selector)=>total+(panel.querySelector?.(selector)?.scrollHeight||0),0);
  const height=Math.min(contentHeight||visibleHeight*.86,visibleHeight*.86);
  panel.style.setProperty('--mobile-slip-height',height+'px');
  panel.style.setProperty('--mobile-slip-top',((viewport?.offsetTop||0)+visibleHeight-height)+'px');
}
window.visualViewport?.addEventListener('resize',syncMobileSlipViewport);
window.visualViewport?.addEventListener('scroll',syncMobileSlipViewport);
window.addEventListener('resize',syncMobileSlipViewport);
$('mobileSlipBar').addEventListener('click',()=>requestAnimationFrame(syncMobileSlipViewport));
$('stake').addEventListener('focus',syncMobileSlipViewport);
syncMobileSlipViewport();
function ticketTable(tickets){const pending=tickets.filter(b=>b.status==='pending');return `<div class="controlSection"><h3>Biletat në pritje</h3>${pending.length?`<table class="controlTable"><thead><tr><th># / Koha</th><th>User</th><th>Seleksionet dhe oferta e koeficientit</th><th>Luajtur</th><th>Odds</th><th>Fitimi i mundshëm</th><th>Veprime</th></tr></thead><tbody>${pending.map(b=>{const placed=b.created_at?new Date(String(b.created_at).replace(' ','T')+'Z').toLocaleString('sq-AL',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';return `<tr class="ticketPending"><td><b>#${b.id}</b><div class="ticketDetails">${esc(placed)}</div></td><td><b>${esc(b.username||'')}</b><div class="ticketDetails">${esc(b.agent_username||'')}</div></td><td>${b.selections.map(s=>`<div class="ticketDetails"><b>${esc(s.home)} - ${esc(s.away)}</b><br>${esc(s.market||'Market')} · ${esc(s.selection)}<br><label>Koeficienti: <input data-offer-odd="${s.id}" type="number" min="1.01" max="${Number(s.odd)}" step="0.01" value="${Number(s.odd).toFixed(2)}" style="width:64px"></label></div>`).join('<hr style="border:0;border-top:1px solid #ddd">')}</td><td>€${Number(b.stake).toFixed(2)}</td><td>${Number(b.total_odds).toFixed(2)}</td><td><b>€${Number(b.potential_win).toFixed(2)}</b></td><td><div class="ticketActions"><button class="lost" data-ticket-action="offer" data-ticket="${b.id}">Ruaj ofertën</button><button data-ticket-action="accept" data-ticket="${b.id}">Prano</button><button class="cancel" data-ticket-action="cancel" data-ticket="${b.id}">Refuzo</button></div></td></tr>`}).join('')}</tbody></table>`:'<div class="noBets">Nuk ka bileta në pritje.</div>'}</div>`}
async function renderOperatorControl(silent=false){const d=await controlFetch('/api/operator/tickets?status=pending');$('controlApp').innerHTML=`<div class="controlTabs"><button class="active">Biletat në pritje</button><span style="margin-left:auto;padding:10px;color:#666">${d.tickets.length} në pritje</span></div>${ticketTable(d.tickets)}`;document.querySelectorAll('[data-ticket-action]').forEach(b=>b.onclick=async()=>{const id=b.dataset.ticket,action=b.dataset.ticketAction;try{if(action==='accept')await controlFetch('/api/operator/tickets/'+id+'/accept',{method:'POST'});else if(action==='cancel')await controlFetch('/api/operator/tickets/'+id+'/cancel',{method:'POST'});else{const row=b.closest('tr'),offers=[...row.querySelectorAll('[data-offer-odd]')].map(x=>({id:x.dataset.offerOdd,odd:x.value}));await controlFetch('/api/operator/tickets/'+id+'/offer',{method:'POST',body:JSON.stringify({offers})})}await renderOperatorControl()}catch(e){alert(e.message)}})}
function closeControlPoll(){if(controlPoll){clearInterval(controlPoll);controlPoll=null}}

$('authForm').onsubmit=authSubmit;$('slipTab').onclick=()=>{if(user&&user.role!=='user')toggleStaffMenu(true);else showMyBets(false)};$('myTopBtn').onclick=()=>{if(user)showMyBets(true);else openAuth()};$('place').onclick=placeBet;$('stake').oninput=updatePotential;$('mobileSlipBar').onclick=()=>{if(slip.length||pendingTicket){$('betslip').classList.add('mobile-open');$('mobileSlipBackdrop').classList.add('show')}};$('slipClose').onclick=()=>{$('betslip').classList.remove('mobile-open');$('mobileSlipBackdrop').classList.remove('show')};$('mobileSlipBackdrop').onclick=()=>{$('betslip').classList.remove('mobile-open');$('mobileSlipBackdrop').classList.remove('show')};document.querySelectorAll('[data-stake]').forEach(b=>b.onclick=()=>{$('stake').value=b.dataset.stake;updatePotential()});$('search').oninput=e=>setEventSearch(e.target.value);$('leagueFilter').onchange=e=>{activeLeague=e.target.value;render(cache,false)};$('homeBtn').onclick=openSportsHome;$('liveBtn').onclick=()=>setMode('live');document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{const id=b.dataset.close;$(id).classList.remove('show');if(id==='controlModal')closeControlPoll()});document.addEventListener('click',e=>{const menu=$('userMenu'),avatar=$('userAvatar');if(menu&&!menu.contains(e.target)&&e.target!==avatar)hideUserMenu()});document.addEventListener('keydown',e=>{if(e.key==='Escape')hideUserMenu()});
setAuthState(user);window.addEventListener('hashchange',()=>{const target=modeFromHash();if(target==='mybets'&&!user){if(token){restore().then(()=>{if(modeFromHash()!=='mybets')return;if(user)showMyBets(true,{fromHash:true});else{setHashForMode('home');setMode('home',{fromHash:true});openAuth()}})}else{setHashForMode('home');setMode('home',{fromHash:true});openAuth()}return}setMode(target,{fromHash:true})});window.addEventListener('popstate',()=>window.dispatchEvent(new HashChangeEvent('hashchange')));const initialMode=modeFromHash();if(initialMode==='mybets'){if(token){restore().then(()=>{if(modeFromHash()!=='mybets')return;if(user)showMyBets(true,{fromHash:true});else{setHashForMode('home');setMode('home',{fromHash:true});openAuth()}})}else{setHashForMode('home');setMode('home',{fromHash:true});openAuth()}}else{setMode(initialMode,{fromHash:true});restore()}renderSlip();

document.querySelector('[data-sidebar-live]').addEventListener('click',()=>setMode('live'));

document.querySelector("[data-sidebar-sport]").addEventListener("click",openSportsHome);
