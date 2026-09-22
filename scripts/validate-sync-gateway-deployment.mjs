// Deployment validation for the deployed mineral-sync-gateway.
// The token is read from a file path passed as argv[2]; it is never printed.
import { readFileSync } from "node:fs";

const base = process.argv[2];
const tokenPath = process.argv[3];
const token = readFileSync(tokenPath, "utf8").trim();
const headers = { Authorization: `Bearer ${token}` };
const channel = "A".repeat(43);
const results = [];
const record = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

const generation = async () => (await (await fetch(`${base}/v1/channels/${channel}`, { headers })).json()).generation;

// 1. unauthenticated is rejected before any Durable Object is addressed
const unauth = await fetch(`${base}/v1/channels/${channel}`);
record("unauthenticated GET rejected", unauth.status === 401, `HTTP ${unauth.status}`);

// 2. authenticated GET returns a generation
const before = await generation();
record("authenticated GET returns generation", /^\d+$/.test(before), `generation=${before}`);

// 3. markDirty advances the generation
const marked = await (await fetch(`${base}/v1/channels/${channel}/dirty`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ source: "obsidian", kind: "upsert" }) })).json();
const after = await generation();
record("markDirty advances generation", BigInt(marked.generation) > BigInt(before) && after === marked.generation, `${before} -> ${after}`);

// 4. a ticket can be minted and a socket can authenticate with it alone
const ticketResponse = await fetch(`${base}/v1/channels/${channel}/ticket`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
const ticket = await ticketResponse.json();
record("ticket issued", ticketResponse.status === 200 && typeof ticket.ticket === "string" && ticket.expiresAt > Date.now(), `protocol=${ticket.protocol}`);
record("ticket does not contain the token", !String(ticket.ticket).includes(token));
const unauthTicket = await fetch(`${base}/v1/channels/${channel}/ticket`, { method: "POST" });
record("ticket endpoint requires auth", unauthTicket.status === 401, `HTTP ${unauthTicket.status}`);

const wsBase = `${base.replace(/^https:/, "wss:")}/v1/channels/${channel}/subscribe?ticket=${encodeURIComponent(ticket.ticket)}`;
const snapshot = await new Promise((resolve) => {
  const socket = new WebSocket(wsBase);
  const timer = setTimeout(() => { try { socket.close(); } catch {} resolve({ error: "timeout" }); }, 15000);
  socket.onmessage = (event) => { clearTimeout(timer); resolve({ socket, data: JSON.parse(String(event.data)) }); };
  socket.onerror = () => { clearTimeout(timer); resolve({ error: "error" }); };
});
record("WS connects with a ticket alone", !snapshot.error, snapshot.error ?? "");
if (!snapshot.error) {
  record("WS initial snapshot is current-generation", snapshot.data.type === "current-generation" && /^\d+$/.test(snapshot.data.generation), JSON.stringify(snapshot.data));

  // 5. markDirty reaches the socket as remote-dirty
  const advancement = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: "timeout" }), 15000);
    snapshot.socket.onmessage = (event) => { clearTimeout(timer); resolve({ data: JSON.parse(String(event.data)) }); };
  });
  await fetch(`${base}/v1/channels/${channel}/dirty`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
  const advanced = await advancement;
  record("markDirty reaches the socket as remote-dirty", !advanced.error && advanced.data.type === "remote-dirty", advanced.error ?? JSON.stringify(advanced.data));
  try { snapshot.socket.close(); } catch {}
}

// 6. a bogus ticket never reaches a Durable Object (the socket is refused)
const forged = await new Promise((resolve) => {
  const socket = new WebSocket(`${wsBase.split("?")[0]}?ticket=forged`);
  const timer = setTimeout(() => { try { socket.close(); } catch {} resolve("timeout"); }, 15000);
  socket.onmessage = () => { clearTimeout(timer); try { socket.close(); } catch {} resolve("message"); };
  socket.onerror = () => { clearTimeout(timer); resolve("error"); };
  socket.onclose = () => { clearTimeout(timer); resolve("closed"); };
});
record("forged ticket rejected", forged === "error" || forged === "closed", `outcome=${forged}`);

// 7. a non-subscribe route still rejects a ticket (ticket scope is WebSocket-only)
const scopedTicket = await fetch(`${base}/v1/channels/${channel}?ticket=${encodeURIComponent(ticket.ticket)}`);
record("ticket cannot authorize HTTP reads", scopedTicket.status === 401, `HTTP ${scopedTicket.status}`);

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
