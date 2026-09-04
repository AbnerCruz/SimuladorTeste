
import * as webllm from "@mlc-ai/web-llm";
import "./style.css";

const MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const ACTIONS = ["buscar_comida","buscar_agua","buscar_abrigo","descansar","fugir","explorar","interagir"];

const app=document.querySelector("#app");
app.innerHTML=`
<header><div><h1>Survival AI</h1><p>Simulação 2D • LLM local compartilhado • sem API externa</p></div>
<div class="buttons"><button id="load">🧠 Carregar IA local</button><button id="start">▶ Iniciar</button><button id="step">⏭ Tick</button><button id="reset">↺ Reset</button></div></header>
<div class="status"><span id="model">IA: não carregada</span><span id="clock">Dia 1, 00:00</span><span id="progress"></span></div>
<main><section><canvas id="world" width="900" height="520"></canvas></section>
<aside><h2>Fila de pensamento</h2><div id="queue"></div><h2>NPCs</h2><div id="npcs"></div><h2>História</h2><div id="story"></div><h2>Log</h2><div id="log"></div></aside></main>`;

const $=s=>document.querySelector(s), canvas=$("#world"),ctx=canvas.getContext("2d");
let engine=null,running=false,timer=null, tick=0, seed=42, logs=[],story=[];
const world={resources:[
{id:"forest",name:"Floresta Norte",kind:"food",x:120,y:110,amount:80,max:80},
{id:"river",name:"Rio Norte",kind:"water",x:450,y:80,amount:100,max:100},
{id:"orchard",name:"Pomar Leste",kind:"food",x:760,y:145,amount:65,max:65},
{id:"lake",name:"Lago Sul",kind:"water",x:650,y:420,amount:100,max:100},
{id:"cave",name:"Caverna",kind:"shelter",x:450,y:420,amount:0,max:0},
{id:"ruins",name:"Ruínas",kind:"shelter",x:190,y:410,amount:0,max:0}],
threats:[{id:"wolves",name:"Lobos",x:730,y:285,r:52,active:true}]};
const names=["Ada","Bento","Cora","Davi","Eva","Félix","Gaia","Hugo"];
let npcs=[];
function rnd(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
function resource(n,k){return world.resources.filter(r=>r.kind===k&&r.amount>0).sort((a,b)=>dist(n,a)-dist(n,b))[0]}
function shelter(n){return world.resources.filter(r=>r.kind==="shelter").sort((a,b)=>dist(n,a))[0]}
function danger(n){return world.threats.find(t=>t.active&&dist(n,t)<t.r)}
function hour(){return `Dia ${Math.floor(tick/24)+1}, ${String(tick%24).padStart(2,"0")}:00`}
function log(type,n,text,people=[]){logs.push({tick,time:hour(),type,npc:n?.name||"Mundo",text,people});logs=logs.slice(-300);render()}
function reset(){
 running=false;clearInterval(timer);tick=0;seed=42;logs=[];story=[];
 npcs=names.map((name,i)=>({id:"n"+i,name,x:150+(i%4)*180+rnd()*20,y:160+Math.floor(i/4)*230+rnd()*20,
 health:90,hunger:30+rnd()*15,thirst:25+rnd()*15,energy:80,food:2,water:2,
 action:"observando",goal:"sobreviver",lastThink:-999,memory:["Água e comida são essenciais."],relations:{}}));
 for(const a of npcs)for(const b of npcs)if(a!==b)a.relations[b.id]={score:0,trust:0,meetings:0};
 render()
}
function priority(n){
 let p=Math.max(0,n.hunger-55)*1.5+Math.max(0,n.thirst-55)*1.7+Math.max(0,45-n.health)*2;
 p+=Math.max(0,25-n.energy);if(danger(n))p+=70;p+=Math.min(25,(tick-n.lastThink)*.8);return p
}
function queue(){return npcs.filter(n=>n.health>0).sort((a,b)=>priority(b)-priority(a))}
function context(n){
 const rel=Object.entries(n.relations).map(([id,r])=>{const o=npcs.find(x=>x.id===id);return `${o.name}: relação ${r.score.toFixed(0)}, confiança ${r.trust.toFixed(0)}`}).join("; ");
 return {npc:n.name,estado:{fome:+n.hunger.toFixed(1),sede:+n.thirst.toFixed(1),saude:+n.health.toFixed(1),energia:+n.energy.toFixed(1),comida:+n.food.toFixed(1),agua:+n.water.toFixed(1),local:[Math.round(n.x),Math.round(n.y)]},objetivo:n.goal,memoria:n.memory.slice(-4),relacoes:rel};
}
const SYSTEM=`Você é o cérebro de um NPC de um simulador de sobrevivência.
Tome UMA decisão por tick. Não narre. Não invente recursos.
Responda SOMENTE JSON válido, sem markdown.
Ações permitidas: ${ACTIONS.join(", ")}.
alvo deve ser um id válido quando necessário: forest, river, orchard, lake, cave, ruins ou id de NPC.
Formato: {"acao":"...","alvo":"...","motivo":"..."}
Priorize sobrevivência, depois segurança, depois recursos, depois relações.`;
function cleanDecision(raw,n){
 let s=raw.replace(/```json|```/g,"").trim(), d;
 try{d=JSON.parse(s)}catch{const m=s.match(/\{[\s\S]*\}/);if(m)try{d=JSON.parse(m[0])}catch{}}
 if(!d||!ACTIONS.includes(d.acao))return {acao:"descansar",alvo:shelter(n).id,motivo:"fallback de segurança"};
 const validTarget=!d.alvo||world.resources.some(r=>r.id===d.alvo)||npcs.some(x=>x.id===d.alvo);
 if(!validTarget)d.alvo=null;
 return d
}
async function think(n){
 n.lastThink=tick;
 if(!engine){return heuristic(n)}
 const response=await engine.chat.completions.create({messages:[
 {role:"system",content:SYSTEM},{role:"user",content:JSON.stringify(context(n))}],
 temperature:.15,top_p:.8,max_tokens:90});
 return cleanDecision(response.choices[0].message.content,n)
}
function heuristic(n){
 const d=danger(n), f=resource(n,"food"),w=resource(n,"water"),s=shelter(n);
 if(d)return {acao:"fugir",alvo:s.id,motivo:"ameaça próxima"};
 if(n.thirst>78)return {acao:"buscar_agua",alvo:w.id,motivo:"sede crítica"};
 if(n.hunger>80)return {acao:"buscar_comida",alvo:f.id,motivo:"fome crítica"};
 if(n.energy<20)return {acao:"descansar",alvo:s.id,motivo:"energia baixa"};
 return rnd()<.3?{acao:"explorar",alvo:null,motivo:"explorar"}:{acao:"buscar_comida",alvo:f.id,motivo:"estoque"};
}
function move(n,t,amount=38){if(!t)return;let dx=t.x-n.x,dy=t.y-n.y,d=Math.hypot(dx,dy)||1,z=Math.min(amount,d);n.x=clamp(n.x+dx/d*z,15,885);n.y=clamp(n.y+dy/d*z,15,505)}
function act(n,d){
 n.action=d.acao;n.goal=d.acao;
 const t=world.resources.find(r=>r.id===d.alvo)||npcs.find(x=>x.id===d.alvo);
 if(d.acao==="buscar_comida"){move(n,t);if(t&&t.kind==="food"&&dist(n,t)<48){let g=Math.min(3,t.amount);t.amount-=g;n.food+=g;n.hunger-=g*8;log("food",n,`encontrou ${g.toFixed(1)} de alimento em ${t.name}.`)}}
 else if(d.acao==="buscar_agua"){move(n,t,42);if(t&&t.kind==="water"&&dist(n,t)<48){let g=Math.min(4,t.amount);t.amount-=g;n.water+=g;n.thirst-=g*10;log("water",n,`obteve água em ${t.name}.`)}}
 else if(d.acao==="buscar_abrigo"||d.acao==="fugir"){move(n,t,50);if(t&&dist(n,t)<55)log(d.acao,n,`${d.acao==="fugir"?"fugiu para":"buscou"} ${t.name}.`)}
 else if(d.acao==="descansar"){move(n,t,18);n.energy+=16;n.health+=2;log("rest",n,"descansou.")}
 else if(d.acao==="explorar"){n.x=clamp(n.x+(rnd()-.5)*100,15,885);n.y=clamp(n.y+(rnd()-.5)*100,15,505);log("explore",n,"explorou o território.")}
 else if(d.acao==="interagir"&&t&&t.health>0){move(n,t,30);if(dist(n,t)<55){n.relations[t.id].score+=2;t.relations[n.id].score+=2;n.relations[t.id].trust++;t.relations[n.id].trust++;log("social",n,`conversou com ${t.name}.`,[n.name,t.name])}}
 n.hunger+=4+rnd()*2;n.thirst+=5+rnd()*2;n.energy-=4;
 if(n.food>0&&n.hunger>65){n.food-=.2;n.hunger-=2.5}
 if(n.water>0&&n.thirst>65){n.water-=.25;n.thirst-=3}
 n.hunger=clamp(n.hunger,0,100);n.thirst=clamp(n.thirst,0,100);n.energy=clamp(n.energy,0,100);n.health=clamp(n.health,0,100);
 if(n.hunger>90)n.health-=3;if(n.thirst>90)n.health-=4;if(danger(n))n.health-=4;
 if(n.health<=0){n.health=0;log("death",n,`morreu após ${hour()}.`)}
}
async function step(){
 tick++;
 const n=queue()[0];if(n){const d=await think(n);act(n,d)}
 for(const r of world.resources)if(r.kind==="food")r.amount=clamp(r.amount+(rnd()<.2?.6:0),0,r.max);
 if(tick%24===0){const deaths=npcs.filter(n=>n.health<=0).length;story.push(`Dia ${Math.floor(tick/24)} terminou com ${npcs.length-deaths} sobreviventes. A comunidade enfrentou ${logs.filter(x=>x.tick>tick-24).length} eventos.`)}
 render()
}
function render(){
 $("#model").textContent=engine?`IA: ${MODEL}`:"IA: fallback local";
 $("#clock").textContent=hour();
 $("#queue").innerHTML=queue().map((n,i)=>`<div class=row><b>#${i+1} ${n.name}</b> <span>${priority(n).toFixed(0)}</span><small>${n.action}</small></div>`).join("")||"<small>Ninguém vivo.</small>";
 $("#npcs").innerHTML=npcs.map(n=>`<div class=row><b>${n.name}</b> ${n.health>0?"🟢":"🔴"}<small>❤️${n.health.toFixed(0)} 🍖${n.hunger.toFixed(0)} 💧${n.thirst.toFixed(0)} ⚡${n.energy.toFixed(0)}</small></div>`).join("");
 $("#story").innerHTML=story.slice().reverse().map(x=>`<div class=row>${x}</div>`).join("")||"<small>História começando...</small>";
 $("#log").innerHTML=logs.slice().reverse().slice(0,100).map(x=>`<div class=row><small>${x.time} • ${x.npc}</small>${x.text}</div>`).join("");
 ctx.fillStyle="#0f172a";ctx.fillRect(0,0,900,520);
 ctx.fillStyle="#163225";ctx.fillRect(0,0,300,240);ctx.fillStyle="#172b3d";ctx.fillRect(300,0,600,200);ctx.fillStyle="#29261d";ctx.fillRect(0,300,900,220);
 for(const r of world.resources){ctx.beginPath();ctx.arc(r.x,r.y,22,0,7);ctx.fillStyle=r.kind==="food"?"#4ade80":r.kind==="water"?"#38bdf8":"#a78b6a";ctx.fill();ctx.fillStyle="#ddd";ctx.font="12px sans-serif";ctx.fillText(r.name,r.x-35,r.y+38)}
 for(const t of world.threats)if(t.active){ctx.beginPath();ctx.arc(t.x,t.y,t.r,0,7);ctx.strokeStyle="#fb7185";ctx.setLineDash([5,5]);ctx.stroke();ctx.setLineDash([])}
 for(const n of npcs)if(n.health>0){ctx.beginPath();ctx.arc(n.x,n.y,11,0,7);ctx.fillStyle=["#7dd3fc","#86efac","#fcd34d","#fb7185","#c4b5fd","#fdba74","#67e8f9","#f0abfc"][npcs.indexOf(n)];ctx.fill();ctx.fillStyle="#fff";ctx.font="11px sans-serif";ctx.fillText(n.name,n.x-12,n.y-17)}
}
$("#load").onclick=async()=>{
 if(!("gpu" in navigator)){alert("Este navegador não expõe WebGPU. Use um navegador/dispositivo com WebGPU.");return}
 $("#progress").textContent=" carregando modelo local...";
 try{
   engine=await webllm.CreateMLCEngine(MODEL,{initProgressCallback:p=>$("#progress").textContent=` ${Math.round(p.progress*100)}%`});
   $("#progress").textContent=" pronto";render()
 }catch(e){console.error(e);$("#progress").textContent=" erro ao carregar";alert("Falha ao carregar o modelo local. Veja o console para detalhes.")}
};
$("#start").onclick=()=>{if(running)return;running=true;timer=setInterval(step,1200)}
$("#step").onclick=()=>{if(!running)step()}
$("#reset").onclick=reset;
reset();
