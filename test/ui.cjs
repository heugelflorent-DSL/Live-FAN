const {JSDOM}=require('jsdom');const fs=require('fs');const fx=require('./fixture.cjs');
const html=fs.readFileSync(__dirname+'/../public/index.html','utf8');
const d=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,url:'https://live-fan.test/',beforeParse(w){
  w.scrollTo=()=>{};w.fetch=async(u,o={})=>{const ok=(b)=>({ok:true,status:200,json:async()=>b});
    if(u==='/api/state')return ok({published:true,config:fx.config,data:fx.data,now:Date.now()});
    if((o.headers||{})['x-admin-key']!=='pw')return{ok:false,status:401,json:async()=>({error:'Mot de passe incorrect.'})};
    if(u==='/api/admin/state')return ok({config:fx.config,data:fx.data});
    if(u==='/api/config'){w.__saved=JSON.parse(o.body);return ok({ok:true})}
    return ok({ok:true,queue:0,remaining:0,total:0});}}});
const w=d.window,q=s=>w.document.querySelector(s),qa=s=>[...w.document.querySelectorAll(s)];
const errs=[],bad=[];w.addEventListener('error',e=>errs.push(e.message));
const tick=()=>new Promise(r=>setTimeout(r,50));
function check(tag){const t=q('main').textContent+q('header').textContent;for(const b of ['undefined','NaN','null','[object','${'])if(t.includes(b))bad.push(tag+': '+b+' … '+t.slice(Math.max(0,t.indexOf(b)-60),t.indexOf(b)+20).replace(/\s+/g,' '))}
(async()=>{await tick();await tick();
  for(const v of ['home','prog','res','pod','rank','part']){const b=q('[data-view='+v+']');if(!b||b.hidden){console.log('hidden',v);continue}b.click();
    qa('#pub-body [data-open]').map(x=>x.dataset.open).slice(0,6).forEach(k=>{const e=q('[data-open="'+k+'"]');e&&e.click()});
    qa('#pub-body [data-sp]').slice(0,2).forEach(x=>x.click());qa('[data-rsex]').forEach(x=>x.click());
    const s=q('#pub-body [data-swimmer]');s&&s.click();check(v);console.log(v,q('#pub-body').textContent.replace(/\s+/g,' ').slice(0,160))}
  q('#admin-btn').click();await tick();q('#login-pw').value='bad';q('#login-form').dispatchEvent(new w.Event('submit'));await tick();console.log('login bad:',q('#login-msg').textContent);
  q('#login-pw').value='pw';q('#login-form').dispatchEvent(new w.Event('submit'));await tick();await tick();check('admin');
  console.log('admin order items',qa('.item').length,'h2',q('#h2').textContent,'| kpis',q('#dash-kpis').textContent.replace(/\s+/g,' '));
  q('[data-addpause="1"]').click();await new Promise(r=>setTimeout(r,900));console.log('saved lines',JSON.stringify(w.__saved&&w.__saved.lines));
  console.log('errors',errs);console.log('bad',bad.slice(0,10));w.close();
})();
