(() => {
  let S = Store.load();
  const uid = Store.uid;
  const $ = (s) => document.querySelector(s);
  const dlg = $('#dlg');
  const DAY = 86400000;

  // ---------- helpers ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
  const persist = () => Store.save(S);
  const cats = () => [...S.categories].sort((a, b) => a.order - b.order);
  const catName = (id) => (S.categories.find((c) => c.id === id) || { name: '未分類' }).name;
  const item = (id) => S.items.find((i) => i.id === id);
  const total = (p) => (p.unitPrice == null ? null : p.unitPrice * p.qty);
  const pad = (n) => String(n).padStart(2, '0');
  const dateVal = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const fmtDate = (iso) => { const d = new Date(iso); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
  const parsePrice = (v) => { const n = parseFloat(v); return v === '' || isNaN(n) || n < 0 ? null : n; };
  const daysAgo = (iso) => Math.floor((startOfDay(new Date()) - startOfDay(new Date(iso))) / DAY);
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

  // 購入サイクルと価格の統計
  // 購入履歴は品目名でまとめる(削除して再登録した品目や、別リストの同名品目も同じ履歴として扱う)
  const pkey = (p) => { const it = item(p.itemId); return it ? it.name : p.name; };
  const stats = (itemId) => statsByName(item(itemId).name);
  function statsByName(name) {
    const ps = S.purchases.filter((p) => pkey(p) === name).sort((a, b) => new Date(a.date) - new Date(b.date));
    const last = ps[ps.length - 1];
    let avgInterval = null;
    if (ps.length >= 2) {
      let sum = 0;
      for (let i = 1; i < ps.length; i++) sum += (startOfDay(new Date(ps[i].date)) - startOfDay(new Date(ps[i - 1].date))) / DAY;
      avgInterval = sum / (ps.length - 1);
    }
    let next = null;
    if (last && avgInterval != null) next = new Date(startOfDay(new Date(last.date)) + Math.round(avgInterval) * DAY);
    const priced = ps.filter((p) => p.unitPrice != null);
    const avgPrice = priced.length ? priced.reduce((s, p) => s + p.unitPrice, 0) / priced.length : null;
    const latestPrice = priced.length ? priced[priced.length - 1].unitPrice : null;
    return { ps, last, avgInterval, next, avgPrice, latestPrice };
  }
  function nextText(next) {
    const diff = Math.round((next.getTime() - startOfDay(new Date())) / DAY);
    if (diff > 0) return `${fmtDate(next)}(あと${diff}日)`;
    if (diff === 0) return `${fmtDate(next)}(今日)`;
    return `${fmtDate(next)}(${-diff}日超過)`;
  }

  // 買う時期が来ているのに、現在のリストにない品目
  function dueList() {
    const inList = new Set(S.items.filter((i) => i.listId === S.currentListId).map((i) => i.name));
    const today = startOfDay(new Date());
    const res = [];
    for (const name of new Set(S.purchases.map(pkey))) {
      if (inList.has(name)) continue;
      const st = statsByName(name);
      if (!st.next || st.avgInterval < 1) continue;
      const diff = Math.round((st.next.getTime() - today) / DAY);
      if (diff <= 0) res.push({ name, diff, last: st.last });
    }
    return res.sort((a, b) => a.diff - b.diff);
  }

  function addItem(name, categoryId, qty, memo) {
    S.items.push({
      id: uid(), listId: S.currentListId, categoryId: S.categories.some((c) => c.id === categoryId) ? categoryId : '',
      name, qty: Math.max(1, qty || 1), memo: memo || '', checked: false, lastPurchaseId: null,
    });
  }

  // 入力補完用: 品目名 → 最後に使ったカテゴリ
  function knownNames() {
    const m = new Map();
    S.purchases.forEach((p) => m.set(pkey(p), p.categoryId || ''));
    S.items.forEach((i) => m.set(i.name, i.categoryId || ''));
    return m;
  }

  // ---------- main render ----------
  function render() {
    // list select
    const sel = $('#listSelect');
    sel.innerHTML = S.lists.map((l) => `<option value="${l.id}" ${l.id === S.currentListId ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
    // add form category
    const ac = $('#addCat');
    const hadOptions = ac.options.length > 0;
    const prev = ac.value;
    ac.innerHTML = cats().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('') + '<option value="">未分類</option>';
    if (hadOptions && (prev === '' || S.categories.some((c) => c.id === prev))) ac.value = prev;
    // 入力補完の候補
    $('#nameList').innerHTML = [...knownNames().keys()].map((n) => `<option value="${esc(n)}">`).join('');
    $('#sortSelect').value = S.sort || 'category';

    const q = $('#search').value.trim().toLowerCase();
    const sort = S.sort || 'category';
    const all = S.items.filter((i) => i.listId === S.currentListId);
    let items = q ? all.filter((i) => (i.name + ' ' + (i.memo || '')).toLowerCase().includes(q)) : all;
    // 並べ替え(追加順は配列の順序を使う)
    if (sort === 'name') items = [...items].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    else if (sort === 'new') items = [...items].reverse();
    const open = items.filter((i) => !i.checked);
    const done = items.filter((i) => i.checked);

    // そろそろ買う品目(検索中は非表示)
    const due = q ? [] : dueList();
    $('#due').innerHTML = due.length ? `<h2 class="group">そろそろ買う品目</h2><div class="card due">${due.map((d) => `
      <div class="row"><div class="body"><div class="name">${esc(d.name)}</div>
        <div class="sub">前回 ${daysAgo(d.last.date)}日前 ・ ${d.diff === 0 ? '今日が目安' : `目安から${-d.diff}日超過`}</div></div>
        <button class="readd" data-action="due-add" data-name="${esc(d.name)}">追加</button></div>`).join('')}
      ${due.length > 1 ? '<div class="row"><button class="readd" style="margin-left:auto" data-action="due-all">すべて追加</button></div>' : ''}</div>` : '';

    const row = (i) => {
      const st = stats(i.id);
      const bits = [];
      if (i.memo) bits.push(esc(i.memo));
      if (st.last) bits.push(`前回 ${daysAgo(st.last.date)}日前`);
      if (st.next && !i.checked) {
        const diff = Math.round((st.next.getTime() - startOfDay(new Date())) / DAY);
        if (diff <= 0) bits.push('そろそろ購入時期');
      }
      return `<div class="row ${i.checked ? 'done' : ''}">
        <button class="check" data-action="toggle" data-id="${i.id}" aria-label="購入済み切替"></button>
        <button class="body" data-action="detail" data-id="${i.id}">
          <div class="name">${esc(i.name)}</div>
          ${bits.length ? `<div class="sub">${bits.join(' ・ ')}</div>` : ''}
        </button>
        <span class="qty">×${i.qty}</span>
        ${i.checked ? `<button class="readd" data-action="readd-one" data-id="${i.id}">再追加</button>` : ''}
      </div>`;
    };

    let html = '';
    if (sort === 'category') {
      const groups = [...cats().map((c) => ({ id: c.id, name: c.name })), { id: '', name: '未分類' }];
      for (const g of groups) {
        const rows = open.filter((i) => (i.categoryId || '') === g.id);
        if (rows.length) html += `<h2 class="group">${esc(g.name)}</h2><div class="card">${rows.map(row).join('')}</div>`;
      }
    } else if (open.length) {
      html += `<h2 class="group">未購入</h2><div class="card">${open.map(row).join('')}</div>`;
    }
    if (done.length) html += `<h2 class="group">購入済み</h2><div class="card">${done.map(row).join('')}</div>`;
    if (!items.length) html = q ? '<p class="empty">該当する品目がありません。</p>' : '<p class="empty">品目がありません。上のフォームから追加してください。</p>';
    $('#list').innerHTML = html;

    // footer
    const allDone = all.filter((i) => i.checked);
    let sum = 0;
    for (const i of allDone) {
      const p = S.purchases.find((x) => x.id === i.lastPurchaseId);
      if (p && total(p) != null) sum += total(p);
    }
    $('#total').textContent = yen(sum);
    const rb = $('#readdBtn');
    rb.disabled = !allDone.length;
    rb.textContent = allDone.length ? `購入済みを再追加 (${allDone.length})` : '購入済みを再追加';
  }

  // ---------- dialogs ----------
  function openDlg(html) {
    dlg.innerHTML = html;
    if (!dlg.open) dlg.showModal();
  }
  const closeDlg = () => { if (dlg.open) dlg.close(); render(); };
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDlg(); });
  dlg.addEventListener('close', render);

  function catOptions(sel) {
    return cats().map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('') +
      `<option value="" ${!sel ? 'selected' : ''}>未分類</option>`;
  }

  // 購入チェック時の金額入力
  function openPriceDlg(id) {
    const it = item(id);
    const st = stats(id);
    const hint = st.latestPrice != null ? `前回 ${yen(st.latestPrice)}` : '任意';
    openDlg(`<h3>${esc(it.name)} を購入</h3>
      <div class="field"><label>単価(円・任意)</label>
        <input id="pPrice" type="number" min="0" step="any" inputmode="decimal" placeholder="${esc(hint)}" value="${st.latestPrice != null ? st.latestPrice : ''}"></div>
      <div class="note">数量 ×${it.qty} <span id="pSum"></span></div>
      <div class="actions">
        <button data-action="cancel">キャンセル</button>
        <button data-action="buy" data-id="${id}" data-skip="1">金額なしで記録</button>
        <button class="primary" data-action="buy" data-id="${id}">記録</button>
      </div>`);
    const upd = () => {
      const p = parsePrice($('#pPrice').value);
      $('#pSum').textContent = p != null ? `= 合計 ${yen(p * it.qty)}` : '';
    };
    $('#pPrice').addEventListener('input', upd); upd();
    setTimeout(() => $('#pPrice').select(), 0);
  }

  function buy(id, skip) {
    const it = item(id);
    const price = skip ? null : parsePrice($('#pPrice').value);
    const p = { id: uid(), itemId: id, name: it.name, categoryId: it.categoryId, date: new Date().toISOString(), qty: it.qty, unitPrice: price };
    S.purchases.push(p);
    it.checked = true;
    it.lastPurchaseId = p.id;
    persist(); closeDlg();
  }

  function uncheck(id) {
    const it = item(id);
    S.purchases = S.purchases.filter((p) => p.id !== it.lastPurchaseId);
    it.checked = false; it.lastPurchaseId = null;
    persist(); render();
  }

  function openDetail(id) {
    const it = item(id);
    if (!it) return closeDlg();
    const st = stats(id);
    const hist = [...st.ps].reverse().map((p) => `<div class="hist">
        <input type="date" value="${dateVal(p.date)}" data-change="p-date" data-pid="${p.id}" data-id="${id}">
        <input type="number" min="0" step="any" inputmode="decimal" placeholder="単価" value="${p.unitPrice ?? ''}" data-change="p-price" data-pid="${p.id}" data-id="${id}">
        <button class="danger" data-action="p-del" data-pid="${p.id}" data-id="${id}" aria-label="履歴削除">✕</button>
      </div>`).join('');
    openDlg(`<h3>品目の詳細</h3>
      <div class="field"><label>品目名</label><input id="dName" value="${esc(it.name)}"></div>
      <div class="field"><label>数量</label><input id="dQty" type="number" min="1" value="${it.qty}" inputmode="numeric"></div>
      <div class="field"><label>カテゴリ</label><select id="dCat">${catOptions(it.categoryId)}</select></div>
      <div class="field"><label>メモ</label><input id="dMemo" value="${esc(it.memo)}"></div>
      <h4>購入サイクルと価格</h4>
      <div class="stats">
        <div class="stat"><span>前回購入日</span><b>${st.last ? `${fmtDate(st.last.date)}(${daysAgo(st.last.date)}日前)` : '—'}</b></div>
        <div class="stat"><span>平均購入間隔</span><b>${st.avgInterval != null ? `${Math.round(st.avgInterval * 10) / 10}日ごと` : '—'}</b></div>
        <div class="stat"><span>次回購入の目安</span><b>${st.next ? nextText(st.next) : '—'}</b></div>
        <div class="stat"><span>購入回数</span><b>${st.ps.length}回</b></div>
        <div class="stat"><span>平均単価</span><b>${st.avgPrice != null ? yen(st.avgPrice) : '—'}</b></div>
        <div class="stat"><span>最新単価</span><b>${st.latestPrice != null ? yen(st.latestPrice) : '—'}</b></div>
      </div>
      <h4>購入履歴(日付・単価は修正できます)</h4>
      ${hist || '<div class="note">まだ購入履歴がありません。</div>'}
      <div class="actions">
        <button class="danger" data-action="del-item" data-id="${id}">削除</button>
        <button data-action="cancel">閉じる</button>
        <button class="primary" data-action="save-item" data-id="${id}">保存</button>
      </div>`);
  }

  function openSpend(ym) {
    const now = new Date();
    if (!ym) ym = { y: now.getFullYear(), m: now.getMonth() };
    const ps = S.purchases.filter((p) => { const d = new Date(p.date); return d.getFullYear() === ym.y && d.getMonth() === ym.m; });
    const priced = ps.filter((p) => total(p) != null);
    const sum = priced.reduce((s, p) => s + total(p), 0);
    const by = new Map();
    for (const p of priced) { const k = p.categoryId && S.categories.some((c) => c.id === p.categoryId) ? p.categoryId : ''; by.set(k, (by.get(k) || 0) + total(p)); }
    const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
    const max = rows.length ? rows[0][1] : 1;
    const prev = ym.m === 0 ? { y: ym.y - 1, m: 11 } : { y: ym.y, m: ym.m - 1 };
    const next = ym.m === 11 ? { y: ym.y + 1, m: 0 } : { y: ym.y, m: ym.m + 1 };
    const noPrice = ps.length - priced.length;
    openDlg(`<h3>月別の支出</h3>
      <div class="monthnav">
        <button data-action="spend" data-y="${prev.y}" data-m="${prev.m}">◀</button>
        <strong>${ym.y}年${ym.m + 1}月</strong>
        <button data-action="spend" data-y="${next.y}" data-m="${next.m}">▶</button>
      </div>
      <div class="big">${yen(sum)}</div>
      ${rows.map(([k, v]) => `<div class="spendrow"><div class="l"><span>${esc(k ? catName(k) : '未分類')}</span><span>${yen(v)}</span></div><div class="bar" style="width:${Math.max(2, (v / max) * 100)}%"></div></div>`).join('') || '<div class="note">この月の金額付き購入はありません。</div>'}
      ${noPrice ? `<div class="note">金額未入力の購入 ${noPrice}件は集計に含まれません。</div>` : ''}
      <div class="actions"><button data-action="cancel">閉じる</button></div>`);
  }

  function openSettings() {
    const cs = cats();
    openDlg(`<h3>設定</h3>
      <h4>リスト</h4>
      ${S.lists.map((l) => `<div class="inline" style="grid-template-columns:1fr 44px">
        <input value="${esc(l.name)}" data-change="list-name" data-id="${l.id}">
        <button class="danger" data-action="list-del" data-id="${l.id}" ${S.lists.length < 2 ? 'disabled' : ''} aria-label="リスト削除">✕</button></div>`).join('')}
      <div class="inline" style="grid-template-columns:1fr auto"><input id="newList" placeholder="新しいリスト名"><button data-action="list-add">追加</button></div>
      <h4>カテゴリ</h4>
      ${cs.map((c, i) => `<div class="inline cat">
        <input value="${esc(c.name)}" data-change="cat-name" data-id="${c.id}">
        <button data-action="cat-up" data-id="${c.id}" ${i === 0 ? 'disabled' : ''} aria-label="上へ">↑</button>
        <button data-action="cat-down" data-id="${c.id}" ${i === cs.length - 1 ? 'disabled' : ''} aria-label="下へ">↓</button>
        <button class="danger" data-action="cat-del" data-id="${c.id}" aria-label="カテゴリ削除">✕</button></div>`).join('')}
      <div class="inline" style="grid-template-columns:1fr auto"><input id="newCat" placeholder="新しいカテゴリ名"><button data-action="cat-add">追加</button></div>
      <div class="note">カテゴリを削除すると、その品目は「未分類」になります。</div>
      <h4>バックアップ</h4>
      <div class="inline" style="grid-template-columns:1fr 1fr">
        <button data-action="export">書き出す</button>
        <button data-action="import">読み込む</button>
      </div>
      <div class="note">データはこの端末のブラウザ内にだけ保存されています。機種変更やブラウザのデータ削除に備えて、ときどき書き出してください。読み込むと現在のデータは置き換わります。</div>
      <div class="actions"><button class="primary" data-action="cancel">閉じる</button></div>`);
  }

  // ---------- テキスト共有 ----------
  function shareText() {
    const list = S.lists.find((l) => l.id === S.currentListId);
    const open = S.items.filter((i) => i.listId === S.currentListId && !i.checked);
    const lines = [`【${list ? list.name : '買い物リスト'}】`];
    const fmt = (i) => `・${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}${i.memo ? `(${i.memo})` : ''}`;
    for (const g of [...cats().map((c) => ({ id: c.id, name: c.name })), { id: '', name: '未分類' }]) {
      const rows = open.filter((i) => (i.categoryId || '') === g.id);
      if (rows.length) { lines.push(`■${g.name}`); rows.forEach((i) => lines.push(fmt(i))); }
    }
    if (!open.length) lines.push('(未購入の品目はありません)');
    return lines.join('\n');
  }

  // ---------- 共有されたテキストの取り込み ----------
  let importRows = [];

  // 共有テキスト(【リスト名】/■カテゴリ/・品目 ×数量(メモ))を解析する。箇条書きなしの行も品目として扱う。
  function parseShared(text) {
    const rows = [];
    let categoryId = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^【.*】$/.test(line) || /^[(（].*ありません.*[)）]$/.test(line)) continue;
      if (/^[■□◆▼]/.test(line)) {
        const c = S.categories.find((x) => x.name === line.replace(/^[■□◆▼]\s*/, '').trim());
        categoryId = c ? c.id : '';
        continue;
      }
      const body = line.replace(/^[・•●\-*]\s*/, '');
      const m = body.match(/^(.*?)\s*(?:[×xX]\s*(\d+))?\s*(?:[(（](.*)[)）])?$/);
      const name = m && m[1].trim();
      if (!name) continue;
      rows.push({ name, qty: Math.max(1, parseInt(m[2], 10) || 1), memo: (m[3] || '').trim(), categoryId });
    }
    return rows;
  }

  function openImport() {
    openDlg(`<h3>共有されたリストを取り込む</h3>
      <div class="field"><label>共有されたテキストを貼り付けてください</label>
        <textarea id="importText" rows="10" placeholder="【買い物リスト】&#10;■乳製品・卵&#10;・牛乳 ×2"></textarea></div>
      <div class="note">今開いているリストに追加します。次の画面で内容を確認できます。</div>
      <div class="actions">
        <button data-action="open-share">戻る</button>
        <button class="primary" data-action="text-parse">内容を確認</button>
      </div>`);
    setTimeout(() => $('#importText').focus(), 0);
  }

  function openImportPreview(text) {
    importRows = parseShared(text);
    // 同じ名前の未購入品目がすでにリストにある場合や、貼り付けた中で重複する場合はスキップ
    const existing = new Set(S.items.filter((i) => i.listId === S.currentListId && !i.checked).map((i) => i.name));
    const seen = new Set();
    importRows.forEach((r) => { r.skip = existing.has(r.name) ? 'リストにあるためスキップ' : seen.has(r.name) ? '重複のためスキップ' : ''; seen.add(r.name); });
    const body = importRows.length
      ? importRows.map((r, i) => `<label class="imp">
          <input type="checkbox" data-imp="${i}" ${r.skip ? 'disabled' : 'checked'}>
          <span>${esc(r.name)} ×${r.qty}${r.memo ? `(${esc(r.memo)})` : ''}<br>
            <small class="note">${esc(r.categoryId ? catName(r.categoryId) : '未分類')}${r.skip ? ` ・ ${r.skip}` : ''}</small></span></label>`).join('')
      : '<div class="note">取り込める品目が見つかりませんでした。</div>';
    const n = importRows.filter((r) => !r.skip).length;
    openDlg(`<h3>取り込む品目を確認</h3>${body}
      <div class="note">一致するカテゴリがない品目は「未分類」になります。</div>
      <div class="actions">
        <button data-action="open-text-import">戻る</button>
        <button class="primary" data-action="text-run" ${n ? '' : 'disabled'}>取り込む</button>
      </div>`);
  }

  function openShare() {
    openDlg(`<h3>リストの共有・取り込み</h3>
      <div class="field"><textarea id="shareText" rows="10" readonly>${esc(shareText())}</textarea></div>
      <div class="note" id="shareMsg">未購入の品目をテキストにしました。</div>
      <div class="actions">
        <button data-action="open-text-import">取り込む</button>
        <button data-action="cancel">閉じる</button>
        <button data-action="copy">コピー</button>
        ${navigator.share ? '<button class="primary" data-action="share">共有</button>' : ''}
      </div>`);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = $('#shareText'); ta.select();
      try { return document.execCommand('copy'); } catch (e2) { return false; }
    }
  }

  // ---------- バックアップ ----------
  function exportData() {
    const d = new Date();
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `shopping-list-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importData(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { alert('ファイルを読み込めませんでした。'); return; }
    const ok = data && ['lists', 'categories', 'items', 'purchases'].every((k) => Array.isArray(data[k])) && data.lists.length > 0;
    if (!ok) { alert('買い物リストのバックアップファイルではありません。'); return; }
    if (!confirm(`バックアップを読み込みます。現在のデータは置き換わります。\n(品目${data.items.length}件、購入履歴${data.purchases.length}件)`)) return;
    if (!data.lists.some((l) => l.id === data.currentListId)) data.currentListId = data.lists[0].id;
    S = data; persist(); closeDlg();
  }

  // ---------- events ----------
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action, id = t.dataset.id;
    switch (a) {
      case 'toggle': item(id).checked ? uncheck(id) : openPriceDlg(id); break;
      case 'detail': openDetail(id); break;
      case 'cancel': closeDlg(); break;
      case 'buy': buy(id, !!t.dataset.skip); break;
      case 'readd':
        S.items.filter((i) => i.listId === S.currentListId && i.checked).forEach((i) => { i.checked = false; i.lastPurchaseId = null; });
        persist(); render(); break;
      case 'readd-one': {
        const it = item(id);
        if (it) { it.checked = false; it.lastPurchaseId = null; persist(); render(); }
        break;
      }
      case 'due-add': {
        const name = t.dataset.name; const st = statsByName(name);
        addItem(name, st.last && st.last.categoryId, st.last && st.last.qty);
        persist(); render(); break;
      }
      case 'due-all':
        dueList().forEach((d) => addItem(d.name, d.last.categoryId, d.last.qty));
        persist(); render(); break;
      case 'open-share': openShare(); break;
      case 'open-text-import': openImport(); break;
      case 'text-parse': openImportPreview($('#importText').value); break;
      case 'text-run': {
        const picked = [...dlg.querySelectorAll('[data-imp]:checked')].map((c) => importRows[+c.dataset.imp]);
        picked.forEach((r) => addItem(r.name, r.categoryId, r.qty, r.memo));
        persist();
        openDlg(`<h3>取り込み完了</h3><p>${picked.length}件を追加しました。${importRows.length - picked.length ? `(スキップ・除外 ${importRows.length - picked.length}件)` : ''}</p>
          <div class="actions"><button class="primary" data-action="cancel">閉じる</button></div>`);
        break;
      }
      case 'copy': {
        const ok = await copyText($('#shareText').value);
        $('#shareMsg').textContent = ok ? 'コピーしました。' : 'コピーできませんでした。テキストを長押しして選択してください。';
        break;
      }
      case 'share':
        try { await navigator.share({ text: $('#shareText').value }); } catch (e) { /* キャンセル */ }
        break;
      case 'export': exportData(); break;
      case 'import': $('#importFile').click(); break;
      case 'open-spend': openSpend(); break;
      case 'spend': openSpend({ y: +t.dataset.y, m: +t.dataset.m }); break;
      case 'open-settings': openSettings(); break;
      case 'save-item': {
        const it = item(id);
        const name = $('#dName').value.trim();
        if (!name) { $('#dName').focus(); return; }
        it.name = name;
        it.qty = Math.max(1, parseInt($('#dQty').value, 10) || 1);
        it.categoryId = $('#dCat').value;
        it.memo = $('#dMemo').value.trim();
        persist(); closeDlg(); break;
      }
      case 'del-item':
        if (confirm('この品目を削除しますか?(購入履歴は支出集計用に残ります)')) {
          S.items = S.items.filter((i) => i.id !== id); persist(); closeDlg();
        } break;
      case 'p-del': {
        const it = item(id);
        S.purchases = S.purchases.filter((p) => p.id !== t.dataset.pid);
        if (it && it.lastPurchaseId === t.dataset.pid) { it.checked = false; it.lastPurchaseId = null; }
        persist(); openDetail(id); break;
      }
      case 'list-add': {
        const v = $('#newList').value.trim(); if (!v) return;
        const l = { id: uid(), name: v }; S.lists.push(l); S.currentListId = l.id; persist(); openSettings(); break;
      }
      case 'list-del':
        if (S.lists.length > 1 && confirm('このリストと品目を削除しますか?')) {
          S.lists = S.lists.filter((l) => l.id !== id);
          S.items = S.items.filter((i) => i.listId !== id);
          if (S.currentListId === id) S.currentListId = S.lists[0].id;
          persist(); openSettings();
        } break;
      case 'cat-add': {
        const v = $('#newCat').value.trim(); if (!v) return;
        S.categories.push({ id: uid(), name: v, order: Math.max(-1, ...S.categories.map((c) => c.order)) + 1 }); persist(); openSettings(); break;
      }
      case 'cat-del':
        if (confirm('このカテゴリを削除しますか?')) {
          S.categories = S.categories.filter((c) => c.id !== id);
          S.items.forEach((i) => { if (i.categoryId === id) i.categoryId = ''; });
          persist(); openSettings();
        } break;
      case 'cat-up': case 'cat-down': {
        const cs = cats(); const i = cs.findIndex((c) => c.id === id); const j = a === 'cat-up' ? i - 1 : i + 1;
        if (j < 0 || j >= cs.length) return;
        [cs[i], cs[j]] = [cs[j], cs[i]]; cs.forEach((c, k) => (c.order = k));
        persist(); openSettings(); break;
      }
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'listSelect') { S.currentListId = t.value; persist(); render(); return; }
    if (t.id === 'sortSelect') { S.sort = t.value; persist(); render(); return; }
    if (t.id === 'importFile') { const f = t.files[0]; t.value = ''; if (f) importData(f); return; }
    const c = t.dataset && t.dataset.change;
    if (!c) return;
    if (c === 'p-date') {
      const p = S.purchases.find((x) => x.id === t.dataset.pid); if (!p || !t.value) return;
      const [y, m, d] = t.value.split('-').map(Number); const old = new Date(p.date);
      p.date = new Date(y, m - 1, d, old.getHours(), old.getMinutes(), old.getSeconds()).toISOString();
      persist(); openDetail(t.dataset.id);
    } else if (c === 'p-price') {
      const p = S.purchases.find((x) => x.id === t.dataset.pid); if (!p) return;
      p.unitPrice = parsePrice(t.value); persist(); openDetail(t.dataset.id);
    } else if (c === 'list-name') {
      const l = S.lists.find((x) => x.id === t.dataset.id); const v = t.value.trim(); if (l && v) { l.name = v; persist(); }
    } else if (c === 'cat-name') {
      const k = S.categories.find((x) => x.id === t.dataset.id); const v = t.value.trim(); if (k && v) { k.name = v; persist(); }
    }
  });

  $('#addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#addName').value.trim(); if (!name) return;
    addItem(name, $('#addCat').value, parseInt($('#addQty').value, 10) || 1);
    $('#addName').value = ''; $('#addQty').value = 1; $('#addName').focus();
    persist(); render();
  });

  // 過去に使った品目名を入力したら、カテゴリを自動で合わせる
  $('#addName').addEventListener('input', () => {
    const cid = knownNames().get($('#addName').value.trim());
    if (cid !== undefined && [...$('#addCat').options].some((o) => o.value === cid)) $('#addCat').value = cid;
  });
  $('#search').addEventListener('input', render);

  render();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
