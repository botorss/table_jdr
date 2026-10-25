import {visibleTokens,gridStroke} from './model.js';

export function publicTokens(scene) {
  return visibleTokens(scene).map(({id,name,kind,x,y,color})=>({id,name,kind,x,y,color}));
}

// Flatten the map + grid + OPAQUE fog on the trusted GM device.
// No original image URL, hidden tokens, or fog history crosses this boundary.
export function makeProjection(scene,image,fog) {
  const canvas=document.createElement('canvas');
  const ratio=Math.min(1,2048/scene.width,2048/scene.height);
  canvas.width=Math.max(1,Math.round(scene.width*ratio));
  canvas.height=Math.max(1,Math.round(scene.height*ratio));
  const ctx=canvas.getContext('2d');
  ctx.scale(canvas.width/scene.width,canvas.height/scene.height);
  ctx.fillStyle='#26333d';ctx.fillRect(0,0,scene.width,scene.height);
  if(image)ctx.drawImage(image,0,0,scene.width,scene.height);
  if(scene.showGrid){
    ctx.beginPath();
    for(let x=0;x<=scene.width;x+=scene.grid){ctx.moveTo(x,0);ctx.lineTo(x,scene.height)}
    for(let y=0;y<=scene.height;y+=scene.grid){ctx.moveTo(0,y);ctx.lineTo(scene.width,y)}
    ctx.strokeStyle=gridStroke(scene);ctx.lineWidth=1;ctx.stroke();
  }
  ctx.drawImage(fog,0,0);
  return canvas.toDataURL('image/webp',.85);
}

export function frameToScene(frame) {
  // Reconstruct a public-only scene; never use any private field from a packet.
  if(!frame||frame.version!==1||!Array.isArray(frame.tokens)||frame.tokens.length>500)throw Error('Vue joueurs invalide');
  return {version:1,title:frame.title,width:frame.width,height:frame.height,image:frame.image,grid:frame.grid,showGrid:false,snap:false,baseRevealed:true,fog:[],movePreview:frame.movePreview&&typeof frame.movePreview.id==='string'&&frame.tokens.some(t=>t.id===frame.movePreview.id)&&Array.isArray(frame.movePreview.path)&&frame.movePreview.path.length<=250?frame.movePreview:null,activeTokenId:typeof frame.activeTokenId==='string'&&frame.tokens.some(t=>t.id===frame.activeTokenId)?frame.activeTokenId:null,gallery:Array.isArray(frame.gallery)?frame.gallery:[],tokens:frame.tokens.map(({id,name,kind,x,y,color})=>({id,name,kind,x,y,color,hidden:false}))};
}
