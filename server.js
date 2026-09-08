const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT) || 10000;
const PUBLIC = path.join(__dirname, "public");
const MAX_HTML = 12 * 1024 * 1024;
const TIMEOUT = 25000;
const jobs = new Map();

function send(res, status, body, type="text/plain; charset=utf-8", extra={}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...extra
  });
  res.end(body);
}
function json(res,status,data){send(res,status,JSON.stringify(data),"application/json; charset=utf-8")}
function cleanUrl(raw){
  let s=String(raw||"").trim();
  if(!s) throw Error("URL is required");
  if(!/^https?:\/\//i.test(s)) s="https://"+s;
  const u=new URL(s); u.hash="";
  if(!["http:","https:"].includes(u.protocol)) throw Error("Only HTTP/HTTPS URLs are supported");
  return u.toString();
}
function normalizeUrl(raw,base){
  try{
    let s=String(raw||"").trim().replace(/^['"`]|['"`]$/g,"");
    if(!s || /^(javascript|mailto|tel|data|blob):/i.test(s)) return null;
    return new URL(s,base).toString();
  }catch{return null}
}
function nameFromUrl(u){
  try{
    const x=new URL(u);
    const f=decodeURIComponent(x.pathname.split("/").pop()||"").replace(/\.[^.]+$/,"");
    return (f||x.hostname).replace(/[-_]+/g," ").replace(/\s+/g," ").trim();
  }catch{return "Trading Bot"}
}
function classify(text,url){
  const s=(text+" "+url).toLowerCase();
  const special=/(special|custom block|custom blocks|advanced block|exclusive|does not work on normal|not normal deriv|proprietary)/i.test(s);
  return special ? "Special" : "Standard";
}
function isBotCandidate(text,url){
  const s=(text+" "+url).toLowerCase();
  return /\.xml(?:[?#]|$)/i.test(url) ||
    /(bot|bots|strategy|strategies|binary|deriv|dbot|freebot|trading bot|automated bot|download)/i.test(s);
}
function extractCandidates(records){
  const map=new Map();
  const add=(url,label,source,context="")=>{
    if(!url || !isBotCandidate(label,url)) return;
    try{
      const u=new URL(url);
      if(!/^https?:$/.test(u.protocol)) return;
      const key=u.toString();
      if(!map.has(key)){
        map.set(key,{
          url:key,
          name:(label||"").replace(/\s+/g," ").trim().slice(0,180)||nameFromUrl(key),
          type:/\.xml(?:[?#]|$)/i.test(key)?"XML":"Candidate",
          category:classify(label, key),
          source
        });
      }
    }catch{}
  };
  for(const r of records){
    add(r.url,r.text,r.source,r.context);
  }
  return [...map.values()].slice(0,500);
}
function collectFromPageData(data){
  const out=[];
  const push=(url,text,source,context="")=>out.push({url,text,source,context});
  for(const a of data.links||[]) push(a.url,a.text||a.aria||"","link",a.outer||"");
  for(const f of data.frames||[]) push(f.url,"iframe","iframe","");
  for(const s of data.scripts||[]) push(s.src||"", "script", "script", "");
  for(const e of data.embedded||[]) push(e.url,e.text||"embedded","embedded",e.context||"");
  for(const x of data.xmls||[]) push(x.url,x.text||"XML","xml",x.context||"");
  return out;
}
async function scanSite(raw){
  const target=cleanUrl(raw);
  const browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-setuid-sandbox"]});
  const context=await browser.newContext({
    userAgent:"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
    viewport:{width:1440,height:1000}
  });
  const page=await context.newPage();
  const records=[];
  const visited=new Set();
  const queue=[{url:target,depth:0}];
  const maxPages=8;

  try{
    while(queue.length && visited.size<maxPages){
      const item=queue.shift();
      let u;
      try{u=new URL(item.url)}catch{continue}
      u.hash="";
      const key=u.toString();
      if(visited.has(key)) continue;
      visited.add(key);
      try{
        await page.goto(key,{waitUntil:"domcontentloaded",timeout:TIMEOUT});
        await page.waitForTimeout(2500);
      }catch(e){
        records.push({url:key,text:"",source:"page-error",context:e.message});
        continue;
      }
      const data=await page.evaluate(()=>{
        const links=[...document.querySelectorAll("a[href],area[href]")].map(a=>({
          url:a.href,text:(a.innerText||a.textContent||"").trim(),aria:a.getAttribute("aria-label")||"",outer:a.outerHTML.slice(0,1000)
        }));
        const frames=[...document.querySelectorAll("iframe[src],frame[src]")].map(f=>({url:f.src}));
        const scripts=[...document.scripts].map(s=>({src:s.src,text:s.textContent||""})).filter(x=>x.src||x.text);
        const xmls=[];
        const embedded=[];
        const html=document.documentElement.outerHTML.slice(0,12000000);
        const urlRegex=/https?:\/\/[^\s"'<>\\]+/gi;
        for(const m of html.matchAll(urlRegex)) embedded.push({url:m[0].replace(/[),.;]+$/,""),text:"embedded URL",context:"html"});
        const xmlRegex=/["'`]\s*([^"'`\\\s]+\.xml(?:\?[^"'`\\\s]*)?)\s*["'`]/gi;
        for(const m of html.matchAll(xmlRegex)) xmls.push({url:m[1],text:"XML reference",context:"html"});
        const keys=/["'](?:url|href|download|downloadUrl|file|xml|bot|botUrl|strategyUrl)["']\s*:\s*["']([^"']+)["']/gi;
        for(const m of html.matchAll(keys)) embedded.push({url:m[1],text:"embedded data",context:"json"});
        return {links,frames,scripts,embedded,xmls};
      });
      for(const r of collectFromPageData(data)) {
        const absolute=normalizeUrl(r.url,key);
        if(absolute) records.push({...r,url:absolute});
      }
      // Also inspect same-origin iframe URLs. We deliberately stay on public pages.
      for(const f of data.frames||[]){
        const fu=normalizeUrl(f.url,key);
        if(!fu) continue;
        try{
          const fuo=new URL(fu), baseo=new URL(target);
          
        }catch{}
        if(item.depth<2) queue.push({url:fu,depth:item.depth+1});
      }
      // Follow promising same-origin links only.
      for(const a of data.links||[]){
        const au=normalizeUrl(a.url,key);
        if(!au) continue;
        try{
          const x=new URL(au), b=new URL(target);
          const promising=isBotCandidate(a.text||"",au) || /\.html?$/i.test(x.pathname);
          if(x.hostname===b.hostname && promising && item.depth<2) queue.push({url:au,depth:item.depth+1});
        }catch{}
      }
    }
    const items=extractCandidates(records);
    const finalUrl=page.url();
    return {
      ok:true, requestedUrl:target, finalUrl, pagesScanned:visited.size,
      count:items.length, items,
      note:items.length
        ?"Public bot/XML candidates discovered from rendered pages, frames and embedded data."
        :"No public bot/XML candidates were discovered. The site may require login, expose downloads only after an action, use protected APIs, or not publish the files publicly."
    };
  }finally{
    await context.close(); await browser.close();
  }
}
async function handleScan(req,res){
  let body="";
  req.on("data",c=>{body+=c;if(body.length>20000)req.destroy()});
  req.on("end",async()=>{
    try{
      const data=JSON.parse(body||"{}");
      const key=cleanUrl(data.url);
      if(jobs.has(key)) return json(res,200,{ok:true,job:jobs.get(key),reused:true});
      const job={id:Math.random().toString(36).slice(2),status:"running",startedAt:Date.now()};
      jobs.set(key,job);
      try{
        const result=await scanSite(key);
        job.status="complete"; job.result=result; job.finishedAt=Date.now();
        json(res,200,result);
      }catch(e){
        job.status="failed"; job.error=e.message; job.finishedAt=Date.now();
        json(res,500,{ok:false,error:e.message});
      }finally{
        setTimeout(()=>jobs.delete(key),10*60*1000);
      }
    }catch(e){json(res,400,{ok:false,error:e.message})}
  });
}
function safeFile(p){
  const decoded=decodeURIComponent(p.split("?")[0]||"/");
  const clean=path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const file=path.join(PUBLIC,clean==="/"?"index.html":clean);
  return file.startsWith(PUBLIC)?file:null;
}
const server=http.createServer((req,res)=>{
  if(req.method==="OPTIONS") return send(res,204,"","text/plain; charset=utf-8",{"Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"});
  if(req.method==="GET" && req.url==="/health") return json(res,200,{ok:true,service:"deriv-bot-scanner-playwright"});
  if(req.method==="POST" && req.url==="/api/scan") return handleScan(req,res);
  if(req.method==="GET"){
    const file=safeFile(req.url||"/");
    if(!file) return send(res,403,"Forbidden");
    let actual=file;
    if(!fs.existsSync(actual)||fs.statSync(actual).isDirectory()) actual=path.join(PUBLIC,"index.html");
    const ext=path.extname(actual).toLowerCase();
    const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg"};
    return send(res,200,fs.readFileSync(actual),types[ext]||"application/octet-stream");
  }
  send(res,405,"Method not allowed");
});
server.listen(PORT,"0.0.0.0",()=>console.log(`Scanner listening on ${PORT}`));
