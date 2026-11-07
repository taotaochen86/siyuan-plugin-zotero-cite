/*
 * 活跃文档集合 专项单测（2026-11-07）
 *
 * 三段，都不碰真思源、不碰真 Zotero 库：
 *   甲、Zotero 侧脚本：把 index.js 里的 docCollectionScript() 丢给假 Zotero 跑，
 *       验「建顶级 / 建子集合 / 多删少补 / 解散只删自己 / 顶级联动解散 / 旧名迁移 /
 *           不抢别人同名集合」。
 *   乙、纯函数：docTailOf()、docCollectionName()。
 *   丙、插件侧编排：用 Object.create(原型) 造一个真实例，覆写掉只读/网络那几处，
 *       验「空文档不建壳、映射落库、按 key 走快路径、改名跟随、残渣清理的保险丝」。
 *
 * 跑法：node test/doc_collection_unit.js
 */
const path = require("path");
const Module = require("module");

/* ---------- 把 require("siyuan") 换成桩，才能 require 真 index.js ---------- */
class PluginStub {
  constructor() {}
  addTopBar() { return { style: {} }; }
  async loadData() { return {}; }
  async saveData() { return true; }
  addIcons() {}
}
const siyuanStub = {
  Plugin: PluginStub,
  Setting: class { constructor(o) { Object.assign(this, o || {}); } addItem() {} },
  Dialog: class { constructor(o) { Object.assign(this, o || {}); } },
  showMessage: () => {},
  fetchSyncPost: async () => ({ code: 0, data: {} }),
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "siyuan") {
    return siyuanStub;
  }
  return origLoad.apply(this, arguments);
};
const PLUGIN = require(path.join(__dirname, "..", "index.js"));
Module._load = origLoad;

const docCollectionScript = PLUGIN.__docCollectionScript;
const docCollectionName = PLUGIN.__docCollectionName;
const docTailOf = PLUGIN.__docTailOf;
const DOC_PARENT = PLUGIN.__DOC_PARENT;

let pass = 0;
let fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    fails.push({ name, detail });
    console.log("  ✗ " + name + (detail !== undefined ? "  ← " + detail : ""));
  }
}

/* ============================================================
 * 甲、假 Zotero + 真 docCollectionScript()
 * ============================================================ */
function makeZotero(seed) {
  const st = { cols: [], items: {}, seq: 0, keySeq: 0, txs: 0 };
  const nextKey = () => { st.keySeq++; return ("K" + st.keySeq).padStart(8, "0"); };
  function Collection() {
    this.id = ++st.seq;
    this.key = nextKey();
    this.parentID = 0;
    this.name = "";
    this.libraryID = 1;
    this.dateModified = "2026-11-07 00:00:00";
    this._items = [];
    st.cols.push(this);
  }
  Collection.prototype.saveTx = async function () { return this.id; };
  Collection.prototype.eraseTx = async function () {
    this._deleted = true;
    st.cols = st.cols.filter((c) => c !== this);
  };
  Collection.prototype.getChildItems = function () {
    return this._items.map((id) => st.items[id]).filter(Boolean);
  };
  Collection.prototype.addItems = async function (ids) {
    ids.forEach((id) => { if (this._items.indexOf(id) < 0) this._items.push(id); });
    return ids.length;
  };
  Collection.prototype.removeItems = async function (ids) {
    this._items = this._items.filter((id) => ids.indexOf(id) < 0);
    return ids.length;
  };
  (seed && seed.cols || []).forEach((c) => {
    const col = new Collection();
    col.name = c.name;
    col.parentID = c.parentID || 0;
    if (c.key) {
      col.key = c.key;
    }
    st.cols[st.cols.length - 1] = col;
  });
  (seed && seed.items || []).forEach((k, i) => {
    st.items[i + 1] = { id: i + 1, key: k };
  });
  return {
    state: st,
    Zotero: {
      Libraries: { userLibraryID: 1 },
      DB: { executeTransaction: async (fn) => { st.txs++; return fn(); } },
      Collection,
      Collections: {
        getByLibrary: () => st.cols.slice(),
        getByLibraryAndKey: (lib, key) => st.cols.find((c) => c.key === key) || false,
      },
      Items: {
        getByLibraryAndKey: (lib, key) => Object.values(st.items).find((i) => i.key === key) || false,
      },
    },
  };
}

async function runScript(payload, mock) {
  const script = docCollectionScript(payload);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction("Zotero", script);
  const raw = await fn(mock.Zotero);
  return JSON.parse(raw);
}

const findByName = (mock, name) => mock.state.cols.filter((c) => c.name === name);
const itemsOf = (col) => col.getChildItems().map((i) => i.key);
const rootOf = (mock) => mock.state.cols.find((c) => !c.parentID && c.name === DOC_PARENT);

async function partA() {
  console.log("\n【甲】Zotero 侧脚本（假库）");

  /* A1 首次同步：顶级 + 子集合，成员按出现顺序 */
  {
    const mock = makeZotero({ items: ["AAA", "BBB", "CCC", "DDD"] });
    const r = await runScript({ action: "sync", docName: "论文初稿", keys: ["AAA", "BBB", "CCC"] }, mock);
    check("A1 首次同步建出子集合", r.ok && r.created === true, JSON.stringify(r));
    check("A1 顶级名 = " + DOC_PARENT, !!rootOf(mock), JSON.stringify(mock.state.cols.map((c) => c.name)));
    const kid = findByName(mock, "论文初稿")[0];
    check("A1 子集合挂在顶级下", !!kid && kid.parentID === rootOf(mock).id, kid && String(kid.parentID));
    check("A1 成员 3 条且顺序正确", kid && itemsOf(kid).join(",") === "AAA,BBB,CCC", kid && itemsOf(kid).join(","));
    check("A1 返回 total=3", r.total === 3, r.total);
    check("A1 增删走事务", mock.state.txs === 1, mock.state.txs);

    /* A2 同一 key 再同步：幂等 */
    const r2 = await runScript({ action: "sync", collectionKey: r.key, docName: "论文初稿", keys: ["AAA", "BBB", "CCC"] }, mock);
    check("A2 二次同步幂等", r2.ok && r2.created === false && r2.added === 0 && r2.removed === 0, JSON.stringify(r2));
    check("A2 没有多建子集合", findByName(mock, "论文初稿").length === 1, findByName(mock, "论文初稿").length);
  }

  /* A3 多删少补 */
  {
    const mock = makeZotero({ items: ["AAA", "BBB", "CCC", "DDD"] });
    const r = await runScript({ action: "sync", docName: "论文初稿", keys: ["AAA", "BBB", "CCC"] }, mock);
    const r2 = await runScript({ action: "sync", collectionKey: r.key, docName: "论文初稿", keys: ["AAA", "DDD"] }, mock);
    const kid = findByName(mock, "论文初稿")[0];
    check("A3 补 1 删 2", r2.added === 1 && r2.removed === 2, JSON.stringify(r2));
    check("A3 成员正好是新的两条", itemsOf(kid).sort().join(",") === "AAA,DDD", itemsOf(kid).join(","));
  }

  /* A4 引用了本机没有的条目：记 missing，不整体失败 */
  {
    const mock = makeZotero({ items: ["AAA"] });
    const r = await runScript({ action: "sync", docName: "论文初稿", keys: ["AAA", "NOPE1", "NOPE2"] }, mock);
    const kid = findByName(mock, "论文初稿")[0];
    check("A4 缺条不报错", r.ok === true, JSON.stringify(r));
    check("A4 缺的进 missing", r.missing.join(",") === "NOPE1,NOPE2", r.missing.join(","));
    check("A4 只收进真有的那条", itemsOf(kid).join(",") === "AAA", itemsOf(kid).join(","));
  }

  /* A5 keys 全空：集合留空，成员清空 */
  {
    const mock = makeZotero({ items: ["AAA"] });
    const r = await runScript({ action: "sync", docName: "论文初稿", keys: ["AAA"] }, mock);
    const r2 = await runScript({ action: "sync", collectionKey: r.key, docName: "论文初稿", keys: [] }, mock);
    const kid = findByName(mock, "论文初稿")[0];
    check("A5 清空成员但集合还在", !!kid && kid.getChildItems().length === 0 && r2.removed === 1, JSON.stringify({ left: kid && kid.getChildItems().length, removed: r2.removed }));
  }

  /* A6 解散 + 顶级联动 */
  {
    const mock = makeZotero({ items: ["AAA"] });
    const r = await runScript({ action: "sync", docName: "论文初稿", keys: ["AAA"] }, mock);
    const d = await runScript({ action: "drop", collectionKey: r.key, docName: "论文初稿" }, mock);
    check("A6 解散成功", d.ok && d.dropped === true, JSON.stringify(d));
    check("A6 顶级跟着一起收掉", d.pruned === true && !rootOf(mock), JSON.stringify({ pruned: d.pruned, cols: mock.state.cols.map((c) => c.name) }));
    check("A6 条目一条没动", Object.keys(mock.state.items).length === 1, Object.keys(mock.state.items).length);
    const d2 = await runScript({ action: "drop", collectionKey: r.key, docName: "论文初稿" }, mock);
    check("A6 再解散一次只报 not-found", d2.ok && d2.dropped === false && d2.reason === "not-found", JSON.stringify(d2));
  }

  /* A7 还有别的文档时不收顶级；删到最后一个才收 */
  {
    const mock = makeZotero({ items: ["AAA"] });
    const r1 = await runScript({ action: "sync", docName: "文档甲", keys: ["AAA"] }, mock);
    const r2 = await runScript({ action: "sync", docName: "文档乙", keys: ["AAA"] }, mock);
    const d1 = await runScript({ action: "drop", collectionKey: r1.key, docName: "文档甲" }, mock);
    check("A7 删一个不收顶级", d1.dropped === true && d1.pruned === false && !!rootOf(mock), JSON.stringify(d1));
    const d2 = await runScript({ action: "drop", collectionKey: r2.key, docName: "文档乙" }, mock);
    check("A7 删最后一个收顶级", d2.pruned === true && !rootOf(mock), JSON.stringify(d2));
    const r3 = await runScript({ action: "sync", docName: "文档丙", keys: ["AAA"] }, mock);
    check("A7 解散后还能重建", r3.ok && r3.created === true && !!rootOf(mock), JSON.stringify(r3));
  }

  /* A8 用户自己根层有个同名集合：不碰 */
  {
    const mock = makeZotero({ items: ["AAA"], cols: [{ name: "论文初稿" }] });
    const userCol = mock.state.cols[0];
    const r = await runScript({ action: "sync", docName: "论文初稿", keys: ["AAA"] }, mock);
    check("A8 自己新建了一个（没接管用户的）", r.key !== userCol.key && r.created === true, JSON.stringify({ mine: r.key, user: userCol.key }));
    check("A8 用户集合成员没变", userCol.getChildItems().length === 0, userCol.getChildItems().length);
  }

  /* A9 旧顶级名原地迁移 */
  {
    const mock = makeZotero({ items: ["AAA"], cols: [{ name: "WPS 活跃文档" }] });
    const oldRoot = mock.state.cols[0];
    const oldKid = new mock.Zotero.Collection();
    oldKid.name = "旧稿";
    oldKid.parentID = oldRoot.id;
    const r = await runScript({ action: "sync", docName: "旧稿", keys: ["AAA"] }, mock);
    check("A9 顶级改名、id 不变", oldRoot.name === DOC_PARENT && mock.state.cols.filter((c) => !c.parentID).length === 1, JSON.stringify(mock.state.cols.map((c) => c.name + "/" + c.parentID)));
    check("A9 返回 renamed=true", r.renamed === true, JSON.stringify(r));
    check("A9 旧子集合原地沿用", oldKid.parentID === oldRoot.id && r.created === false && findByName(mock, "旧稿").length === 1, JSON.stringify({ created: r.created, n: findByName(mock, "旧稿").length }));
  }

  /* A9b 上一代顶级名【【活跃文档】】也认得（2026-11-07 改名 Connected Document 后必须能接住） */
  {
    const mock = makeZotero({ items: ["AAA"], cols: [{ name: "【【活跃文档】】" }] });
    const oldRoot = mock.state.cols[0];
    const oldKid = new mock.Zotero.Collection();
    oldKid.name = "上一代";
    oldKid.parentID = oldRoot.id;
    const r = await runScript({ action: "sync", docName: "上一代", keys: ["AAA"] }, mock);
    check("A9b 上一代顶级名原地改名", oldRoot.name === DOC_PARENT && mock.state.cols.filter((c) => !c.parentID).length === 1,
      JSON.stringify(mock.state.cols.map((c) => c.name + "/" + c.parentID)));
    check("A9b 返回 renamed=true 且没重建", r.renamed === true && r.created === false, JSON.stringify(r));
    check("A9b 旧子集合的 key 没变（成员不丢）", oldKid.key === r.key && oldKid.parentID === oldRoot.id,
      JSON.stringify({ oldKid: oldKid.key, mine: r.key }));
  }

  /* A9c 两代旧名同时存在（机器上手动改过一次）：认最新的那个，另一个原样不动 */
  {
    const mock = makeZotero({ items: ["AAA"], cols: [{ name: "WPS 活跃文档" }, { name: "【【活跃文档】】" }] });
    const newest = mock.state.cols[1];
    const r = await runScript({ action: "sync", docName: "双旧名", keys: ["AAA"] }, mock);
    check("A9c 认【【活跃文档】】、不动 WPS 活跃文档", newest.name === DOC_PARENT && mock.state.cols[0].name === "WPS 活跃文档",
      JSON.stringify(mock.state.cols.map((c) => c.name)));
    check("A9c 子集合挂在新改名的那个下", (function () {
      const kid = mock.state.cols.find((c) => c.name === "双旧名");
      return !!kid && kid.parentID === newest.id;
    })(), JSON.stringify(mock.state.cols.map((c) => c.name + "/" + c.parentID)));
    check("A9c 只建了一个新顶级", mock.state.cols.filter((c) => !c.parentID && c.name === DOC_PARENT).length === 1, "ok");
  }

  /* A9d 上一代 Connected 单数名也认得（2026-11-07 加 s 后必须能接住） */
  {
    const mock = makeZotero({ items: ["AAA"], cols: [{ name: "【【Connected Document】】" }] });
    const oldRoot = mock.state.cols[0];
    const oldKid = new mock.Zotero.Collection();
    oldKid.name = "单数代";
    oldKid.parentID = oldRoot.id;
    const r = await runScript({ action: "sync", docName: "单数代", keys: ["AAA"] }, mock);
    check("A9d 单数旧名原地改成复数", oldRoot.name === DOC_PARENT && mock.state.cols.filter((c) => !c.parentID).length === 1,
      JSON.stringify(mock.state.cols.map((c) => c.name + "/" + c.parentID)));
    check("A9d renamed=true 且没重建", r.renamed === true && r.created === false, JSON.stringify(r));
    check("A9d 子集合 key 没变（成员不丢）", oldKid.key === r.key && oldKid.parentID === oldRoot.id,
      JSON.stringify({ oldKid: oldKid.key, mine: r.key }));
  }

  /* A10 list 在空库里只读：一个集合都不许建 */
  {
    const mock = makeZotero({ items: ["AAA"] });
    const l = await runScript({ action: "list" }, mock);
    check("A10 list 空库不建集合", l.ok && l.parent === null && l.children.length === 0 && mock.state.cols.length === 0, JSON.stringify({ parent: l.parent, kids: l.children.length, cols: mock.state.cols.length }));
  }

  /* A11 空文档名：sync 直接拒绝，别为了报错建出空顶级 */
  {
    const mock = makeZotero({ items: ["AAA"] });
    const r = await runScript({ action: "sync", docName: "", keys: ["AAA"] }, mock);
    check("A11 空文档名被拒且不建集合", r.ok === false && r.error === "docName-missing" && mock.state.cols.length === 0, JSON.stringify(r));
  }

  /* A12 avoidKeys：别人的同名集合不许被接管 */
  {
    const mock = makeZotero({ items: ["AAA"] });
    const other = await runScript({ action: "sync", docName: "同名文档", keys: ["AAA"] }, mock);
    // 思源侧首次同步：list 出别人的 key → 传进 avoidKeys，且不允许按名字兜底
    const l = await runScript({ action: "list" }, mock);
    const avoid = l.children.map((c) => c.key);
    const mine = await runScript({
      action: "sync", docName: "同名文档", keys: ["AAA"], avoidKeys: avoid, allowNameFallback: true,
    }, mock);
    check("A12 没抢别人的集合", mine.key !== other.key && mine.created === true, JSON.stringify({ mine: mine.key, other: other.key }));
    check("A12 顶级下两个同名子集合并存", findByName(mock, "同名文档").length === 2, findByName(mock, "同名文档").length);
    check("A12 原集合成员没被清", findByName(mock, "同名文档").find((c) => c.key === other.key).getChildItems().length === 1, "ok");
  }

  /* A13 allowNameFallback=false：旧 key 失效时宁可新建，也不去捡别人的同名集合 */
  {
    const mock = makeZotero({ items: ["AAA"] });
    const other = await runScript({ action: "sync", docName: "同名文档", keys: ["AAA"] }, mock);
    const mine = await runScript({
      action: "sync", collectionKey: "GONEKEY0", docName: "同名文档", keys: ["AAA"], allowNameFallback: false,
    }, mock);
    check("A13 key 失效后新建、不接管同名集合", mine.key !== other.key && mine.created === true, JSON.stringify({ mine: mine.key, other: other.key }));
  }

  /* A14 drop 时同样不许误删别人的同名集合 */
  {
    const mock = makeZotero({ items: ["AAA"] });
    const keep = await runScript({ action: "sync", docName: "同名文档", keys: ["AAA"] }, mock);
    const d = await runScript({ action: "drop", collectionKey: "GONEKEY0", docName: "同名文档", avoidKeys: [keep.key] }, mock);
    check("A14 只认 key，名字兜底跳过别人的", d.dropped === false && findByName(mock, "同名文档").length === 1, JSON.stringify(d));
  }
}

/* ============================================================ */
function partB() {
  console.log("\n【乙】纯函数");

  check("B1 docTailOf 取连字符后的 7 位", docTailOf("20261031203523-ozf451t") === "ozf451t", docTailOf("20261031203523-ozf451t"));
  check("B1 docTailOf 对无连字符的串取后 7 位", docTailOf("abcdefghij") === "defghij", docTailOf("abcdefghij"));

  const map = {
    "20260101000000-aaaaaaa": { key: "K1", name: "论文初稿" },
    "20260101000001-bbbbbbb": { key: "K2", name: "另稿" },
  };
  check("B2 不撞名就用原标题", docCollectionName("论文初稿", "20260101000000-aaaaaaa", map) === "论文初稿", "x");
  check("B3 撞名给后来者加后缀", docCollectionName("论文初稿", "20260101000002-ccccccc", map) === "论文初稿 · ccccccc", docCollectionName("论文初稿", "20260101000002-ccccccc", map));
  check("B4 同一个 key 的映射残留不算撞名", docCollectionName("论文初稿", "20260101000009-ddddddd", {
    "20260101000000-aaaaaaa": { key: "K1", name: "论文初稿" },
    "20260101000009-ddddddd": { key: "K1", name: "论文初稿" },
  }) === "论文初稿", "x");
  check("B5 空标题返回空串（调用方据此跳过）", docCollectionName("", "20260101000000-aaaaaaa", map) === "", "x");
}

/* ============================================================
 * 丙、插件侧编排（真实例，只覆写网络与只读那几处）
 * ============================================================ */
function makePlugin(opts) {
  const o = opts || {};
  const p = Object.create(PLUGIN.prototype);
  p.settings = Object.assign({ docCollection: true, token: "T0KEN" }, o.settings || {});
  p._docMap = o.docMap || {};
  p._docSyncTimers = {};
  p._saved = 0;
  p.saveDocMap = async () => { p._saved++; };
  p.docTitleOf = async (id) => (o.titles && o.titles[id]) || "";
  p.openDocIds = () => (o.open === undefined ? null : o.open);
  p._mock = o.mock || makeZotero({ items: ["AAA", "BBB"] });
  p._calls = [];
  /* 真调用：真生成脚本、真在假 Zotero 里执行，只把网络这一跳换掉 */
  p.docCollectionCall = async (payload) => {
    p._calls.push(payload);
    return runScript(payload, p._mock);
  };
  return p;
}

async function partC() {
  console.log("\n【丙】插件侧编排");

  /* C1 空文档（没引用、也没建过集合）不建壳 */
  {
    const p = makePlugin({ titles: { D1: "空文档" } });
    const r = await p.syncDocCollection("D1", []);
    check("C1 无引用不建空壳", r.skipped === "empty" && p._calls.length === 0 && p._mock.state.cols.length === 0, JSON.stringify(r));
  }

  /* C2 正常同步：建集合、映射落库 */
  {
    const p = makePlugin({ titles: { D1: "论文初稿" } });
    const r = await p.syncDocCollection("D1", ["AAA"]);
    check("C2 建集合成功", r.ok && r.created === true, JSON.stringify(r));
    check("C2 映射写进 docMap", p._docMap.D1 && p._docMap.D1.key === r.key && p._docMap.D1.name === "论文初稿", JSON.stringify(p._docMap));
    check("C2 映射已落盘", p._saved === 1, p._saved);
    check("C2 首次同步先 list 再 sync", p._calls.map((c) => c.action).join(",") === "list,sync", p._calls.map((c) => c.action).join(","));
    check("C2 首次 list 结果转成了 avoidKeys（没包含自己）", (p._calls[1].avoidKeys || []).length === 0, JSON.stringify(p._calls[1].avoidKeys));
  }

  /* C3 已有 key：不再 list，直接按 key 走 */
  {
    const p = makePlugin({ titles: { D1: "论文初稿" } });
    const r1 = await p.syncDocCollection("D1", ["AAA"]);
    p._calls = [];
    const r2 = await p.syncDocCollection("D1", ["AAA", "BBB"]);
    check("C3 第二次只发一次 sync", p._calls.map((c) => c.action).join(",") === "sync", p._calls.map((c) => c.action).join(","));
    check("C3 带上了上次的 key", p._calls[0].collectionKey === r1.key, p._calls[0].collectionKey);
    check("C3 明确禁止按名字兜底", p._calls[0].allowNameFallback === false, String(p._calls[0].allowNameFallback));
    check("C3 成员补到 2 条", r2.added === 1, JSON.stringify(r2));
  }

  /* C4 文档改名：集合跟着改 */
  {
    const titles = { D1: "旧标题" };
    const p = makePlugin({ titles });
    await p.syncDocCollection("D1", ["AAA"]);
    titles.D1 = "新标题";
    const r = await p.syncDocCollection("D1", ["AAA"]);
    check("C4 集合改名", r.name === "新标题" && findByName(p._mock, "新标题").length === 1, JSON.stringify(r));
    check("C4 映射里也是新名字", p._docMap.D1.name === "新标题", JSON.stringify(p._docMap.D1));
  }

  /* C5 两篇同名文档并存，互不抢 */
  {
    const titles = { D1: "同名稿", D2: "同名稿" };
    const p = makePlugin({ titles });
    const r1 = await p.syncDocCollection("D1", ["AAA"]);
    const r2 = await p.syncDocCollection("D2", ["BBB"]);
    check("C5 两篇都建成了、key 不同", r1.ok && r2.ok && r1.key !== r2.key, JSON.stringify({ a: r1.key, b: r2.key }));
    check("C5 后来者名字带 docId 后缀", String(r2.name).indexOf("同名稿 · ") === 0, r2.name);
    check("C5 各自成员正确", itemsOf(findByName(p._mock, "同名稿")[0]).join(",") === "AAA" && itemsOf(findByName(p._mock, r2.name)[0]).join(",") === "BBB", "x");
  }

  /* C6 解散：删集合、清映射 */
  {
    const p = makePlugin({ titles: { D1: "论文初稿" } });
    const r = await p.syncDocCollection("D1", ["AAA"]);
    const d = await p.dropDocCollection("D1");
    check("C6 解散成功并收掉顶级", d.dropped === true && d.pruned === true, JSON.stringify(d));
    check("C6 映射清空", !p._docMap.D1, JSON.stringify(p._docMap));
    check("C6 库里一个集合都不剩", p._mock.state.cols.length === 0, p._mock.state.cols.length);
  }

  /* C7 残渣清理：问不出打开的文档 → 一律不动 */
  {
    const p = makePlugin({ titles: { D1: "甲", D2: "乙" }, open: null });
    await p.syncDocCollection("D1", ["AAA"]);
    await p.syncDocCollection("D2", ["BBB"]);
    const before = p._mock.state.cols.length;
    const r = await p.sweepDocCollections();
    check("C7 问不出来就不清理", r.swept === 0 && p._mock.state.cols.length === before, JSON.stringify(r));
  }

  /* C8 残渣清理：只清没打开的，打开着的留着 */
  {
    const p = makePlugin({ titles: { D1: "甲", D2: "乙" }, open: ["D1"] });
    const r1 = await p.syncDocCollection("D1", ["AAA"]);
    const r2 = await p.syncDocCollection("D2", ["BBB"]);
    const r = await p.sweepDocCollections();
    check("C8 清了 1 个", r.swept === 1, JSON.stringify(r));
    check("C8 打开着的还在", !!p._mock.state.cols.find((c) => c.key === r1.key), "x");
    check("C8 关掉的那个没了", !p._mock.state.cols.find((c) => c.key === r2.key), "x");
    check("C8 映射里只剩打开的", Object.keys(p._docMap).join(",") === "D1", Object.keys(p._docMap).join(","));
  }

  /* C9 开关关掉：一次网络都不发 */
  {
    const p = makePlugin({ titles: { D1: "论文初稿" }, settings: { docCollection: false } });
    const r = await p.syncDocCollection("D1", ["AAA"]);
    check("C9 关开关后不同步", r.skipped === "off" && p._calls.length === 0, JSON.stringify(r));
    const r2 = await p.sweepDocCollections();
    check("C9 关开关后不扫残渣", r2.skipped === "off", JSON.stringify(r2));
  }

  /* C10 没令牌：静默跳过，不当成错误抛出去 */
  {
    const p = makePlugin({ titles: { D1: "论文初稿" }, settings: { token: "" } });
    const r = await p.syncDocCollection("D1", ["AAA"]);
    check("C10 没令牌静默跳过", r.skipped === "off" && p._calls.length === 0, JSON.stringify(r));
  }

  /* C11 文档没有标题（取不到）：跳过，不建无名集合 */
  {
    const p = makePlugin({ titles: {} });
    const r = await p.syncDocCollection("DX", ["AAA"]);
    check("C11 没标题跳过", r.skipped === "no-title" && p._calls.length === 0, JSON.stringify(r));
  }

  /* C13 openDocIds 只认活着的编辑器（已 remove("protyle") 类 / 已摘出 DOM 的都不算） */
  {
    const prevDoc = global.document;
    global.document = {
      querySelectorAll: (sel) => (sel === ".protyle-title[data-node-id]" ? [
        { getAttribute: () => "D1", closest: () => ({ classList: { contains: () => true }, isConnected: true }) },
        { getAttribute: () => "D2", closest: () => ({ classList: { contains: () => false }, isConnected: true }) },
        { getAttribute: () => "D3", closest: () => ({ classList: { contains: () => true }, isConnected: false }) },
        { getAttribute: () => "D4", closest: () => null },
      ] : []),
    };
    const p = Object.create(PLUGIN.prototype);
    const ids = p.openDocIds();
    global.document = prevDoc;
    check("C13 已销毁的编辑器不算打开", ids.join(",") === "D1", JSON.stringify(ids));
  }

  /* C14 页面上一个编辑器都没有时，sweep 一律不清理（防止刚启动时误删） */
  {
    const prevDoc = global.document;
    global.document = { querySelectorAll: () => [] };
    const mock = makeZotero({ items: ["AAA"] });
    const p = Object.create(PLUGIN.prototype);
    p.settings = { docCollection: true, token: "T" };
    p._docMap = { D1: { key: "K1", name: "甲" } };
    p._docSyncTimers = {};
    p.saveDocMap = async () => {};
    p._mock = mock;
    p._calls = [];
    p.docCollectionCall = async (payload) => { p._calls.push(payload); return runScript(payload, mock); };
    const r = await p.sweepDocCollections();
    global.document = prevDoc;
    check("C14 没有编辑器时不扫残渣", r.skipped === "no-editor" && p._calls.length === 0, JSON.stringify(r));
  }

  /* C12 关开关时把本机建过的全收掉 */
  {
    const p = makePlugin({ titles: { D1: "甲", D2: "乙" } });
    await p.syncDocCollection("D1", ["AAA"]);
    await p.syncDocCollection("D2", ["BBB"]);
    await p.dropAllDocCollections();
    check("C12 全收掉、映射清空", p._mock.state.cols.length === 0 && Object.keys(p._docMap).length === 0,
      JSON.stringify({ cols: p._mock.state.cols.map((c) => c.name), map: Object.keys(p._docMap) }));
  }
}

(async () => {
  await partA();
  partB();
  await partC();
  console.log("\n=== " + pass + "/" + (pass + fail) + " ===");
  if (fail) {
    console.log("失败用例：");
    fails.forEach((f) => console.log("  - " + f.name + (f.detail !== undefined ? "  ← " + f.detail : "")));
    process.exit(1);
  }
})().catch((e) => {
  console.error("测试异常：", e);
  process.exit(2);
});
