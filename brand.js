'use strict';
// One codebase, several brands. BRAND (env) picks the name and logo served to players and
// staff; each brand runs as its own deployment with its own database. The default brand
// is served exactly as the files are written.
const fs=require('fs'),path=require('path');
const BRANDS={
  baronbet:{name:'Baronbet',console:'EURO97'},
  escobet:{name:'EscoBet',console:'EscoBet'}
};
// The pages and stylesheets reference the default brand's logo files by these paths.
const LOGOS={'/assets/brand/baronbet.png':'wordmark','/assets/brand/bb.png':'monogram'};
const PAGES={'/':'index.html','/index.html':'index.html','/backoffice.html':'backoffice.html','/backoffice.js':'backoffice.js'};

function createBrand(key,publicDir){
  const id=Object.hasOwn(BRANDS,key)?key:'baronbet',brand=BRANDS[id];
  const pages=new Map();
  function logoFile(kind){
    for(const ext of ['png','svg']){const file=path.join(publicDir,'assets','brand',id,kind+'.'+ext);if(fs.existsSync(file))return file;}
    return null;
  }
  function page(file){
    if(!pages.has(file)){
      const text=fs.readFileSync(path.join(publicDir,file),'utf8').replace(/Baronbet/g,brand.name).replace(/BARONBET/g,brand.name.toUpperCase()).replace(/EURO97/g,brand.console);
      pages.set(file,text);
    }
    return pages.get(file);
  }
  function middleware(req,res,next){
    if(id==='baronbet'||(req.method!=='GET'&&req.method!=='HEAD'))return next();
    if(LOGOS[req.path]){const file=logoFile(LOGOS[req.path]);return file?res.sendFile(file):next();}
    const file=PAGES[req.path];
    if(!file)return next();
    res.type(path.extname(file)).send(page(file));
  }
  return {id,name:brand.name,middleware};
}
module.exports={createBrand,BRANDS};
