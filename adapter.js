/* Runs the quiz outside Claude: live sync over Supabase Realtime (broadcast + presence),
   questions and game state saved in the host's own browser, pictures in IndexedDB.
   Exposes the same small `claude.use(name)` surface the quiz code was written against. */
(() => {
  "use strict";
  const CFG = window.QUIZ_CONFIG || {};
  const isHost = location.hash === "#host";
  const myId = Math.random().toString(36).slice(2, 12);
  window.__imgs = {};      // image id -> data URL (full size on the host, phone size on phones)
  window.__imgsSmall = {}; // host only: image id -> phone-size data URL

  // ---------- pictures (host): IndexedDB ----------
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open("retreat-quiz", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("imgs");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("imgs", mode); const out = fn(t.objectStore("imgs")); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); };
    return {
      put: (id, v) => tx("readwrite", (s) => s.put(v, id)),
      all: async () => { const db = await open(); return new Promise((res, rej) => { const out = {}; const t = db.transaction("imgs", "readonly"); const c = t.objectStore("imgs").openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } }; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); }); },
    };
  })();
  const toDataURL = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
  async function resize(blob, max, q) {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", q);
  }
  const assets = {
    async upload(blob) {
      const id = "img" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const full = await resize(blob, 1600, 0.85).catch(() => toDataURL(blob));
      const small = await resize(blob, 640, 0.6).catch(() => full);
      await idb.put(id, { full, small });
      window.__imgs[id] = full; window.__imgsSmall[id] = small;
      return { id };
    },
    async importAll(map) { for (const [id, v] of Object.entries(map || {})) { if (!v || !v.full) continue; await idb.put(id, v); window.__imgs[id] = v.full; window.__imgsSmall[id] = v.small || v.full; } },
    exportAll(ids) { const out = {}; for (const id of ids) if (window.__imgs[id]) out[id] = { full: window.__imgs[id], small: window.__imgsSmall[id] }; return out; },
  };

  // ---------- saved data (host): localStorage documents ----------
  const db = {
    doc(path) {
      const key = "retreat-quiz:" + path;
      const read = () => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } };
      const snap = () => { const d = read(); return { exists: !!d, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } }; };
      return {
        get: async () => snap(),
        set: async (d) => { localStorage.setItem(key, JSON.stringify(d)); },
        onSnapshot: (next) => { setTimeout(() => next(snap()), 0); return () => {}; },
      };
    },
  };

  const user = { canEdit: async () => isHost };

  // ---------- live room: Supabase Realtime ----------
  function makeRoom() {
    if (!window.supabase || !CFG.supabaseUrl || !CFG.supabaseKey || /PASTE/.test(CFG.supabaseUrl + CFG.supabaseKey)) return null;
    const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: false } });
    const ch = sb.channel("quiz-" + (CFG.room || "main"), { config: { broadcast: { self: false }, presence: { key: myId } } });
    const topicH = {}, peerH = [], connH = [];
    let connected = false, myPres = {}, lastKeys = new Set(), peerList = [];
    const setConn = (c) => { if (c !== connected) { connected = c; connH.forEach((f) => f(c)); } };

    ch.on("broadcast", { event: "*" }, (msg) => {
      (topicH[msg.event] || []).forEach((f) => { try { f({ topic: msg.event, data: msg.payload, isMe: false, sameTab: false, kind: "viewer", guest: false, by: null, peer: "" }); } catch (e) { console.error(e); } });
    });
    ch.on("presence", { event: "sync" }, () => {
      const st = ch.presenceState();
      const keys = Object.keys(st);
      const list = keys.map((k) => { const metas = st[k] || []; const m = { ...(metas[metas.length - 1] || {}) }; delete m.presence_ref; return Object.freeze({ peer: k, isMe: k === myId, sameTab: k === myId, by: null, kind: "viewer", guest: false, presence: Object.freeze(m), updatedAt: Date.now() }); });
      const joined = list.filter((p) => !lastKeys.has(p.peer));
      const left = [...lastKeys].filter((k) => !keys.includes(k)).map((k) => ({ peer: k }));
      lastKeys = new Set(keys); peerList = Object.freeze(list);
      peerH.forEach((f) => { try { f({ peers: peerList, joined, left, updated: list }); } catch (e) { console.error(e); } });
    });
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") { setConn(true); ch.track(myPres).catch(() => {}); }
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setConn(false);
    });

    let trackTimer = null;
    return {
      emit: async (topic, data) => { if (!connected) return; await ch.send({ type: "broadcast", event: topic, payload: data }); },
      on: (topic, fn) => { (topicH[topic] = topicH[topic] || []).push(fn); return () => { topicH[topic] = topicH[topic].filter((f) => f !== fn); }; },
      presence: async (patch) => {
        for (const [k, v] of Object.entries(patch)) { if (v === null) delete myPres[k]; else myPres[k] = v; }
        clearTimeout(trackTimer);
        trackTimer = setTimeout(() => { if (connected) ch.track(myPres).catch(() => {}); }, 150);
      },
      peers: () => peerList,
      onPeers: (fn) => { peerH.push(fn); return () => {}; },
      connected: () => connected,
      onConnection: (fn) => { connH.push(fn); setTimeout(() => fn(connected), 0); return () => {}; },
    };
  }

  let ready = null;
  const init = () => ready || (ready = (async () => {
    if (isHost) { try { const all = await idb.all(); for (const [id, v] of Object.entries(all)) { window.__imgs[id] = v.full; window.__imgsSmall[id] = v.small || v.full; } } catch {} }
    return { user, db: isHost ? db : null, assets: isHost ? assets : null, room: makeRoom() };
  })());
  window.claude = { use: async (name) => (await init())[name] || null };
})();
