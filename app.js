import {createScene,isRevealed,visibleTokens,validateScene,gridStroke} from './model.js';
import {localTransport,networkHost,networkPlayer,serverInfo,joinByCode} from './transport.js';
import {makeProjection,publicTokens,frameToScene} from './projection.js';
const $=id=>document.getElementById(id),canvas=$('map'),ctx=canvas.getContext('2d'),fog=document.createElement('canvas'),fx=fog.getContext('2d'),KEY='table-jdr-scene-v1';
let scene=createScene(),player=new URLSearchParams(location.search).get('mode')==='player',locked=player,tool='move',brush=100,scale=1,pan={x:0,y:0},img=null,gesture=null,history=[],saveTimer,toastTimer,imageRevision=0,dirty=true;
const joinParams=new URLSearchParams(location.hash.slice(1));
const remoteJoin=locked&&!!joinParams.get('session');
document.body.classList.toggle('locked',locked);
let projectionDirty=true,projectedImage=null,publishTimer,viewer=null,activeSession=null,hasRemoteFrame=false,sessionStarting=false,selectedEnemyId=null,pings=[],touchPoints=new Map(),touchGesture=null,pingAnimation=null;
function combatState(){return scene.combat||(scene.combat={active:false,order:[],current:0,round:1})}
function combatOrder(){const c=combatState();return c.active?c.order.map(id=>scene.tokens.find(t=>t.id===id)).filter(Boolean):scene.tokens}
function currentToken(){const c=combatState();return c.active?scene.tokens.find(t=>t.id===c.order[c.current]):null}
function reconcileCombat(){const c=combatState();if(!c.active)return;const old=c.order[c.current];c.order=c.order.filter(id=>scene.tokens.some(t=>t.id===id));if(!c.order.length){c.active=false;c.current=0;return}const pos=c.order.indexOf(old);c.current=pos>=0?pos:Math.min(c.current,c.order.length-1)}
const host=networkHost(message=>{$('connection').textContent=message;if(!host.active()){$('sharepanel').hidden=true;activeSession=null;$('qr-help').hidden=true;$('qr-help').classList.remove('qr-open');$('connect').disabled=false;$('connect').textContent='Connecter la tablette'}},ping=>addPing(ping.x*scene.width,ping.y*scene.height));
function addPing(x,y){
  if(!Number.isFinite(x)||!Number.isFinite(y))return;
  pings.push({x,y,at:performance.now()});
  if(!pingAnimation){const animate=()=>{const now=performance.now();pings=pings.filter(p=>now-p.at<3000);draw();pingAnimation=pings.length?requestAnimationFrame(animate):null};pingAnimation=requestAnimationFrame(animate)}
  draw();
}
function markPlayerCell(p){
  if(!inside(p)||!(hasRemoteFrame||remoteJoin||(!locked&&player)))return;
  const grid=Math.max(1,scene.grid||60);
  const x=Math.min(scene.width,(Math.floor(p.x/grid)+.5)*grid);
  const y=Math.min(scene.height,(Math.floor(p.y/grid)+.5)*grid);
  addPing(x,y);
  if(remoteJoin)viewer?.ping(x/scene.width,y/scene.height);else if(!locked&&activeSession){host.localPing?.(x/scene.width,y/scene.height);}
}
function toast(message){$('toast').textContent=message;$('toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').style.display='none',3500)}
function remember(){history.push(JSON.stringify(scene));if(history.length>30)history.shift()}
const transport=localTransport(frame=>{if(locked&&!remoteJoin)receiveFrame(frame).catch(()=>toast('Mise à jour invalide'))},()=>{if(!locked)publishFrame()});
async function receiveFrame(frame){const next=validateScene(frameToScene(frame)),fit=!hasRemoteFrame||next.width!==scene.width||next.height!==scene.height;await setScene(next,fit);hasRemoteFrame=true;$('joinform').hidden=true;}
function clearPlayer(){hasRemoteFrame=false;imageRevision++;scene=createScene();img=null;dirty=true;renderGallery();draw()}
function publishFrame(){
  if(locked)return;
  if(dirty)rebuildFog();
  if(projectionDirty||!projectedImage){projectedImage=makeProjection(scene,img,fog);projectionDirty=false;}
  const active=currentToken();const frame={version:1,title:scene.title,width:scene.width,height:scene.height,grid:scene.grid,image:projectedImage,tokens:publicTokens(scene),activeTokenId:active&&!active.hidden&&isRevealed(scene,active.x,active.y)?active.id:null,gallery:(scene.gallery||[]).filter(a=>a.visible).map(({id,name,src,x,y,w})=>({id,name,src,x,y,w,visible:true}))};
  transport.publish(frame);host.publish(frame);
}
function schedulePublish(){if(locked||publishTimer)return;publishTimer=setTimeout(()=>{publishTimer=null;publishFrame()},120)}
async function setScene(s,fit=true){scene=s;reconcileCombat();dirty=true;projectionDirty=true;syncUI();renderGallery();const revision=++imageRevision;img=null;if(s.image){const next=new Image();next.src=s.image;try{await next.decode();if(revision!==imageRevision)return;img=next}catch{toast('La carte ne peut pas être affichée');if(locked)throw Error('Image illisible')}}if(fit)fitView();draw()}
async function load(){
  // Player pages never read IndexedDB: even a local test must not load GM secrets.
  if(locked){fitView();syncUI();setMode(true);if(remoteJoin){$('status').textContent='Connexion au PC MJ…';viewer=networkPlayer({id:joinParams.get('session'),token:joinParams.get('key')||'',onFrame:receiveFrame,onStatus:message=>{$('status').textContent=message},onClear:clearPlayer})}else{$('joinform').hidden=false;$('status').textContent='En attente du code de la partie.';transport.request()}return;}
  try{const raw=await readDB();if(raw)await setScene(validateScene(raw));else fitView()}catch{toast('Sauvegarde indisponible : utilisez Exporter la scène.');fitView()}
  syncUI();setMode(false);publishFrame();
  try{if(sessionStorage.getItem('table-jdr-session-v2'))await connectTablet()}catch{}
}
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('table-jdr',1);r.onupgradeneeded=()=>r.result.createObjectStore('scenes');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function readDB(){const db=await openDB();try{return await new Promise((resolve,reject)=>{const r=db.transaction('scenes').objectStore('scenes').get(KEY);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}}
async function save(){try{const db=await openDB();try{await new Promise((resolve,reject)=>{const tx=db.transaction('scenes','readwrite');tx.objectStore('scenes').put(scene,KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}finally{db.close()}$('status').textContent='Sauvegardé sur cet appareil · '+new Date().toLocaleTimeString('fr-FR')}catch{$('status').textContent='Échec de sauvegarde · exportez la scène';toast('Sauvegarde impossible. Exportez la scène pour la conserver.')}}
function changed(fogChange=false){if(fogChange){dirty=true;projectionDirty=true}draw();syncUI();renderGallery();schedulePublish();clearTimeout(saveTimer);saveTimer=setTimeout(save,500)}
function showEnemySheet(){
 const panel=$('enemy-sheet');
 const t=scene.tokens.find(x=>x.id===selectedEnemyId&&x.kind==='mob');
 if(player||!t){panel.hidden=true;panel.replaceChildren();return}
 panel.hidden=false;panel.replaceChildren();
 if(!Number.isInteger(t.maxHp))t.maxHp=20;
 if(!Number.isInteger(t.hp))t.hp=t.maxHp;
 if(!Number.isInteger(t.ac))t.ac=12;
 const heading=document.createElement('div');heading.className='sheet-heading';
 const title=document.createElement('strong');title.textContent=t.name;
 const close=document.createElement('button');close.textContent='×';close.title='';close.onclick=()=>{selectedEnemyId=null,pings=[],touchPoints=new Map(),touchGesture=null,pingAnimation=null;showEnemySheet();syncUI()};
 heading.append(title,close);
 const hpTitle=document.createElement('label');hpTitle.textContent='PV';
 const hpRow=document.createElement('div');hpRow.className='sheet-hp';
 const minus=document.createElement('button');minus.textContent='−';minus.title='';
 const plus=document.createElement('button');plus.textContent='+';plus.title='';
 const hp=document.createElement('input');hp.type='number';hp.min='0';hp.max='99999';hp.value=t.hp;hp.setAttribute('aria-label','PV actuels');
 const slash=document.createElement('span');slash.textContent='/';
 const max=document.createElement('input');max.type='number';max.min='1';max.max='99999';max.value=t.maxHp;max.setAttribute('aria-label','PV maximum');
 const apply=(field,value)=>{if(!Number.isInteger(value)||value<(field==='maxHp'?1:0)||value>99999){toast('PV invalides');showEnemySheet();return}remember();t[field]=value;if(field==='maxHp')t.hp=Math.min(t.hp,t.maxHp);if(field==='hp')t.hp=Math.min(t.hp,t.maxHp);changed()};
 minus.onclick=()=>apply('hp',Math.max(0,t.hp-1));plus.onclick=()=>apply('hp',Math.min(t.maxHp,t.hp+1));
 hp.onchange=()=>apply('hp',Number(hp.value));max.onchange=()=>apply('maxHp',Number(max.value));
 hpRow.append(minus,hp,slash,max,plus);
 const acRow=document.createElement('label');acRow.className='sheet-ac';acRow.textContent="CA";
 const ac=document.createElement('input');ac.type='number';ac.min='0';ac.max='99';ac.value=t.ac;ac.setAttribute('aria-label','Classe d’armure');ac.onchange=()=>{const v=Number(ac.value);if(!Number.isInteger(v)||v<0||v>99){toast('CA invalide');showEnemySheet();return}remember();t.ac=v;changed()};acRow.append(ac);
 const bar=document.createElement('div');bar.className='sheet-healthbar';const progress=document.createElement('div');progress.style.width=`${100*t.hp/t.maxHp}%`;bar.append(progress);
 const state=document.createElement('small');state.textContent=t.hp===0?'0 PV':`${Math.round(100*t.hp/t.maxHp)} %`;
 panel.append(heading,hpTitle,hpRow,bar,state,acRow);
}
function syncUI(){$('title').value=scene.title;$('grid').checked=scene.showGrid;$('size').value=scene.grid;$('gridvalue').textContent=scene.grid+' px';$('snap').checked=scene.snap;$('gridcolor').value=scene.gridColor;$('gridopacity').value=Math.round(scene.gridOpacity*100);$('opacityvalue').textContent=Math.round(scene.gridOpacity*100)+' %';$('pjcolor').value=scene.pjColor;$('mobcolor').value=scene.mobColor;$('count').textContent=scene.tokens.length;$('empty').hidden=!!scene.image||player;const c=combatState(),current=currentToken();$('combat-start').hidden=c.active;$('combat-next').hidden=!c.active;$('combat-end').hidden=!c.active;$('combat-status').textContent=c.active?(current?'R'+c.round+' · '+current.name:'Combat en cours'):'Hors combat';const list=$('tokens');list.replaceChildren();for(const t of combatOrder()){const row=document.createElement('div');row.className='token'+(t.kind==='mob'&&selectedEnemyId===t.id?' token-selected':'');row.title='';if(t.kind==='mob')row.onclick=e=>{if(player||e.target.closest('button,input'))return;selectedEnemyId=t.id;syncUI()};row.className='token'+(c.active&&current?.id===t.id?' token-current':'')+(t.kind==='mob'&&selectedEnemyId===t.id?' token-selected':'');if(c.active&&current?.id===t.id){const arrow=document.createElement('strong');arrow.className='turn-arrow';arrow.textContent='➜';row.append(arrow)}const dot=document.createElement('input');dot.type='color';dot.value=t.color;dot.className='token-color';dot.setAttribute('aria-label','Couleur de '+t.name);dot.title='';dot.onchange=()=>{if(player)return;remember();t.color=dot.value;changed()};const name=document.createElement('span');name.textContent=t.name;const ini=document.createElement('input');ini.type='number';ini.className='initiative';ini.min='-100';ini.max='100';ini.step='1';ini.placeholder='Init.';ini.title='';ini.setAttribute('aria-label','Initiative de '+t.name);ini.value=t.initiative??'';ini.disabled=c.active;ini.onchange=()=>{if(player)return;const v=ini.value.trim();if(v!==''&&(!Number.isInteger(Number(v))||Number(v)<-100||Number(v)>100)){toast('Initiative entière entre -100 et 100');syncUI();return}remember();t.initiative=v===''?null:Number(v);changed()};const eye=document.createElement('button');eye.textContent=t.hidden?'◌':'◉';eye.setAttribute('aria-label',(t.hidden?'Afficher ':'Masquer ')+t.name);eye.onclick=()=>{if(player)return;remember();t.hidden=!t.hidden;changed()};const del=document.createElement('button');del.textContent='×';del.setAttribute('aria-label','Supprimer '+t.name);del.onclick=()=>{if(player)return;remember();scene.tokens=scene.tokens.filter(x=>x.id!==t.id);if(selectedEnemyId===t.id)selectedEnemyId=null,pings=[],touchPoints=new Map(),touchGesture=null,pingAnimation=null;reconcileCombat();changed()};row.append(dot,name,ini,eye,del);list.append(row)}showEnemySheet();$('undo').disabled=!history.length}
function rebuildFog(){fog.width=scene.width;fog.height=scene.height;fx.clearRect(0,0,fog.width,fog.height);if(!scene.baseRevealed){fx.fillStyle='#080c11';fx.fillRect(0,0,fog.width,fog.height)}for(const f of scene.fog){fx.globalCompositeOperation=f.reveal?'destination-out':'source-over';fx.fillStyle='#080c11';fx.beginPath();if(f.type==='circle')fx.arc(f.x,f.y,f.r,0,Math.PI*2);else fx.rect(f.x,f.y,f.w,f.h);fx.fill()}fx.globalCompositeOperation='source-over';dirty=false;projectionDirty=true}
function draw(){const dpr=devicePixelRatio||1,w=canvas.clientWidth,h=canvas.clientHeight;if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr)}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#121212';ctx.fillRect(0,0,w,h);ctx.translate(pan.x,pan.y);ctx.scale(scale,scale);ctx.save();ctx.beginPath();ctx.rect(0,0,scene.width,scene.height);ctx.clip();ctx.fillStyle='#232331';ctx.fillRect(0,0,scene.width,scene.height);if(img)ctx.drawImage(img,0,0,scene.width,scene.height);if(scene.showGrid){ctx.beginPath();for(let x=0;x<=scene.width;x+=scene.grid){ctx.moveTo(x,0);ctx.lineTo(x,scene.height)}for(let y=0;y<=scene.height;y+=scene.grid){ctx.moveTo(0,y);ctx.lineTo(scene.width,y)}ctx.strokeStyle=gridStroke(scene);ctx.lineWidth=1/scale;ctx.stroke()}if(dirty)rebuildFog();ctx.globalAlpha=player?1:.65;ctx.drawImage(fog,0,0);ctx.globalAlpha=1;for(const t of player?visibleTokens(scene):scene.tokens){ctx.globalAlpha=t.hidden?.45:1;ctx.beginPath();ctx.arc(t.x,t.y,scene.grid*.34,0,Math.PI*2);ctx.fillStyle=t.color;ctx.fill();ctx.strokeStyle=t.hidden?'#e9b970':'#fff';ctx.lineWidth=2/scale;ctx.setLineDash(t.hidden?[5/scale,4/scale]:[]);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`bold ${Math.max(12,scene.grid*.25)}px system-ui`;ctx.fillText(t.name.slice(0,2).toUpperCase(),t.x,t.y);ctx.font=`${14/scale}px system-ui`;const active=player?scene.activeTokenId===t.id:currentToken()?.id===t.id;if(active){ctx.save();ctx.globalAlpha=1;ctx.beginPath();ctx.arc(t.x,t.y,scene.grid*.46,0,Math.PI*2);ctx.strokeStyle='#ffe17a';ctx.shadowColor='#ffcd47';ctx.shadowBlur=22/scale;ctx.lineWidth=5/scale;ctx.stroke();ctx.shadowBlur=0;ctx.fillStyle='#ffe17a';ctx.font=`bold ${24/scale}px system-ui`;ctx.fillText('➜',t.x,t.y-scene.grid*.58);ctx.restore()}const label=t.name+(t.hidden?' · caché':'');const tw=ctx.measureText(label).width;ctx.fillStyle='#121212';ctx.fillRect(t.x-tw/2-4/scale,t.y+scene.grid*.38,tw+8/scale,20/scale);ctx.fillStyle='#fff';ctx.fillText(label,t.x,t.y+scene.grid*.38+10/scale)}ctx.globalAlpha=1;
  for(const ping of pings){const age=(performance.now()-ping.at)/3000;if(age>=1)continue;
    const pulse=1+.3*Math.sin(age*12*Math.PI),r=Math.max(10,scene.grid*.16)*pulse;
    ctx.save();ctx.globalAlpha=(1-age)*.9;ctx.strokeStyle='#ff3b44';ctx.fillStyle='#ff3344';ctx.shadowColor='#ff2a34';ctx.shadowBlur=20/scale;
    ctx.beginPath();ctx.arc(ping.x,ping.y,r,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(ping.x,ping.y,r+Math.max(7,scene.grid*.13)*(1+age),0,Math.PI*2);ctx.lineWidth=4/scale;ctx.stroke();ctx.restore();
  }
  if(gesture?.type==='rect'){const a=gesture.start,b=gesture.last;ctx.fillStyle='#e9b97033';ctx.strokeStyle='#e9b970';ctx.lineWidth=2/scale;ctx.fillRect(a.x,a.y,b.x-a.x,b.y-a.y);ctx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y)}ctx.restore();$('zoom').textContent=Math.round(scale*100)+' %'}
function fitView(){scale=(player?Math.max(canvas.clientWidth/scene.width,canvas.clientHeight/scene.height):Math.min(canvas.clientWidth/scene.width,canvas.clientHeight/scene.height)*.92);pan={x:(canvas.clientWidth-scene.width*scale)/2,y:(canvas.clientHeight-scene.height*scale)/2};draw()}
function point(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left-pan.x)/scale,y:(e.clientY-r.top-pan.y)/scale}}
function inside(p){return p.x>=0&&p.y>=0&&p.x<=scene.width&&p.y<=scene.height}
function zoom(factor,x=canvas.clientWidth/2,y=canvas.clientHeight/2){const old=scale;scale=Math.max(.08,Math.min(6,scale*factor));pan.x=x-(x-pan.x)*scale/old;pan.y=y-(y-pan.y)*scale/old;draw()}
function paint(p,last){const distance=last?Math.hypot(p.x-last.x,p.y-last.y):0,steps=Math.max(1,Math.ceil(distance/(brush*.2)));for(let i=1;i<=steps;i++){const x=last?last.x+(p.x-last.x)*i/steps:p.x,y=last?last.y+(p.y-last.y)*i/steps:p.y;scene.fog.push({type:'circle',x,y,r:brush/2,reveal:tool==='reveal'})}dirty=true;draw()}
canvas.oncontextmenu=e=>e.preventDefault();canvas.onpointerdown=e=>{if(e.button!==0&&e.button!==2)return;canvas.setPointerCapture(e.pointerId);const p=point(e);
  if(player){
    touchPoints.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(touchPoints.size===1){touchGesture={start:{x:e.clientX,y:e.clientY},previous:{x:e.clientX,y:e.clientY},moved:false,pinch:false,startTime:performance.now()}}
    else if(touchPoints.size===2){const a=[...touchPoints.values()];touchGesture={pinch:true,distance:Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y)}}
    return;
  }
  if(e.button===2||e.altKey){gesture={type:'pan',client:{x:e.clientX,y:e.clientY},origin:{...pan}};return}if(!inside(p))return;if(tool==='move'){const t=[...scene.tokens].reverse().find(t=>Math.hypot(p.x-t.x,p.y-t.y)<scene.grid*.4);if(t){remember();gesture={type:'token',token:t,offset:{x:p.x-t.x,y:p.y-t.y}}}else gesture={type:'pan',client:{x:e.clientX,y:e.clientY},origin:{...pan}}}else{remember();gesture={type:tool==='rect'?'rect':'paint',start:p,last:p};if(gesture.type==='paint')paint(p)}};
canvas.onpointermove=e=>{
  if(player&&touchPoints.has(e.pointerId)){
    const old=touchPoints.get(e.pointerId);touchPoints.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(touchPoints.size===2){const a=[...touchPoints.values()],dist=Math.hypot(a[0].x-a[1].x,a[0].y-a[1].y);
      if(touchGesture?.pinch&&touchGesture.distance>0){const r=canvas.getBoundingClientRect();const mx=(a[0].x+a[1].x)/2-r.left,my=(a[0].y+a[1].y)/2-r.top;zoom(dist/touchGesture.distance,mx,my)}
      touchGesture={pinch:true,distance:dist};
    }else if(touchGesture&&!touchGesture.pinch){pan.x+=e.clientX-old.x;pan.y+=e.clientY-old.y;
      if(Math.hypot(e.clientX-touchGesture.start.x,e.clientY-touchGesture.start.y)>9)touchGesture.moved=true;draw()}
    return;
  }
  if(!gesture)return;const p=point(e);if(gesture.type==='pan'){pan.x=gesture.origin.x+e.clientX-gesture.client.x;pan.y=gesture.origin.y+e.clientY-gesture.client.y}else if(gesture.type==='token'){let x=p.x-gesture.offset.x,y=p.y-gesture.offset.y;if(scene.snap){x=(Math.floor(x/scene.grid)+.5)*scene.grid;y=(Math.floor(y/scene.grid)+.5)*scene.grid}gesture.token.x=Math.max(0,Math.min(scene.width,x));gesture.token.y=Math.max(0,Math.min(scene.height,y))}else if(gesture.type==='paint'){paint(p,gesture.last);gesture.last=p}else gesture.last=p;draw();if(gesture.type==='token'||gesture.type==='paint')schedulePublish()};
function finish(){if(!gesture)return;const g=gesture;if(g.type==='rect'){const a=g.start,b=g.last;scene.fog.push({type:'rect',x:Math.max(0,Math.min(a.x,b.x)),y:Math.max(0,Math.min(a.y,b.y)),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y),reveal:true});dirty=true}gesture=null;if(g.type!=='pan')changed(g.type!=='token');else draw()}
function endPointer(e,cancel=false){
  if(player&&touchPoints.has(e.pointerId)){
    const tapped=!cancel&&touchPoints.size===1&&touchGesture&&!touchGesture.pinch&&!touchGesture.moved&&performance.now()-touchGesture.startTime<600;
    const at=tapped?point(e):null;touchPoints.delete(e.pointerId);
    if(tapped)markPlayerCell(at);
    if(touchPoints.size===1){const remaining=[...touchPoints.values()][0];touchGesture={pinch:true,start:remaining,previous:remaining}}
    else if(!touchPoints.size)touchGesture=null;
    return;
  }
  finish();
}
canvas.onpointerup=e=>endPointer(e);canvas.onpointercancel=e=>endPointer(e,true);canvas.onwheel=e=>{e.preventDefault();const r=canvas.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.001),e.clientX-r.left,e.clientY-r.top)};canvas.addEventListener('wheel',()=>{},{passive:false});
function setMode(v){finish();player=v;document.body.classList.toggle('player',v);$('viewlabel').textContent=v?'ÉCRAN JOUEURS':'ÉCRAN MJ';$('gm').classList.toggle('active',!v);$('player').classList.toggle('active',v);if(!locked){$('gm').style.display='inline-block';$('player').textContent=v?'Retour au MJ':'Vue joueurs'}requestAnimationFrame(()=>{if(v)fitView();else draw()})}
$('gm').onclick=()=>{if(!locked)setMode(false)};$('player').onclick=()=>{if(!locked)setMode(!player)};$('window').onclick=()=>window.open('./?mode=player','table-jdr-joueurs');$('fit').onclick=fitView;$('plus').onclick=()=>zoom(1.2);$('minus').onclick=()=>zoom(1/1.2);
function updateJoinLink(){
  if(!activeSession)return;
  const url=new URL('/?mode=player',$('network').value);
  url.hash=new URLSearchParams({session:activeSession.id,key:activeSession.playerToken}).toString();
  $('joinlink').value=url.href;
  $('qr-image').src='/api/qr?url='+encodeURIComponent(url.href);
  $('qr-help').hidden=false;
}
$('qr-info').onclick=()=>{const panel=$('qr-help');panel.classList.toggle('qr-open');$('qr-info').setAttribute('aria-expanded',String(panel.classList.contains('qr-open')))};
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#qr-help')){$('qr-help').classList.remove('qr-open');$('qr-info').setAttribute('aria-expanded','false')}});

async function connectTablet(){
  if(locked||sessionStarting)return;sessionStarting=true;$('connect').disabled=true;$('connection').textContent='Préparation de la connexion…';
  try{
    const info=await serverInfo();
    activeSession=await host.start();
    $('network').replaceChildren();
    for(const address of info.addresses.length?info.addresses:[info.localOrigin]){const option=document.createElement('option');option.value=address;option.textContent=address;$('network').append(option)}
    updateJoinLink();$('sessioncode').textContent=activeSession.code?activeSession.code.slice(0,4)+' '+activeSession.code.slice(4):'Utilisez le lien complet';$('sharepanel').hidden=false;$('connect').textContent='Connexion activée';publishFrame();
    if(!info.addresses.length)$('connection').textContent='Aucun réseau local détecté. Connectez le PC au Wi-Fi puis fermez et recréez la partie.';
  }catch{$('connection').textContent='Lancez Lancer_Mac.command et ouvrez http://127.0.0.1:4174. La tablette doit utiliser le même Wi-Fi.';$('connect').disabled=false;}
  finally{sessionStarting=false}
}
$('connect').onclick=connectTablet;$('network').onchange=updateJoinLink;
$('joinform').onsubmit=async e=>{e.preventDefault();$('joinbutton').disabled=true;$('joinerror').textContent='Connexion…';try{const s=await joinByCode($('joincode').value);const url=new URL(location.href);url.searchParams.set('joined',Date.now().toString(36));url.hash=new URLSearchParams({session:s.id,key:s.playerToken}).toString();location.replace(url.href)}catch(error){$('joinerror').textContent=error.message==='Failed to fetch'?'Connexion impossible. Vérifiez le Wi-Fi et le PC.':error.message;$('joinbutton').disabled=false}};
$('copylink').onclick=async()=>{try{await navigator.clipboard.writeText($('joinlink').value);toast('Lien copié. Ouvrez-le sur la tablette.')}catch{$('joinlink').select();toast('Copiez le lien sélectionné avec Ctrl+C.')}};
$('openlink').onclick=()=>{if(activeSession){const url=new URL('/?mode=player',location.origin);url.hash=new URLSearchParams({session:activeSession.id,key:activeSession.playerToken}).toString();window.open(url.href,'table-jdr-joueurs')}};
$('disconnect').onclick=async()=>{try{await host.stop();toast('Partie partagée fermée. Le lien joueur est désactivé.')}catch{toast('Serveur injoignable. Le lien ne recevra plus de mises à jour.')}activeSession=null;$('sharepanel').hidden=true;$('connect').disabled=false;$('connect').textContent='Connecter la tablette';$('connection').textContent='Partage arrêté. Vous pouvez créer un nouveau lien.'};
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{if(player)return;tool=b.dataset.tool;document.querySelectorAll('[data-tool]').forEach(x=>x.classList.toggle('active',x===b));canvas.style.cursor=tool==='move'?'grab':'crosshair'});
$('brush').oninput=e=>{brush=Number(e.target.value);$('brushvalue').textContent=brush+' px'};$('size').oninput=e=>{if(player)return;scene.grid=Number(e.target.value);changed(true)};$('grid').onchange=e=>{if(player)return;scene.showGrid=e.target.checked;changed(true)};$('snap').onchange=e=>{if(player)return;scene.snap=e.target.checked;changed()};$('title').onchange=e=>{if(player)return;scene.title=e.target.value.slice(0,200)||'Nouvelle scène';changed()};
function add(kind){if(player)return;const newInit=$('newinitiative').value.trim();if(kind==='mob'){const h=Number($('newhp').value),a=Number($('newac').value);if(!Number.isInteger(h)||h<1||h>99999||!Number.isInteger(a)||a<0||a>99){toast('PV ou CA invalide');return}}if(newInit!==''&&(!Number.isInteger(Number(newInit))||Number(newInit)<-100||Number(newInit)>100)){toast('Initiative entière entre -100 et 100');return}remember();const center={x:(canvas.clientWidth/2-pan.x)/scale,y:(canvas.clientHeight/2-pan.y)/scale};scene.tokens.push({id:crypto.randomUUID(),kind,name:$('tokenname').value.trim().slice(0,40)||(kind==='pj'?'Aventurier':'Monstre'),x:Math.max(0,Math.min(scene.width,center.x)),y:Math.max(0,Math.min(scene.height,center.y)),hidden:kind==='mob',...(kind==='mob'?{hp:Number($('newhp').value),maxHp:Number($('newhp').value),ac:Number($('newac').value)}:{}),initiative:$('newinitiative').value.trim()===''?null:Number($('newinitiative').value),color:kind==='pj'?scene.pjColor:scene.mobColor});$('tokenname').value='';$('newinitiative').value='';changed()}
for(const [id,key] of [['gridcolor','gridColor'],['pjcolor','pjColor'],['mobcolor','mobColor']])$(id).onchange=e=>{if(player)return;remember();scene[key]=e.target.value;changed(key==='gridColor')};
$('gridopacity').onpointerdown=()=>{if(!player)remember()};$('gridopacity').onkeydown=e=>{if(!player&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))remember()};$('gridopacity').oninput=e=>{if(player)return;scene.gridOpacity=Number(e.target.value)/100;changed(true)};
$('combat-start').onclick=()=>{if(player)return;const c=combatState();if(!scene.tokens.length){toast('Ajoutez au moins un pion');return}if(scene.tokens.some(t=>t.initiative==null)){toast('Indiquez une initiative pour chaque PJ et mob avant le combat');return}remember();c.order=[...scene.tokens].sort((a,b)=>(b.initiative??-Infinity)-(a.initiative??-Infinity)).map(t=>t.id);c.current=0;c.round=1;c.active=true;changed();toast('Combat commencé !')};
$('combat-next').onclick=()=>{if(player)return;const c=combatState();if(!c.active)return;remember();reconcileCombat();if(!c.active){changed();return}c.current++;if(c.current>=c.order.length){c.current=0;c.round++}changed()};
$('combat-end').onclick=()=>{if(player)return;const c=combatState();if(!c.active)return;remember();c.active=false;c.order=[];c.current=0;c.round=1;changed();toast('Combat terminé')};
$('addpj').onclick=()=>add('pj');$('addmob').onclick=()=>add('mob');$('all').onclick=()=>{if(player)return;remember();scene.baseRevealed=true;scene.fog=[];changed(true)};$('cover').onclick=()=>{if(player)return;remember();scene.baseRevealed=false;scene.fog=[];changed(true)};$('undo').onclick=async()=>{if(player||!history.length)return;await setScene(JSON.parse(history.pop()),false);changed(true)};$('save').onclick=()=>{if(!player)save()};
$('export').onclick=()=>{if(player)return;const blob=new Blob([JSON.stringify(scene)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='scene-jdr.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
$('scene').onchange=async e=>{if(player)return;const file=e.target.files[0];if(!file)return;try{if(file.size>30000000)throw Error();const s=validateScene(JSON.parse(await file.text()));remember();await setScene(s);changed(true);toast('Scène chargée')}catch{toast('Ce fichier ne contient pas une scène valide.')}e.target.value=''};
$('image').onchange=async e=>{if(player)return;const file=e.target.files[0];if(!file)return;try{if(file.size>15*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error();const bitmap=await createImageBitmap(file),ratio=Math.min(1,4096/bitmap.width,4096/bitmap.height),c=document.createElement('canvas');c.width=Math.max(1,Math.round(bitmap.width*ratio));c.height=Math.max(1,Math.round(bitmap.height*ratio));c.getContext('2d').drawImage(bitmap,0,0,c.width,c.height);bitmap.close();const data=c.toDataURL('image/webp',.9);remember();await setScene({...scene,image:data,width:c.width,height:c.height,tokens:[],fog:[],baseRevealed:false});changed(true);toast('Carte importée · tout est masqué pour les joueurs')}catch{toast('Image illisible ou trop volumineuse (maximum 15 Mo).')}e.target.value=''};
// Rotation et variation de taille : recadrer la carte sur tout le nouvel ecran joueur.
let playerViewportWidth=0,playerViewportHeight=0,resizeQueued=false;
function onMapResize(){
 if(resizeQueued)return;
 resizeQueued=true;
 requestAnimationFrame(()=>{
   resizeQueued=false;
   const w=canvas.clientWidth,h=canvas.clientHeight;
   if(!w||!h)return;
   if(player && (Math.abs(w-playerViewportWidth)>1||Math.abs(h-playerViewportHeight)>1)){
     playerViewportWidth=w;playerViewportHeight=h;
     fitView();
   }else draw();
 });
}
new ResizeObserver(onMapResize).observe(canvas);
window.addEventListener('orientationchange',()=>setTimeout(onMapResize,120));
window.visualViewport?.addEventListener('resize',onMapResize);window.addEventListener('beforeunload',()=>{transport.close();viewer?.close()});document.addEventListener('keydown',e=>{if(e.key==='Escape')finish();if(e.ctrlKey&&e.key==='z'&&!player&&!['INPUT','TEXTAREA'].includes(e.target.tagName)){e.preventDefault();$('undo').click()}});if('serviceWorker'in navigator){navigator.serviceWorker.getRegistrations().then(regs=>regs.forEach(r=>r.unregister())).catch(()=>{})}
// Galerie privée MJ ; seules les images rendues visibles sont partagées.
const galleryLayer=$('image-windows'),galleryList=$('gallery-list');
let galleryDragging=null, galleryRenderPending=false;
function renderGallery(){
 if(!galleryLayer)return;
 galleryList.replaceChildren();
 if(!player)for(const a of scene.gallery||[]){
  const row=document.createElement('div');row.className='gallery-row'+(a.visible?' shown':'');
  const thumb=document.createElement('img');thumb.src=a.src;thumb.alt='';
  const name=document.createElement('span');name.textContent=a.name;
  const toggle=document.createElement('button');toggle.type='button';toggle.className='gallery-toggle';toggle.setAttribute('aria-pressed',String(a.visible));toggle.append(thumb,name);toggle.onclick=()=>{remember();a.visible=!a.visible;changed()};
  const del=document.createElement('button');del.type='button';del.className='gallery-remove';del.textContent='×';del.setAttribute('aria-label','Supprimer '+a.name);del.onclick=()=>{remember();scene.gallery=scene.gallery.filter(x=>x.id!==a.id);changed()};
  row.append(toggle,del);galleryList.append(row);
 }
 const shown=(scene.gallery||[]).filter(a=>a.visible);
 for(const el of [...galleryLayer.children])if(!shown.some(a=>a.id===el.dataset.id))el.remove();
 for(const a of shown){
  let win=[...galleryLayer.children].find(el=>el.dataset.id===a.id);
  if(!win){win=document.createElement('div');win.className='gallery-window';win.dataset.id=a.id;
   const bar=document.createElement('div');bar.className='gallery-window-head';bar.textContent=a.name;
   const picture=document.createElement('img');picture.src=a.src;picture.draggable=false;picture.alt=a.name;
   win.append(bar,picture);galleryLayer.append(win);
   if(!player){const handle=document.createElement('div');handle.className='gallery-resize';handle.title='';win.append(handle);
    const start=(e,mode)=>{e.preventDefault();e.stopPropagation();win.setPointerCapture(e.pointerId);galleryDragging={id:a.id,mode,startX:e.clientX,startY:e.clientY,x:a.x,y:a.y,w:a.w};};
    bar.addEventListener('pointerdown',e=>start(e,'move'));
    handle.addEventListener('pointerdown',e=>start(e,'size'));
    win.addEventListener('pointermove',e=>{if(!galleryDragging||galleryDragging.id!==a.id)return;
     const bw=galleryLayer.clientWidth||1,bh=galleryLayer.clientHeight||1,dx=(e.clientX-galleryDragging.startX)/bw,dy=(e.clientY-galleryDragging.startY)/bh;
     if(galleryDragging.mode==='move'){a.x=Math.max(0,Math.min(1-a.w,galleryDragging.x+dx));a.y=Math.max(0,Math.min(.92,galleryDragging.y+dy));}
     else a.w=Math.max(.12,Math.min(.85,1-a.x,galleryDragging.w+dx));
     positionGalleryWindow(win,a);schedulePublish();
    });
    const end=()=>{if(galleryDragging?.id===a.id){galleryDragging=null;changed()}};
    win.addEventListener('pointerup',end);win.addEventListener('pointercancel',end);
   }
  }
  positionGalleryWindow(win,a);
 }
}
function positionGalleryWindow(win,a){win.style.left=(a.x*100)+'%';win.style.top=(a.y*100)+'%';win.style.width=(a.w*100)+'%';}
// Decode via a normal image element for compatibility with Safari and non-secure LAN origins.
function galleryImageId(){
 if(globalThis.crypto?.randomUUID)return crypto.randomUUID();
 if(globalThis.crypto?.getRandomValues){const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');}
 return 'img-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
}
function decodeGalleryFile(file){return new Promise((resolve,reject)=>{
 const url=URL.createObjectURL(file),picture=new Image();
 picture.onload=()=>{URL.revokeObjectURL(url);resolve(picture)};
 picture.onerror=()=>{URL.revokeObjectURL(url);reject(Error('PNG illisible ou non décodable'))};
 picture.src=url;
});}
async function addGalleryFiles(files){
 if(player)return;
 let count=0;
 for(const file of files){
  if((scene.gallery||[]).length>=24){toast('Maximum 24 images');break}
  if(!/^image\/(png|jpeg|webp)$/i.test(file.type)&&!/\.(png|jpe?g|webp)$/i.test(file.name)){toast('Format non pris en charge : '+file.name);continue}
  if(file.size>12*1024*1024){toast('Image trop lourde (12 Mo max) : '+file.name);continue}
  try{
   const picture=await decodeGalleryFile(file);
   if(!picture.naturalWidth||!picture.naturalHeight)throw Error('Dimensions invalides');
   const ratio=Math.min(1,1000/picture.naturalWidth,1000/picture.naturalHeight);
   const c=document.createElement('canvas');
   c.width=Math.max(1,Math.round(picture.naturalWidth*ratio));
   c.height=Math.max(1,Math.round(picture.naturalHeight*ratio));
   const context=c.getContext('2d');if(!context)throw Error('Canvas indisponible');
   context.drawImage(picture,0,0,c.width,c.height);
   let src=c.toDataURL('image/webp',.76);
   if(!src.startsWith('data:image/webp;'))src=c.toDataURL('image/jpeg',.78);
   if(!/^data:image\/(webp|jpeg);base64,/.test(src))throw Error('Encodage image indisponible');
   if(src.length>1800000)throw Error('Image trop volumineuse après compression');
   if((scene.gallery||[]).reduce((n,a)=>n+a.src.length,0)+src.length>14000000)throw Error('Galerie pleine (14 Mo max)');
   scene.gallery??=[];
   scene.gallery.push({id:galleryImageId(),name:file.name.slice(0,100),src,x:.15+(count%4)*.04,y:.12+(count%4)*.04,w:.36,visible:false});
   count++;
  }catch(error){console.error('Import galerie',file.name,error);toast('Import : '+file.name+' — '+(error?.message||'Erreur inconnue'))}
 }
 if(count)changed();
}
$('gallery-upload').addEventListener('change',async e=>{await addGalleryFiles([...e.target.files]);e.target.value=''});
const galleryDrop=$('gallery-drop');
galleryDrop.addEventListener('dragover',e=>{e.preventDefault();galleryDrop.classList.add('dragover')});
galleryDrop.addEventListener('dragleave',()=>galleryDrop.classList.remove('dragover'));
galleryDrop.addEventListener('drop',e=>{e.preventDefault();galleryDrop.classList.remove('dragover');addGalleryFiles([...e.dataTransfer.files])});
new ResizeObserver(()=>{for(const a of (scene.gallery||[]).filter(a=>a.visible)){const el=[...galleryLayer.children].find(e=>e.dataset.id===a.id);if(el)positionGalleryWindow(el,a)}}).observe(galleryLayer);

load();
