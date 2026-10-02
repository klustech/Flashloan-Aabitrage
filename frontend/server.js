// Private, same-origin dashboard. Backend credentials stay server-side.
const http=require('http');
const https=require('https');
const fs=require('fs');
const path=require('path');
const ROOT=path.join(__dirname,'build');
const api=new URL(process.env.BACKEND_API_URL||'http://127.0.0.1:3001');
const transport=api.protocol==='https:'?https:http;
const allowedHosts=new Set((process.env.DASHBOARD_ALLOWED_HOSTS||'localhost,127.0.0.1').split(','));
function allowed(req){const host=new URL(`http://${req.headers.host}`).hostname;if(!allowedHosts.has(host))return false;return !req.headers.origin || new URL(req.headers.origin).host===req.headers.host;}
function createServer(){const server=http.createServer((req,res)=>{
  try{
    if(!allowed(req)){res.writeHead(403);return res.end('Dashboard origin denied');}
    if(req.url.startsWith('/api/')||req.url==='/metrics'){
      if(!process.env.API_KEY){res.writeHead(503);return res.end('Backend authentication missing');}
      if(req.method!=='GET'&&req.headers['x-requested-with']!=='XMLHttpRequest'){res.writeHead(403);return res.end('Request header required');}
      const upstream=transport.request(new URL(req.url,api),{method:req.method,headers:{'x-api-key':process.env.API_KEY,'content-type':req.headers['content-type']||'application/json'}},response=>{
        res.writeHead(response.statusCode,{'content-type':response.headers['content-type']||'application/json','cache-control':'no-store'});response.pipe(res);
      });upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Backend unavailable');});req.pipe(upstream);return;
    }
    if(req.method!=='GET'){res.writeHead(405);return res.end();}
    let file=path.resolve(ROOT,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(!file.startsWith(ROOT+path.sep)&&file!==ROOT){res.writeHead(403);return res.end();}
    if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(ROOT,'index.html');
    const types={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json'};
    res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','x-content-type-options':'nosniff','referrer-policy':'same-origin'});const stream=fs.createReadStream(file);stream.on('error',()=>res.end());stream.pipe(res);
  }catch(_){res.writeHead(400);res.end('Invalid request');}
});
  server.on('upgrade',(req,socket,head)=>{
    try{if(req.url!=='/ws'||!allowed(req)||!process.env.API_KEY){socket.destroy();return;}
      const upstream=transport.request(new URL('/ws',api),{headers:{...req.headers,host:api.host,'x-api-key':process.env.API_KEY}});
      upstream.on('upgrade',(response,remote,remoteHead)=>{socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`);if(head.length)remote.write(head);if(remoteHead.length)socket.write(remoteHead);remote.pipe(socket);socket.pipe(remote);remote.on('error',()=>socket.destroy());socket.on('error',()=>remote.destroy());});
      upstream.on('error',()=>socket.destroy());upstream.end();
    }catch(_){socket.destroy();}
  });return server;}
if(require.main===module)createServer().listen(process.env.PORT||3002,process.env.DASHBOARD_BIND_HOST||'127.0.0.1',()=>console.log('Private dashboard ready'));
module.exports={createServer};
