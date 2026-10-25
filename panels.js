
// Sections repliables et positionnement des aides hors de la zone scrollable.
const controlsPanel=document.getElementById('controls');
controlsPanel.querySelectorAll('.section-toggle').forEach(button=>{
  button.addEventListener('click',()=>{
    const body=document.getElementById(button.getAttribute('aria-controls'));
    const open=button.getAttribute('aria-expanded')!=='true';
    button.setAttribute('aria-expanded',String(open));
    body.hidden=!open;
  });
});
function locateHelp(element,kind){
  const r=element.getBoundingClientRect();
  const width=kind==='qr'?258:220;
  const left=Math.min(Math.max(12,r.right+12),window.innerWidth-width-12);
  const top=Math.max(12,Math.min(r.bottom+8,window.innerHeight-(kind==='qr'?300:100)-12));
  const target=kind==='qr'?element.parentElement:element;
  target.style.setProperty(kind==='qr'?'--qr-left':'--tip-left',left+'px');
  target.style.setProperty(kind==='qr'?'--qr-top':'--tip-top',top+'px');
}
controlsPanel.querySelectorAll('.mini-info').forEach(el=>{
  el.addEventListener('pointerenter',()=>locateHelp(el,'tip'));
  el.addEventListener('focus',()=>locateHelp(el,'tip'));
});
const qrHelp=document.getElementById('qr-help');
const qrButton=document.getElementById('qr-info');
if(qrHelp&&qrButton){
  const refreshQR=()=>locateHelp(qrButton,'qr');
  qrHelp.addEventListener('pointerenter',refreshQR);
  qrButton.addEventListener('focus',refreshQR);
  qrButton.addEventListener('click',refreshQR);
  controlsPanel.addEventListener('scroll',refreshQR,{passive:true});
}

// Infobulles rendues directement sous body pour éviter tout rognage Safari.
const floating=document.createElement('div');floating.id='floating-help';floating.hidden=true;document.body.append(floating);
let activeHelp=null;
const positionFloating=el=>{
  const r=el.getBoundingClientRect();const w=floating.classList.contains('is-qr')?258:250;
  const h=floating.offsetHeight||100;
  let left=Math.min(window.innerWidth-w-10,r.right+12);
  if(left<10)left=10;
  let top=r.top;
  if(top+h>window.innerHeight-10)top=Math.max(10,window.innerHeight-h-10);
  floating.style.left=left+'px';floating.style.top=top+'px';
};
function showFloating(el,qr=false){
  if(document.body.classList.contains('player'))return;
  activeHelp=el;floating.classList.toggle('is-qr',qr);
  if(qr){floating.replaceChildren();const title=document.createElement('strong');title.textContent='Accès joueur';const img=document.createElement('img');img.src=document.getElementById('qr-image').src;img.alt='QR code joueur';floating.append(title,img)}
  else floating.textContent=el.dataset.tip||el.getAttribute('aria-label')||'';
  floating.hidden=false;positionFloating(el);
}
function hideFloating(el){if(activeHelp===el){floating.hidden=true;activeHelp=null;}}
controlsPanel.querySelectorAll('.mini-info').forEach(el=>{
  el.addEventListener('pointerenter',()=>showFloating(el));el.addEventListener('pointerleave',()=>hideFloating(el));
  el.addEventListener('focus',()=>showFloating(el));el.addEventListener('blur',()=>hideFloating(el));
});
if(qrButton){
  qrButton.addEventListener('pointerenter',()=>showFloating(qrButton,true));
  qrButton.addEventListener('pointerleave',()=>hideFloating(qrButton));
  qrButton.addEventListener('focus',()=>showFloating(qrButton,true));
  qrButton.addEventListener('blur',()=>hideFloating(qrButton));
  qrButton.addEventListener('click',()=>activeHelp===qrButton?hideFloating(qrButton):showFloating(qrButton,true));
}
controlsPanel.addEventListener('scroll',()=>{if(activeHelp)positionFloating(activeHelp)},{passive:true});
window.addEventListener('resize',()=>{if(activeHelp)positionFloating(activeHelp)});
