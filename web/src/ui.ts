// Tiny DOM helpers. All interpolated text uses textContent (never
// inner_html with untrusted data); the only HTML built as strings is static
// page chrome written by us.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<string | Node>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/** Short human time, or "—" for null. Never throws on bad input. */
export function when(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString();
}

/** Copyable one-line identifier. */
export function id_span(id: string): HTMLElement {
  return el("span", { class: "mono" }, id);
}
