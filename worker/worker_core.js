// LiveChat Bad-Rating Monitor - Cloudflare Worker
const PH = 8;
const LC_API = "https://api.livechatinc.com/v3.5/agent/action/";
const LC_CFG = "https://api.livechatinc.com/v3.5/configuration/action/";
const SESSION_HOURS = 12;
const MAX_PAGES = 45;

const PROFANITY = ["putang","puta","gago","gaga","tanga","bobo","ulol","hayop","hayup","lintik","tarantado","punyeta","kingina","kupal","inutil","buraot","sakim","lintek","burat","pokpok","ina mo","fuck","shit","bitch","asshole","bastard","stupid","idiot","damn","wtf","dumbass","moron"];
const SIGNAL_WORDS = ["scam","fraud","refund","magnanakaw","steal","rob"];
const HOLD_PAT = ["please wait","for a while","wait for","submitted to the relevant","escalat","still working","be patient","kindly wait","give me a moment","bear with me","checking","under review","please hold","one moment"];
const CUST_ERRORS = [
  [["abnormal betting","unusual betting","irregular betting","winning amount","deduct","suspicious bet","betting pattern"],
   "Withdrawal rejected for abnormal/unusual betting; winnings deducted",
   "Show the customer the evidence and the appeal path; escalate to Risk; apply one consistent deduction SOP."],
  [["deposit","deposito","not credited","not reflect","hindi pumasok","hindi naipasok","stuck","naipit","pending deposit","load","top up","recharge"],
   "Deposit not credited / stuck (GCash/PSP delay)",
   "Check the PSP/GCash status and the receipt; credit or refund within SLA; give a ticket/ETA instead of 'wait'."],
  [["withdraw","withdrawal","payout","cash out","cashout","encash","widraw"],
   "Withdrawal pending / not received", "Verify the account and processing status; give a clear status or ETA."],
  [["otp","verification code","sim","mobile number","registered number","unbind","change number","cannot receive code"],
   "OTP not received / cannot change registered number (e.g., lost SIM)",
   "Apply the lost-SIM / change-number exception flow; don't dead-end the customer."],
  [["bonus","turnover","promo","free spin","scatter","rebate","cashback"],
   "Bonus / turnover / promotion terms confusion", "Explain the turnover/promo terms clearly and verify eligibility."],
  [["locked","frozen","cannot log","can't log","cannot login","password","forgot user","account lock"],
   "Account access / locked out", "Walk through the verification & unlock steps once, then unlock or escalate; avoid repeating requirements."],
  [["error","glitch","maintenance","lag","disconnect","stuck","server"],
   "Game error / technical glitch", "Check the server logs and confirm with the technical team; inform the customer of the outcome."],
];

function has(t, arr){ t=(t||"").toLowerCase(); return arr.some(w=>t.includes(w)); }
function b64url(bytes){ let s=""; const b=new Uint8Array(bytes); for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]); return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function b64urlDecode(str){ str=str.replace(/-/g,"+").replace(/_/g,"/"); str += "=".repeat((4 - str.length % 4) % 4); const bin=atob(str); const bytes=Uint8Array.from(bin,c=>c.charCodeAt(0)); return new TextDecoder().decode(bytes); }
function b64toUtf8(b64){ const bin=atob(b64); const bytes=Uint8Array.from(bin,c=>c.charCodeAt(0)); return new TextDecoder().decode(bytes); }

async function hmacHex(secret, msg){
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64url(sig);
}
async function makeSession(user, secret){
  const p = b64url(new TextEncoder().encode(JSON.stringify({u:user, e:Math.floor(Date.now()/1000)+SESSION_HOURS*3600})));
  return p + "." + await hmacHex(secret, p);
}
async function verifySession(tok, secret){
  try{
    const [p, sig] = tok.split(".");
    const exp = await hmacHex(secret, p);
    if(exp !== sig) return null;
    const data = JSON.parse(b64urlDecode(p));
    if(data.e < Math.floor(Date.now()/1000)) return null;
    return data.u;
  }catch(e){ return null; }
}
function getCookie(req){ const c=req.headers.get("Cookie")||""; const m=c.match(/(?:^|;\s*)lcmon=([^;]+)/); return m?m[1]:null; }
async function getUser(req, env){ const t=getCookie(req); return t? await verifySession(t, env.SESSION_SECRET):null; }
function json(obj, status=200){ return new Response(JSON.stringify(obj), {status, headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}}); }
function html(str){ return new Response(str, {headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}}); }

function iso6(d){ return d.toISOString().slice(0,19)+".000000+00:00"; }
function dayRange(dateStr){
  const start = Date.parse(dateStr+"T00:00:00.000+08:00");
  return { from: iso6(new Date(start)), to: iso6(new Date(start+86400000)) };
}
function pht(iso){ if(!iso) return null; const d=new Date(iso); return new Date(d.getTime()+PH*3600000); }
function fmtDT(d){ return d? d.toISOString().slice(0,10)+" "+d.toISOString().slice(11,16) : ""; }
function fmtT(d){ return d? d.toISOString().slice(11,19) : ""; }

async function lcPost(env, url, body){
  return fetch(url, { method:"POST", headers:{ "Authorization":"Basic "+env.LIVECHAT_TOKEN, "Content-Type":"application/json" }, body: JSON.stringify(body) });
}
async function getGroups(env){
  if(env.LC_KV){ const cached = await env.LC_KV.get("groups", "json"); if(cached) return cached; }
  const r = await lcPost(env, LC_CFG+"list_groups", { all:true });
  if(!r.ok) return {};
  const arr = await r.json();
  const map = {};
  for(const g of arr) map[g.id] = g.name;
  if(env.LC_KV) await env.LC_KV.put("groups", JSON.stringify(map), { expirationTtl: 604800 });
  return map;
}

function classify(cust, human, rating){
  const labels=[];
  const jc=cust.join(" ").toLowerCase();
  if(has(jc, PROFANITY)) labels.push("Cursing/Profanity");
  if(!human.length){ labels.push("No reply"); if(cust.length) labels.push("Abandonment"); }
  else{
    const hold = human.filter(a=>has(a, HOLD_PAT)).length;
    if(hold && hold>=Math.max(1, human.length*0.6) && rating==="bad") labels.push("No solution provided");
  }
  if(has(human.join(" ").toLowerCase(), ["cannot help","not possible","create a new account","cannot unlock","we cannot","unable to","walang magagawa"]) && rating==="bad") labels.push("Possible agent mistake (review)");
  if(has(jc, SIGNAL_WORDS)) labels.push("Claimed scam/fraud");
  return labels;
}
function issueType(concern, labels, cust){
  const jc=cust.join(" ").toLowerCase(), c=(concern||"").toLowerCase();
  if(jc.includes("otp")||jc.includes("verification code")||c.includes("otp")) return "OTP";
  const m={"withdrawal":"Withdrawal","deposit":"Deposit","promotions":"Promotions","game issue":"Game","game":"Game","sign up":"Sign up","forget password":"Account"};
  for(const k in m){ if(c.includes(k)) return m[k]; }
  if(labels.includes("Cursing/Profanity")) return "Emotional";
  return "Other";
}
function detectError(cust, human, labels){
  const c=cust.join(" ").toLowerCase();
  for(const [kws,err,sol] of CUST_ERRORS){ if(kws.some(k=>c.includes(k))) return [err,sol]; }
  if(labels.includes("No reply")) return ["No human agent ever replied (bot-only)", "Review routing/staffing and call the customer back."];
  if(labels.includes("No solution provided")) return ["Agent gave only holding replies - no resolution", "Escalate to an agent with authority; give an ETA or an actual resolution."];
  if(labels.includes("Cursing/Profanity")) return ["Customer emotional/abusive (no specific request)", "Assign a senior agent to de-escalate; check account/betting status."];
  return ["No specific issue detected in the transcript", "Review the transcript and follow up as needed."];
}
function summarize(cust){ if(!cust.length) return ""; return cust.reduce((a,b)=>b.length>a.length?b:a,"").slice(0,240); }

function buildRow(c, groups){
  const t=c.thread||{}, users=c.users||[];
  const cust=users.find(u=>u.type==="customer")||{};
  const agents=users.filter(u=>u.type==="agent" && (u.id||"").includes("@"));
  const dt=pht(t.created_at);
  const gids=((t.access||{}).group_ids)||[], gid=gids.length?gids[gids.length-1]:null;
  let ratingLabel=null, hasComment=false, comment="", concern="";
  const custTexts=[], humanTexts=[], transcript=[], bots=[];
  let firstC=null, firstH=null;
  for(const ev of (t.events||[])){
    const et=ev.type;
    if(et==="filled_form"){
      for(const f of (ev.fields||[])){
        const lbl=(f.label||"").toLowerCase(); const ans=f.answer; const val=(ans&&typeof ans==="object")?ans.label:ans;
        if(lbl.includes("rate your experience")) ratingLabel=String(val);
        else if(lbl.includes("concern")) concern=String(val);
        else if(lbl.includes("comment")||lbl.includes("feedback")||lbl.includes("remarks")){ if(val){hasComment=true; comment=String(val);} }
      }
      continue;
    }
    const sm=ev.system_message_type;
    if(sm==="rating.chat_rated"){ const sc=(ev.text_vars||{}).score; ratingLabel=ratingLabel||(sc==="good"?"Good":"A lot to improve!"); }
    else if(sm==="rating.chat_commented"){ hasComment=true; comment=ev.text||comment; }
    if(et==="message"||et==="rich_message"){
      const a=ev.author_id; const tx=(ev.text||"").replace(/\n/g," ").trim();
      const e2=pht(ev.created_at); const ts=fmtT(e2);
      if(a===cust.id){ if(tx){ custTexts.push(tx); transcript.push({role:"customer",name:cust.name||"Customer",t:ts,text:tx.slice(0,500)}); } if(firstC===null) firstC=ev.created_at; }
      else{
        const au=users.find(u=>u.id===a)||{}; const nm=au.name||"";
        if((a||"").includes("@")){ if(tx){ humanTexts.push(tx); transcript.push({role:"agent",name:nm||"Agent",t:ts,text:tx.slice(0,500)}); } if(firstH===null) firstH=ev.created_at; }
        else if(tx){ transcript.push({role:"bot",name:nm||"Bot",t:ts,text:tx.slice(0,500)}); if(nm&&!bots.includes(nm)) bots.push(nm); }
      }
    }
  }
  const lab=(ratingLabel||"").toLowerCase();
  let rating=null;
  if(["excellent!","good","excellent"].includes(lab)) rating="good";
  else if(["could be better","could be better!","a lot to improve!","a lot to improve","bad"].includes(lab)) rating="bad";
  const labels=classify(custTexts, humanTexts, rating);
  const itype=issueType(concern, labels, custTexts);
  const [err,sol]=detectError(custTexts, humanTexts, labels);
  let problem=summarize(custTexts); if(comment) problem=(problem?problem+"  | comment: ":"comment: ")+comment.slice(0,160);
  const nc=custTexts.length, nh=humanTexts.length, nb=transcript.filter(m=>m.role==="bot").length;
  const ureason = rating?"":(nc===0&&nh===0&&nb===0)?"No messages at all":(nc===0&&nh===0&&nb>0)?"Bot only - customer never typed":(nc===0&&nh>0)?"Agent only - customer never typed":(nh===0&&nc>0)?"Customer wrote, no human agent replied":"Agent handled - customer just didn't rate";
  let fr=null; if(firstC&&firstH) fr=Math.round((Date.parse(firstH)-Date.parse(firstC))/1000);
  return { chat_id:c.id, time:fmtDT(dt), group_id:gid, group_name:groups[gid]||"", customer:cust.name||"(unknown)", customer_id:cust.id||"",
    rating:rating||"unrated", rating_label:ratingLabel||"", has_comment:hasComment, comment, concern,
    agents:agents.map(a=>({name:a.name,id:a.id})), n_agents:agents.length, bots, bot_only:agents.length===0,
    issue_type:itype, unrated_reason:ureason, problem, error:err, classification:labels, suggestion:sol, first_response:fr,
    link:`https://my.livechatinc.com/archives/${c.id}?query=${c.id}`, transcript };
}

async function fetchGroupDay(env, date, group, ratedOnly, groups){
  const {from,to}=dayRange(date);
  const rows=[]; let page=null, pages=0;
  while(true){
    const body = page ? {page_id:page} : {limit:100, sort_order:"asc", filters:{from,to,group_ids:[parseInt(group)]}};
    const r = await lcPost(env, LC_API+"list_archives", body);
    if(!r.ok) break;
    const d = await r.json(); const cs=d.chats||[];
    for(const c of cs) rows.push(buildRow(c, groups));
    pages++; page=d.next_page_id;
    if(!page||!cs.length||pages>=MAX_PAGES) break;
  }
  return ratedOnly ? rows.filter(r=>r.rating==="bad"||r.rating==="good") : rows;
}

async function handleReport(url, env){
  const date=url.searchParams.get("date"), group=url.searchParams.get("group");
  const ratedOnly = url.searchParams.get("rated")!=="0";
  if(!date||!group) return json({error:"date and group required"},400);
  const refresh = url.searchParams.get("refresh")==="1";
  const key = `r:${date}:${group}:${ratedOnly?1:0}`;
  if(!refresh && env.LC_KV){
    const cached = await env.LC_KV.get(key, "json");
    if(cached) return json({date, group, rows:cached, cached:true});
  }
  const groups = await getGroups(env);
  const rows = await fetchGroupDay(env, date, group, ratedOnly, groups);
  if(env.LC_KV) await env.LC_KV.put(key, JSON.stringify(rows), { expirationTtl: 259200 });
  return json({date, group, rows, cached:false});
}

async function handleLogin(request, env){
  let body={}; try{ body=await request.json(); }catch(e){}
  const ok = String(body.user||"") === String(env.ADMIN_USER||"\u0000") && String(body.pass||"") === String(env.ADMIN_PASSWORD||"\u0000");
  if(!ok) return json({error:"Invalid username or password."}, 401);
  const tok = await makeSession("Admin", env.SESSION_SECRET);
  return new Response(JSON.stringify({ok:true}), {status:200, headers:{
    "content-type":"application/json; charset=utf-8",
    "Set-Cookie":`lcmon=${tok}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS*3600}`,
    "cache-control":"no-store"}});
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const p = url.pathname;
    if(p==="/favicon.svg") return new Response(b64toUtf8(FAVICON_B64), {headers:{"content-type":"image/svg+xml","cache-control":"public, max-age=86400"}});
    if(p==="/login"||p==="/login.html") return html(b64toUtf8(LOGIN_HTML_B64));
    if(p==="/api/login" && request.method==="POST") return handleLogin(request, env);
    if(p==="/api/logout") return new Response(JSON.stringify({ok:true}), {status:200, headers:{"content-type":"application/json","Set-Cookie":"lcmon=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0","cache-control":"no-store"}});
    const user = await getUser(request, env);
    if(p.startsWith("/api/")){
      if(!user) return json({error:"unauthorized"},401);
      if(p==="/api/groups") return json(await getGroups(env));
      if(p==="/api/report") return handleReport(url, env);
      return json({error:"not found"},404);
    }
    if(p==="/"||p==="/index.html"){
      if(!user) return html(b64toUtf8(LOGIN_HTML_B64));
      return html(b64toUtf8(DASH_HTML_B64));
    }
    return new Response("Not found", {status:404});
  }
};
