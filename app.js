(() => {
  let S = Store.load();
  const uid = Store.uid;
  const $ = (s) => document.querySelector(s);
  const dlg = $('#dlg');
  const DAY = 86400000;

  // ---------- helpers ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
  const persist = () => { Store.save(S); if (window.Cloud) window.Cloud.onLocalChange(S); };
  const cloud = () => window.Cloud || null;
  const cstate = () => (window.Cloud ? window.Cloud.state() : null);

  // cloud.js(家族共有)から呼ばれる。共有側の変更を取り込み、端末内にも保存する(送り返さない)
  window.AppHooks = {
    getState: () => S,
    applyRemote(col, docs) {
      if (col === 'lists' && !docs.length) return; // リストが1つもない状態にはしない
      S[col] = docs;
      if (!S.lists.some((l) => l.id === S.currentListId)) S.currentListId = S.lists[0].id;
      Store.save(S);
      render();
    },
  };
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
      name, qty: Math.max(1, qty || 1), memo: memo || '', checked: false, lastPurchaseId: null, ts: Date.now(),
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
  let swiping = false, renderQueued = false; // スワイプ中は再描画を保留する(共有側の更新が来ても行が消えないように)
  function render() {
    if (swiping) { renderQueued = true; return; }
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
      // 背面(.under)に、右スワイプ=購入済み(緑)・左スワイプ=削除(赤)を置く
      return `<div class="swipe-row" data-id="${i.id}" data-done="${i.checked ? 1 : 0}">
        <div class="under" aria-hidden="true"><span class="u-buy">${i.checked ? '' : '✓ 購入済み'}</span><span class="u-del">🗑 削除</span></div>
        <div class="row ${i.checked ? 'done' : ''}">
          <button class="check" data-action="toggle" data-id="${i.id}" aria-label="購入済み切替"></button>
          <button class="body" data-action="detail" data-id="${i.id}">
            <div class="name">${esc(i.name)}</div>
            ${bits.length ? `<div class="sub">${bits.join(' ・ ')}</div>` : ''}
          </button>
          <span class="qty">×${i.qty}</span>
          ${i.checked ? `<button class="readd" data-action="readd-one" data-id="${i.id}">再追加</button>` : ''}
        </div>
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

    // 同期の状態表示(共有に参加しているときだけ)
    const cs = cstate();
    $('#syncState').textContent = cs && cs.joined
      ? (!navigator.onLine ? '☁ オフライン(つながると自動で同期します)' : cs.error ? '☁ 同期できていません' : cs.ready ? '☁ 家族と共有中' : '☁ 同期しています…')
      : '';
  }

  // ---------- dialogs ----------
  function openDlg(html, kind) {
    dlg.innerHTML = html;
    dlg.dataset.kind = kind || '';
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

  // この品目の購入履歴(過去に品目を削除して履歴だけ残っている同名の分も含む。別の品目に紐づく履歴は含めない)
  const historyOf = (it) => S.purchases.filter((p) => pkey(p) === it.name && (p.itemId === it.id || !item(p.itemId)));

  function openDeleteDlg(id) {
    const it = item(id);
    if (!it) return closeDlg();
    const n = historyOf(it).length;
    openDlg(`<h3>「${esc(it.name)}」を削除</h3>
      ${n ? `<p>この品目の購入履歴が${n}件あります。履歴は月別の支出などの集計に使われています。</p>
        <div class="note">「履歴も削除」を選ぶと、この分は支出の合計からも消えます。元に戻せません。</div>`
          : '<p>購入履歴はありません。</p>'}
      <div class="actions">
        <button data-action="detail" data-id="${id}">戻る</button>
        <button ${n ? '' : 'class="danger"'} data-action="del-item-keep" data-id="${id}">${n ? '履歴は残して削除' : '削除'}</button>
        ${n ? `<button class="danger" data-action="del-item-all" data-id="${id}">履歴も削除</button>` : ''}
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

  // ---------- 家族共有 ----------
  function cloudSection() {
    const c = cstate();
    const head = '<h4>家族と共有</h4>';
    if (!c) return `${head}<div class="note">共有機能を読み込めませんでした。電波のある場所で、アプリを開き直してください。(共有しなくても、今までどおり使えます)</div>`;
    const err = c.error ? `<div class="note" style="color:var(--danger)">${esc(c.error)}</div>` : '';
    const wait = c.busy ? '<div class="note">処理中です…</div>' : '';
    if (!c.signedIn) {
      return `${head}<div class="note">Googleアカウントでログインすると、家族とリストや購入履歴を共有できます。ログインしなくても、今までどおり使えます。</div>
        ${wait}${err}<div class="actions" style="justify-content:flex-start"><button class="primary" data-action="cloud-signin" ${c.busy ? 'disabled' : ''}>Googleでログイン</button></div>`;
    }
    let body = `<div class="note">ログイン中: ${esc(c.email)}</div>`;
    if (c.joined) {
      body += `<div class="note">共有中(メンバー${c.members}人)${c.ready ? '' : ' ・ 同期しています…'}</div>`;
      if (c.invite) {
        body += `<div class="note" style="color:var(--text)"><b>別の共有に招待されています。</b>参加すると、いまの共有から、招待された共有に移ります。</div>
          <div class="actions" style="justify-content:flex-start"><button class="primary" data-action="cloud-use" data-hid="${esc(c.invite)}" ${c.busy ? 'disabled' : ''}>招待された共有に参加する</button></div>`;
      }
      if (c.isOwner) {
        body += `<h4>家族を招待</h4>
          <div class="note">家族のGoogleメールアドレスを登録すると、その人がログインして「参加する」を押せます。</div>
          <div class="inline" style="grid-template-columns:1fr auto"><input id="inviteEmail" type="email" inputmode="email" placeholder="家族のメールアドレス" autocomplete="off"><button data-action="cloud-invite" ${c.busy ? 'disabled' : ''}>招待</button></div>
          ${c.invited.map((m) => `<div class="inline" style="grid-template-columns:1fr 44px"><div class="note" style="align-self:center">招待中: ${esc(m)}</div><button class="danger" data-action="cloud-uninvite" data-email="${esc(m)}" aria-label="招待を取り消す">✕</button></div>`).join('')}`;
      }
      body += `<div class="actions" style="justify-content:flex-start"><button data-action="cloud-leave" ${c.busy ? 'disabled' : ''}>この端末の同期を止める</button></div>`;
    } else if (c.invite || c.mine) {
      if (c.invite) {
        body += `<div class="note">家族から招待されています。</div>
          <div class="actions" style="justify-content:flex-start"><button class="primary" data-action="cloud-use" data-hid="${esc(c.invite)}" ${c.busy ? 'disabled' : ''}>参加する</button></div>`;
      }
      if (c.mine) {
        body += `<div class="note">${c.invite ? 'このアカウントで作った共有もあります。' : 'このアカウントは共有に参加しています。'}</div>
          <div class="actions" style="justify-content:flex-start"><button ${c.invite ? '' : 'class="primary"'} data-action="cloud-use" data-hid="${esc(c.mine)}" ${c.busy ? 'disabled' : ''}>この端末で自分の共有を使う</button></div>`;
      }
    } else {
      body += `<div class="note">まだ共有を始めていません。始めると、この端末のデータがすべて共有に追加されます。家族は、そのあとで招待できます。</div>
        <div class="actions" style="justify-content:flex-start"><button class="primary" data-action="cloud-create" ${c.busy ? 'disabled' : ''}>共有を始める</button></div>`;
    }
    body += `<div class="actions" style="justify-content:flex-start"><button data-action="cloud-signout" ${c.busy ? 'disabled' : ''}>ログアウト</button></div>`;
    return `${head}${body}${wait}${err}`;
  }

  // 設定画面が開いているときは、状態の変化に合わせて表示を更新する(入力中のメールアドレスは保つ)
  function refreshCloudUI() {
    render();
    if (dlg.open && dlg.dataset.kind === 'settings') {
      const el = $('#inviteEmail'); const v = el ? el.value : '';
      const sc = dlg.scrollTop;
      openSettings();
      const el2 = $('#inviteEmail'); if (el2 && v) el2.value = v;
      dlg.scrollTop = sc;
    }
  }
  window.addEventListener('cloud-change', refreshCloudUI);
  window.addEventListener('online', render);
  window.addEventListener('offline', render);

  function openMergeChoice(targetHid) {
    const n = S.items.length, m = S.purchases.length;
    openDlg(`<h3>この端末のデータを共有に追加しますか?</h3>
      <p>この端末には、品目${n}件・購入履歴${m}件があります。</p>
      <div class="note">「追加する」: 同じ名前のカテゴリ・リストはまとめ、同じ名前の品目や重複する履歴は追加しません。<br>
        「追加しない」: 共有のデータだけを使います。この端末のデータは、念のため端末内にバックアップとして残ります。</div>
      <div class="actions">
        <button data-action="open-settings">キャンセル</button>
        <button data-action="cloud-join" data-hid="${esc(targetHid)}" data-merge="0">追加しない</button>
        <button class="primary" data-action="cloud-join" data-hid="${esc(targetHid)}" data-merge="1">追加する</button>
      </div>`);
  }

  function openSettings() {
    const cs = cats();
    openDlg(`<h3>設定</h3>
      ${cloudSection()}
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
      <div class="actions"><button class="primary" data-action="cancel">閉じる</button></div>`, 'settings');
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
    const joined = cstate() && cstate().joined;
    if (!confirm(`バックアップを読み込みます。現在のデータは置き換わります。${joined ? '\n【注意】家族と共有中のため、共有のデータも置き換わります。' : ''}\n(品目${data.items.length}件、購入履歴${data.purchases.length}件)`)) return;
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
      case 'cloud-signin': if (cloud()) cloud().signIn(); break;
      case 'cloud-signout': if (cloud()) cloud().signOut(); break;
      case 'cloud-create':
        if (cloud() && confirm('この端末のデータをすべて共有に追加して、共有を始めます。\n念のため、設定の「書き出す」でバックアップを取っておくと安心です。\n始めますか?')) cloud().createHousehold();
        break;
      case 'cloud-use': openMergeChoice(t.dataset.hid); break;
      case 'cloud-join': if (cloud()) { openSettings(); cloud().join(t.dataset.hid, t.dataset.merge === '1'); } break;
      case 'cloud-invite': { const el = $('#inviteEmail'); if (cloud() && el) { const v = el.value; cloud().invite(v).then(() => { const e2 = $('#inviteEmail'); if (e2 && !(cstate() || {}).error) e2.value = ''; }); } break; }
      case 'cloud-uninvite': if (cloud() && confirm('この招待を取り消しますか?')) cloud().uninvite(t.dataset.email); break;
      case 'cloud-leave':
        if (cloud() && confirm('この端末の同期を止めます。端末内のデータは、最後の状態のまま残ります。\nよろしいですか?')) cloud().leave();
        break;
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
      case 'del-item': openDeleteDlg(id); break;
      case 'del-item-keep': case 'del-item-all': {
        const it = item(id);
        if (!it) { closeDlg(); break; }
        if (a === 'del-item-all') {
          const gone = new Set(historyOf(it).map((p) => p.id));
          S.purchases = S.purchases.filter((p) => !gone.has(p.id));
        }
        S.items = S.items.filter((i) => i.id !== id);
        persist(); closeDlg(); break;
      }
      case 'p-del': {
        const it = item(id);
        S.purchases = S.purchases.filter((p) => p.id !== t.dataset.pid);
        if (it && it.lastPurchaseId === t.dataset.pid) { it.checked = false; it.lastPurchaseId = null; }
        persist(); openDetail(id); break;
      }
      case 'list-add': {
        const v = $('#newList').value.trim(); if (!v) return;
        const l = { id: uid(), name: v, ts: Date.now() }; S.lists.push(l); S.currentListId = l.id; persist(); openSettings(); break;
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
        S.categories.push({ id: uid(), name: v, order: Math.max(-1, ...S.categories.map((c) => c.order)) + 1, ts: Date.now() }); persist(); openSettings(); break;
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

  // ---------- 横スワイプ(右=購入済み、左=削除) ----------
  (() => {
    const list = $('#list');
    let sw = null;          // 進行中のスワイプ {wrap, row, id, done, x0, y0, dx, locked}
    let lastSwipe = 0;      // スワイプ直後の click を打ち消すための時刻
    const EDGE = 20;        // 画面の左右の端から始まる動きは、OSの「戻る」操作と競合するので無視

    const threshold = (w) => Math.min(140, Math.max(80, w * 0.3));
    const finish = (commit) => {
      if (!sw) return;
      const s = sw; sw = null;
      s.row.classList.add('snap');
      s.row.style.transform = '';
      swiping = false;
      if (s.locked === 'h') {
        lastSwipe = Date.now();
        if (commit && Math.abs(s.dx) >= threshold(s.wrap.offsetWidth)) {
          if (s.dx > 0 && !s.done) openPriceDlg(s.id);
          else if (s.dx < 0) openDeleteDlg(s.id);
        }
      }
      setTimeout(() => { s.row.classList.remove('snap'); s.wrap.classList.remove('active'); }, 250);
      if (renderQueued) { renderQueued = false; render(); }
    };

    list.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const wrap = e.target.closest('.swipe-row');
      if (!wrap || e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return;
      sw = { wrap, row: wrap.querySelector('.row'), id: wrap.dataset.id, done: wrap.dataset.done === '1', x0: e.clientX, y0: e.clientY, dx: 0, locked: null };
    });

    list.addEventListener('pointermove', (e) => {
      if (!sw) return;
      const dx = e.clientX - sw.x0, dy = e.clientY - sw.y0;
      if (!sw.locked) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.5) {
          sw.locked = 'h'; swiping = true; sw.wrap.classList.add('active');
          try { sw.row.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
        } else { sw = null; return; } // 縦の動き = スクロール
      }
      sw.dx = (sw.done && dx > 0) ? 0 : dx; // 購入済みの行は、右スワイプ(購入済み)を無効にする
      sw.row.classList.remove('snap');
      sw.row.style.transform = `translateX(${sw.dx}px)`;
    });

    list.addEventListener('pointerup', () => finish(true));
    list.addEventListener('pointercancel', () => finish(false));
    // スワイプのあとに、ボタンの click が誤って発火しないようにする
    list.addEventListener('click', (e) => {
      if (Date.now() - lastSwipe < 400) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  })();

  render();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
