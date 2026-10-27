// Legacy UI entries. The canonical flows live in the portal SPA; these
// routes only redirect there or explain unavailability. There is NO
// JavaScript and NO form that mutates auth state: the emailed GET link
// never consumes, and approval/finalize happen exclusively through the
// versioned JSON API (same consume/finalize the SPA uses).

const css = `body{font-family:system-ui,sans-serif;background:#101014;color:#e8e8ea;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:26rem;width:100%;padding:2rem;background:#1a1a20;border:1px solid #2c2c34;border-radius:.75rem}h1{font-size:1.1rem;margin:0 0 1rem}p{font-size:.9rem;line-height:1.5}.muted{color:#9a9aa3}.err{color:#ff9a9a}`;

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body><main>${body}</main></body></html>`;
}

export function unavailable_page(): string {
  return shell(
    "Portal unavailable",
    `<h1>Portal unavailable</h1><p class="muted">The account portal is not deployed on this instance. Use the API directly.</p>`,
  );
}

export function confirm_page(): string {
  return shell(
    "Approve sign-in",
    `<h1>Approve this sign-in?</h1>
<p class="muted">Opening this link never signs anyone in by itself: mail scanners that merely open links approve nothing. To approve, open this link in a browser with the portal and follow the approval there.</p>`,
  );
}
