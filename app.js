import {createScene,isRevealed,visibleTokens,validateScene,gridStroke} from './model.js';
import {localTransport,networkHost,networkPlayer,serverInfo,joinByCode} from './transport.js';
import {makeProjection,publicTokens,frameToScene} from './projection.js';
const $=id=>document.getElementById(id),canvas=$('map'),ctx=canvas.getContext('2d'),fog=document.createElement('canvas'),fx=fog.getContext('2d'),KEY='table-jdr-scene-v1';
let scene=createScene(),player=new URLSearchParams(location.search).get('mode')==='player',locked=player,tool='move',brush=100,scale=1,pan={x:0,y:0},img=null,gesture=null,history=[],saveTimer,toastTimer,imageRevision=0,dirty=true;
const joinParams=new URLSearchParams(location.hash.slice(1));
const remoteJoin=locked&&!!joinParams.get('session');
document.body.classList.toggle('locked',locked);
let projectionDirty=true,projectedImage=null,publishTimer,viewer=null,activeSession=null,hasRemoteFrame=false,sessionStarting=false,selectedEnemyId=null,pings=[],touchPoints=new Map(),touchGesture=null,pingAnimation=null,movePreview=null;
const PERMANENT_PLAYERS=[['elandir','Élandir'],['xavier','Xavier'],['drogar','Drogar'],['denethor','Denethor']];
const PLAYER_GREEN='#3fb950';
function ensurePermanentPlayers(){
 if(player)return;
 for(const [key,name] of PERMANENT_PLAYERS){
  const id='permanent-pj-'+key;
  let token=scene.tokens.find(t=>t.id===id);
  if(!token){
   const index=PERMANENT_PLAYERS.findIndex(([k])=>k===key);
   token={id,kind:'pj',name,x:Math.min(scene.width-1,scene.grid*(1.5+index)),y:Math.min(scene.height-1,scene.grid*1.5),hidden:false,initiative:null,color:PLAYER_GREEN};
   scene.tokens.push(token);
  }
  token.kind='pj';token.name=name;token.color=PLAYER_GREEN;if(!Number.isInteger(token.maxHp))token.maxHp=20;if(!Number.isInteger(token.hp))token.hp=token.maxHp;if(!Number.isInteger(token.ac))token.ac=12;
 }
}
function tokenColor(t){return t.id?.startsWith('permanent-pj-')?PLAYER_GREEN:t.kind==='pj'?'#58a6ff':'#f85149'}
ensurePermanentPlayers();
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
// Déplacement préparé : ne modifie pas le pion avant validation.
const cellOf=(x,y)=>({cx:Math.max(0,Math.min(Math.ceil(scene.width/scene.grid)-1,Math.floor(x/scene.grid))),cy:Math.max(0,Math.min(Math.ceil(scene.height/scene.grid)-1,Math.floor(y/scene.grid)))});
const cellCenter=c=>({x:Math.min(scene.width,(c.cx+.5)*scene.grid),y:Math.min(scene.height,(c.cy+.5)*scene.grid)});
function extendMove(x,y){
 if(!movePreview)return;
 const c=cellOf(x,y),path=movePreview.path,last=path[path.length-1];
 if(c.cx===last.cx&&c.cy===last.cy)return;
 // DDA : traverse toutes les cases, même si la souris bouge vite.
 const dx=c.cx-last.cx,dy=c.cy-last.cy,n=Math.max(Math.abs(dx),Math.abs(dy));
 for(let i=1;i<=n;i++){
  const next={cx:Math.round(last.cx+dx*i/n),cy:Math.round(last.cy+dy*i/n)};
  const previous=path[path.length-1];
  if(next.cx===previous.cx&&next.cy===previous.cy)continue;
  if(path.length>=2&&path[path.length-2].cx===next.cx&&path[path.length-2].cy===next.cy){path.pop();continue}
  if(path.length<250)path.push(next);
 }
 movePreview.x=cellCenter(path[path.length-1]).x;
 movePreview.y=cellCenter(path[path.length-1]).y;
 movePreview.meters=Math.round((path.length-1)*1.5*10)/10;
 draw();schedulePublish();
}
function cancelMove(){if(!movePreview)return;movePreview=null;draw();schedulePublish()}
function commitMove(){if(!movePreview||locked||player)return;const t=scene.tokens.find(t=>t.id===movePreview.id);if(!t){cancelMove();return}remember();t.x=movePreview.x;t.y=movePreview.y;movePreview=null;changed();}
function drawMove(){
 const m=player?scene.movePreview:movePreview;if(!m||!Array.isArray(m.path)||!m.path.length)return;
 const pts=m.path.map(c=>cellCenter(c));const last=pts[pts.length-1];
 ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.lineWidth=Math.max(3/scale,scene.grid*.075);ctx.strokeStyle='#aa90ff';ctx.shadowColor='#3b19e3';ctx.shadowBlur=14/scale;ctx.setLineDash([scene.grid*.2,scene.grid*.12]);
 ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);for(const pt of pts.slice(1))ctx.lineTo(pt.x,pt.y);ctx.stroke();ctx.setLineDash([]);ctx.shadowBlur=0;
 ctx.globalAlpha=.55;ctx.fillStyle=m.color||'#8f7cff';ctx.beginPath();ctx.arc(last.x,last.y,scene.grid*.34,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;
 ctx.strokeStyle='#d9cfff';ctx.lineWidth=3/scale;ctx.stroke();
 ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`bold ${Math.max(12,scene.grid*.25)}px system-ui`;ctx.fillText((m.name||'').slice(0,2).toUpperCase(),last.x,last.y);
 const label=(m.meters||0).toLocaleString('fr-FR')+' m';ctx.font=`bold ${Math.max(13/scale,scene.grid*.25)}px system-ui`;
 const tw=ctx.measureText(label).width,h=26/scale;
 ctx.fillStyle='#181818';ctx.fillRect(last.x-tw/2-8/scale,last.y-scene.grid*.5-h-4/scale,tw+16/scale,h);
 ctx.fillStyle='#eeeaff';ctx.fillText(label,last.x,last.y-scene.grid*.5-h/2-4/scale);ctx.restore();
}
function toast(message){$('toast').textContent=message;$('toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').style.display='none',3500)}
function remember(){history.push(JSON.stringify(scene));if(history.length>30)history.shift()}
const transport=localTransport(frame=>{if(locked&&!remoteJoin)receiveFrame(frame).catch(()=>toast('Mise à jour invalide'))},()=>{if(!locked)publishFrame()},ping=>{if(locked&&!remoteJoin)addPing(ping.x*scene.width,ping.y*scene.height)});
async function receiveFrame(frame){const next=validateScene(frameToScene(frame)),fit=!hasRemoteFrame||next.width!==scene.width||next.height!==scene.height;await setScene(next,fit);hasRemoteFrame=true;$('joinform').hidden=true;}
function clearPlayer(){hasRemoteFrame=false;imageRevision++;scene=createScene();img=null;dirty=true;renderGallery();draw()}
function publishFrame(){
  if(locked)return;
  if(dirty)rebuildFog();
  if(projectionDirty||!projectedImage){projectedImage=makeProjection(scene,img,fog);projectionDirty=false;}
  const active=currentToken();const frame={version:1,title:scene.title,width:scene.width,height:scene.height,grid:scene.grid,image:projectedImage,tokens:publicTokens(scene),activeTokenId:active&&!active.hidden&&isRevealed(scene,active.x,active.y)?active.id:null,gallery:(scene.gallery||[]).filter(a=>a.visible).map(({id,name,src,x,y,w})=>({id,name,src,x,y,w,visible:true})),movePreview:movePreview&&scene.tokens.some(t=>t.id===movePreview.id&&!t.hidden&&isRevealed(scene,t.x,t.y))?{...movePreview,path:movePreview.path.filter(c=>{const q=cellCenter(c);return isRevealed(scene,q.x,q.y)})}:null};
  transport.publish(frame);host.publish(frame);
}
function schedulePublish(){if(locked||publishTimer)return;publishTimer=setTimeout(()=>{publishTimer=null;publishFrame()},120)}
async function setScene(s,fit=true){scene=s;ensurePermanentPlayers();for(const token of scene.tokens)token.color=tokenColor(token);reconcileCombat();dirty=true;projectionDirty=true;syncUI();renderGallery();const revision=++imageRevision;img=null;if(s.image){const next=new Image();next.src=s.image;try{await next.decode();if(revision!==imageRevision)return;img=next}catch{toast('La carte ne peut pas être affichée');if(locked)throw Error('Image illisible')}}if(fit)fitView();draw()}
async function load(){
  // Player pages never read IndexedDB: even a local test must not load GM secrets.
  if(locked){fitView();syncUI();setMode(true);if(remoteJoin){$('status').textContent='Connexion au PC MJ…';viewer=networkPlayer({id:joinParams.get('session'),token:joinParams.get('key')||'',onFrame:receiveFrame,onPing:ping=>addPing(ping.x*scene.width,ping.y*scene.height),onStatus:message=>{$('status').textContent=message},onClear:clearPlayer})}else{$('joinform').hidden=false;$('status').textContent='En attente du code de la partie.';transport.request()}return;}
  // Chaque lancement côté MJ démarre sur une scène neuve (aucune restauration).
  fitView();
  syncUI();setMode(false);publishFrame();
  await connectTablet(); // Connexion réseau lancée automatiquement au démarrage.
}
function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open('table-jdr',1);r.onupgradeneeded=()=>r.result.createObjectStore('scenes');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
async function readDB(){const db=await openDB();try{return await new Promise((resolve,reject)=>{const r=db.transaction('scenes').objectStore('scenes').get(KEY);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}}
async function save(){try{const db=await openDB();try{await new Promise((resolve,reject)=>{const tx=db.transaction('scenes','readwrite');tx.objectStore('scenes').put(scene,KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}finally{db.close()}$('status').textContent='Sauvegardé sur cet appareil · '+new Date().toLocaleTimeString('fr-FR')}catch{$('status').textContent='Échec de sauvegarde · exportez la scène';toast('Sauvegarde impossible. Exportez la scène pour la conserver.')}}
function changed(fogChange=false){if(fogChange){dirty=true;projectionDirty=true}draw();syncUI();renderGallery();schedulePublish()}
function positionEnemySheet(){
 const panel=$('enemy-sheet');
 if(player||panel.hidden||!selectedEnemyId)return;
 const t=scene.tokens.find(x=>x.id===selectedEnemyId);
 if(!t)return;
 const board=canvas.parentElement;
 const canvasRect=canvas.getBoundingClientRect(),boardRect=board.getBoundingClientRect();
 const x=canvasRect.left-boardRect.left+pan.x+t.x*scale;
 const y=canvasRect.top-boardRect.top+pan.y+t.y*scale;
 const pw=panel.offsetWidth||300,ph=panel.offsetHeight||210;
 const maxX=Math.max(8,board.clientWidth-pw-8);
 const maxY=Math.max(8,board.clientHeight-ph-8);
 // Privilégier le côté droit du pion, basculer à gauche au bord de la carte.
 const targetX=x+scene.grid*.42*scale+12;
 const left=targetX+pw+8>board.clientWidth?x-scene.grid*.42*scale-pw-12:targetX;
 panel.style.left=Math.max(8,Math.min(maxX,left))+'px';
 panel.style.top=Math.max(8,Math.min(maxY,y-ph/2))+'px';
}
function showEnemySheet(){
 const panel=$('enemy-sheet');
 const t=scene.tokens.find(x=>x.id===selectedEnemyId);
 if(player||!t){panel.hidden=true;panel.replaceChildren();return}
 panel.hidden=false;panel.replaceChildren();
 if(!Number.isInteger(t.maxHp))t.maxHp=20;
 if(!Number.isInteger(t.hp))t.hp=t.maxHp;
 if(!Number.isInteger(t.ac))t.ac=12;
 const heading=document.createElement('div');heading.className='sheet-heading';
 const title=document.createElement('strong');title.textContent=t.name;
 const close=document.createElement('button');close.textContent='×';close.setAttribute('aria-label','Fermer la fiche');close.onclick=()=>{selectedEnemyId=null;showEnemySheet();syncUI();draw()};
 heading.append(title,close);
 const hpRow=document.createElement('div');hpRow.className='sheet-hp';
 const label=document.createElement('span');label.className='sheet-stat-label';label.textContent='PV';
 const minus=document.createElement('button');minus.textContent='−';minus.setAttribute('aria-label','Retirer 1 PV');
 const hp=document.createElement('span');hp.className='sheet-hp-count';hp.textContent=t.hp+' / '+t.maxHp;
 const plus=document.createElement('button');plus.textContent='+';plus.setAttribute('aria-label','Ajouter 1 PV');
 const changeHp=value=>{const next=Math.max(0,Math.min(t.maxHp,value));if(next===t.hp)return;remember();t.hp=next;changed()};
 minus.onclick=()=>changeHp(t.hp-1);plus.onclick=()=>changeHp(t.hp+1);
 hpRow.append(label,minus,hp,plus);
 const acRow=document.createElement('div');acRow.className='sheet-ac';
 const acLabel=document.createElement('span');acLabel.textContent='CA';
 const acValue=document.createElement('strong');acValue.textContent=t.ac;
 acRow.append(acLabel,acValue);
 panel.append(heading,hpRow,acRow);
 if(!t.id.startsWith('permanent-pj-')){
  const remove=document.createElement('button');remove.type='button';remove.className='sheet-delete';remove.textContent='Supprimer le pion';remove.setAttribute('aria-label','Supprimer '+t.name);
  remove.onclick=()=>{if(player)return;remember();scene.tokens=scene.tokens.filter(token=>token.id!==t.id);selectedEnemyId=null;reconcileCombat();changed()};
  panel.append(remove);
 }
 positionEnemySheet();
}
function syncUI(){ensurePermanentPlayers();for(const token of scene.tokens)token.color=tokenColor(token);$('title').value=scene.title;$('grid').checked=scene.showGrid;syncToolbarGrid();$('size').value=scene.grid;$('gridvalue').textContent=scene.grid+' px';$('snap').checked=scene.snap;$('gridcolor').value=scene.gridColor;$('gridopacity').value=Math.round(scene.gridOpacity*100);$('opacityvalue').textContent=Math.round(scene.gridOpacity*100)+' %';$('count').textContent=scene.tokens.length;$('empty').hidden=!!scene.image||player;const c=combatState(),current=currentToken();$('combat-panel').classList.toggle('combat-active',c.active);$('combat-start').hidden=c.active;$('combat-next').hidden=!c.active;$('combat-end').hidden=!c.active;$('combat-status').textContent=c.active?(current?'R'+c.round+' · '+current.name:'Combat en cours'):'Hors combat';const list=$('tokens');list.replaceChildren();for(const t of combatOrder()){const row=document.createElement('div');row.className='token'+(selectedEnemyId===t.id?' token-selected':'');row.title='';row.ondblclick=e=>{if(player||e.target.closest('button,input'))return;selectedEnemyId=t.id;syncUI();draw()};row.className='token'+(c.active&&current?.id===t.id?' token-current':'')+(selectedEnemyId===t.id?' token-selected':'');const dot=document.createElement('i');dot.className='token-dot';dot.style.background=tokenColor(t);dot.setAttribute('aria-label',t.kind==='pj'?'Personnage joueur':'Ennemi');const name=document.createElement('span');name.textContent=t.name;const ini=document.createElement('input');ini.type='number';ini.className='initiative';ini.min='-100';ini.max='100';ini.step='1';ini.placeholder='Init.';ini.title='';ini.setAttribute('aria-label','Initiative de '+t.name);ini.value=t.initiative??'';ini.disabled=c.active;ini.onchange=()=>{if(player)return;const v=ini.value.trim();if(v!==''&&(!Number.isInteger(Number(v))||Number(v)<-100||Number(v)>100)){toast('Initiative entière entre -100 et 100');syncUI();return}remember();t.initiative=v===''?null:Number(v);changed()};const eye=document.createElement('button');eye.innerHTML=t.hidden?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c5.3 0 9 7 9 7a15.6 15.6 0 0 1-3.1 3.8M6.5 6.5C3.9 8.2 3 12 3 12s3.7 7 9 7a9.5 9.5 0 0 0 4.4-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.7-7 10-7 10 7 10 7-3.7 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';eye.setAttribute('aria-label',(t.hidden?'Afficher ':'Masquer ')+t.name);eye.onclick=()=>{if(player)return;remember();t.hidden=!t.hidden;changed()};row.append(dot,name,ini,eye);list.append(row)}showEnemySheet();$('undo').disabled=!history.length}
function rebuildFog(){fog.width=scene.width;fog.height=scene.height;fx.clearRect(0,0,fog.width,fog.height);if(!scene.baseRevealed){fx.fillStyle='#080c11';fx.fillRect(0,0,fog.width,fog.height)}for(const f of scene.fog){fx.globalCompositeOperation=f.reveal?'destination-out':'source-over';fx.fillStyle='#080c11';fx.beginPath();if(f.type==='circle')fx.arc(f.x,f.y,f.r,0,Math.PI*2);else fx.rect(f.x,f.y,f.w,f.h);fx.fill()}fx.globalCompositeOperation='source-over';dirty=false;projectionDirty=true}
function draw(){const dpr=devicePixelRatio||1,w=canvas.clientWidth,h=canvas.clientHeight;if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr)}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#121212';ctx.fillRect(0,0,w,h);ctx.translate(pan.x,pan.y);ctx.scale(scale,scale);ctx.save();ctx.beginPath();ctx.rect(0,0,scene.width,scene.height);ctx.clip();ctx.fillStyle='#232331';ctx.fillRect(0,0,scene.width,scene.height);if(img)ctx.drawImage(img,0,0,scene.width,scene.height);if(scene.showGrid){ctx.beginPath();for(let x=0;x<=scene.width;x+=scene.grid){ctx.moveTo(x,0);ctx.lineTo(x,scene.height)}for(let y=0;y<=scene.height;y+=scene.grid){ctx.moveTo(0,y);ctx.lineTo(scene.width,y)}ctx.strokeStyle=gridStroke(scene);ctx.lineWidth=1/scale;ctx.stroke()}if(dirty)rebuildFog();ctx.globalAlpha=player?1:.65;ctx.drawImage(fog,0,0);ctx.globalAlpha=1;for(const t of player?visibleTokens(scene):scene.tokens){ctx.globalAlpha=t.hidden?.45:1;ctx.beginPath();ctx.arc(t.x,t.y,scene.grid*.34,0,Math.PI*2);ctx.fillStyle=t.color;ctx.fill();ctx.strokeStyle=t.hidden?'#e9b970':'#fff';ctx.lineWidth=2/scale;ctx.setLineDash(t.hidden?[5/scale,4/scale]:[]);ctx.stroke();ctx.setLineDash([]);
 if(!player&&t.id===selectedEnemyId){
   ctx.save();ctx.globalAlpha=1;ctx.beginPath();ctx.arc(t.x,t.y,scene.grid*.405,0,Math.PI*2);
   ctx.strokeStyle='#f85149';ctx.lineWidth=3/scale;ctx.shadowColor='#f85149';ctx.shadowBlur=12/scale;ctx.stroke();ctx.restore();
 }
 ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`bold ${Math.max(12,scene.grid*.25)}px system-ui`;ctx.fillText(t.name.slice(0,2).toUpperCase(),t.x,t.y);ctx.font=`${14/scale}px system-ui`;const active=player?scene.activeTokenId===t.id:currentToken()?.id===t.id;if(active){ctx.save();ctx.globalAlpha=1;const pulse=.5+.5*Math.sin(performance.now()*Math.PI/900);ctx.beginPath();ctx.arc(t.x,t.y,scene.grid*(.45+.035*pulse),0,Math.PI*2);ctx.strokeStyle='#ffe17a';ctx.shadowColor='#ffcd47';ctx.shadowBlur=(9+12*pulse)/scale;ctx.lineWidth=(3+1.5*pulse)/scale;ctx.globalAlpha=.78+.22*pulse;ctx.stroke();ctx.restore()}const label=t.name+(t.hidden?' · caché':'');const tw=ctx.measureText(label).width;ctx.fillStyle='#121212';ctx.fillRect(t.x-tw/2-4/scale,t.y+scene.grid*.38,tw+8/scale,20/scale);ctx.fillStyle='#fff';ctx.fillText(label,t.x,t.y+scene.grid*.38+10/scale)}ctx.globalAlpha=1;drawMove();
  for(const ping of pings){const age=(performance.now()-ping.at)/3000;if(age>=1)continue;
    const pulse=1+.3*Math.sin(age*12*Math.PI),r=Math.max(10,scene.grid*.16)*pulse;
    ctx.save();ctx.globalAlpha=(1-age)*.9;ctx.strokeStyle='#ff3b44';ctx.fillStyle='#ff3344';ctx.shadowColor='#ff2a34';ctx.shadowBlur=20/scale;
    ctx.beginPath();ctx.arc(ping.x,ping.y,r,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(ping.x,ping.y,r+Math.max(7,scene.grid*.13)*(1+age),0,Math.PI*2);ctx.lineWidth=4/scale;ctx.stroke();ctx.restore();
  }
  if(gesture?.type==='rect'){const a=gesture.start,b=gesture.last;ctx.fillStyle='#e9b97033';ctx.strokeStyle='#e9b970';ctx.lineWidth=2/scale;ctx.fillRect(a.x,a.y,b.x-a.x,b.y-a.y);ctx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y)}ctx.restore();positionEnemySheet();$('zoom').textContent=Math.round(scale*100)+' %'}
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
  if(movePreview){cancelMove()}if(e.button===2||e.altKey){gesture={type:'pan',client:{x:e.clientX,y:e.clientY},origin:{...pan}};return}if(!inside(p))return;if(tool==='move'){const t=[...scene.tokens].reverse().find(t=>Math.hypot(p.x-t.x,p.y-t.y)<scene.grid*.4);if(t){gesture={type:'token-pending',token:t,offset:{x:p.x-t.x,y:p.y-t.y},startX:e.clientX,startY:e.clientY};}else gesture={type:'pan',client:{x:e.clientX,y:e.clientY},origin:{...pan}}}else{remember();gesture={type:tool==='rect'?'rect':'paint',start:p,last:p};if(gesture.type==='paint')paint(p)}};
canvas.ondblclick=e=>{
 if(player||e.button!==0)return;
 const p=point(e);
 if(!inside(p))return;
 addPing(p.x,p.y);
 transport.ping(p.x/scene.width,p.y/scene.height);
 host.hostPing(p.x/scene.width,p.y/scene.height);
 if(tool!=='move')return;
 const t=[...scene.tokens].reverse().find(t=>Math.hypot(p.x-t.x,p.y-t.y)<scene.grid*.4);
 if(!t)return;
 selectedEnemyId=t.id;
 syncUI();draw();
};
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
  if(!gesture)return;
  if(gesture.type==='token-pending'){
    // Un simple clic sélectionne le pion : aucun déplacement n'est préparé.
    if(Math.hypot(e.clientX-gesture.startX,e.clientY-gesture.startY)<6)return;
    const t=gesture.token,offset=gesture.offset;
    if(combatState().active){
      const origin=cellOf(t.x,t.y);
      movePreview={id:t.id,name:t.name,color:t.color,path:[origin],x:t.x,y:t.y,meters:0};
      gesture={type:'token',token:t,offset};schedulePublish();
    }else{remember();gesture={type:'token-direct',token:t,offset}}
  }
  const p=point(e);if(gesture.type==='pan'){pan.x=gesture.origin.x+e.clientX-gesture.client.x;pan.y=gesture.origin.y+e.clientY-gesture.client.y}else if(gesture.type==='token'){let x=p.x-gesture.offset.x,y=p.y-gesture.offset.y;if(scene.snap){x=(Math.floor(x/scene.grid)+.5)*scene.grid;y=(Math.floor(y/scene.grid)+.5)*scene.grid}extendMove(Math.max(0,Math.min(scene.width-.001,x)),Math.max(0,Math.min(scene.height-.001,y)))}else if(gesture.type==='token-direct'){let x=p.x-gesture.offset.x,y=p.y-gesture.offset.y;if(scene.snap){x=(Math.floor(x/scene.grid)+.5)*scene.grid;y=(Math.floor(y/scene.grid)+.5)*scene.grid}gesture.token.x=Math.max(0,Math.min(scene.width-.001,x));gesture.token.y=Math.max(0,Math.min(scene.height-.001,y));schedulePublish()}else if(gesture.type==='paint'){paint(p,gesture.last);gesture.last=p}else gesture.last=p;draw();if(gesture.type==='paint')schedulePublish()};
function finish(){if(!gesture)return;const g=gesture;if(g.type==='rect'){const a=g.start,b=g.last;scene.fog.push({type:'rect',x:Math.max(0,Math.min(a.x,b.x)),y:Math.max(0,Math.min(a.y,b.y)),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y),reveal:true});dirty=true}gesture=null;if(g.type==='token'){draw();schedulePublish();toast('Entrée : déplacer · Échap : annuler')}else if(g.type==='token-pending'){draw()}else if(g.type==='token-direct'){changed()}else if(g.type!=='pan')changed(true);else draw()}
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
function setMode(v){cancelMove();finish();player=v;document.body.classList.toggle('player',v);requestAnimationFrame(()=>{if(v)fitView();else draw()})}

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
function selectMapTool(next){if(player)return;tool=next;document.querySelectorAll('[data-tool]').forEach(x=>{const active=x.dataset.tool===next;x.classList.toggle('active',active);if(x.hasAttribute('aria-pressed'))x.setAttribute('aria-pressed',String(active))});$('toolbar-fog').classList.toggle('active',next!=='move');$('toolbar-fog').setAttribute('aria-pressed',String(next!=='move'));canvas.style.cursor=tool==='move'?'grab':'crosshair'}
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>selectMapTool(b.dataset.tool));
$('toolbar-fog').onclick=()=>{if(player)return;selectMapTool(tool==='move'?'reveal':tool);togglePopup('fog',true)};
$('toolbar-grid').onclick=()=>{if(player)return;$('grid').checked=!$('grid').checked;$('grid').dispatchEvent(new Event('change'));syncToolbarGrid()};
function syncToolbarGrid(){$('toolbar-grid').classList.toggle('active',scene.showGrid);$('toolbar-grid').setAttribute('aria-pressed',String(scene.showGrid))}
let openPopup=null, gridHoverTimer=null;
function togglePopup(which,force){const next=force===undefined?(openPopup===which?null:which):(force?which:null);openPopup=next;for(const name of ['fog','grid']){const el=$(name+'-popup');el.classList.toggle('open',next===name);$(name==='fog'?'toolbar-fog':'toolbar-grid').setAttribute('aria-expanded',String(next===name))}}
const fogGroup=$('fog-tool-group'),gridGroup=$('grid-tool-group');
fogGroup.addEventListener('pointerenter',e=>{if(e.pointerType!=='touch')togglePopup('fog',true)});
fogGroup.addEventListener('pointerleave',()=>{if(openPopup==='fog')togglePopup('fog',false)});
gridGroup.addEventListener('pointerenter',e=>{if(e.pointerType==='touch')return;clearTimeout(gridHoverTimer);gridHoverTimer=setTimeout(()=>togglePopup('grid',true),1000)});
gridGroup.addEventListener('pointerleave',()=>{clearTimeout(gridHoverTimer);if(openPopup==='grid')togglePopup('grid',false)});
$('toolbar-grid').addEventListener('contextmenu',e=>{e.preventDefault();togglePopup('grid')});
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#bottom-toolbar'))togglePopup(null,false)});
document.addEventListener('keydown',e=>{if(e.key==='Escape')togglePopup(null,false)});

$('brush').oninput=e=>{brush=Number(e.target.value);$('brushvalue').textContent=brush+' px'};$('size').oninput=e=>{if(player)return;scene.grid=Number(e.target.value);changed(true)};$('grid').onchange=e=>{if(player)return;scene.showGrid=e.target.checked;changed(true)};$('snap').onchange=e=>{if(player)return;scene.snap=e.target.checked;changed()};$('title').oninput=e=>{if(player)return;scene.title=e.target.value.slice(0,200);};$('title').onchange=e=>{if(player)return;scene.title=e.target.value.trim().slice(0,200);changed()};
function add(kind){if(player)return;{const h=Number($('newhp').value),a=Number($('newac').value);if(!Number.isInteger(h)||h<1||h>99999||!Number.isInteger(a)||a<0||a>99){toast('PV ou CA invalide');return}}remember();const center={x:(canvas.clientWidth/2-pan.x)/scale,y:(canvas.clientHeight/2-pan.y)/scale};scene.tokens.push({id:crypto.randomUUID(),kind,name:$('tokenname').value.trim().slice(0,40)||(kind==='pj'?'Aventurier':'Monstre'),x:Math.max(0,Math.min(scene.width,center.x)),y:Math.max(0,Math.min(scene.height,center.y)),hidden:true,hp:Number($('newhp').value),maxHp:Number($('newhp').value),ac:Number($('newac').value),initiative:null,color:kind==='pj'?'#58a6ff':'#f85149'});$('tokenname').value='';changed()}
for(const [id,key] of [['gridcolor','gridColor']])$(id).onchange=e=>{if(player)return;remember();scene[key]=e.target.value;changed(key==='gridColor')};
$('gridopacity').onpointerdown=()=>{if(!player)remember()};$('gridopacity').onkeydown=e=>{if(!player&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))remember()};$('gridopacity').oninput=e=>{if(player)return;scene.gridOpacity=Number(e.target.value)/100;changed(true)};
$('combat-start').onclick=()=>{if(player)return;const c=combatState();if(!scene.tokens.length){toast('Ajoutez au moins un pion');return}if(scene.tokens.some(t=>t.initiative==null)){toast('Indiquez une initiative pour chaque PJ et mob avant le combat');return}remember();c.order=[...scene.tokens].sort((a,b)=>(b.initiative??-Infinity)-(a.initiative??-Infinity)).map(t=>t.id);c.current=0;c.round=1;c.active=true;changed();toast('Combat commencé !')};
$('combat-next').onclick=()=>{if(player)return;const c=combatState();if(!c.active)return;remember();reconcileCombat();if(!c.active){changed();return}c.current++;if(c.current>=c.order.length){c.current=0;c.round++}changed()};
$('combat-end').onclick=()=>{if(player)return;const c=combatState();if(!c.active)return;cancelMove();remember();c.active=false;c.order=[];c.current=0;c.round=1;changed();toast('Combat terminé')};
$('addpj').onclick=()=>add('pj');$('addmob').onclick=()=>add('mob');$('all').onclick=()=>{if(player)return;remember();scene.baseRevealed=true;scene.fog=[];changed(true)};$('cover').onclick=()=>{if(player)return;remember();scene.baseRevealed=false;scene.fog=[];changed(true)};$('undo').onclick=async()=>{if(player||!history.length)return;await setScene(JSON.parse(history.pop()),false);changed(true)};
// Archives portables : toutes les images sont stockées comme fichiers dans le ZIP.
const imageMimeExtension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
function imageBytes(uri){
 const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(uri);
 if(!match)throw Error('Image non prise en charge dans la scène');
 const binary=atob(match[2]),bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return {mime:match[1],extension:imageMimeExtension[match[1]],bytes};
}
function uriFromBytes(bytes,mime){
 let text='';const chunk=32768;
 for(let i=0;i<bytes.length;i+=chunk)text+=String.fromCharCode(...bytes.subarray(i,i+chunk));
 return `data:${mime};base64,${btoa(text)}`;
}
function safeZipName(){return (scene.title||'scene-jdr').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]+/g,'-').replace(/^-|-$/g,'').slice(0,65)||'scene-jdr'}
async function saveSceneArchive(){
 if(player)return;
 // Lire le champ immédiatement, même si l'utilisateur n'en a pas quitté le focus.
 const title=$('title').value.trim().slice(0,200);
 if(!title){toast('Indiquez un nom de scène avant de sauvegarder');$('title').focus();return;}
 scene.title=title;
 const button=$('save-scene-zip');button.disabled=true;
 try{
  const archive=new JSZip(),state=JSON.parse(JSON.stringify(scene));
  if(state.image){const picture=imageBytes(state.image),path=`images/carte.${picture.extension}`;archive.file(path,picture.bytes);state.image={file:path,mime:picture.mime};}
  for(let i=0;i<(state.gallery||[]).length;i++){
   const item=state.gallery[i],picture=imageBytes(item.src),path=`images/galerie-${String(i+1).padStart(3,'0')}.${picture.extension}`;
   archive.file(path,picture.bytes);item.src={file:path,mime:picture.mime};
  }
  archive.file('scene.json',JSON.stringify({format:'table-jdr-portable',archiveVersion:1,scene:state},null,2));
  const blob=await archive.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:5}});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=safeZipName()+'.zip';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  $('status').textContent='Scène enregistrée dans une archive ZIP';toast('Archive ZIP créée avec toutes les images');
 }catch(err){console.error(err);toast('Impossible de sauvegarder la scène : '+err.message)}finally{button.disabled=false}
}
async function loadSceneArchive(file){
 if(player||!file)return;
 if(file.size>100*1024*1024)throw Error('Archive supérieure à 100 Mo');
 const archive=await JSZip.loadAsync(file,{checkCRC32:true});
 const entry=archive.file('scene.json');if(!entry)throw Error('Fichier scene.json absent');
 const manifest=JSON.parse(await entry.async('string'));
 if(manifest.format!=='table-jdr-portable'||manifest.archiveVersion!==1)throw Error('Format d’archive inconnu');
 const state=manifest.scene;
 if(!state||!Array.isArray(state.gallery)||state.gallery.length>24)throw Error('Scène invalide');
 async function restoreImage(reference){
  if(!reference)return null;
  if(typeof reference!=='object'||typeof reference.file!=='string'||!/^images\/[a-zA-Z0-9_.-]+$/.test(reference.file)||!imageMimeExtension[reference.mime])throw Error('Référence image invalide');
  const entry=archive.file(reference.file);if(!entry)throw Error('Image manquante : '+reference.file);
  const bytes=await entry.async('uint8array');if(bytes.length>20*1024*1024)throw Error('Une image dépasse 20 Mo');
  return uriFromBytes(bytes,reference.mime);
 }
 state.image=await restoreImage(state.image);
 for(const item of state.gallery)item.src=await restoreImage(item.src);
 const next=validateScene(state);
 remember();selectedEnemyId=null;history=[];await setScene(next);changed(true);
 $('status').textContent='Scène chargée : '+file.name;toast('Scène ZIP chargée avec toutes les images');
}
async function importMapImage(file){
 if(player||!file)return;
 if(file.size>15*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('Image illisible ou supérieure à 15 Mo');
 const bitmap=await createImageBitmap(file),ratio=Math.min(1,4096/bitmap.width,4096/bitmap.height),c=document.createElement('canvas');
 c.width=Math.max(1,Math.round(bitmap.width*ratio));c.height=Math.max(1,Math.round(bitmap.height*ratio));
 c.getContext('2d').drawImage(bitmap,0,0,c.width,c.height);bitmap.close();
 const data=c.toDataURL('image/webp',.9);remember();selectedEnemyId=null;
 await setScene({...scene,image:data,width:c.width,height:c.height,tokens:[],fog:[],baseRevealed:false});changed(true);
 toast('Carte importée · brouillard activé pour les joueurs');
}
$('save-scene-zip').onclick=saveSceneArchive;
$('load-scene-zip').onclick=()=>$('scene-zip-file').click();
$('scene-zip-file').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{await loadSceneArchive(file)}catch(err){console.error(err);toast('Chargement impossible : '+err.message)}};
// Le glisser-déposer fonctionne sur toute l'application, hors zone galerie.
let dragDepth=0;
document.addEventListener('dragenter',e=>{if(player||!e.dataTransfer?.types.includes('Files'))return;e.preventDefault();dragDepth++;document.body.classList.add('scene-dragging')});
document.addEventListener('dragover',e=>{if(player||!e.dataTransfer?.types.includes('Files'))return;e.preventDefault();e.dataTransfer.dropEffect='copy'});
document.addEventListener('dragleave',e=>{if(player)return;dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)document.body.classList.remove('scene-dragging')});
document.addEventListener('drop',async e=>{
 if(player)return;
 e.preventDefault();dragDepth=0;document.body.classList.remove('scene-dragging');
 if(e.target.closest('#gallery-drop'))return;
 const files=[...e.dataTransfer.files];if(files.length!==1){toast('Déposez une seule image ou une seule archive ZIP');return}
 const file=files[0];
 try{
  if(/\.zip$/i.test(file.name)||file.type==='application/zip'||file.type==='application/x-zip-compressed')await loadSceneArchive(file);
  else if(file.type.startsWith('image/')||/\.(png|jpe?g|webp)$/i.test(file.name))await importMapImage(file);
  else throw Error('Utilisez une image PNG/JPEG/WebP ou une scène ZIP');
 }catch(err){console.error(err);toast('Import impossible : '+err.message)}
});
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
window.visualViewport?.addEventListener('resize',onMapResize);window.addEventListener('beforeunload',()=>{transport.close();viewer?.close()});document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(movePreview){e.preventDefault();gesture=null;cancelMove()}else finish()}if(e.key==='Enter'&&movePreview&&!['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)){e.preventDefault();gesture=null;commitMove()}if(e.ctrlKey&&e.key==='z'&&!player&&!['INPUT','TEXTAREA'].includes(e.target.tagName)){e.preventDefault();$('undo').click()}});if('serviceWorker'in navigator){navigator.serviceWorker.getRegistrations().then(regs=>regs.forEach(r=>r.unregister())).catch(()=>{})}
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

// Animation purement visuelle du cercle du pion dont c'est le tour.
let lastTurnHaloFrame=0;
function animateTurnHalo(now){
  if(now-lastTurnHaloFrame>=33 && (player ? !!scene.activeTokenId : !!currentToken())){
    lastTurnHaloFrame=now;
    draw();
  }
  requestAnimationFrame(animateTurnHalo);
}
requestAnimationFrame(animateTurnHalo);
