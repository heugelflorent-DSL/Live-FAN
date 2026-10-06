// Données de test au format produit par le scraper (src/ffn.js)
const clubs=["DAUPHINS DE ST-LOUIS","SR COLMAR","THANN OLYMPIC N"];
function sw(i,sex){return{name:`NAGEUR${i} ${sex==="F"?"Léa":"Hugo"}`,year:String(2012+i%3),club:clubs[i%3]}}
function ev(epr,name,time,n,sex,relay,done){
  const lanes=[];for(let i=0;i<n;i++){const s=relay?{name:`R${i} A`,year:"2013",club:clubs[i%3]}:sw(i+epr,sex);lanes.push({lane:i%8+1,...s,entry:60+i,members:relay?[{name:`R${i} A`,year:"2013"},{name:`NAGEUR${i+12} ${sex==="F"?"Léa":"Hugo"}`,year:String(2012+(i+12)%3)},{name:"X",year:"2013"},{name:"Y",year:"2014"}]:undefined})}
  const heats=[];for(let h=0;h*8<n;h++)heats.push({n:h+1,of:Math.ceil(n/8),time:time,lanes:lanes.slice(h*8,h*8+8)});
  const rows=done?lanes.map((l,i)=>({place:i===n-1?null:i+1,name:l.name,iuf:1000+i,year:l.year,club:l.club,time:i===n-1?null:58+i,status:i===n-1?"DSQ":null,reason:i===n-1?"Disqualifié":null,points:800-i*20,
    splits:[{d:25,cum:28+i/2,lap:28+i/2},{d:50,cum:58+i,lap:30+i/2}],relay:relay?l.members.map((m,j)=>({...m,leg:15+j})):undefined,team:relay?l.club:undefined})):[];
  return{item:{kind:"event",epr,cat:0,typ:60,num:epr,time,name,round:"Séries",nSeries:heats.length,nPart:n},st:{heats,heatsAt:1,results:{title:name,rows},resultsAt:1,nRows:rows.length,doneAt:done?Date.parse("2026-03-15T08:20:00Z"):undefined}};
}
function comp(id,name,list){const events={};const r1={n:1,day:"Dimanche 15 Mars 2026",doors:"08h30",items:[]};
  for(const e of list){const x=ev(...e);r1.items.push(x.item);events[x.item.epr]=x.st}
  return{meta:{city:"CERNAY",name,pool:"25 m",date:"Dimanche 15 Mars 2026"},reunions:[r1],progAt:1,events}}
module.exports={
  config:{name:"",comps:["93220","93222"],order:{},lines:{},starts:{},gap:40,timing:"elec",delay:{},published:true,
    rankings:[{id:"r1",name:"Plot",type:"race",comps:["93220"],mode:"year",groups:"",places:3},{id:"r2",name:"Interclubs",type:"team",comps:["93222"],mode:"scratch",places:3,perEvent:0}],
    infos:[{id:"i1",title:"Bienvenue",text:"Test",important:true}],scrape:{every:2,onlyLive:true}},
  data:{comps:{"93220":comp("93220","Plot U12 et +",[[3,"200 Nage Libre Dames","10h00",12,"F",false,true],[53,"200 Nage Libre Messieurs","10h12",9,"M",false,false]]),
               "93222":comp("93222","Interclubs U13",[[47,"4x50 Nage Libre Dames","09h50",6,"F",true,true],[32,"100 Papillon Dames","09h59",12,"F",false,true],[82,"100 Papillon Messieurs","10h07",8,"M",false,false]])},lastOk:Date.now(),queue:[]},
};
