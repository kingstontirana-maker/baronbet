'use strict';
// One codebase, several brands. BRAND (env) picks the name, logo and colour theme served to
// players and staff; each brand runs as its own deployment with its own database. The
// default brand is served exactly as the files are written.
const fs=require('fs'),path=require('path');
// hue: the brand's main colour in degrees. Stylesheets are written in the default green;
// every green tone is moved to this hue at the same perceived brightness (see recolorCss).
const BRANDS={
  baronbet:{name:'Baronbet',console:'EURO97'},
  escobet:{name:'EscoBet',console:'EscoBet',hue:216,mark:{symbol:'EB',text:'ESCO',accent:'BET'},
    // The player header crops the Baronbet wordmark with fixed offsets; this one is already tight.
    siteCss:'.brand-wordmark{width:230px;height:48px}.brand-wordmark img{position:static;left:auto;top:auto;width:100%;height:100%;object-fit:contain;object-position:left center}'}
};
// The backoffice sidebar draws the default brand as "97" in a badge and "EURO" + accent "97".
const CONSOLE_MARK='<span class="brand-symbol">97<span>●</span></span><span>EURO<span class="brand-number">97</span>';
const SITE_CSS='euro07.bet/vbet/user/build/main.css';
// The pages and stylesheets reference the default brand's logo files by these paths.
const LOGOS={'/assets/brand/baronbet.png':'wordmark','/assets/brand/bb.png':'monogram'};
const PAGES={'/':'index.html','/index.html':'index.html','/backoffice.html':'backoffice.html','/backoffice.js':'backoffice.js'};

// ---- Colour theme ----
const GREEN={from:80,to:185,centre:160},MIN_SATURATION=0.08;
function rgbToHsl(r,g,b){
  r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2,d=max-min;
  if(!d)return [0,0,l];
  const s=d/(1-Math.abs(2*l-1));
  const h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;
  return [(h*60+360)%360,s,l];
}
function hslToRgb(h,s,l){
  const c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2;
  const [r,g,b]=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
  return [r,g,b].map(v=>Math.round((v+m)*255));
}
// WCAG relative luminance: equal luminance means equal contrast against any background.
function luminance(r,g,b){const f=v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);}
// Moves a green tone to the brand hue, keeping its saturation and its luminance (so text and
// buttons keep exactly the contrast of the original design). Other colours are returned as is.
function shiftColor(r,g,b,hue){
  const [h,s]=rgbToHsl(r,g,b);
  if(s<MIN_SATURATION||h<GREEN.from||h>GREEN.to)return [r,g,b];
  const target=luminance(r,g,b),nh=(hue+(h-GREEN.centre)*0.35+360)%360;
  let lo=0,hi=1;
  for(let i=0;i<30;i++){const mid=(lo+hi)/2;if(luminance(...hslToRgb(nh,s,mid))<target)lo=mid;else hi=mid;}
  return hslToRgb(nh,s,(lo+hi)/2);
}
const hex=n=>n.toString(16).padStart(2,'0');
function recolorValue(value,hue){
  return value
    .replace(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/gi,(m,h)=>{
      // #rgb, #rgba, #rrggbb and #rrggbbaa; the alpha channel is kept as written.
      const full=h.length<=4?h.replace(/./g,c=>c+c):h,[r,g,b]=[0,2,4].map(i=>parseInt(full.slice(i,i+2),16));
      const out=shiftColor(r,g,b,hue);return out.every((v,i)=>v===[r,g,b][i])?m:'#'+out.map(hex).join('')+full.slice(6);
    })
    .replace(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(\s*,\s*[\d.]+%?)?\s*\)/gi,(m,r,g,b,a)=>{
      const out=shiftColor(+r,+g,+b,hue);return out.every((v,i)=>v===[+r,+g,+b][i])?m:(a?'rgba(':'rgb(')+out.join(',')+(a||'')+')';
    });
}
// Only declaration values are touched (text after ':' that ends in ';' or '}'), never
// selectors: an id such as #add must not be mistaken for a colour.
function recolorCss(css,hue){return css.replace(/:([^;{}]*)(?=[;}])/g,(m,value)=>':'+recolorValue(value,hue));}

function createBrand(key,publicDir){
  const id=Object.hasOwn(BRANDS,key)?key:'baronbet',brand=BRANDS[id];
  const cache=new Map();
  function logoFile(kind){
    for(const ext of ['png','webp','svg']){const file=path.join(publicDir,'assets','brand',id,kind+'.'+ext);if(fs.existsSync(file))return file;}
    return null;
  }
  function read(file,transform){
    if(!cache.has(file))cache.set(file,transform(fs.readFileSync(path.join(publicDir,file),'utf8')));
    return cache.get(file);
  }
  const mark=brand.mark?`<span class="brand-symbol">${brand.mark.symbol}<span>●</span></span><span>${brand.mark.text}<span class="brand-number">${brand.mark.accent}</span>`:CONSOLE_MARK;
  const rename=text=>text.split(CONSOLE_MARK).join(mark).replace(/Baronbet/g,brand.name).replace(/BARONBET/g,brand.name.toUpperCase()).replace(/EURO97/g,brand.console);
  function middleware(req,res,next){
    if(id==='baronbet'||(req.method!=='GET'&&req.method!=='HEAD'))return next();
    if(LOGOS[req.path]){const file=logoFile(LOGOS[req.path]);return file?res.sendFile(file):next();}
    if(PAGES[req.path])return res.type(path.extname(PAGES[req.path])).send(read(PAGES[req.path],rename));
    if(brand.hue!=null&&req.path.endsWith('.css')){
      const file=path.normalize(decodeURIComponent(req.path)).replace(/^[\\/]+/,'');
      if(file.startsWith('..')||!fs.existsSync(path.join(publicDir,file)))return next();
      const extra=brand.siteCss&&file.replace(/\\/g,'/')===SITE_CSS?'\n'+brand.siteCss+'\n':'';
      return res.type('css').send(read(file,css=>recolorCss(css,brand.hue)+extra));
    }
    next();
  }
  return {id,name:brand.name,middleware};
}
module.exports={createBrand,BRANDS,recolorCss,shiftColor,luminance};
