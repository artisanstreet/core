// Minimal sign-in / confirmation pages. No framework, no tracking, inline
// CSS. The emailed token travels in the link (required); the request secret
// stays in localStorage and POST bodies, never in URLs.
const css = `body{font-family:system-ui,sans-serif;background:#101014;color:#e8e8ea;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:26rem;width:100%;padding:2rem;background:#1a1a20;border:1px solid #2c2c34;border-radius:.75rem}h1{font-size:1.1rem;margin:0 0 1rem}input,button{font:inherit}input[type=email],input[type=text]{width:100%;box-sizing:border-box;padding:.6rem;margin:.25rem 0 .75rem;background:#101014;border:1px solid #3a3a44;color:#fff;border-radius:.4rem}button{background:#4f7cff;border:0;color:#fff;padding:.6rem 1rem;border-radius:.4rem;cursor:pointer}button:disabled{opacity:.5}p{font-size:.9rem;line-height:1.5}.muted{color:#9a9aa3}.ok{color:#7dd87d}.err{color:#ff9a9a}`;

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function signinPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Ast</title><style>${css}</style></head><body><main>
<h1>Sign in to Ast</h1>
<p class="muted">We email you a sign-in link. Opening it approves this browser; a different browser needs your explicit approval here.</p>
<form id="f"><input id="email" type="email" required placeholder="you@example.com" autocomplete="email"><button type="submit">Email me a link</button></form>
<p id="msg" class="muted"></p>
<div id="done" hidden><p class="ok">Check your email, then approve the link.</p><p class="muted">Waiting for approval…</p><button id="finish" hidden>Finish sign-in on this device</button><div id="totp" hidden><input id="code" type="text" inputmode="numeric" placeholder="Authenticator code (if enrolled)"></div></div>
<script>
let req=null;
document.getElementById('f').onsubmit=async e=>{e.preventDefault();
 const email=document.getElementById('email').value;
 const r=await fetch('/v1/auth/magic/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email})});
 const j=await r.json();
 if(!r.ok){document.getElementById('msg').textContent=j.error.message;return;}
 req=j; localStorage.setItem('ast-core:secret:'+j.requestId,j.requestSecret);
 document.getElementById('done').hidden=false; poll();};
async function poll(){ if(!req)return;
 const r=await fetch('/v1/auth/magic/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:req.requestId,requestSecret:req.requestSecret})});
 const j=await r.json(); if(!r.ok)return;
 if(j.status==='email_approved'||j.status==='completed'&&false){document.getElementById('finish').hidden=false;document.getElementById('totp').hidden=!j.totpRequired;}
 else setTimeout(poll,3000);}
document.getElementById('finish').onclick=async()=>{const b={requestId:req.requestId,requestSecret:req.requestSecret};
 const code=document.getElementById('code').value; if(code)b.totpCode=code;
 const r=await fetch('/v1/auth/magic/finalize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
 const j=await r.json(); document.getElementById('msg').textContent=r.ok?'Signed in as '+j.accountId:j.error.message;};
</script></main></body></html>`;
}

export function confirmPage(token: string): string {
  const t = esc(token);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve sign-in</title><style>${css}</style></head><body><main>
<h1>Approve this sign-in?</h1>
<p class="muted">Clicking approve confirms the emailed link. It never signs anyone in by itself: completing sign-in needs the secret held by the browser that requested it, plus your authenticator code if enrolled. Mail scanners that merely open links approve nothing.</p>
<button id="approve">Approve this request</button>
<p id="msg" class="muted"></p>
<div id="finish" hidden><p class="ok">This browser holds the original request — you can finish here.</p><div id="totp" hidden><input id="code" type="text" inputmode="numeric" placeholder="Authenticator code (if enrolled)"></div><button id="go">Finish sign-in</button></div>
<script>
let req=null,secret=null;
document.getElementById('approve').onclick=async()=>{
 const r=await fetch('/v1/auth/magic/consume',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'${t}'})});
 const j=await r.json();
 if(!r.ok){document.getElementById('msg').textContent=j.error.message;return;}
 req=j.requestId;
 secret=localStorage.getItem('ast-core:secret:'+req);
 document.getElementById('msg').textContent='Approved. '+(secret?'This is your requesting browser.':'Return to your requesting browser to finish sign-in.');
 if(secret){document.getElementById('finish').hidden=false;document.getElementById('totp').hidden=!j.totpRequired;}};
document.getElementById('go').onclick=async()=>{const b={requestId:req,requestSecret:secret};
 const code=document.getElementById('code').value; if(code)b.totpCode=code;
 const r=await fetch('/v1/auth/magic/finalize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
 const j=await r.json();document.getElementById('msg').textContent=r.ok?'Signed in as '+j.accountId:j.error.message;};
</script></main></body></html>`;
}

export function claimPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claim Forge enrollment</title><style>${css}</style></head><body><main>
<h1>Claim a Forge enrollment</h1>
<p class="muted">Enter the 8-character code your Forge printed. This binds the Forge's key to your account; the Forge operator still confirms the exact identity locally.</p>
<form id="f"><input id="code" type="text" required placeholder="ABCDEFGH" maxlength="8"><button type="submit">Claim</button></form>
<p id="msg" class="muted"></p>
<script>
document.getElementById('f').onsubmit=async e=>{e.preventDefault();
 const code=document.getElementById('code').value;
 const r=await fetch('/v1/machines/enrollments/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});
 const j=await r.json();document.getElementById('msg').textContent=r.ok?'Claimed '+j.enrollmentId+'. Confirm on the Forge.':j.error.message;};
</script></main></body></html>`;
}
