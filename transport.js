// Carries PUBLIC frames only, never the private GM scene.
export function localTransport(onFrame,onRequest,onPing){const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('table-jdr-public-v2'):null;channel?.addEventListener('message',e=>{if(e.data.type==='frame')onFrame(e.data.frame);if(e.data.type==='request')onRequest();if(e.data.type==='ping'&&Number.isFinite(e.data.x)&&Number.isFinite(e.data.y))onPing?.(e.data)});return{publish:frame=>channel?.postMessage({type:'frame',frame}),ping:(x,y)=>channel?.postMessage({type:'ping',x,y}),request:()=>channel?.postMessage({type:'request'}),close:()=>channel?.close()};}

async function api(path,options={}) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try {
    const response=await fetch(path,{...options,signal:controller.signal,cache:'no-store',headers:{'Content-Type':'application/json',...options.headers}});
    if(response.status===204)return null;
    const body=await response.json();
    if(!response.ok){const error=Error(body.error||'Connexion impossible.');error.status=response.status;throw error;}
    return body;
  }finally{clearTimeout(timer)}
}
export function networkHost(onStatus,onPing) {
  let session=null,pending=null,busy=false,heartbeat=null,retry=null,pingTimer=null,pingRevision=0,generation=0;
  async function flush() {
    if(!session||busy)return;
    busy=true;const current=session,g=generation,frame=pending;pending=null;
    try {
      const result=await api('/api/sessions/'+current.id,{method:'PUT',headers:{Authorization:'Bearer '+current.hostToken},body:JSON.stringify(frame?{frame}:{heartbeat:true})});
      if(g===generation)onStatus(result.viewerConnected?'Tablette connectée':'En attente de la tablette');
    }catch(error){
      if(g!==generation)return;
      if(error.status===404||error.status===403){clearInterval(heartbeat);clearInterval(pingTimer);session=null;pending=null;try{sessionStorage.removeItem('table-jdr-session-v2')}catch{};onStatus('Partie fermée : reconnectez la tablette.');return;}
      if(frame&&!pending)pending=frame;
      onStatus('Connexion interrompue · nouvel essai automatique');
      clearTimeout(retry);retry=setTimeout(()=>{retry=null;flush()},2000);
    }finally{busy=false;if(pending&&session&&!retry)queueMicrotask(flush)}
  }
  async function pollPings(){
    if(!session)return;
    const current=session;
    try {
      const result=await api('/api/pings/'+current.id+'?after='+pingRevision,{headers:{Authorization:'Bearer '+current.hostToken}});
      if(session!==current)return;
      pingRevision=result.revision;
      for(const ping of result.pings||[])onPing?.(ping);
    }catch{} // La carte et le partage continuent même si un ping échoue.
  }
  return {
    async start() {
      if(session)return session;
      let stored;try{stored=JSON.parse(sessionStorage.getItem('table-jdr-session-v2'))}catch{}
      if(stored?.id&&stored?.hostToken&&stored?.playerToken){try{await api('/api/sessions/'+stored.id,{method:'PUT',headers:{Authorization:'Bearer '+stored.hostToken},body:JSON.stringify({heartbeat:true})});session=stored}catch{}}
      if(!session)session=await api('/api/sessions',{method:'POST',headers:{'X-Table-JDR':'1'}});
      generation++;try{sessionStorage.setItem('table-jdr-session-v2',JSON.stringify(session))}catch{}
      clearInterval(heartbeat);heartbeat=setInterval(flush,2000);clearInterval(pingTimer);pingRevision=0;pingTimer=setInterval(pollPings,350);pollPings();onStatus('En attente de la tablette');return session;
    },
    publish(frame){if(!session)return;pending=frame;clearTimeout(retry);retry=null;flush()},
    async stop(){const old=session;session=null;pending=null;generation++;clearInterval(heartbeat);clearInterval(pingTimer);clearTimeout(retry);retry=null;try{sessionStorage.removeItem('table-jdr-session-v2')}catch{};if(old)await api('/api/sessions/'+old.id,{method:'DELETE',headers:{Authorization:'Bearer '+old.hostToken}})},
    hostPing(x,y){if(!session)return;api('/api/pings/'+encodeURIComponent(session.id),{method:'POST',headers:{Authorization:'Bearer '+session.hostToken},body:JSON.stringify({x,y})}).catch(()=>{})},
    localPing(x,y){if(!session)return;api('/api/pings/'+encodeURIComponent(session.id),{method:'POST',headers:{Authorization:'Bearer '+session.playerToken},body:JSON.stringify({x,y})}).catch(()=>{})},
    active:()=>!!session
  };
}
export function networkPlayer({id,token,onFrame,onPing,onStatus,onClear}) {
  let revision=0,stopped=false,timer,cleared=false,pingRevision=0,pingTimer;
  async function pollPings(){if(stopped)return;try{const result=await api('/api/pings/'+encodeURIComponent(id)+'?after='+pingRevision,{headers:{Authorization:'Bearer '+token}});if(stopped)return;pingRevision=result.revision;for(const ping of result.pings||[])onPing?.(ping)}catch{}}
  pingTimer=setInterval(pollPings,350);pollPings();
  async function poll(){
    if(stopped)return;
    try {
      const data=await api('/api/sessions/'+encodeURIComponent(id)+'?after='+revision,{headers:{Authorization:'Bearer '+token}});
      if(stopped)return;
      if(data?.waiting)onStatus('En attente de la première image du MJ…');
      else {
        if(data?.frame){await onFrame(data.frame);if(stopped)return;revision=data.revision;cleared=false;}
        onStatus('Connecté au PC MJ · écran joueurs');
      }
    }catch(error){
      if(stopped)return;
      if(!cleared){onClear();cleared=true;revision=0;}
      onStatus(error.status===404?'Partie fermée · demandez un nouveau lien au MJ.':error.status===403?'Lien joueur invalide · demandez un nouveau lien au MJ.':'Connexion perdue · vérifiez le Wi-Fi et laissez le PC allumé. Reconnexion automatique…');
      if(error.status===404||error.status===403){stopped=true;return;}
    }
    if(!stopped)timer=setTimeout(poll,800);
  }
  poll();return{
    ping(x,y){if(stopped)return;api('/api/pings/'+encodeURIComponent(id),{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({x,y})}).catch(()=>{});},
    close(){stopped=true;clearTimeout(timer);clearInterval(pingTimer)}
  };
}
export const serverInfo=()=>api('/api/info');
export const joinByCode=code=>api('/api/join',{method:'POST',body:JSON.stringify({code})});
