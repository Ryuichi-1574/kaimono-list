// データ層。将来クラウド同期に差し替える場合は、同じ load / save を実装し直す。
const Store = (() => {
  const KEY = 'shopping-list-v1';

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  function defaults() {
    const names = ['野菜・果物', '肉・魚', '乳製品・卵', '主食・乾物', '飲料', '日用品', 'その他'];
    const listId = uid();
    return {
      lists: [{ id: listId, name: '買い物リスト' }],
      categories: names.map((name, order) => ({ id: uid(), name, order })),
      items: [],      // {id, listId, categoryId, name, qty, memo, checked, lastPurchaseId}
      purchases: [],  // {id, itemId, name, categoryId, date(ISO), qty, unitPrice|null}
      currentListId: listId,
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && s.lists && s.lists.length) return s;
      }
    } catch (e) { /* 破損時は初期化 */ }
    return defaults();
  }

  function save(state) {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { alert('保存に失敗しました: ' + e.message); }
  }

  return { load, save, uid };
})();
