import WebSocket from "ws"; import fs from "node:fs";
const TAP = fs.readFileSync(new URL("./tap.js", import.meta.url), "utf8");
const ws = new WebSocket("ws://127.0.0.1:9222/session");
let id=0; const pend=new Map(); const recs=[];
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.on("message",d=>{const m=JSON.parse(d);
  if(m.id&&pend.has(m.id)){const q=pend.get(m.id);pend.delete(m.id);m.type==="success"?q.res(m.result):q.rej(new Error(m.error+": "+m.message));}
  else if(m.type==="event"){ if(m.method==="script.message"){ try{recs.push({T:"tap",...JSON.parse(m.params.data.value)});}catch{} }
    else if(m.method==="network.responseCompleted") recs.push({T:"res",url:m.params.response?.url,status:m.params.response?.status,nCookies:(m.params.request?.cookies||[]).length}); }
});
const fin=(s)=>{console.log(s);ws.close();}; ws.on("close",()=>process.exit(0));
ws.on("open", async ()=>{ try{
  await send("session.new",{capabilities:{}});
  await send("session.subscribe",{events:["network.responseCompleted","script.message"]});
  await send("script.addPreloadScript",{functionDeclaration:TAP,arguments:[{type:"channel",value:{channel:"browserlog"}}]});
  const t=await send("browsingContext.getTree",{}); const ctx=t.contexts[0].context;
  await send("browsingContext.navigate",{context:ctx,url:"https://example.com/",wait:"complete"});
  await send("script.callFunction",{ functionDeclaration:"async()=>{const r=await fetch(\"/\");await r.text();}", target:{context:ctx}, awaitPromise:true });
  await new Promise(r=>setTimeout(r,1500));
  const taps=recs.filter(r=>r.T==="tap").map(r=>r.k);
  console.log("native res events:", recs.filter(r=>r.T==="res").length);
  console.log("tap kinds:", [...new Set(taps)].join(", "));
  console.log("fetch bodies captured:", recs.filter(r=>r.k==="fetch-body-end").length);
  const chunk=recs.find(r=>r.k==="fetch-chunk");
  console.log("sample chunk text starts:", chunk?.text?.slice(0,40).replace(/\n/g," "));
  fin("ok");
}catch(e){ fin("ERR "+e.message); } });
setTimeout(()=>fin("timeout"),20000);
