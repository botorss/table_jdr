#!/usr/bin/env python3
"""Serveur local Table JDR (Python 3, aucune dépendance)."""
import json, secrets, socket, threading, time, webbrowser, sys, html, ipaddress
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'qr_vendor'))
import qrcode
PORT=4174
sessions={}
lock=threading.RLock()

def addresses():
    ips=set()
    try:
        for item in socket.getaddrinfo(socket.gethostname(),None,socket.AF_INET):
            ip=item[4][0]
            if not ip.startswith(('127.','169.254.')):ips.add(ip)
    except OSError:pass
    try:
        sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
        sock.connect(('192.0.2.1',80));ip=sock.getsockname()[0];sock.close()
        if not ip.startswith('127.'):ips.add(ip)
    except OSError:pass
    return [f'http://{ip}:{PORT}' for ip in sorted(ips)]

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control','no-store, max-age=0')
        super().end_headers()
    def __init__(self,*args,**kw):super().__init__(*args,directory=str(ROOT),**kw)
    def json_response(self,code,data):
        b=json.dumps(data,ensure_ascii=False,separators=(',',':')).encode()
        self.send_response(code);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
    def payload(self):
        try:
            length=int(self.headers.get('Content-Length','0'))
            if length>25_000_000:raise ValueError('Données trop volumineuses')
            return json.loads(self.rfile.read(length))
        except (ValueError,UnicodeDecodeError):return None
    def auth(self,token):return secrets.compare_digest(self.headers.get('Authorization',''), 'Bearer '+token)
    def api(self):
        u=urlparse(self.path);path=u.path
        if path=='/api/qr' and self.command=='GET':
            value=parse_qs(u.query).get('url',[''])[0]
            parsed=urlparse(value)
            # Local only: prevent QR codes linking to unrelated websites.
            try:
                ip=ipaddress.ip_address(parsed.hostname or '')
                valid_ip=ip.is_private or ip.is_loopback
            except ValueError:valid_ip=False
            if not (valid_ip and parsed.scheme=='http' and parsed.port==PORT and parsed.path=='/' and
                    parse_qs(parsed.query).get('mode')==['player'] and 0<len(value)<1500 and
                    parsed.fragment.startswith('session=')):
                return self.json_response(400,{'error':'Lien joueur invalide'})
            qr=qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,box_size=1,border=4)
            qr.add_data(value);qr.make(fit=True)
            cells=qr.get_matrix();size=len(cells)
            rects=''.join(f'<path d="M{x} {y}h1v1h-1z"/>' for y,row in enumerate(cells) for x,v in enumerate(row) if v)
            svg=(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
                 f'width="{size}" height="{size}" shape-rendering="crispEdges">'
                 f'<rect width="100%" height="100%" fill="white"/><g fill="black">{rects}</g></svg>').encode('utf-8')
            self.send_response(200);self.send_header('Content-Type','image/svg+xml');self.send_header('Content-Length',str(len(svg)));self.end_headers();self.wfile.write(svg)
            return
        if path=='/api/info' and self.command=='GET':return self.json_response(200,{'addresses':addresses(),'localOrigin':f'http://127.0.0.1:{PORT}'})
        with lock:
            now=time.time()
            for sid,s in list(sessions.items()):
                if now-s['last']>7200:del sessions[sid]
            if path=='/api/sessions' and self.command=='POST':
                sid=secrets.token_urlsafe(18);code=''.join(str(secrets.randbelow(10)) for _ in range(8))
                while any(s['code']==code for s in sessions.values()):code=''.join(str(secrets.randbelow(10)) for _ in range(8))
                s={'id':sid,'code':code,'hostToken':secrets.token_urlsafe(24),'playerToken':secrets.token_urlsafe(24),'frame':None,'revision':0,'last':now,'viewerConnected':False,'pings':[],'pingSeq':0}
                sessions[sid]=s
                return self.json_response(200,{k:s[k] for k in ('id','code','hostToken','playerToken')})
            if path=='/api/join' and self.command=='POST':
                body=self.payload()
                if not isinstance(body,dict):return self.json_response(400,{'error':'Code invalide'})
                code=''.join(c for c in str(body.get('code','')) if c.isdigit())
                for s in sessions.values():
                    if s['code']==code:return self.json_response(200,{'id':s['id'],'playerToken':s['playerToken']})
                return self.json_response(404,{'error':'Code de partie introuvable'})
            if path.startswith('/api/pings/'):
                sid=path.rsplit('/',1)[-1];s=sessions.get(sid)
                if not s:return self.json_response(404,{'error':'Partie introuvable'})
                if self.command=='POST':
                    if not (self.auth(s['playerToken']) or self.auth(s['hostToken'])):return self.json_response(403,{'error':'Accès refusé'})
                    source='host' if self.auth(s['hostToken']) else 'player'
                    body=self.payload()
                    if not isinstance(body,dict):return self.json_response(400,{'error':'Données invalides'})
                    try:x=float(body.get('x'));y=float(body.get('y'))
                    except (ValueError,TypeError):return self.json_response(400,{'error':'Coordonnées invalides'})
                    if not (0<=x<=1 and 0<=y<=1):return self.json_response(400,{'error':'Coordonnées invalides'})
                    s['pingSeq']+=1
                    s['pings'].append({'seq':s['pingSeq'],'x':x,'y':y,'time':now,'source':source})
                    s['pings']=s['pings'][-30:]
                    return self.json_response(200,{'ok':True})
                if self.command=='GET':
                    if not (self.auth(s['hostToken']) or self.auth(s['playerToken'])):return self.json_response(403,{'error':'Accès refusé'})
                    source='player' if self.auth(s['hostToken']) else 'host'
                    try:after=int(parse_qs(u.query).get('after',['0'])[0])
                    except ValueError:after=0
                    return self.json_response(200,{'pings':[{'seq':p['seq'],'x':p['x'],'y':p['y']} for p in s['pings'] if p['seq']>after and now-p['time']<=3 and p.get('source','player')==source], 'revision':s['pingSeq']})
                return self.json_response(405,{'error':'Méthode refusée'})
            if path.startswith('/api/sessions/'):
                sid=path.rsplit('/',1)[-1];s=sessions.get(sid)
                if not s:return self.json_response(404,{'error':'Partie introuvable'})
                if self.command=='PUT':
                    if not self.auth(s['hostToken']):return self.json_response(403,{'error':'Accès refusé'})
                    body=self.payload()
                    if not isinstance(body,dict):return self.json_response(400,{'error':'Données invalides'})
                    if 'frame' in body:
                        s['frame']=body['frame'];s['revision']+=1
                    s['last']=now
                    return self.json_response(200,{'viewerConnected':s['viewerConnected']})
                if self.command=='GET':
                    if not self.auth(s['playerToken']):return self.json_response(403,{'error':'Accès refusé'})
                    s['viewerConnected']=True
                    after=parse_qs(u.query).get('after',['0'])[0]
                    try:after=int(after)
                    except ValueError:after=0
                    if s['frame'] is None:return self.json_response(200,{'waiting':True})
                    return self.json_response(200,{'revision':s['revision'],'frame':s['frame'] if after!=s['revision'] else None})
                if self.command=='DELETE':
                    if not self.auth(s['hostToken']):return self.json_response(403,{'error':'Accès refusé'})
                    del sessions[sid];return self.json_response(204,{})
        return self.json_response(404,{'error':'API introuvable'})
    def do_GET(self):
        if urlparse(self.path).path.startswith('/api/'):return self.api()
        if urlparse(self.path).path=='/':self.path='/index.html'
        return super().do_GET()
    def do_POST(self):return self.api()
    def do_PUT(self):return self.api()
    def do_DELETE(self):return self.api()

if __name__=='__main__':
    try:server=ThreadingHTTPServer(('0.0.0.0',PORT),Handler)
    except OSError as e:raise SystemExit(f'Impossible de démarrer le serveur sur le port {PORT} : {e}')
    print('Table JDR démarre sur http://127.0.0.1:4174',flush=True)
    for a in addresses():print('Adresse tablette :',a,flush=True)
    print('Gardez ce terminal ouvert. Ctrl+C pour arrêter.',flush=True)
    webbrowser.open('http://127.0.0.1:4174')
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()
