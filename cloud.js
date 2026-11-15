// 家族共有(Firebase 同期)。ログインしなくてもアプリは今までどおり動く。
// このファイルが読み込めない場合(オフラインの初回など)も、アプリ本体は端末内のデータで動作する。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut as fbSignOut, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDocs, addDoc, updateDoc, onSnapshot, query, where,
  arrayUnion, arrayRemove, writeBatch,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

// Firebase の設定値は公開されても問題ない値(守るのは Firestore のルールと API キーの制限)
const firebaseConfig = {
  apiKey: 'AIzaSyALwxHwIFnDJc1zGfBBlnEDzQgGLF1jddY',
  authDomain: 'kaimono-list-233cd.firebaseapp.com',
  projectId: 'kaimono-list-233cd',
  storageBucket: 'kaimono-list-233cd.firebasestorage.app',
  messagingSenderId: '735099589708',
  appId: '1:735099589708:web:0f87e6dda53945442390e9',
};

const COLS = ['lists', 'categories', 'items', 'purchases'];
const KEY = 'shopping-list-cloud-v1';
const BACKUP_KEY = 'shopping-list-v1-backup-prejoin';

let auth, db;
let user = null;
let hid = null;            // 参加している世帯ID
let hh = null;             // 世帯文書(members / invitedEmails / ownerUid)
let ready = false;         // 4つのコレクションを最初に受信し終えたか
let unsubs = [];
let synced = {};           // コレクション名 → Map(id → 正規化JSON)。サーバー側と同じと見なせる状態
let seen = new Set();
let discovery = { mine: null, invite: null };
let err = '';
let busy = false;

const hooks = () => window.AppHooks;
const emit = () => window.dispatchEvent(new Event('cloud-change'));
const setErr = (m) => { err = m || ''; emit(); };

// キー順を揃えた JSON(Firestore から返る順序とローカルの順序の違いで差分が出ないようにする)
const canon = (o) => {
  const p = JSON.parse(JSON.stringify(o));
  return JSON.stringify(Object.fromEntries(Object.keys(p).sort().map((k) => [k, p[k]])));
};
const loadHid = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}').hid || null; } catch (e) { return null; } };
const saveHid = (h) => { try { h ? localStorage.setItem(KEY, JSON.stringify({ hid: h })) : localStorage.removeItem(KEY); } catch (e) { /* 無視 */ } };

function errText(e) {
  const c = (e && e.code) || '';
  if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return '';
  if (c === 'auth/popup-blocked') return 'ポップアップがブロックされました。ブラウザの設定で許可してから、もう一度お試しください。';
  if (c === 'permission-denied') return '権限がありません。招待されたGoogleアカウントでログインしているか確認してください。';
  if (c === 'unavailable' || c === 'auth/network-request-failed') return '通信できませんでした。電波の状態を確認してください。';
  return '処理に失敗しました(' + (c || (e && e.message) || '不明') + ')';
}

// 並び順を保つための作成時刻。古いデータには付いていないので補う。
function ensureTs(S) {
  for (const c of ['lists', 'categories', 'items']) {
    const base = Date.now() - S[c].length;
    S[c].forEach((o, i) => { if (o.ts == null) o.ts = base + i; });
  }
}
const sortDocs = (c, docs) => docs.sort((a, b) =>
  c === 'purchases'
    ? String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id))
    : ((a.ts ?? 0) - (b.ts ?? 0)) || String(a.id).localeCompare(String(b.id)));

// ---------- 書き込み ----------
function commit(ops) {
  // 順序を保つため、待たずにすぐ発行する(オフラインでも端末内のキャッシュに入り、復帰後に反映される)
  const col = (c) => (id) => doc(db, 'households', hid, c, id);
  const jobs = [];
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    ops.slice(i, i + 400).forEach((op) => {
      const ref = col(op.c)(op.id);
      op.t === 'set' ? b.set(ref, op.data) : b.delete(ref);
    });
    jobs.push(b.commit());
  }
  const all = Promise.all(jobs);
  all.catch((e) => setErr(errText(e)));
  return all;
}

// ローカルの変更(app.js の persist から呼ばれる)を差分だけ送る
function onLocalChange(S) {
  if (!hid || !user || !ready) return;
  ensureTs(S);
  const ops = [];
  for (const c of COLS) {
    const cur = new Map(S[c].map((o) => [o.id, canon(o)]));
    for (const [id, s] of cur) if (synced[c].get(id) !== s) ops.push({ t: 'set', c, id, data: JSON.parse(s) });
    for (const id of synced[c].keys()) if (!cur.has(id)) ops.push({ t: 'del', c, id });
    synced[c] = cur;
  }
  if (ops.length) commit(ops);
}

// ---------- 受信 ----------
function stopListening() {
  unsubs.forEach((u) => { try { u(); } catch (e) { /* 無視 */ } });
  unsubs = []; ready = false; hh = null; seen = new Set(); synced = {};
}

function startListening() {
  stopListening();
  COLS.forEach((c) => { synced[c] = new Map(); });
  const onErr = async (e) => {
    if (e && e.code === 'permission-denied') {
      // 別のアカウントでログインした場合など。共有は止め、端末内のデータはそのまま使う。
      stopListening(); hid = null; saveHid(null); await discover();
    }
    setErr(errText(e));
  };
  unsubs.push(onSnapshot(doc(db, 'households', hid), (s) => { hh = s.exists() ? s.data() : null; emit(); }, onErr));
  for (const c of COLS) {
    unsubs.push(onSnapshot(collection(db, 'households', hid, c), (snap) => {
      // 端末のキャッシュが空のまま届いた最初の通知は、サーバーの内容ではないので反映しない
      if (snap.metadata.fromCache && snap.empty) return;
      const docs = sortDocs(c, snap.docs.map((d) => ({ ...d.data(), id: d.id })));
      synced[c] = new Map(docs.map((d) => [d.id, canon(d)]));
      hooks().applyRemote(c, docs);
      seen.add(c);
      if (!ready && seen.size === COLS.length) { ready = true; emit(); }
    }, onErr));
  }
  emit();
}

// ---------- 世帯の検出・作成・参加 ----------
async function discover() {
  discovery = { mine: null, invite: null };
  if (!user) return;
  try {
    // すでに共有に入っている端末では「自分の世帯」の検索は不要。招待は常に探す(別の共有への招待を知らせるため)。
    if (!hid) {
      const mine = await getDocs(query(collection(db, 'households'), where('members', 'array-contains', user.uid)));
      if (!mine.empty) discovery.mine = mine.docs[0].id;
    }
    const inv = await getDocs(query(collection(db, 'households'), where('invitedEmails', 'array-contains', user.email)));
    discovery.invite = inv.docs.map((d) => d.id).find((id) => id !== hid && id !== discovery.mine) || null;
  } catch (e) { err = errText(e); }
}

function backupLocal() {
  try { localStorage.setItem(BACKUP_KEY, JSON.stringify(hooks().getState())); } catch (e) { /* 無視 */ }
}

const allOps = (S) => COLS.flatMap((c) => S[c].map((o) => ({ t: 'set', c, id: o.id, data: JSON.parse(canon(o)) })));

async function run(fn) {
  if (busy) return;
  busy = true; err = ''; emit();
  try { await fn(); } catch (e) { err = errText(e); }
  busy = false; emit();
}

// 端末内のデータを、共有側へ追加する分だけ計算する(同じ名前はまとめて、重複は作らない)
function planMerge(local, remote) {
  const add = { lists: [], categories: [], items: [], purchases: [] };
  const byId = (arr) => new Map(arr.map((o) => [o.id, o]));
  const rLists = byId(remote.lists), rCats = byId(remote.categories), rItems = byId(remote.items), rPur = byId(remote.purchases);

  const listMap = new Map(), catMap = new Map(), itemMap = new Map(), purMap = new Map();
  let t = Date.now();
  for (const l of local.lists) {
    const same = rLists.get(l.id) || remote.lists.find((x) => x.name === l.name);
    if (same) { listMap.set(l.id, same.id); continue; }
    listMap.set(l.id, l.id); add.lists.push({ ...l, ts: l.ts ?? t++ });
  }
  const maxOrder = Math.max(-1, ...remote.categories.map((c) => c.order ?? 0));
  let extra = 0;
  for (const c of local.categories) {
    const same = rCats.get(c.id) || remote.categories.find((x) => x.name === c.name);
    if (same) { catMap.set(c.id, same.id); continue; }
    catMap.set(c.id, c.id); add.categories.push({ ...c, order: maxOrder + 1 + extra++, ts: c.ts ?? t++ });
  }
  const mapCat = (id) => (id ? (catMap.get(id) || '') : '');

  // 購入履歴(先に処理して、品目の lastPurchaseId の付け替えに使う)
  const rKeys = new Map(remote.purchases.map((p) => [(p.name || '') + '|' + p.date, p.id]));
  const localItemName = new Map(local.items.map((i) => [i.id, i.name]));
  const pending = [];
  for (const p of local.purchases) {
    if (rPur.has(p.id)) { purMap.set(p.id, p.id); continue; }
    const name = p.name || localItemName.get(p.itemId) || '';
    const dup = rKeys.get(name + '|' + p.date);
    if (dup) { purMap.set(p.id, dup); continue; }
    purMap.set(p.id, p.id);
    pending.push({ ...p, name, categoryId: mapCat(p.categoryId) });
  }

  for (const i of local.items) {
    const listId = listMap.get(i.listId);
    if (!listId) continue;
    if (rItems.has(i.id)) { itemMap.set(i.id, i.id); continue; }
    const same = remote.items.find((x) => x.listId === listId && x.name === i.name);
    if (same) { itemMap.set(i.id, same.id); continue; }
    itemMap.set(i.id, i.id);
    add.items.push({ ...i, listId, categoryId: mapCat(i.categoryId), ts: i.ts ?? t++, lastPurchaseId: i.lastPurchaseId ? (purMap.get(i.lastPurchaseId) || null) : null });
  }
  pending.forEach((p) => add.purchases.push({ ...p, itemId: itemMap.get(p.itemId) || p.itemId }));
  return add;
}

async function fetchRemote() {
  const out = {};
  for (const c of COLS) {
    const snap = await getDocs(collection(db, 'households', hid, c));
    out[c] = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  }
  return out;
}

const api = {
  available: true,
  state() {
    return {
      signedIn: !!user, email: user ? user.email : '',
      joined: !!(hid && user), ready, busy, error: err,
      members: hh && hh.members ? hh.members.length : 0,
      isOwner: !!(hh && user && hh.ownerUid === user.uid),
      invited: hh && hh.invitedEmails ? hh.invitedEmails : [],
      mine: discovery.mine, invite: discovery.invite,
    };
  },
  onLocalChange,

  signIn() {
    return run(async () => {
      try { await signInWithPopup(auth, new GoogleAuthProvider()); }
      catch (e) { err = errText(e); }
    });
  },
  signOut() {
    return run(async () => { stopListening(); discovery = { mine: null, invite: null }; await fbSignOut(auth); });
  },

  // 共有を始める(自分の端末のデータをすべて共有に追加)
  createHousehold() {
    return run(async () => {
      if (!user) return;
      backupLocal();
      const S = hooks().getState();
      ensureTs(S);
      const ref = await addDoc(collection(db, 'households'), { ownerUid: user.uid, members: [user.uid], invitedEmails: [] });
      hid = ref.id; saveHid(hid);
      await commit(allOps(S));
      startListening();
    });
  },

  // 招待を受けて参加 / すでに参加しているアカウントでこの端末を使い始める。merge=true で端末のデータを共有に追加。
  join(targetHid, merge) {
    return run(async () => {
      if (!user) return;
      backupLocal();
      if (discovery.invite === targetHid) {
        await updateDoc(doc(db, 'households', targetHid), { members: arrayUnion(user.uid), invitedEmails: arrayRemove(user.email) });
      }
      stopListening(); // いまの共有から、参加先の共有へ移る
      hid = targetHid; saveHid(hid);
      if (merge) {
        const S = hooks().getState();
        ensureTs(S);
        const add = planMerge(S, await fetchRemote());
        await commit(allOps(add));
      }
      discovery = { mine: targetHid, invite: null };
      startListening();
    });
  },

  invite(email) {
    return run(async () => {
      const e = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { err = 'メールアドレスの形式を確認してください。'; return; }
      await updateDoc(doc(db, 'households', hid), { invitedEmails: arrayUnion(e) });
    });
  },
  uninvite(email) {
    return run(async () => { await updateDoc(doc(db, 'households', hid), { invitedEmails: arrayRemove(email) }); });
  },

  // この端末での同期を止める(端末内のデータは最後の状態のまま残る)
  leave() {
    return run(async () => { stopListening(); hid = null; saveHid(null); await discover(); });
  },
};

try {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  window.Cloud = api;
  onAuthStateChanged(auth, async (u) => {
    user = u;
    if (!u) { stopListening(); discovery = { mine: null, invite: null }; emit(); return; }
    hid = loadHid();
    if (hid) startListening();
    await discover();
    emit();
  });
} catch (e) {
  console.error('共有機能を初期化できませんでした', e);
}
emit();
