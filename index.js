/**
 * Zotero Cite for SiYuan
 * ------------------------------------------------------------------
 * 通过 ZBridge（默认 http://127.0.0.1:23119/zbridge/execute）在思源里插入文献引用。
 * ZBridge 是 Zotero Debug Bridge 的替代扩展，同时提供 /zbridge/execute 与
 * 原版兼容端点 /debug-bridge/execute；老配置里的旧地址会被一次性迁到新默认值。
 *
 * 架构要点（实测依据，勿随意改动）：
 *   1. 思源渲染进程 fetch 127.0.0.1:23119 是通的，6ms 级，不需要任何中转。
 *   2. 端点的 body 是「裸 JS」，不能包成 JSON（会 SyntaxError）。
 *   3. 请求头必须是 Content-Type: text/plain + Authorization: Bearer <token>。
 *   4. CSL 渲染全部放在 Zotero 侧完成（citeproc），插件只负责搬运与排版，
 *      这样任意 CSL 样式都能用，插件里不打包 citeproc。
 *   5. 数字样式的编号必须「整篇一次性送渲染」，否则编号会不一致。
 *   6. 引用以 markdown 链接形式落盘："[(Chen et al., 2021)](zotero://select/library/items/KEY)"
 *      —— 链接本身就是数据源，重排时靠正则从正文回收 key 顺序，不依赖额外状态。
 *   7. 点击跳转走 @electron/remote 的 shell.openExternal。
 *
 * 零构建：CommonJS 单文件，直接放进 data/plugins/ 即可。
 */

const { Plugin, Setting, Dialog, showMessage, fetchSyncPost } = require("siyuan");

/**
 * 静默调用内核 API —— 与 fetchSyncPost 等价，但**失败不弹提示**。
 *
 * ⚠️ 思源的 fetchSyncPost 在内核返回 code !== 0 时会自己弹一条「<msg> v<版本>」。
 *    对「尽力而为」的写操作（补删可能已经不存在的块、补写标题、打标记）来说，
 *    失败本来就在预期内，弹出来只会吓用户：2026-11-04 用户重排时看到的一串
 *    「tree not found v3.8.9」就是补删已删块时由 fetchSyncPost 弹出来的。
 *    这类调用一律走这里，自己看 code 决定后续。
 */
async function apiQuiet(path, payload) {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    return await r.json();
  } catch (e) {
    return null;
  }
}

/* ============================ 常量 ============================ */

/**
 * 文末文献条目的块标记。
 * ⚠️ 标题是可配置的、还能完全不生成，所以定位文末列表不能再靠「含参考文献字样的标题块」，
 *    改成给每条文献打一个属性标记，定位只看这个属性。
 *    老版本文档（1.2.29 及以前）的条目没有标记，locateBib 里会退回标题文字匹配，仍能接管。
 */
const BIB_ATTR = "custom-zotero-bib";

const DEFAULT_SETTINGS = {
  // ZBridge 原生端点。令牌走 query（?token=），不接受 Bearer；
  // 老地址 http://127.0.0.1:23119/debug-bridge/execute 是 ZBridge 的原版兼容端点，
  // 仍能连通，但默认值统一到新端点。
  bridgeUrl: "http://127.0.0.1:23119/zbridge/execute",
  token: "",
  // 默认样式只用「Zotero 全新安装就自带」的样式，绝不指向需要另下载的 csl。
  //   Zotero 7 的预置样式打在安装包 omni.ja 的 styles/ 里，共 15 个：
  //     ACS / AMA / APSA / ASA / APA 7 / Chicago (author-date, notes-bibliography,
  //     shortened notes) / Elsevier Harvard / Cite Them Right Harvard / IEEE /
  //     MHRA / MLA / Nature / NLM(Vancouver)
  //   ⚠️ GB/T 7714 系列、CSTR、各中文期刊样式都不在预置里，是「从样式库添加」的，
  //      换电脑不会自动出现 —— 拿它当默认，用户在新机器上一上来就会被拒绝重排。
  //   选 APA：它是预置项里唯一通用且带作者年制的（与国内学位论文常见的
  //   「(张三等, 2024)」形态一致）；要顺序编码制就在设置里换 IEEE 或 Nature。
  styleId: "http://www.zotero.org/styles/apa",
  defaultFormat: "csl",
  // 文末标题。三种取值：
  //   "auto"（默认）→ 按当前 CSL 样式的语言自动选：「参考文献」/「References」
  //   ""            → 不生成标题（中文论文与英文论文写法不同，标题交给用户自己在文档里写）
  //   其它文字       → 原样使用
  bibHeading: "auto",
  // 文末文献列表的编号样式。
  //   ""      → 跟随 CSL 样式自带的编号（IEEE 出 [1]、Nature 出 1.、作者年式本来就没有）
  //   "none"  → 不显示编号
  //   其它    → 当作模板覆盖，`{n}` 是序号占位符，如 "{n}. " / "[{n}] " / "【{n}】"
  bibNumber: "",
  linkEnabled: true,
  /*
   * 活跃文档集合：在这篇文档里用过插件时，在 Zotero 里建一个临时集合
   * 【【Connected Documents】】→ <文档标题>，收这篇文档引用到的全部文献。
   * 关闭文档时自动解散；成员只做 addItems/removeItems，不改条目原有归属。
   */
  docCollection: true,
  // 内部标记：文末标题的默认值由「参考文献」改成 auto 时迁移过一次，
  // 避免每次启动都把用户显式设置的「参考文献」重新覆盖成 auto
  bibHeadingMigrated: false,
};

/* ============================ 依赖与图标 ============================ */

/**
 * 本插件不是纯前端工具，它依赖 Zotero 侧的一个扩展：ZBridge
 * （Zotero Debug Bridge 的替代品，保留 /debug-bridge/execute 兼容端点）。
 * 没有它，任何请求都会 404 / 连接被拒，用户看到的是"连不上 Zotero"，
 * 光看报错根本猜不到要装扩展，所以所有失败提示都必须把这份说明指出来。
 */
const DEP_NAME = "ZBridge";
const DEP_URL = "https://github.com/taotaochen86/zbridge/releases/latest";
const DEP_TOKEN_PREF = "extensions.zotero.zbridge.token";
/** 老默认地址（原版 Debug Bridge 端点，ZBridge 也保留为兼容端点），仅用于一次性迁移 */
const LEGACY_BRIDGE_URL = "http://127.0.0.1:23119/debug-bridge/execute";

/**
 * 从 eventBus 事件里取 protyle。
 *
 * 真实事件的形状是 `{detail: {protyle}}`；但不同调用方（以及测试里手动 emit 时）
 * 可能在外面再套一层 detail，两种都认一下，免得一处取不到就整条链静默不工作。
 */
function protyleOfEvent(e) {
  const d = e && e.detail;
  if (!d) {
    return null;
  }
  if (d.protyle) {
    return d.protyle;
  }
  if (d.detail && d.detail.protyle) {
    return d.detail.protyle;
  }
  return null;
}

/* ---------------- 活跃文档集合 ---------------- */

/**
 * 顶级集合名。**跨软件共用**：WPS 插件（ZoteroCiteWps）建的子集合也挂在这同一个顶级下，
 * 将来别的编辑器接进来同样往这里挂，所以名字要中性，不要带软件名。
 * 用户 2026-11-07 明确要求：二级结构即可（顶级 → 文档名），**不要**再加来源分组。
 */
const DOC_PARENT = "【【Connected Documents】】";
/**
 * 旧顶级名，按「越新越靠前」排。找到哪一个都认作同一个顶级，sync 时原地改名，
 * 子集合一个不搬 —— 用户 2026-11-07 要求把【【活跃文档】】改成【【Connected Documents】】，
 * 已经建好的那棵树不能重建（重建会丢成员）。
 *   【【Connected Document】】 ← 1.2.37 早期的名字（少了复数 s）
 *   【【活跃文档】】           ← 1.2.36 用的名字
 *   WPS 活跃文档               ← WPS 插件 ≤1.1.1 用的名字
 */
const DOC_LEGACY_PARENTS = ["【【Connected Document】】", "【【活跃文档】】", "WPS 活跃文档"];
/** docId → {key, name} 映射，单独一个文件，不塞进 conf.json（免得设置被 pickSettings 过滤掉） */
const DOCMAP_FILE = "docmap.json";

/* ==================== 1.3.0 多文档作用域 ==================== */
/** 作用域名：rootId → {bibDocId}。独立文件，不塞 conf.json（会被 pickSettings 过滤） */
const SCOPE_FILE = "scopes.json";
/** 未指定输出文档时自动生成的文献表文档名（用户 2026-11-08 拍板用 Reference） */
const REF_DOC_TITLE = "Reference";

/**
 * 文档 ID 路径的前缀。'/a/b.sy' → '/a/b/'，根 '/a.sy' → '/a/'。
 * ⚠️ 判子文档用 ID 路径前缀，不用 root_id/hpath 等值比较（04c #5）。
 */
function scopePathPrefix(p) {
  const s = String(p || "").replace(/\.sy$/, "");
  return s.replace(/\/$/, "") + "/";
}

/** docPath 是否落在 rootPath 这棵树里（不含 root 自己）。Conflicted 副本由调用方按标题排除。 */
function isScopeDescendant(docPath, rootPath) {
  const d = String(docPath || "");
  const pfx = scopePathPrefix(rootPath);
  return d !== String(rootPath || "") && d.indexOf(pfx) === 0;
}

/** 脏配置过滤：只认思源文档 ID 形态的 key，bibDocId 必须是字符串或空。 */
function normalizeScopes(obj) {
  const out = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return out;
  }
  for (const k in obj) {
    if (!/^\d{14}-[a-z0-9]{7}$/i.test(String(k))) {
      continue;
    }
    const v = obj[k] || {};
    out[String(k)] = { bibDocId: typeof v.bibDocId === "string" ? v.bibDocId : "" };
  }
  return out;
}

/** 深度优先、父在子前；同级按 path 字典序（≈创建顺序）。文件树真实顺序由 collectScopeDocIds 覆盖。 */
function orderScopeDocs(rows, rootId) {
  const list = (rows || []).filter((r) => r && r.id);
  const root = list.find((r) => r.id === rootId);
  const rootPath = root ? root.path : "";
  const kids = list.filter((r) => r.id !== rootId && isScopeDescendant(r.path, rootPath));
  kids.sort((a, b) => String(a.path) < String(b.path) ? -1 : (String(a.path) > String(b.path) ? 1 : 0));
  return [rootId].concat(kids.map((r) => r.id));
}

/** 纯判定：docId 属于哪棵顶级树。多根命中取 path 最长（最里面那棵）。 */
function scopeFromRows(rows, docId, scopes) {
  const cfg = normalizeScopes(scopes);
  const byId = {};
  (rows || []).forEach((r) => { if (r && r.id) { byId[r.id] = r; } });
  const cur = byId[docId];
  let best = null;
  let bestLen = -1;
  Object.keys(cfg).forEach((rid) => {
    const rr = byId[rid];
    if (!rr) { return; }
    const hit = (rid === docId) || (!!cur && isScopeDescendant(cur.path, rr.path));
    if (hit && String(rr.path || "").length > bestLen) {
      bestLen = String(rr.path || "").length;
      best = rid;
    }
  });
  if (!best) {
    return { mode: "single", rootId: docId, bibDocId: "" };
  }
  return { mode: "multi", rootId: best, bibDocId: cfg[best].bibDocId || "" };
}

/** 思源文档 id 形如 20261031203523-ozf451t，后缀那 7 位才是人眼可辨的部分 */
function docTailOf(docId) {
  const s = String(docId || "");
  const i = s.indexOf("-");
  return i >= 0 ? s.slice(i + 1) : s.slice(-7);
}

/**
 * 集合显示名。
 *
 * ⚠️ 思源允许两篇文档同名，Zotero 也允许两个集合同名 —— 但人看着会懵，
 *    所以撞名时给后来者加一个 `· <docId 后缀>`。判断依据是本地 docmap
 *    （docId → 上次用的名字），只有「另一个 docId 已经在用这个名字」才算撞。
 */
function docCollectionName(title, docId, docMap) {
  const t = String(title || "").trim();
  if (!t) {
    return "";
  }
  const mine = docMap && docMap[docId];
  const key = mine && mine.key;
  let clash = false;
  for (const id in (docMap || {})) {
    if (id === docId) {
      continue;
    }
    const rec = docMap[id];
    if (!rec || String(rec.name || "") !== t) {
      continue;
    }
    // 同一个集合（key 相同）不算撞名，那是历史映射残留
    if (key && rec.key === key) {
      continue;
    }
    clash = true;
    break;
  }
  return clash ? t + " · " + docTailOf(docId) : t;
}

/**
 * Zotero 侧脚本。
 *
 * 三个动作：
 *   sync → 找（或建）该文档的子集合，成员按 keys 多删少补
 *   drop → 解散该文档的子集合；若顶级下已经没有任何子集合，顶级一起收掉
 *   list → 列出顶级下所有子集合，供「文档已关掉」的残渣清理用
 *
 * ⚠️ 只在自己这棵树里动手：parent 一定是「顶级集合」，子集合一定校验 parentID，
 *    collectionKey 传串了也只会被忽略后重建，绝不去改用户自己的集合。
 * ⚠️ addItems / removeItems 必须包在 Zotero.DB.executeTransaction 里，
 *    裸调报 "Not in transaction"（Zotero 10 实测，见 WPS 插件同款实现）。
 * ⚠️ 删父集合会带走子集合，所以 prune 前必须重新读一次集合列表，
 *    否则会把这期间别的文档刚建的集合连带删掉。
 */
function docCollectionScript(payload) {
  const P = payload || {};
  const pack = {
    action: String(P.action || "sync"),
    collectionKey: String(P.collectionKey || ""),
    docName: String(P.docName || ""),
    parentName: String(P.parentName || DOC_PARENT),
    // 旧顶级名候选（按新旧排序）。命中最靠前的那个就当同一个顶级，sync 时改名。
    legacyParents: (P.legacyParents || DOC_LEGACY_PARENTS).map(String),
    // 已知属于「别的文档」的集合 key：按名字兜底找的时候要跳过，
    // 否则两篇文档（或 WPS 与思源各一篇）同名时会互抢同一个集合
    avoidKeys: (P.avoidKeys || []).map(String),
    // 有 collectionKey 时一律传 false：只按 key 找，找不到就新建。
    // 不然「集合被用户删了 + 恰好有别人的同名集合」就会把别人的接管过来。
    allowNameFallback: P.allowNameFallback !== false,
    keys: (P.keys || []).map(String),
  };
  return [
    "const P = " + JSON.stringify(pack) + ";",
    "const lib = Zotero.Libraries.userLibraryID;",
    "let all = Zotero.Collections.getByLibrary(lib, true);",
    "if (all && typeof all.then === 'function') all = await all;",
    "all = all || [];",
    "let parent = null;",
    "for (let i = 0; i < all.length; i++) {",
    "  const c = all[i];",
    "  if (!c.parentID && c.name === P.parentName) { parent = c; break; }",
    "}",
    /* 旧顶级名：认它当同一个顶级，sync 时原地改名。list / drop 只读、只删。
       候选按新旧排，逐个试 —— 用户改过一次名，机器上可能停在任意一代。 */
    "if (!parent && P.legacyParents && P.legacyParents.length) {",
    "  for (let j = 0; j < P.legacyParents.length && !parent; j++) {",
    "    for (let i = 0; i < all.length; i++) {",
    "      const c = all[i];",
    "      if (!c.parentID && c.name === P.legacyParents[j]) { parent = c; break; }",
    "    }",
    "  }",
    "}",
    /* 文档名先校验：别为了报个错反而建出一个空顶级集合 */
    "if (P.action === 'sync' && !P.docName) return JSON.stringify({ok: false, error: 'docName-missing'});",
    "let renamed = false;",
    "if (P.action === 'sync') {",
    "  if (!parent) {",
    "    parent = new Zotero.Collection();",
    "    parent.libraryID = lib;",
    "    parent.name = P.parentName;",
    "    await parent.saveTx();",
    "  } else if (parent.name !== P.parentName) {",
    "    parent.name = P.parentName;",
    "    await parent.saveTx();",
    "    renamed = true;",
    "  }",
    "}",
    "const kids = function () {",
    "  return parent ? all.filter(function (c) { return c.parentID === parent.id; }) : [];",
    "};",
    /* ---- list ---- */
    "if (P.action === 'list') {",
    "  return JSON.stringify({ok: true,",
    "    parent: parent ? {key: parent.key, id: parent.id, name: parent.name} : null,",
    "    renamed: renamed,",
    "    children: kids().map(function (c) {",
    "      let n = 0; try { n = (c.getChildItems() || []).length; } catch (e) { n = -1; }",
    "      return {key: c.key, name: c.name, items: n, modified: String(c.dateModified || '')};",
    "    })});",
    "}",
    /* ---- drop ---- */
    "if (P.action === 'drop') {",
    "  let hit = null;",
    "  const ks = kids();",
    "  if (P.collectionKey) {",
    "    for (let i = 0; i < ks.length; i++) { if (ks[i].key === P.collectionKey) { hit = ks[i]; break; } }",
    "  }",
    "  if (!hit && P.docName) {",
    "    for (let i = 0; i < ks.length; i++) {",
    "      if (ks[i].name !== P.docName) continue;",
    "      if (P.avoidKeys.indexOf(ks[i].key) >= 0) continue;",
    "      hit = ks[i]; break;",
    "    }",
    "  }",
    "  if (!hit) return JSON.stringify({ok: true, dropped: false, reason: 'not-found'});",
    "  const nm = hit.name;",
    "  const hk = hit.key;",
    "  await hit.eraseTx();",
    "  let pruned = false;",
    "  let fresh = [];",
    "  try { fresh = await Zotero.Collections.getByLibrary(lib, true); } catch (e) { fresh = null; }",
    "  if (fresh && parent) {",
    "    const remain = fresh.filter(function (c) { return c.parentID === parent.id && c.id !== hit.id; });",
    "    if (!remain.length) { await parent.eraseTx(); pruned = true; }",
    "  }",
    "  return JSON.stringify({ok: true, dropped: true, key: hk, name: nm, pruned: pruned});",
    "}",
    /* ---- sync ---- */
    "let col = null;",
    "if (P.collectionKey) {",
    "  let c = null;",
    "  try { c = Zotero.Collections.getByLibraryAndKey(lib, P.collectionKey); } catch (e) { c = null; }",
    "  if (c && c.parentID === parent.id) col = c;",
    "}",
    "if (!col && P.allowNameFallback) {",
    "  const ks = kids();",
    "  for (let i = 0; i < ks.length; i++) {",
    "    if (ks[i].name !== P.docName) continue;",
    "    if (P.avoidKeys.indexOf(ks[i].key) >= 0) continue;",
    "    col = ks[i]; break;",
    "  }",
    "}",
    "let created = false;",
    "if (!col) {",
    "  col = new Zotero.Collection();",
    "  col.libraryID = lib;",
    "  col.name = P.docName;",
    "  col.parentID = parent.id;",
    "  await col.saveTx();",
    "  created = true;",
    "} else if (col.name !== P.docName) {",
    /* 文档改名后集合跟着改 */
    "  col.name = P.docName;",
    "  await col.saveTx();",
    "}",
    /* key → itemID：找不到的记进 missing，不让整次同步失败（文献被删是常态） */
    "const ids = []; const missing = [];",
    "P.keys.forEach(function (k) {",
    "  let it = null;",
    "  try { it = Zotero.Items.getByLibraryAndKey(lib, k); } catch (e) { it = null; }",
    "  if (it && it.id) ids.push(it.id); else missing.push(k);",
    "});",
    "const have = (col.getChildItems() || []).map(function (i) { return i.id; });",
    "const toAdd = ids.filter(function (id) { return have.indexOf(id) < 0; });",
    "const toRemove = have.filter(function (id) { return ids.indexOf(id) < 0; });",
    "let added = 0, removed = 0;",
    "if (toAdd.length) {",
    "  await Zotero.DB.executeTransaction(async function () { await col.addItems(toAdd); });",
    "  added = toAdd.length;",
    "}",
    "if (toRemove.length) {",
    "  await Zotero.DB.executeTransaction(async function () { await col.removeItems(toRemove); });",
    "  removed = toRemove.length;",
    "}",
    "return JSON.stringify({ok: true, key: col.key, name: col.name, parent: parent.key,",
    "  renamed: renamed, created: created, added: added, removed: removed,",
    "  total: ids.length, missing: missing});",
  ].join("\n");
}

/**
 * 顶栏图标（32 栅格，画在 2 单位整数栅格上 —— 思源顶栏只显示 16px，
 * 坐标取偶数才能让 2:1 缩放落到整像素，否则斜笔会糊成一团）。
 *   红 Z  —— 继承 Zotero 的标志色，一排灰图标里一眼能认
 *   上标块 —— 点出"文献引用编号"的语义，缩到 16px 退化成一个亮点，仍可辨
 * 颜色写死，不用 currentColor：思源顶栏默认会把图标染成主题色，
 * 混在一排灰图标里就找不到了。渐变用 inline style，防止被主题 CSS 覆盖。
 */
const ICON_SVG = `<svg class="zc-topbar-icon" viewBox="0 0 32 32" width="32" height="32" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="zcZg" x1="12" y1="10" x2="12" y2="30" gradientUnits="userSpaceOnUse"><stop stop-color="#E4523F"/><stop offset="1" stop-color="#BC1B14"/></linearGradient></defs><path d="M2 10h20v6L12 24h10v6H2v-6l10-8H2z" fill="url(#zcZg)" style="fill:url(#zcZg)"/><rect x="24" y="2" width="6" height="6" rx="1.5" fill="#F26B55" style="fill:#F26B55"/></svg>`;

/**
 * 引用形态。
 *
 * 只有两种，因为「正文引用长什么样、多条怎么合并、要不要带 [n]」全部由 CSL 样式
 * 自己定义（APA → (作者, 年)；IEEE → [1]；GB/T 顺序编码 → [1]）。插件不再自作主张。
 *
 *  - csl : 完全按样式输出（默认）
 *  - narr: 叙述式 —— author-only + suppress-author，样式不支持时自动退回 csl
 *
 * 形态逐条存储，写在链接的 ?f= 里，同一篇可以混用。
 */
const FMT = {
  csl: { narr: false },
  narr: { narr: true },
};

const FMT_LABEL = {
  csl: "文献引用默认格式（按 CSL 样式）",
  narr: "Chen et al. (2026) 叙述式",
};

const FMT_ORDER = ["csl", "narr"];

/** 旧版形态 ID → 新形态（1.2.0 收敛为两种） */
const LEGACY_FMT = {
  csl: "csl",
  narr: "narr",
  paren: "csl",
  num: "csl",
  "paren+num": "csl",
  "narr+num": "narr",
};

function normFmt(id) {
  return LEGACY_FMT[String(id || "").trim()] || "csl";
}

/** 插件配置文件（相对 data/storage/petal/<pluginName>/） */
const CONF_FILE = "conf.json";

/** 从任意对象里只挑出 DEFAULT_SETTINGS 定义过的键（防止历史脏键写回） */
function pickSettings(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") {
    return out;
  }
  for (const k in DEFAULT_SETTINGS) {
    if (obj[k] !== undefined) {
      out[k] = obj[k];
    }
  }
  return out;
}

/**
 * 引用链接正则。
 * 分组1 = 显示文本（允许反斜杠转义）
 * 分组2 = 路径里的 key（新格式只有一个；旧格式是 A,B 逗号串，重排时自动迁移）
 * 分组3 = 整个 query 串（zkeys / f / bib……），由 parseQuery 再拆
 *
 * ⚠️ 为什么不把多个 key 直接写在路径里（zotero://select/library/items/A,B）？
 *    Zotero 10 的 ZoteroProtocolHandler 只有「query 参数 itemKey」会被
 *    Zotero.API.parseParams 按逗号拆开；路径里的 :objectKey 会整串当成一个 key 去查，
 *    经 Windows 协议分发后实测会把 Zotero 拖到无响应。
 *    所以路径只放第一个 key（保证被系统直接打开时也是合法单条），
 *    其余 key 放 ?zkeys=，由插件解析后走 ZBridge 多选。
 */
const CITE_RE = /\[((?:\\.|[^\[\]\\])*)\]\(zotero:\/\/select\/library\/items\/([A-Za-z0-9]+(?:,[A-Za-z0-9]+)*)(?:\?([^)\s]*))?\)/g;

/** 把 ?a=1&b=2 拆成对象 */
function parseQuery(q) {
  const out = {};
  // ⚠️ 思源 kramdown 会把链接里的 & 存成 &amp;，
  //    不还原的话 "zkeys=…&amp;f=narr" 只会解析出 zkeys，f 丢了。
  const raw = String(q || "").replace(/&amp;/gi, "&");
  raw.split("&").forEach((kv) => {
    if (!kv) {
      return;
    }
    const i = kv.indexOf("=");
    const k = i < 0 ? kv : kv.slice(0, i);
    const v = i < 0 ? "" : kv.slice(i + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch (e) {
      out[k] = v;
    }
  });
  return out;
}

/** 把正则的两个分组拍平成去重的 key 数组 */
function citeKeysOf(kPath, query) {
  const q = parseQuery(query);
  const out = String(kPath || "").split(",")
    .concat(q.zkeys ? String(q.zkeys).split(",") : [])
    .filter(Boolean);
  return Array.from(new Set(out));
}

/** 从 query 里取形态 ID；没有（老链接）就用 fallback。老形态 ID 会被 normFmt 迁移 */
function fmtOfQuery(query, fallback) {
  const f = String(parseQuery(query).f || "").trim();
  return f ? normFmt(f) : normFmt(fallback);
}

/** 从一条 zotero:// 链接里解析出 itemKey 列表（兼容新老格式与 ?bib=1） */
function parseCiteKeys(href) {
  const s = String(href || "");
  const m = /zotero:\/\/select\/library\/items\/([^?#\s]+)(?:\?([^#\s]*))?/.exec(s);
  if (!m) {
    return [];
  }
  return citeKeysOf(m[1], m[2] || "");
}

/* ============================ Zotero 桥 ============================ */

/**
 * 实际请求地址。
 *   ZBridge 原生端点 /zbridge/execute 只认 query 里的 token（Bearer 会被忽略），
 *   所以这里把设置里的令牌补进 query；用户自己填了 ?token= 就尊重原值。
 *   原版兼容端点 /debug-bridge/execute 走 Authorization 头，地址原样返回。
 */
function bridgeUrlFor(settings) {
  let url = String(settings.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl).trim() || DEFAULT_SETTINGS.bridgeUrl;
  if (/\/zbridge\/execute(\?|$)/.test(url) && !/[?&]token=/.test(url)) {
    url += (url.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(settings.token || "");
  }
  return url;
}

/**
 * 在 Zotero 里执行一段 JS，返回它 JSON.parse 后的结果。
 * code 必须是裸 JS（可用 return）。
 */
async function zoteroExec(settings, code) {
  const url = bridgeUrlFor(settings);
  if (!settings.token) {
    throw new Error("还没填令牌。本插件依赖 Zotero 的「" + DEP_NAME + "」扩展：先装好它，" +
      "用 工具 → 开发者 → Run JavaScript 设置 token，再把 token 填到插件设置里。" +
      "安装步骤：" + DEP_URL);
  }
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Authorization": "Bearer " + settings.token,
      },
      body: code,
    });
  } catch (e) {
    throw new Error("连不上 Zotero（" + url + "）。检查两件事：① Zotero 已启动；" +
      "② 已装「" + DEP_NAME + "」扩展（没装的话这个端口根本不存在）。" +
      "安装步骤：" + DEP_URL + (e && e.message ? " 详情：" + e.message : ""));
  }
  const txt = await resp.text();
  if (!resp.ok) {
    // 404 = 端口在（Zotero 起了）但没有这个端点 → 十成是没装 ZBridge
    const hint = resp.status === 404
      ? " 端口通但没有 zbridge 端点，通常是没装「" + DEP_NAME + "」扩展。下载与安装：" + DEP_URL
      : (resp.status === 401 || resp.status === 403
        ? " 令牌不对。到 Zotero 设置编辑器核对 " + DEP_TOKEN_PREF + "，" +
          "并确认插件设置里的访问令牌与它一致。"
        : "");
    throw new Error("ZBridge 返回 " + resp.status + "：" + String(txt).slice(0, 200) + hint);
  }
  let v = txt;
  // 兼容端点会把返回值再 JSON.stringify 一层，形成「字符串套 JSON」（原生端点也是单层字符串）
  for (let i = 0; i < 2 && typeof v === "string"; i++) {
    const t = v.trim();
    if (!t.startsWith("{") && !t.startsWith("[") && !t.startsWith("\"")) {
      break;
    }
    try {
      v = JSON.parse(t);
    } catch (e) {
      break;
    }
  }
  if (typeof v === "string") {
    throw new Error("Zotero 返回了非预期内容：" + v.slice(0, 300));
  }
  if (v && v.error) {
    const err = new Error(v.error === "no-items"
      ? "这些条目在 Zotero 里找不到（可能已删除或换了库）：" + (v.missing || []).join(", ")
      : v.error === "style-missing"
        ? "本机 Zotero 里没有这个 CSL 样式：" + v.wanted +
          "。自定义样式不随 Zotero 账号同步，换电脑要手动把 .csl 装到本机；" +
          "或在插件设置里换一个已装样式。本机现有样式：" + (v.available || []).join(" / ")
        : String(v.error));
    /*
     * 把 Zotero 侧的出错类型带出来：调用方要区分「条目查不到」（可以退回文档存档，
     * 属于可恢复）与「样式没装 / 连不上」（必须报给用户），不能一律当致命错误。
     */
    err.zcode = v.error;
    err.zdata = v;
    throw err;
  }
  return v;
}

/**
 * 去掉 kramdown 里携带的块属性语法 `{: id="…" updated="…"}`。
 *
 * ⚠️ 为什么必须去掉（踩过的坑）：
 *    读块内容用的是 `getBlockKramdown`，属性是**紧贴正文末尾**的一串
 *    `…{: id="20261031203523-ozf451t" updated="20261031205035"}`；
 *    写回去用的是 `updateBlock` + `dataType: "markdown"`。
 *    这两个不是同一种语法：markdown 侧不一定把紧贴的 `{: …}` 认成块属性，
 *    一旦没认出来，它就变成**正文文字**，用户看到的是
 *
 *        Zhang et al. (2020)}{: id="20261031203523-ozf451t" updated="20261031205035"}
 *
 *    块 id 和属性由思源自己维护，`updateBlock` 按 id 原地更新，不需要我们回传，
 *    所以最稳的做法是写之前把它整段剥掉。
 */
function stripBlockAttrs(kd) {
  let s = String(kd || "");
  // 1) 独占一行的属性行（列表、表格、标题后面常见）
  s = s.replace(/^[ \t]*\{:[^{}\n]*\}[ \t]*$/gm, "");
  // 2) 紧贴正文末尾的属性；可能被历史污染叠了不止一层，反复剥到稳定
  let prev;
  do {
    prev = s;
    s = s.replace(/[ \t]*\{:[^{}\n]*\}[ \t]*$/gm, "");
  } while (s !== prev);
  // 3) 已经被写进正文的残渣（就在行中间）：`{: id="…" updated="…"}`
  //    这是修复历史损坏的关键 —— 不清掉它，重排一百次也还是正文。
  s = s.replace(/\{:\s*[^{}\n]*\}/g, "");
  // 去掉清洗后留下的行尾空格与多余空行
  s = s.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

/**
 * 判断一段 kramdown 的块属性是不是「已经脏了」。
 *
 * 思源自己写出来的属性只有两种合法位置：
 *   · 行首/行尾独占：`正文\n{: id="…" updated="…"}`
 *   · 紧跟在列表、引用标记后面：`- {: id="…"}正文` / `> {: id=…}内容`
 *
 * ⚠️ 不能再用「出现两组以上就算脏」：列表块和列表项块天生就带多组属性 ——
 *    `i` 块的 kramdown 是 `- {: id="…"}列表项甲\n  {: id="…"}`，`l` 块里
 *    每个子项都带一组。旧判据把它们永远判成脏，于是**每重排一次就白写一遍**
 *    （2026-11-04 实测：列表里带引用的文档每次 updated 都多 2，永远不收敛）。
 *
 * 真正脏的形态是「属性前面还压着正文」，例如历史上出现过的
 * `Zhang et al. (2020)}{: id="…" updated="…"}` —— 那一组的前面不是空白、
 * 也不是列表/引用标记，说明它已经变成正文文字了，必须写一次清掉。
 */
function attrsAreDirty(kd) {
  const s = String(kd || "");
  const re = /\{:[^{}\n]*\}/g;
  let m;
  while ((m = re.exec(s))) {
    const lineStart = s.lastIndexOf("\n", m.index) + 1;
    const head = s.slice(lineStart, m.index);
    if (!/^[\s>*+\-–—\d.、)）|]*$/.test(head)) {
      return true;
    }
  }
  return false;
}

/**
 * 把代码块 / 行内代码临时遮住。
 *
 * ⚠️ 为什么要遮：教程、备份文档里经常贴示例
 *     `[标题](zotero://select/library/items/KEY?f=csl)`
 *    不遮住的话，重排会把这段示例当成真引用，甚至给它生成参考文献
 *    （实测在备份文档上误加了一整节「参考文献」）。
 */
function maskCode(text) {
  const store = [];
  const masked = String(text || "").replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    store.push(m);
    return "\u0001ZCMASK" + (store.length - 1) + "\u0001";
  });
  return { s: masked, store: store };
}

function unmaskCode(text, store) {
  return String(text || "").replace(/\u0001ZCMASK(\d+)\u0001/g, (_, i) => {
    const v = store[Number(i)];
    return v == null ? "" : v;
  });
}

/** 规范化：遮住代码 → 剥块属性 → 去零宽字符 → 还原代码 */
function canonicalContent(kd) {
  const mk = maskCode(kd);
  return unmaskCode(stripBlockAttrs(mk.s), mk.store).replace(/[\u200b\u200c\u200d]/g, "");
}

/** 组装 Zotero 侧渲染脚本 */
function buildRenderScript(payload) {
  const P = JSON.stringify(payload);
  return `
const P = ${P};
const lib = Zotero.Libraries.userLibraryID;
const items = P.keys.map(function (k) { return Zotero.Items.getByLibraryAndKey(lib, k); })
                   .filter(function (x) { return !!x; });
if (!items.length) { return JSON.stringify({error: "no-items", missing: P.keys}); }
/*
 * 样式必须真实存在，找不到就报错退出 —— 不做静默回退。
 * ⚠️ 这里以前写成 Styles.get(styleId) || Styles.getVisible()[0]：
 *    换电脑后自定义样式（比如 syau-thesis 沈农学位论文）没装，就会悄悄换成
 *    可见列表第一个（本机是 ACS Guide 2026），把全篇正文与文末格式改掉，
 *    还不报错。宁可拒绝重排，也不能替用户换样式。
 */
const style = Zotero.Styles.get(P.styleId);
if (!style) {
  return JSON.stringify({
    error: "style-missing",
    wanted: P.styleId,
    available: Zotero.Styles.getVisible().slice(0, 8).map(function (s) { return s.title || s.styleID; })
  });
}
const csl = style.getCiteProc();
csl.setOutputFormat("html");
csl.updateItems(items.map(function (i) { return i.id; }));
const citeFormat = (csl.opt && csl.opt.citation_format) || null;

const idByKey = {};
items.forEach(function (i) { idByKey[i.key] = i.id; });

/*
 * 快照底料：把每条条目转成「精简 CSL 对象」，随渲染结果一起回传，插件侧压进文档属性。
 * 用 csl.retrieveItem（citeproc 真实的取数口径）而不是 item.toJSON：字段名与 CSL 一致，
 * 以后要拿它重建 Zotero 条目时不用再做一遍映射；体积也只有 toJSON 的约三分之一。
 */
const snapCsl = {};
const keepFields = P.cslKeep || [];
items.forEach(function (i) {
  try {
    const o = csl.retrieveItem(i.id);
    if (!o) { return; }
    const slim = {id: i.id, type: o.type};
    keepFields.forEach(function (f) {
      const v = o[f];
      if (v !== undefined && v !== null && v !== "") { slim[f] = v; }
    });
    snapCsl[i.key] = slim;
  } catch (e) { /* 取不到就不进快照，绝不影响本次渲染 */ }
});

/*
 * 按「正文出现顺序」逐个 cluster 渲染。
 * 两条理由：
 *  1) 多条目必须一次交给 CSL，它才会自己排序、去重、压缩成 (A, 2019; B, 2020) / [1], [2]
 *     ——插件手工拼括号既不尊重排序规则，也拼不出数字样式的连号压缩。
 *  2) 数字样式的编号是按 makeCitationCluster 的调用顺序分配的，顺序一乱编号就错。
 */
const cites = {};
P.clusters.forEach(function (ks) {
  const group = ks.map(function (k) { return {id: idByKey[k]}; })
                  .filter(function (g) { return !!g.id; });
  if (!group.length) { return; }
  const key = ks.join("|");
  if (cites[key]) { return; }
  const c = String(csl.makeCitationCluster(group)).trim();
  let np = [];
  // 数字式样式没有 author-only，硬调只会输出 [NO_PRINTED_FORM]，直接不给。
  if (citeFormat !== "numeric") {
    /*
     * ⚠️ 叙述式必须逐条渲染再拼，不能把多条塞进一次 author-only 调用：
     *    那样 CSL 会输出 "Y. Lu et al. (2021; 2020)" —— 把不同作者的年份塞进一个括号，
     *    语义完全错。逐条得 "Zhang et al. (2020); Kumar et al. (2020)" 才对。
     *    拼接规则（分号 + 最后的 and/和）交给插件侧 joinNarrParts，脚本只给零件。
     */
    np = group.map(function (g) {
      let a = String(csl.makeCitationCluster([{id: g.id, "author-only": true}])).trim();
      /*
       * 有些样式（Crop Science、部分 Elsevier 系）在 author-only 里连"作者与年份之间的
       * 分隔逗号"一起吐出来，直接拼会变成 "Lu et al., (2021)"。
       * 只去尾随逗号，句点必须留 —— "et al." 的句点是作者缩写的一部分。
       */
      a = a.replace(/[,，]\s*$/, "");
      const b = String(csl.makeCitationCluster([{id: g.id, "suppress-author": true}])).trim();
      return (a + " " + b).trim();
    }).filter(function (x) { return x && x.indexOf("NO_PRINTED_FORM") < 0; });
  }
  cites[key] = {c: c, np: np};
});

const r = csl.makeBibliography();
const entries = (r && r[1]) ? r[1] : [];
const eids = (r && r[0] && r[0].entry_ids) ? r[0].entry_ids : [];
// ⚠️ 作者年样式的 bibliography 按作者字母排序，entries[i] 与 keys[i] 不是一一对应。
//    必须用 entry_ids 把条目重新绑到 key 上，否则文末列表与跳转链接会错位。
const idToKey = {};
items.forEach(function (i) { idToKey[i.id] = i.key; });
const bibByKey = {};
const bibOrder = [];
entries.forEach(function (html, idx) {
  const eid = eids[idx] && eids[idx][0];
  const k = (eid !== undefined && eid !== null) ? idToKey[eid] : null;
  if (k) {
    bibByKey[k] = html;
    bibOrder.push(k);
  }
});
// 有没有任何一种 cluster 能出叙述式？数字式样式（IEEE / GB-T 顺序编码）一律没有，
// csl.opt.citation_format 在 Zotero 里拿不到（返回 null），只能从实际输出反推。
let narrativeSupported = false;
for (const ck in cites) {
  if (cites[ck] && cites[ck].np && cites[ck].np.length) { narrativeSupported = true; break; }
}
return JSON.stringify({
  style: {id: style.styleID, title: style.title},
  citationFormat: citeFormat,
  narrativeSupported: narrativeSupported,
  cites: cites,
  bibByKey: bibByKey,
  bibOrder: bibOrder,
  bibRaw: entries,
  snapCsl: snapCsl,
  order: items.map(function (i) { return i.key; }),
  meta: items.map(function (i) {
    return {
      key: i.key,
      title: String(i.getField("title") || ""),
      year: String(i.getField("date") || "").slice(0, 4),
      authors: (i.getCreators() || []).map(function (c) { return c.lastName || c.name || ""; }).join(", "),
      itemType: Zotero.ItemTypes.getName(i.itemTypeID)
    };
  })
});
`;
}

/* ============================ 元数据取用 ============================ */

/** 读 Zotero 当前选中条目 */
async function fetchSelected(settings) {
  const code = `
const pane = Zotero.getActiveZoteroPane();
if (!pane) { return JSON.stringify({items: []}); }
const sel = pane.getSelectedItems();
/*
 * 引用只认「父条目」。选中的是 PDF / 笔记时上溯到父条目，
 * 独立笔记、独立附件（没有父条目）直接丢掉 —— 它们没有可引用的书目信息。
 */
const picked = [];
const seen = {};
for (let k = 0; k < sel.length; k++) {
  let it = sel[k];
  /*
   * 一路向上找父条目：批注（annotation）的父级是附件，附件再上一级才是书目，
   * 只上溯一层会停在附件上、被丢掉。没有父级的（独立笔记/独立附件）直接跳过。
   */
  let guard = 0;
  while (it && (!it.isRegularItem || !it.isRegularItem()) && guard++ < 8) {
    const pid = it.parentID || (it.parentItem && it.parentItem.id) || 0;
    it = pid ? Zotero.Items.get(pid) : null;
  }
  if (!it || (it.isRegularItem && !it.isRegularItem())) { continue; }
  if (seen[it.key]) { continue; }
  seen[it.key] = 1;
  picked.push(it);
}
return JSON.stringify({items: picked.map(function (i) {
  return {
    key: i.key,
    title: String(i.getField("title") || ""),
    year: String(i.getField("date") || "").slice(0, 4),
    authors: (i.getCreators() || []).map(function (c) { return c.lastName || c.name || ""; }).join(", "),
    itemType: Zotero.ItemTypes.getName(i.itemTypeID)
  };
})});
`;
  const r = await zoteroExec(settings, code);
  return (r && r.items) || [];
}

/** 在 Zotero 库里快速搜索（只返回父条目） */
async function searchLibrary(settings, q) {
  const code = `
const q = ${JSON.stringify(q)};
const lib = Zotero.Libraries.userLibraryID;
const s = new Zotero.Search();
s.libraryID = lib;
s.addCondition("quicksearch-everything", "contains", q);
const ids = await s.search();
/*
 * ⚠️ quicksearch-everything 会把**笔记和附件**一起搜出来（PDF 文件名也参与匹配）。
 *    引用只认父条目，所以这里统一上溯：
 *      · 子条目（附件/笔记）→ 父条目
 *      · 独立笔记、独立附件（没有 parentID）→ 丢掉，它们没有可引用的书目信息
 *      · 同一父条目被多条子项命中 → 去重
 *    40 条上限按「父条目」算，不是按原始命中数算。
 */
const picked = [];
const seen = {};
for (let k = 0; k < ids.length && picked.length < 40; k++) {
  let it = Zotero.Items.get(ids[k]);
  if (!it) { continue; }
  /* 批注 → 附件 → 父条目，一路向上；没有父级的独立笔记/独立附件直接跳过 */
  let guard = 0;
  while (it && (!it.isRegularItem || !it.isRegularItem()) && guard++ < 8) {
    const pid = it.parentID || (it.parentItem && it.parentItem.id) || 0;
    it = pid ? Zotero.Items.get(pid) : null;
  }
  if (!it || (it.isRegularItem && !it.isRegularItem())) { continue; }
  if (seen[it.key]) { continue; }
  seen[it.key] = 1;
  picked.push(it);
}
return JSON.stringify({items: picked.map(function (i) {
  return {
    key: i.key,
    title: String(i.getField("title") || ""),
    year: String(i.getField("date") || "").slice(0, 4),
    authors: (i.getCreators() || []).map(function (c) { return c.lastName || c.name || ""; }).join(", "),
    itemType: Zotero.ItemTypes.getName(i.itemTypeID)
  };
})});
`;
  const r = await zoteroExec(settings, code);
  return (r && r.items) || [];
}

/** 读 Zotero 已安装的 CSL 样式 */
async function fetchStyles(settings) {
  const code = `
const list = Zotero.Styles.getVisible().map(function (s) {
  return {id: s.styleID, title: s.title};
});
return JSON.stringify({styles: list});
`;
  const r = await zoteroExec(settings, code);
  return (r && r.styles) || [];
}

/* ============================ 文末标题 ============================ */

/**
 * 判断当前 CSL 样式是不是「中文样式」。
 * 优先看 Zotero 给出的样式 title 里有没有汉字（渲染脚本已经把 style.title 带回来了）；
 * 拿不到 title 时退回 styleId 的关键字（GB/T 7714 系列、CSTR、各家中文期刊样式都命中）。
 */
function isChineseStyle(styleId, styleTitle) {
  if (/[\u3400-\u9fff]/.test(String(styleTitle || ""))) {
    return true;
  }
  const id = String(styleId || "").toLowerCase();
  return /china|chinese|gb[-\/]?t|7714|cstr|zh[-\/]|cn[-\/]/.test(id);
}

/**
 * 解析文末标题最终要写的文字。返回空字符串表示「不生成标题块」。
 *   "auto"      → 中文样式「参考文献」，其它「References」
 *   "" / "none" → 空（不生成）
 *   其它        → 原样
 * ⚠️ rendered 可能为 null（扫描阶段还没渲染），这时只用 styleId 判断，结果一致。
 */
function resolveBibHeading(settings, rendered) {
  const raw = String((settings && settings.bibHeading) == null ? "auto" : settings.bibHeading).trim();
  if ("" === raw || "none" === raw.toLowerCase()) {
    return "";
  }
  if ("auto" === raw.toLowerCase()) {
    const st = (rendered && rendered.style) || {};
    const id = st.id || (settings && settings.styleId);
    return isChineseStyle(id, st.title) ? "参考文献" : "References";
  }
  return raw;
}

/** 插件自己以前写过的标题文字，用来认领老文档里的标题块 */
const LEGACY_BIB_HEADINGS = ["参考文献", "References", "Bibliography", "参考书目"];

/* ============================ HTML → Markdown ============================ */

const ENTITIES = {
  "&#38;": "&", "&amp;": "&", "&#60;": "<", "&lt;": "<", "&#62;": ">", "&gt;": ">",
  "&#34;": "\"", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
  "&#x2013;": "–", "&#8211;": "–", "&#x2014;": "—", "&#8212;": "—",
  "&#x2019;": "’", "&#8217;": "’", "&#x2018;": "‘", "&#8216;": "‘",
};

function decodeEntities(s) {
  let out = String(s || "");
  for (const k in ENTITIES) {
    out = out.split(k).join(ENTITIES[k]);
  }
  return out.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/**
 * <sup>/<sub> 统一成无属性的 HTML 标签。
 *
 * ⚠️ 为什么不用 Unicode 上标（¹²³）：
 *    Unicode 没有「上标逗号」，多条目会变成 `¹,³,⁴` —— 逗号掉回基线，看着是断的
 *    （ACS 这类样式正文就是 <sup>1,3,4</sup>）。
 *    HTML 的 <sup> 能把整串连逗号一起抬上去，思源也认这个标签。
 *
 * ⚠️ 副作用与对策：
 *    链接文本里带 <sup> 时，思源会把节点渲染成 data-type="a sup"。
 *    所以所有"找引用链接"的选择器一律用 [data-href*="zotero://select"]，
 *    绝不能用 [data-type="a"] 精确匹配。
 */
function normScriptTags(s) {
  return String(s || "")
    .replace(/<sup[^>]*>/gi, "<sup>")
    .replace(/<\/sup>/gi, "</sup>")
    .replace(/<sub[^>]*>/gi, "<sub>")
    .replace(/<\/sub>/gi, "</sub>");
}

/** 这段 HTML 是不是整体被一个 <sup> 包住（正文里条那样的整体上标引用） */
function isWholeSup(html) {
  const s = normScriptTags(html).trim();
  const m = /^<sup>([\s\S]*)<\/sup>$/.exec(s);
  if (!m) {
    return null;
  }
  // 内部不能再有 sup，否则不是"整体包一层"
  if (/<sup[\s>]/i.test(m[1])) {
    return null;
  }
  return m[1];
}

/** citeproc 的 HTML 片段 → 思源可用的 markdown 行内文本 */
function cslHtmlToMarkdown(html) {
  let s = String(html || "");
  // 数字式样式（IEEE 等）的条目是两栏结构：
  // <div class="csl-left-margin">[1]</div><div class="csl-right-inline">正文</div>
  // 必须先拍平成 "[1] 正文"，否则两个 div 被剥掉后序号会丢。
  s = s.replace(
    /<div[^>]*class="csl-left-margin"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="csl-right-inline"[^>]*>([\s\S]*?)<\/div>/gi,
    (_, num, body) => {
      // 序号可能是 "[1]"、"(1)"、"1." —— 已自带括号就原样用，别再包一层
      let label = decodeEntities(String(num).replace(/<[^>]+>/g, "")).trim();
      if (label && !/^[\[(（]/.test(label)) {
        label = "[" + label + "]";
      }
      return label ? label + " " + body : body;
    }
  );
  s = s.replace(/<div[^>]*class="csl-entry"[^>]*>/gi, "").replace(/<\/div>/gi, "");
  s = s.replace(/<div[^>]*>/gi, "").replace(/<\/div>/gi, "");
  // 上下标保留为 HTML（不用 Unicode：没有上标逗号，多条目会断成 ¹,³,⁴）
  s = normScriptTags(s);
  s = s.replace(/<i[^>]*>/gi, "*").replace(/<\/i>/gi, "*");
  s = s.replace(/<em[^>]*>/gi, "*").replace(/<\/em>/gi, "*");
  s = s.replace(/<b[^>]*>/gi, "**").replace(/<\/b>/gi, "**");
  s = s.replace(/<strong[^>]*>/gi, "**").replace(/<\/strong>/gi, "**");
  s = s.replace(/<span[^>]*>/gi, "").replace(/<\/span>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, " ");
  // 链接保留为 markdown
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = decodeEntities(text).replace(/[\[\]]/g, "");
    if (!t || /^https?:\/\/doi\.org\//i.test(t) && false) {
      return t;
    }
    return "[" + t + "](" + href + ")";
  });
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** 把「不属于 markdown 链接」的裸方括号转义，避免条目被误解析 */
function escapeLooseBrackets(md) {
  const store = [];
  let s = String(md || "").replace(/\[[^\[\]]*\]\([^)]+\)/g, (m) => {
    store.push(m);
    return "\u0000" + (store.length - 1) + "\u0000";
  });
  s = s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => store[Number(i)]);
  return s;
}

/**
 * 拆出文末条目开头的编号前缀，返回 { label, head, n, body } 或 null。
 *
 * 口径与 cslNumRe 一致：`[1]` / `［1］` / `(1)` / `（1）` / `1.` / `1、` / `1)`。
 * ⚠️ 必须排除「年份开头」的样式：有的样式条目本身就是 `(2020). Title…` 或 `2020. Title…`，
 *    把 2020 当编号会把整条正文剥掉。判据用「编号不可能大到年份那个量级」。
 */
function splitBibHead(text) {
  const s = String(text || "");
  const m = /^\s*(\[\s*\d+\s*\]|［\s*\d+\s*］|\(\s*\d+\s*\)|（\s*\d+\s*）|\d{1,4}\s*[.、．)）])\s*/.exec(s);
  if (!m) {
    return null;
  }
  const n = Number((m[1].match(/\d+/) || ["0"])[0]);
  if (!n || n > 999) {
    return null;
  }
  return { label: m[1], head: m[0], n: n, body: s.slice(m[0].length) };
}

/* ============================ 引用记录（正文回收） ============================ */

/**
 * 剥掉包在 Zotero 引用外面的 <sup>/<sub> 外壳。
 *
 * 历史包袱：1.2.0 早期版本把 CSL 的 <sup>1</sup> 写成 markdown 的 ^1^，
 * 思源把它当上标语法解析，于是链接变成 <sup>[1](zotero://…)</sup> ——
 * 上标里的 markdown 链接不再被解析，DOM 里 data-type="a" 消失，右键自然"没了"。
 * 重排时必须先把这个壳剥掉，否则每重排一次就多套一层 <sup>。
 */
function unwrapCiteSups(kd) {
  let s = String(kd || "");
  let prev;
  do {
    prev = s;
    s = s.replace(/<sup>\s*(<sup>)?\s*(\[[^\]\n]*\]\(zotero:\/\/[^)\s]*\))\s*(<\/sup>)?\s*<\/sup>/g, "$2");
    s = s.replace(/<sub>\s*(<sub>)?\s*(\[[^\]\n]*\]\(zotero:\/\/[^)\s]*\))\s*(<\/sub>)?\s*<\/sub>/g, "$2");
  } while (s !== prev);
  return s;
}

/**
 * 删掉标签残渣：空的 <sup>*</sup>，以及没有开标签的孤立 </sup>。
 * 这些是历史上 * 与 <sup> 错位配对留下的，肉眼看不见但会一直堆在正文里。
 */
function dropStrayScriptTags(s) {
  let t = String(s || "");
  let prev;
  do {
    prev = t;
    t = t.replace(/<sup>[\s\u200b\*]*<\/sup>/g, "");
    t = t.replace(/<sub>[\s\u200b\*]*<\/sub>/g, "");
  } while (t !== prev);

  // 用栈配对，删掉没有对应 <sup> 的 </sup>
  const out = [];
  let depth = 0;
  let last = 0;
  const re = /<\/?sup>/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    if (m[0] === "<sup>") {
      depth++;
      continue;
    }
    if (depth === 0) {
      out.push(t.slice(last, m.index));
      last = m.index + m[0].length;
    } else {
      depth--;
    }
  }
  out.push(t.slice(last));
  return out.join("");
}

/**
 * 把块里同一处引用的残留合并回一份。
 *
 * 历史包袱：1.2.x 反复调整上标写法时，多次重排把同一处引用写成了多份
 * （形如 `<sup>[1](url)</sup>​*<sup>[1](url)*</sup> ​<sup>[1](url)</sup>`，
 *  中间的 * 是斜体标记被错位配对）。这里统一：
 *   1) 把"装饰标记 + 链接"整体吃掉（含 \u200b 零宽空格、<sup>、*）
 *   2) 同一个 URL 只保留第一份，其余删掉
 *   3) 输出裸链接，后续按当前样式重新渲染
 * 同一段落里对同一文献重复引用两次属于极罕见情况，合并可接受。
 */
function collapseCiteMarkup(kd) {
  /*
   * ⚠️ 只合并「紧挨着的」重复，不能全局去重。
   *
   * 历史包袱：1.2.x 反复调整上标写法时，**同一处**引用被写成了多份，形如
   *     <sup>[1](url)</sup>​*<sup>[1](url)*</sup> ​<sup>[1](url)</sup>
   * 中间只剩装饰（零宽空格 / 星号 / <sup> 外壳），没有真正的文字。
   *
   * 但同一段里**正常地**引用同一篇文献两次（先一处……再一处）是常见写法，
   * 全局 seen 去重会把第二处也删掉 —— 实测就是这样丢了内容。
   * 判据改成：URL 相同 **且** 与上一次命中紧邻（中间没有任何文字）。
   */
  let lastUrl = null;
  let lastEnd = -1;
  /*
   * ⚠️ 这里的空白只能用「行内空白」[ \t\u00a0]，不能用 \s。
   *    \s 会把换行也吃掉：列表块里两个列表项之间是空行，一旦被吞掉，
   *    整个列表块每次重排都会被判成「内容变了」（写回去思源又补回空行），
   *    表现为列表里带引用的文档永远不幂等、每次 updated 都多 1（2026-11-04 实测）。
   */
  const unit = /([ \t\u00a0\u200b]|\*)*(<sup>)?[ \t\*]*(\[[^\]\n]*\]\(zotero:\/\/select\/library\/items\/[A-Za-z0-9]+[^)\s]*\))[ \t\*]*(<\/sup>)?[ \t\*]*/g;
  // 分组 1..4，offset 在第 5 个参数
  const s = String(kd || "").replace(unit, (full, pre, s1, link, s2, offset) => {
    const um = /\((zotero:\/\/[^)\s]*)\)/.exec(link);
    const url = um ? um[1] : link;
    const end = offset + full.length;
    const dup = url === lastUrl && offset <= lastEnd;
    if (!dup) {
      lastUrl = url;
    }
    // 即使丢掉这一份也要推进 lastEnd：三层残留是连着来的
    lastEnd = end;
    /*
     * ⚠️ 非重复时必须原样返回 full，不能返回 link。
     *    unit 的前后段 `([ \t\u00a0\u200b]|\*)*` 和 `[ \t\*]*` 把链接两侧的空白
     *    也吃进了匹配范围；以前统一 return link，等于每重排一次就把引用两侧的空格
     *    删掉一处，正文变成 `TN[(Case et al. 2012)`，切换 CSL 样式时尤其明显
     *    （2026-11-04 用户报的现象就是这个）。返回 full 即「这一份一个字符都不动」，
     *    真正要合并的重复份仍然整个丢掉。
     */
    return dup ? "" : full;
  });
  return dropStrayScriptTags(s);
}

/** 从 markdown 文本里按出现顺序收集 key，并返回链接片段列表。
 * fallbackFmt：老链接没带 ?f= 时按这个形态算（用于迁移，通常取设置里的默认形态）
 * 返回 { keys: [有序去重], hits: [{raw, text, keys, fmt, index}] }
 */
function scanCites(md, fallbackFmt) {
  const keys = [];
  const hits = [];
  const seen = new Set();
  CITE_RE.lastIndex = 0;
  let m;
  while ((m = CITE_RE.exec(md)) !== null) {
    // 文末参考文献条目的 [↗] 跳转链接带 ?bib=1，它也是 zotero:// 链接，
    // 但绝对不是正文引用。不排除掉的话：删掉正文引用后，文末条目还会被算成一处引用，
    // 于是这条文献永远删不掉（自持循环）。
    if (parseQuery(m[3]).bib === "1") {
      continue;
    }
    const inner = citeKeysOf(m[2], m[3]);
    hits.push({
      raw: m[0],
      text: m[1],
      keys: inner,
      fmt: fmtOfQuery(m[3], fallbackFmt),
      index: m.index,
    });
    for (const k of inner) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return { keys, hits };
}

/**
 * 把一段文本里的引用链接按「紧挨着」分组。
 *
 * 为什么需要：用户经常连着插两条，得到 `(Yuan et al., 2020)(Frederick, 2023)` ——
 * 两个独立链接、各渲染各的。正确写法是一个 cluster：`(Yuan et al., 2020; Frederick, 2023)`。
 * 只在中间**什么都没有**（空白/零宽字符）时才合并，中间有文字的一律不动。
 *
 * 返回 [{start, end, keys, items}]，keys 已去重且保持出现顺序（决定文末顺序）。
 */
function groupCites(text, fallbackFmt) {
  const src = String(text || "");
  const hits = [];
  CITE_RE.lastIndex = 0;
  let m;
  while ((m = CITE_RE.exec(src)) !== null) {
    // 文末条目的 [↗] 回跳链接带 ?bib=1，不是正文引用
    if (parseQuery(m[3]).bib === "1") {
      continue;
    }
    hits.push({
      start: m.index,
      end: m.index + m[0].length,
      text: m[1],
      keys: citeKeysOf(m[2], m[3]),
      fmt: fmtOfQuery(m[3], fallbackFmt),
    });
  }
  CITE_RE.lastIndex = 0;
  const groups = [];
  for (const h of hits) {
    const prev = groups[groups.length - 1];
    const gap = prev ? src.slice(prev.end, h.start) : null;
    /*
     * ⚠️ 只认同「同一行内的空白」。不能写成 \s —— \s 包含换行，
     *    那样全文导出时机上把**相邻两块**的引用当成一组合并，而逐块改写时块内只有单条，
     *    渲染结果里查不到这个组合，正文就会变成 `[?]`（实测踩过）。
     */
    if (prev && /^[ \t\u200b\u200c\u200d]*$/.test(gap)) {
      prev.end = h.end;
      prev.items.push(h);
      const seen = new Set(prev.keys);
      for (const k of h.keys) {
        if (!seen.has(k)) {
          seen.add(k);
          prev.keys.push(k);
        }
      }
    } else {
      groups.push({ start: h.start, end: h.end, keys: h.keys.slice(), items: [h] });
    }
  }
  return groups;
}

/** 按 groupCites 的结果重写文本：每一组交给 renderGroup(group) 生成新文本；返回 null 表示这组保持原样 */
function rewriteCites(text, groups, renderGroup) {
  let out = "";
  let last = 0;
  for (const g of groups) {
    out += text.slice(last, g.start);
    const rep = renderGroup(g);
    out += rep == null ? text.slice(g.start, g.end) : rep;
    last = g.end;
  }
  return out + text.slice(last);
}

/* ===================== 原生右键菜单：把插件项放到一级菜单 ===================== */

/** 菜单的 items 容器（思源的 Menu 实例 element 里有 .b3-menu__items） */
function menuItemsRoot(menu) {
  const el = menu && menu.element;
  if (!el) {
    return null;
  }
  try {
    if (el.querySelector) {
      const q = el.querySelector(".b3-menu__items");
      if (q) {
        return q;
      }
    }
  } catch (e) { /* 退回 element */ }
  return el;
}

/**
 * 取「真正的主菜单」。
 *
 * ⚠️ 关键结论（思源前端 App 层的行为，别绕开）：
 *    emit `open-menu-content` / `click-blockicon` 之前，思源会 new 一个 subMenu 顶替掉
 *    `detail.menu`，等事件跑完再把这个 subMenu 整体挂成主菜单里的「插件 ›」子项。
 *    所以凡是用 `detail.menu.addItem()` 加的项，**注定**进二级菜单 —— 调 index、加分隔线、
 *    事后搬 DOM 都没用（搬 DOM 还会弄坏 MenuItem 的宿主，点完关不掉菜单）。
 *
 * 正路：主菜单实例仍挂在 `window.siyuan.menus.menu` 上，且 MenuItem 默认就挂它，
 *       在它上面 addItem 既落在一级菜单，点完也能正常关闭。
 */
function mainMenuOf(menu) {
  try {
    if (typeof window === "undefined") {
      return null;
    }
    const m = window.siyuan && window.siyuan.menus && window.siyuan.menus.menu;
    if (!m || m === menu) {
      return null;
    }
    if (typeof m.addItem !== "function" || !m.element) {
      return null;
    }
    if (typeof m.element.querySelector !== "function") {
      return null;
    }
    // 没有 items 容器说明还是初始化阶段的空壳，退回子菜单更安全
    if (!m.element.querySelector(".b3-menu__items")) {
      return null;
    }
    return m;
  } catch (e) {
    return null;
  }
}

/** 把刚加进去的项搬到菜单最前面，并在其后补一条分隔线（思源块菜单有二十多项，追加在底部等于看不见） */
function promoteMenuItems(menu, before) {
  try {
    const root = menuItemsRoot(menu);
    if (!root || !root.children) {
      return;
    }
    const kids = Array.prototype.slice.call(root.children);
    if (kids.length <= before) {
      return;
    }
    const fresh = kids.slice(before);
    const anchor = root.firstChild;
    for (const el of fresh) {
      root.insertBefore(el, anchor);
    }
    const doc = root.ownerDocument || (root.parentNode && root.parentNode.ownerDocument);
    if (doc && root.children.length > fresh.length) {
      const sep = doc.createElement("div");
      sep.className = "b3-menu__separator";
      root.insertBefore(sep, fresh[fresh.length - 1].nextSibling);
    }
  } catch (e) { /* 排不上就保持原位，功能不受影响 */ }
}

/** 转义 markdown 链接文本里的方括号 */
function escapeLinkText(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
/**
 * 正文引用文本里绝不能出现强调标记（`*` / `<i>`）。
 *
 * 实测（2026-11-04，思源 3.8.9）：`[(*标题*, 不详)](zotero://…)` 会被 Lute 拆成三段链接 ——
 * `[(](…)​*[标题](…)​*[, 不详)](…)`，因为强调标记在链接文本里形成了嵌套；
 * 下一轮扫描就把这一处当成 3 条独立引用，每重排一次再拆一次，永远不收敛
 * （`<i>` 与 `*` 结果完全相同，都是被当成强调处理）。
 *
 * 网页类条目（无作者、无年份）恰恰最常渲染出 `(*标题*, 不详)` 这种形态，
 * 所以只要引用里出现斜体就必须剥掉。强调只是装饰，剥掉不影响可读性；
 * 宁可少一个斜体，也不能让链接结构坏掉、让重排永不幂等。
 * ⚠️ 只用于正文引用。文末条目是独立段落，不嵌链接，斜体照常保留。
 */
function stripEmphasis(s) {
  return String(s || "").replace(/\*+/g, "");
}
function unescapeLinkText(s) {
  return String(s || "").replace(/\\([\\\[\]])/g, "$1");
}

/** 生成一条引用链接的 markdown。fmtId 决定这处引用怎么呈现，写进 ?f= */
function makeCiteLink(text, keys, settings, fmtId) {
  const label = escapeLinkText(stripEmphasis(text));
  if (!settings.linkEnabled) {
    return label.replace(/\\/g, "");
  }
  const list = (keys || []).filter(Boolean);
  if (!list.length) {
    return label.replace(/\\/g, "");
  }
  // 路径只放第一个 key（单条 URL，任何情况下都能被系统正常打开）；
  // 多条目时用 ?zkeys= 带上全部 key，由插件解析后走 ZBridge 多选。
  const qs = [];
  if (list.length > 1) {
    qs.push("zkeys=" + list.join(","));
  }
  // ⚠️ 形态总是显式写进链接：每处引用自带形态，
  //    以后改设置里的「默认形态」不会悄悄改掉已经写好的引用。
  qs.push("f=" + normFmt(fmtId));
  return "[" + label + "](zotero://select/library/items/" + list[0] + "?" + qs.join("&") + ")";
}

/* ============================ 引用快照 ============================ */
/*
 * 为什么要把文献数据存进文档属性：
 *   Zotero 里删掉一条文献、或换到没同步全的电脑，渲染时就取不到这条。此时旧版会留下
 *   三处无声的痕迹：① 正文那处保留旧文字（看起来像正常引用，其实点开是空）；
 *   ② 合并引用（A+B）里缺失的那条静默消失，但 ?zkeys= 还挂着旧 key；
 *   ③ 文末末尾多一条只有 ↗ 的空条目。
 *   把「每条文献的精简 CSL 数据 + 上次渲染出的正文/文末文本」压进文档块属性后，
 *   下次重排即使 Zotero 里已经没有了，也能把上次的原文放回去，并明确告知。
 *
 * 体积（实测）：单条 CSL（剔除摘要、笔记）约 0.4 KB，gzip+base64 后约 0.3 KB，
 *   100 条约 30 KB。块属性实测写到 293 KB 仍只需 0.03 秒，读回逐字节一致。
 * 属性名 custom-zotero-bibsnap；值一律以 "z1:"（gzip）或 "j0:"（无 zlib 时）打头，
 *   后面全是 base64 —— 不含引号、花括号、下划线，绕开块属性的实体转义与
 *   _esc_newline_ 变换行那套语义改写。
 */
const SNAP_ATTR = "custom-zotero-bibsnap";
const SNAP_VER = 1;
/* 只留「重建条目」需要的字段：摘要、笔记、关键词一律不存（摘要一条就能占 700+ 字节） */
const SNAP_CSL_KEEP = [
  "type", "title", "author", "editor", "translator", "issued", "container-title",
  "collection-title", "volume", "issue", "page", "publisher", "publisher-place",
  "edition", "DOI", "URL", "ISBN", "ISSN", "language", "number", "number-of-pages",
  "genre", "event-title", "chapter-number", "archive", "archive_location",
];

function snapToB64(str) {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(str, "utf8").toString("base64");
    }
    return btoa(unescape(encodeURIComponent(str)));
  } catch (e) {
    return "";
  }
}

function snapFromB64(b64) {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(b64, "base64").toString("utf8");
    }
    return decodeURIComponent(escape(atob(b64)));
  } catch (e) {
    return "";
  }
}

/** 对象 → 属性值。gzip 优先，没有 zlib（手机端/受限环境）就退纯 base64。 */
function snapPack(obj) {
  const json = JSON.stringify(obj);
  try {
    const zlib = require("zlib");
    return "z1:" + zlib.gzipSync(Buffer.from(json, "utf8")).toString("base64");
  } catch (e) {
    return "j0:" + snapToB64(json);
  }
}

function snapUnpack(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  try {
    if (raw.startsWith("z1:")) {
      const zlib = require("zlib");
      return JSON.parse(zlib.gunzipSync(Buffer.from(raw.slice(3), "base64")).toString("utf8"));
    }
    if (raw.startsWith("j0:")) {
      return JSON.parse(snapFromB64(raw.slice(3)));
    }
    return JSON.parse(raw); // 兼容手工写进去的纯 JSON
  } catch (e) {
    return null;
  }
}

/** 读文档里的快照；没有或解不开都返回 null（不让快照坏了阻断重排） */
async function readSnapshot(docId, attrs) {
  try {
    let a = attrs;
    if (!a) {
      const r = await fetchSyncPost("/api/attr/getBlockAttrs", { id: docId });
      a = (r && r.data) || {};
    }
    const o = snapUnpack(a[SNAP_ATTR]);
    if (!o || !o.items) {
      return null;
    }
    return o;
  } catch (e) {
    return null;
  }
}

/**
 * 在快照 clusters 里找「这一处引用」。
 *
 * 先按原样的 key 顺序找（绝大多数情况一次命中）；顺序变了（用户在对话框里调过先后）
 * 就按 key 集合相等再找一遍 —— 同一组文献的显示文本，顺序换了文本也基本一致，
 * 拿它兜底远好过报「取不到」。
 */
function pickCluster(clusters, keys) {
  if (!clusters) {
    return null;
  }
  const exact = clusters[keys.join("|")];
  if (exact) {
    return exact;
  }
  const want = keys.slice().sort().join("|");
  const hit = Object.keys(clusters).find(
    (ck) => ck.split("|").slice().sort().join("|") === want
  );
  return hit ? clusters[hit] : null;
}

async function writeSnapshot(docId, snap) {
  try {
    await fetchSyncPost("/api/attr/setBlockAttrs", {
      id: docId,
      attrs: { [SNAP_ATTR]: snapPack(snap) },
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 按 key 批量取条目元数据（编辑引用对话框用）。
 *
 * found=false 表示「这个 key 在当前 Zotero 里找不到」。对话框据此退回文档快照显示，
 * 不能像以前那样直接写一句「(该条目已不在库里)」——换了 Zotero profile（数据目录）
 * 之后 key 会成批失效，用户看到的是一屏同样的空行，既不知道是哪篇，也不知道能不能救。
 *
 * 查找范围是「所有库」而不只是我的文库：条目可能被搬进群组库。
 */
async function fetchMetaByKeys(settings, keys) {
  const code = `
const lib = Zotero.Libraries.userLibraryID;
const libs = [];
try {
  (Zotero.Libraries.getAll() || []).forEach(function (l) {
    if (libs.indexOf(l.libraryID) < 0) { libs.push(l.libraryID); }
  });
} catch (e) {}
if (libs.indexOf(lib) < 0) { libs.unshift(lib); }
function zcItem(k) {
  for (let i = 0; i < libs.length; i++) {
    const it = Zotero.Items.getByLibraryAndKey(libs[i], k);
    if (it) { return it; }
  }
  return null;
}
const ks = ${JSON.stringify(keys)};
const out = ks.map(function (k) {
  const it = zcItem(k);
  if (!it) { return {key: k, found: false, title: "", authors: "", year: "", itemType: ""}; }
  return {
    key: k,
    found: true,
    title: String(it.getField("title") || ""),
    year: String(it.getField("date") || "").slice(0, 4),
    authors: (it.getCreators() || []).map(function (c) { return c.lastName || c.name || ""; }).join(", "),
    itemType: Zotero.ItemTypes.getName(it.itemTypeID)
  };
});
return JSON.stringify({items: out});
`;
  const r = await zoteroExec(settings, code);
  return (r && r.items) || [];
}

/** 快照里的精简 CSL：取标题/作者/年份（兼容 date-parts 与插件自己的 {year,month} 两种写法） */
function cslTitle(csl) {
  return String((csl && csl.title) || "");
}
function cslYear(csl) {
  const is = (csl && csl.issued) || {};
  if (is.year) { return String(is.year); }
  const dp = is["date-parts"];
  return (dp && dp[0] && dp[0][0]) ? String(dp[0][0]) : "";
}
function cslAuthors(csl) {
  const a = (csl && csl.author) || [];
  return a.map(x => x.family || x.literal || x.name || "").filter(Boolean).join(", ");
}

/**
 * 按 DOI / 标题在当前 Zotero 库里把旧 key 接回同名条目。
 *
 * 场景：换了 Zotero profile、或把文献从别处重新导入，条目内容没变但 item key 变了，
 * 文档里存的还是旧 key。此时只要能按 DOI 或标题唯一命中，就能把引用重新接上，
 * 而不是永久锁死在快照上。
 *
 * 只认「唯一命中」：DOI 归一化后相等，或标题归一化后全等；命中多条一律放弃，
 * 宁可让用户手动指定，也不能把 A 的引用接到 B 上。
 */
async function relinkEntries(settings, asks) {
  const code = `
const lib = Zotero.Libraries.userLibraryID;
const asks = ${JSON.stringify(asks)};
const norm = function (s) {
  return String(s || "").toLowerCase().replace(/[^0-9a-z\\u00c0-\\u024f\\u4e00-\\u9fff]+/g, "");
};
const reg = function (ids) {
  return ids.map(function (id) { return Zotero.Items.get(id); })
    .filter(function (x) { return x && x.isRegularItem && x.isRegularItem(); });
};
const out = [];
for (let i = 0; i < asks.length; i++) {
  const a = asks[i];
  let hit = null;
  let how = "";
  const doi = String(a.doi || "").trim().replace(/^https?:\\/\\/(dx\\.)?doi\\.org\\//i, "");
  if (doi) {
    const s = new Zotero.Search();
    s.libraryID = lib;
    s.addCondition("DOI", "is", doi);
    const cand = reg(await s.search());
    if (cand.length === 1) { hit = cand[0]; how = "doi"; }
    else if (cand.length > 1) {
      const t = norm(a.title);
      const same = cand.filter(function (x) { return norm(x.getField("title")) === t; });
      if (same.length === 1) { hit = same[0]; how = "doi+title"; }
    }
  }
  if (!hit && a.title) {
    const words = String(a.title).split(/\\s+/).filter(Boolean).slice(0, 8).join(" ");
    if (words) {
      const s = new Zotero.Search();
      s.libraryID = lib;
      s.addCondition("title", "contains", words);
      const t = norm(a.title);
      const cand = reg(await s.search()).filter(function (x) { return norm(x.getField("title")) === t; });
      if (cand.length === 1) { hit = cand[0]; how = "title"; }
    }
  }
  out.push({
    key: a.key,
    newKey: hit ? hit.key : null,
    title: hit ? String(hit.getField("title") || "") : "",
    year: hit ? String(hit.getField("date") || "").slice(0, 4) : "",
    how: how
  });
}
return JSON.stringify({items: out});
`;
  const r = await zoteroExec(settings, code);
  return (r && r.items) || [];
}

/**
 * 把多条叙述式零件拼成一句话。
 *
 * 既然用 and/和 收尾，就不用分号了（分号 + and 读起来别扭）：
 *   英文 → "S.-G. Lu et al. (2014), Bordoloi et al. (2019) and Kumar et al. (2020)"
 *   中文 → "王伟（2014）、李强（2019）和张敏（2020）"
 * 中英文按内容自动判断（含 CJK 即视为中文）。两条时不加分隔符，直接 A and B。
 */
function joinNarrParts(parts) {
  const list = (parts || []).filter(Boolean);
  if (!list.length) {
    return null;
  }
  if (list.length === 1) {
    return list[0];
  }
  const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(list.join(" "));
  const sep = cjk ? "、" : ", ";
  const conj = cjk ? "和" : " and ";
  return list.slice(0, -1).join(sep) + conj + list[list.length - 1];
}

/* ============================ 主类 ============================ */

module.exports = class ZoteroCite extends Plugin {

  async onload() {
    let saved = {};
    try {
      saved = (await this.loadData(CONF_FILE)) || {};
    } catch (e) {
      saved = {};
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, pickSettings(saved));
    // 旧版设置是整篇一个 mode，新版只有「按 CSL / 叙述式」两种形态
    if (!saved.defaultFormat && saved.mode) {
      this.settings.defaultFormat = (saved.mode === "narrative") ? "narr" : "csl";
    }
    /*
     * 文末标题：默认值从「参考文献」改成 auto（按 CSL 样式语言自动选）。
     * 老配置里存的正是旧默认值，一次性迁到 auto —— 中文样式仍然出「参考文献」，
     * 换英文样式时才会变成 References。用户自己改过的标题不动。
     */
    if (!saved.bibHeadingMigrated && "参考文献" === this.settings.bibHeading) {
      this.settings.bibHeading = "auto";
    }
    this.settings.bibHeadingMigrated = true;
    /*
     * 桥接地址：默认值从原版 Debug Bridge 端点换成 ZBridge 原生端点。
     * 老配置里存的正是旧默认值，一次性迁过来；用户自己填过的地址一律不动。
     */
    if (String(this.settings.bridgeUrl || "").trim() === LEGACY_BRIDGE_URL) {
      this.settings.bridgeUrl = DEFAULT_SETTINGS.bridgeUrl;
    }
    this.curProtyle = null;
    this.styleCache = null;
    this._menuEl = null;
    this._refreshLock = null;
    this._lastRendered = null;
    this._menuOpenedAt = 0;
    /* 撤销栈：docId → [{ts, label, blocks:[{id, kd}]}]，最多 20 步 */
    this._undoStack = {};
    this._inUndo = false;
    this._lastStyleId = null;
    this._styleBeforeChange = null;
    /* 活跃文档集合：docId → {key, name, at}，以及每文档一个防抖计时器 */
    this._docMap = {};
    this._docSyncTimers = {};
    this._docColLog = [];
    await this.loadDocMap();
    /* 1.3.0 多文档作用域配置 */
    this._scopes = {};
    this._scopeIndex = {};
    this._knownDocs = {};   // 本插件刚建、SQL 还没索引到的文档
    await this.loadScopes();

    /* 设置面板 */
    this.setting = new Setting({
      confirmCallback: () => this.saveFromSetting(),
    });
    this.setting.addItem({
      title: "Zotero 引用",
      description: "连接、样式与引用形态",
      createActionElement: () => {
        const div = document.createElement("div");
        div.className = "zc-setting b3-label";
        div.innerHTML = this.settingRender();
        this._settingEl = div;
        this.settingBind(div);
        return div;
      },
    });

    /* 顶栏按钮 */
    this.topBarEl = this.addTopBar({
      icon: ICON_SVG,
      title: "插入 Zotero 文献引用（用 Zotero 当前选中项）",
      position: "right",
      callback: () => this.insertFromSelection(),
    });

    /* 追踪当前编辑器 */
    const track = (e) => {
      if (e && e.detail && e.detail.protyle) {
        this.curProtyle = e.detail.protyle;
      }
    };
    this.eventBus.on("loaded-protyle-static", track);
    this.eventBus.on("switch-protyle", track);

    /*
     * 活跃文档集合：打开文档就对齐一次，关掉文档就解散。
     *
     * ⚠️ destroy-protyle 在「切标签」时不一定触发，而且它比文档真正从 DOM 上摘掉更早，
     *    所以延迟 700 ms 再确认一次「这篇是不是还开着」。openDocIds() 返回 null
     *    （问不出来）时**不删**，留给下次启动的 sweep 收拾 —— 宁可留空壳，不可误删。
     */
    /* 前端重载 / 退出程序时，protyle 会全部销毁，那不是「用户关了文档」 */
    this._pageUnloading = false;
    this._unloadHandler = () => { this._pageUnloading = true; };
    window.addEventListener("beforeunload", this._unloadHandler);

    this.eventBus.on("loaded-protyle-dynamic", (e) => {
      const p = protyleOfEvent(e);
      const docId = p && p.block && p.block.rootID;
      this.logDocCol("loaded", { docId: docId || null });
      if (docId) {
        this.scheduleDocCollection(String(docId), null, 1200);
      }
    });
    this.eventBus.on("destroy-protyle", (e) => {
      const p = protyleOfEvent(e);
      const docId = p && p.block && p.block.rootID;
      this.logDocCol("destroy", { docId: docId || null, hasProtyle: !!p, unloading: !!this._pageUnloading });
      if (!docId) {
        return;
      }
      /*
       * 前端重载 / 退出程序时，所有 protyle 都会被销毁 —— 那不是「用户关了文档」，
       * 重载后还会重新打开。这种时候不解散，否则每次刷新界面都会把集合删一遍。
       */
      if (this._pageUnloading) {
        return;
      }
      const id = String(docId);
      /*
       * 关文档 → 解散集合。
       *
       * ⚠️ 判定用「DOM 上还有没有这篇的活编辑器」：
       *    · 明确还开着（同一文档在两个标签里）→ 不动；
       *    · DOM 还没就绪（刚 reload 时会短暂查不到，浏览器里现在只会返回空数组）→ 重试；
       *    · 重试完仍查不到 → 按「已关闭」处理。
       *    早先的写法把「查不到」当成"不确定 → 不删"，而关闭文档时恰恰就是查不到，
       *    于是集合永远留着 —— 用户 2026-11-07 报的「关文档没解散」就是这个。
       */
      const attempt = (n) => {
        const open = this.openDocIds();
        const still = !!(open && open.indexOf(id) >= 0);
        this.logDocCol("destroy-check", { docId: id, open: open, stillOpen: still, attempt: n });
        if (still) {
          return;
        }
        if (!open && n < 3) {
          setTimeout(() => attempt(n + 1), 800);
          return;
        }
        this.dropDocCollection(id).then((r) => {
          this.logDocCol("destroy-drop", { docId: id, r: r });
        }).catch((err) => {
          this.logDocCol("destroy-drop-error", { docId: id, err: String((err && err.message) || err) });
          console.log("[zotero-cite] 解散活跃文档集合失败：", err && err.message ? err.message : err);
        });
      };
      setTimeout(() => attempt(0), 1200);
    });
    /*
     * 启动后清一次残渣：上次退出时没来得及解散的集合。
     * 15 s 是给编辑器铺开留的余量 —— sweep 里还有一道「一个编辑器都没有就不扫」的门闩，
     * 两道加起来才能保证既清得掉残渣、又不会把刚启动时的空白页当成"文档全关了"。
     */
    setTimeout(() => {
      this.sweepDocCollections().catch(() => {});
    }, 15000);

    /* 块内右键菜单 → 插入 Zotero 文献引用（与顶栏按钮、/zotero 等价） */
    this.bindContentMenu();
    /* 1.3.0：左侧文档树右键 → 设顶级文档 / 设输出文档（用户真正会去右键的地方） */
    this.bindDocTreeMenu();

    /* 拦截 zotero:// 链接点击，交给系统唤起 Zotero
       ⚠️ 思源的行内链接是 <span data-type="a" data-href="...">，没有 href 属性，
          所以不能用 a[href^="zotero://"] 选择器，否则永远选不中。 */
    this._linkHandler = (ev) => {
      /*
       * ⚠️ 只拦**本插件自己生成的引用链接**（zotero://select/library/items/…）。
       *    以前写的是 `[data-href^="zotero://"]`，把所有 zotero:// 链接一网打尽 ——
       *    结果 Zotero 的批注回跳链接 `zotero://open-pdf/library/items/KEY?page=1&annotation=XXX`
       *    也被吞掉：preventDefault + stopPropagation 之后只调了 openInZotero（仅选中条目），
       *    PDF 页码与批注定位全丢了。别的 zotero 集成插件也被 stopPropagation 挡死。
       */
      const SEL = '[data-href^="zotero://select/library/items/"], a[href^="zotero://select/library/items/"]';
      const el = ev.target && ev.target.closest ? ev.target.closest(SEL) : null;
      if (!el) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      this.openInZotero(el.getAttribute("data-href") || el.getAttribute("href"));
    };
    document.addEventListener("click", this._linkHandler, true);

    /* 右键引用 → 改形态 / 编辑文献 / 切换样式 / 删除
       监听挂在 window 捕获阶段：思源自己的 protyle 菜单在同层可能 stopPropagation，
       挂在 document 上会被拦掉，表现为「右键没反应」。 */
    this._ctxHandler = (ev) => {
      const el = ev.target && ev.target.closest
        ? ev.target.closest('[data-href*="zotero://select"], a[href*="zotero://select"]')
        : null;
      if (!el) {
        return;
      }
      // 文末参考文献条目（?bib=1）不是正文引用，不提供改形态/删除
      const href0 = el.getAttribute("data-href") || el.getAttribute("href") || "";
      if (/[?&]bib=1\b/.test(href0)) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      this.showCiteMenu(el, ev.clientX, ev.clientY);
    };
    window.addEventListener("contextmenu", this._ctxHandler, true);

    /* 点别处 / 滚动 / 按 Esc 关掉引用菜单 */
    this._closeMenuHandler = (ev) => {
      if (!this._menuEl) {
        return;
      }
      if (this._menuEl.contains(ev.target)) {
        return;
      }
      // ⚠️ 两条豁免，否则菜单会「闪一下就没了」：
      //   1) 右键自身的 mousedown 不关菜单 —— 部分设备（触控板长按、两指点按）
      //      会先派发 contextmenu 再派发 mousedown，刚弹出的菜单会被立刻收掉；
      //   2) 弹出后 300ms 内的 mousedown/scroll 一律忽略 —— 右键会改变选区，
      //      思源可能顺手把编辑器滚动到光标，这条 scroll 同样会误伤。
      if (ev.type === "mousedown" && ev.button === 2) {
        return;
      }
      if (Date.now() - (this._menuOpenedAt || 0) < 300) {
        return;
      }
      this.closeCiteMenu();
    };
    document.addEventListener("mousedown", this._closeMenuHandler, true);
    document.addEventListener("scroll", this._closeMenuHandler, true);
    this._escHandler = (ev) => {
      if (ev.key === "Escape") {
        this.closeCiteMenu();
      }
    };
    document.addEventListener("keydown", this._escHandler, true);

    /* 斜杠菜单：编辑器里敲 /zotero 直接调出插入面板
       ⚠️ 思源没有 addProtyleSlash 方法，斜杠菜单是直接给 this.protyleSlash 赋值（数组），
          protyle 输入 "/" 时遍历各插件的这个数组去匹配 filter。
       ⚠️ 思源在调用 callback 前已把输入的 "/zotero" 删掉，这里不能再清理文本。
       ⚠️ callback 收到的对象不一定带 block.rootID（实测可能是个空壳），
          直接赋值会把原本有效的 this.curProtyle 覆盖掉，导致 getDocId() 立刻返回 null、
          弹出「请先在文档里点一下光标位置」。所以只在能取到 rootID 时才覆盖。 */
    this.protyleSlash = [{
      filter: ["/zotero"],
      id: "zotero-cite-insert",
      html: this.slashItemHtml(),
      callback: (protyle) => {
        const rid = protyle && protyle.block && protyle.block.rootID;
        if (rid) {
          this.curProtyle = protyle;
          try {
            const inst = (typeof protyle.getInstance === "function" && protyle.getInstance()) || protyle;
            if (inst && typeof inst.insert === "function") {
              this._realProtyle = inst;
            }
          } catch (e) { /* 忽略，交给 getProtyle 兜底 */ }
        }
        this.insertFromSelection();
      },
    }];

    /* 命令面板 */
    this.addCommand({
      langKey: "insertCite",
      hotkey: "",
      callback: () => this.insertFromSelection(),
    });
    this.addCommand({
      langKey: "refreshCites",
      hotkey: "",
      /*
       * ⚠️ 必须自己接住异常。命令面板的 callback 没有任何人 await，
       *    缺样式 / Zotero 没开时 refreshDocument 会抛（这正是「拒绝重排」的设计），
       *    不接就是一条 unhandled rejection —— 用户点完什么提示都没有，
       *    只会觉得「点了没反应」。这是 1.2.32 之前命令面板入口的静默失败。
       */
      callback: () => this.refreshDocument(true)
        .catch((e) => showMessage(String((e && e.message) || e), 9000)),
    });
    this.addCommand({
      langKey: "cycleCiteFormat",
      hotkey: "",
      callback: () => this.cycleCiteFormat(),
    });
    /* 1.3.0 多文档：命令面板兜底入口。右键菜单万一被别的插件挡住，这里一定能用。
       ⚠️ 用 langText 直接给中文，不往 i18n 里加键（省得中英两处漏一个）。 */
    this.addCommand({
      langKey: "setScopeRoot",
      langText: "多文档：把当前文档设为引文顶级文档",
      hotkey: "",
      callback: () => {
        const id = this.getDocId();
        if (!id) { showMessage("请先在文档里点一下光标位置，再执行这个命令", 5000); return; }
        this.setScopeRoot(id);
      },
    });
    this.addCommand({
      langKey: "unsetScopeRoot",
      langText: "多文档：取消当前文档的引文顶级设置",
      hotkey: "",
      callback: () => {
        const id = this.getDocId();
        if (!id) { showMessage("请先在文档里点一下光标位置，再执行这个命令", 5000); return; }
        this.unsetScopeRoot(id);
      },
    });
    this.addCommand({
      langKey: "setBibDoc",
      langText: "多文档：把当前文档设为文献表输出文档",
      hotkey: "",
      callback: () => {
        const id = this.getDocId();
        if (!id) { showMessage("请先在文档里点一下光标位置，再执行这个命令", 5000); return; }
        this.setBibDoc(id);
      },
    });
    this.addCommand({
      langKey: "undoCite",
      hotkey: "⌥⌘Z",
      callback: () => this.undoLast(),
    });

    console.log("[zotero-cite] loaded");
  }

  /* 斜杠菜单条目的显示内容：跟随思源当前界面语言 */
  slashItemHtml() {
    let zh = true;
    try {
      const lang = window.siyuan && window.siyuan.config && window.siyuan.config.appearance
        ? window.siyuan.config.appearance.lang
        : "";
      zh = String(lang || "").toLowerCase().indexOf("en") !== 0;
    } catch (e) {
      zh = true;
    }
    const text = zh ? "插入 Zotero 文献引用" : "Insert Zotero citation";
    /* 纯常量，无用户输入，不需要转义 */
    return '<div class="b3-list-item__first">'
      + '<span class="b3-list-item__text">' + text + "</span>"
      + '<span class="b3-list-item__meta">Zotero</span>'
      + "</div>";
  }

  onunload() {
    if (this._linkHandler) {
      document.removeEventListener("click", this._linkHandler, true);
    }
    if (this._ctxHandler) {
      window.removeEventListener("contextmenu", this._ctxHandler, true);
    }
    if (this._closeMenuHandler) {
      document.removeEventListener("mousedown", this._closeMenuHandler, true);
      document.removeEventListener("scroll", this._closeMenuHandler, true);
    }
    if (this._escHandler) {
      document.removeEventListener("keydown", this._escHandler, true);
    }
    this.closeCiteMenu();
    if (this._unloadHandler) {
      window.removeEventListener("beforeunload", this._unloadHandler);
    }
    if (this._docSyncTimers) {
      Object.keys(this._docSyncTimers).forEach((id) => clearTimeout(this._docSyncTimers[id]));
      this._docSyncTimers = {};
    }
    console.log("[zotero-cite] unloaded");
  }

  /* ---------------- 设置 ---------------- */

  async updateSettings(patch) {
    const prevStyle = this.settings.styleId;
    const prevDocCol = this.settings.docCollection;
    this.settings = Object.assign({}, this.settings, pickSettings(patch));
    // 记下「改之前」的样式：撤销要回到这个，而不是回到刚改完的样式。
    // 放在这个统一入口，设置页 / 右键样式选择器 / 命令 都覆盖得到。
    if (patch && patch.styleId && patch.styleId !== prevStyle) {
      this._styleBeforeChange = prevStyle;
    }
    try {
      // 注意：SiYuan 的 saveData 是 (文件名, 数据) 两参数，不是单参数
      await this.saveData(CONF_FILE, this.settings);
    } catch (e) {
      console.warn("[zotero-cite] saveData failed:", e && e.message ? e.message : e);
    }
    /*
     * 关掉「活跃文档集合」这个开关时，顺手把本机建过的集合收掉 ——
     * 用户关开关的意图就是不想让 Zotero 里再多出东西，留一堆空壳反而更烦。
     * 只删本地映射里有的，别人的集合一个不碰。
     */
    if (prevDocCol && !this.settings.docCollection) {
      this.dropAllDocCollections().catch(() => {});
    }
  }

  /* ---------------- 跳转 Zotero ---------------- */

  /**
   * 点击引用 → 在 Zotero 里选中对应条目。
   *
   * ⚠️ 为什么不再直接 shell.openExternal("zotero://select/library/items/A,B")：
   *    Zotero 10 的 ZoteroProtocolHandler 只对「query 参数 itemKey」做逗号拆分
   *    （见 xpcom/api.js → Zotero.API.parseParams），路径里的 :objectKey 会整串
   *    被当成一个 key 去查。查不到还要再走一遍 Windows 协议分发，实测直接把
   *    Zotero 拖到无响应（用户需强杀）。
   *    所以：多条目一律走 ZBridge 在 Zotero 内部 selectItems()，
   *    bridge 不通时退回「只打开第一个 key」的单条协议（单条已验证安全）。
   */
  /** 用系统浏览器打开外部链接（设置面板里没有可用的 <a target=_blank> 环境） */
  openExternalUrl(url) {
    try {
      const remote = require("@electron/remote");
      remote.shell.openExternal(url);
      return true;
    } catch (e) {
      try {
        window.open(url, "_blank");
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  async openInZotero(href) {
    /*
     * 防线二：只处理引用链接。批注回跳（zotero://open-pdf/…?annotation=…）这类绝不能
     * 走到这里 —— 这里只会「选中条目」，会把页码和批注定位弄丢，必须交给系统默认处理。
     */
    if (!/^zotero:\/\/select\/library\/items\//.test(String(href || ""))) {
      return;
    }
    const now = Date.now();
    if (now - (this._lastOpen || 0) < 600) {
      return; // 防连点：600ms 内只处理一次，避免重复唤起
    }
    this._lastOpen = now;

    const keys = parseCiteKeys(href);
    if (!keys.length) {
      return;
    }

    // 1) 首选：在 Zotero 内部选中（完全绕开 Windows 的 zotero:// 协议分发）
    if (this.settings.token) {
      try {
        const code = [
          "const lib = Zotero.Libraries.userLibraryID;",
          "const ks = " + JSON.stringify(keys) + ";",
          "const ids = ks.map(function (k) { var it = Zotero.Items.getByLibraryAndKey(lib, k); return it ? it.id : null; }).filter(Boolean);",
          "if (!ids.length) { return JSON.stringify({ok: false, n: 0}); }",
          "const win = Zotero.getMainWindow();",
          "if (win) { try { win.focus(); } catch (e) {} }",
          "try { win.Zotero_Tabs.select('zotero-pane'); } catch (e) {}",
          "await win.ZoteroPane.selectItems(ids);",
          "return JSON.stringify({ok: true, n: ids.length});",
        ].join("\n");
        const r = await zoteroExec(this.settings, code);
        if (r && r.ok) {
          return;
        }
      } catch (e) {
        console.warn("[zotero-cite] select via bridge failed:", e && e.message);
      }
    }

    // 2) 回退：单条 key 的协议链接（永远不带逗号）
    const url = "zotero://select/library/items/" + keys[0];
    try {
      const remote = require("@electron/remote");
      remote.shell.openExternal(url);
    } catch (e) {
      try {
        const a = document.createElement("a");
        a.href = url;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (e2) {
        showMessage("无法唤起 Zotero：" + (e && e.message ? e.message : e));
      }
    }
  }

  /* ---------------- 当前文档 ---------------- */

  /**
   * 拿到真正的 Protyle 实例。
   * ⚠️ eventBus 事件 detail.protyle 给的是「门面对象」（普通 Object，只有几个转发方法），
   *    它上面没有 insert；必须再调 getInstance() 才拿到原型带 insert 的真实例。
   */
  getProtyle() {
    const cp = this.curProtyle;
    if (cp) {
      try {
        if (typeof cp.getInstance === "function") {
          const inst = cp.getInstance();
          if (inst && typeof inst.insert === "function") {
            if (inst.block && inst.block.rootID) {
              this._realProtyle = inst;
            }
            return inst;
          }
        }
      } catch (e) { /* 继续兜底 */ }
      if (typeof cp.insert === "function") {
        this._realProtyle = cp;
        return cp;
      }
    }
    /* 兜底：只要还能插入就交出去，不再强求 block.rootID ——
       实测斜杠菜单回传的实例可能有 insert 却拿不到 block。 */
    if (this._realProtyle && typeof this._realProtyle.insert === "function") {
      return this._realProtyle;
    }
    return null;
  }

  getDocId() {
    const p = this.getProtyle();
    if (p && p.block && p.block.rootID) {
      return p.block.rootID;
    }
    if (this.curProtyle && this.curProtyle.block && this.curProtyle.block.rootID) {
      return this.curProtyle.block.rootID;
    }
    /* ⚠️ 思源的 .protyle-wysiwyg 上并没有 data-node-id（取到的是 null），
       文档 id 实际挂在 .protyle-title 上，这里必须走 title，否则活动编辑器取不到 id。
       ⚠️ 再套一层 typeof document 判断：非浏览器环境（脚本化调用、单测）里没有 document，
          不加这层会直接抛 ReferenceError，把整条调用链打断。 */
    if (typeof document === "undefined" || !document.querySelector) {
      return null;
    }
    const act = document.querySelector(".protyle:not(.fn__none)") || document.querySelector(".protyle");
    if (act) {
      const t = act.querySelector(".protyle-title[data-node-id]");
      if (t) {
        return t.getAttribute("data-node-id");
      }
      const w = act.querySelector(".protyle-wysiwyg[data-node-id]");
      if (w) {
        return w.getAttribute("data-node-id");
      }
      const bg = act.querySelector(".protyle-background[data-node-id]");
      if (bg) {
        return bg.getAttribute("data-node-id");
      }
    }
    return null;
  }

  /* ---------------- 活跃文档集合（Zotero 侧的临时集合） ---------------- */

  /**
   * 文档标题。
   *
   * ⚠️ 不能只查 SQL 的 `blocks.content`：刚 createDocWithMd 建出来的文档，
   *    SQL 索引要一会儿才有（踩坑记录：新建文档 0.8 s 仍查不到），
   *    那段时间里「标题取不到 → 不同步」，用户新建文档插第一条引用就没集合。
   *    所以先走 getHPathByID（`/笔记本/父文档/当前文档`，最后一段就是标题），
   *    它读的是文件树、没有索引延迟；失败再退回 SQL。
   */
  async docTitleOf(docId) {
    if (!docId) {
      return "";
    }
    try {
      const r = await apiQuiet("/api/filetree/getHPathByID", { id: docId });
      const hp = (r && r.code === 0 && r.data) || "";
      const seg = String(hp).split("/").filter(Boolean).pop() || "";
      if (seg) {
        return seg.replace(/\.sy$/, "").trim();
      }
    } catch (e) { /* 退回 SQL */ }
    try {
      const rows = await this.querySql(`SELECT content FROM blocks WHERE id='${String(docId).replace(/'/g, "")}'`);
      return String((rows[0] && rows[0].content) || "").trim();
    } catch (e) {
      return "";
    }
  }

  /**
   * 当前**打开着**的文档 id 列表。
   * 返回 null = 问不出来（调用方必须当成「不确定」，不要据此删东西）。
   *
   * ⚠️ 主用 DOM：每个打开过的标签都有 `.protyle-title[data-node-id]`，
   *    隐藏标签的 DOM 也还在。layout 遍历作补充（有的标签还没铺开 protyle）。
   *    两者都拿不到 → null。
   */
  openDocIds() {
    /*
     * 返回 null 只表示「这个环境根本查不了」（脚本化调用、单测里没有 document）。
     * 浏览器里一律返回数组，**没有任何文档开着就是空数组**。
     */
    if (typeof document === "undefined" || !document.querySelectorAll) {
      return null;
    }
    const ids = new Set();
    const nodes = document.querySelectorAll(".protyle-title[data-node-id]");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      /*
       * ⚠️ 只认「还活着的编辑器」。
       *    思源销毁 protyle 时先 `element.classList.remove("protyle")`，
       *    之后才把节点摘出 DOM；这中间（甚至更久，若 element 被暂存）
       *    `.protyle-title[data-node-id]` 依然能查到 —— 拿它当「还开着」，
       *    关闭文档时就永远不会解散集合（用户实测踩到）。
       *    判据：祖先必须是带 protyle 类、且仍连在文档上的节点。
       */
      const pn = el.closest ? el.closest(".protyle") : null;
      if (!pn || !pn.classList.contains("protyle")) {
        continue;
      }
      if (typeof pn.isConnected === "boolean" && !pn.isConnected) {
        continue;
      }
      const id = el.getAttribute("data-node-id");
      if (id) {
        ids.add(String(id));
      }
    }
    return Array.from(ids);
  }

  async loadDocMap() {
    try {
      const m = await this.loadData(DOCMAP_FILE);
      this._docMap = (m && typeof m === "object") ? m : {};
    } catch (e) {
      this._docMap = {};
    }
  }

  async saveDocMap() {
    try {
      await this.saveData(DOCMAP_FILE, this._docMap || {});
    } catch (e) {
      console.warn("[zotero-cite] saveData(docmap) failed:", e && e.message ? e.message : e);
    }
  }

  /* ---------------- 1.3.0 多文档作用域 ---------------- */

  async loadScopes() {
    try {
      const m = await this.loadData(SCOPE_FILE);
      this._scopes = normalizeScopes(m);
    } catch (e) {
      this._scopes = {};
    }
    this._scopeIndex = {};
  }

  async saveScopes() {
    try {
      await this.saveData(SCOPE_FILE, this._scopes || {});
    } catch (e) {
      console.warn("[zotero-cite] saveData(scopes) failed:", e && e.message ? e.message : e);
    }
  }

  /** 非 async 调用点用：从上次 resolveScope 建好的内存索引里找顶级文档 */
  scopeRootIdSync(docId) {
    const d = String(docId || "");
    return (this._scopeIndex && this._scopeIndex[d]) || d;
  }

  /** 一次 SQL 拿全库文档元数据。显式 LIMIT 绕开默认 64 行（04c #3） */
  async allDocRows() {
    let rows = [];
    try {
      const r = await fetchSyncPost("/api/query/sql", {
        stmt: "SELECT id, path, hpath, content, box FROM blocks WHERE type='d' LIMIT 1000",
      });
      rows = (r && r.data) || [];
    } catch (e) {
      rows = [];
    }
    /*
     * 刚由本插件新建的 Reference 文档 SQL 查不到（04c #7 索引延迟）。
     * 不并进来的话，下一次 resolveScope 会认为「输出文档不存在」而再建一个同名文档：
     * 2026-11-08 真机实测一轮重排建出两篇 Reference，文献表写进前一篇、
     * 后一篇空白，表现就是「文献表没生成」。
     */
    const seen = new Set(rows.map((x) => x && x.id));
    const known = this._knownDocs || {};
    Object.keys(known).forEach((id) => { if (!seen.has(id)) { rows.push(known[id]); } });
    return rows;
  }

  /**
   * 按思源真实文档树顺序（深度优先、父在子前）收集 root 及所有层级后代。
   * 主通道 listDocsByPath（实时、甩掉 SQL 索引滞后 04c #7）；不可用退回 SQL path 前缀。
   */
  async collectScopeDocIds(rootRow, rowMap) {
    const out = [rootRow.id];
    const seen = new Set(out);
    const box = rootRow.box;
    const pfx = scopePathPrefix(rootRow.path);
    let apiOk = false;
    const walk = async (parentPath) => {
      if (!parentPath || seen.size > 500) { return; }
      const r = await apiQuiet("/api/filetree/listDocsByPath", { notebook: box, path: parentPath });
      const files = (r && r.data && r.data.files) || [];
      if (r && r.code === 0) { apiOk = true; }
      for (const f of files) {
        if (!f || !f.id || seen.has(f.id)) { continue; }
        if (/\(Conflicted/i.test(String(f.name || ""))) { continue; } // 04c #12
        seen.add(f.id);
        out.push(f.id);
        if (Number(f.subFileCount) > 0 && f.path) { await walk(f.path); }
      }
    };
    try { await walk(rootRow.path); } catch (e) { /* 落到 SQL 兜底 */ }
    const extraIds = Object.keys(rowMap)
      .filter((id) => !seen.has(id) && String((rowMap[id] || {}).path || "").indexOf(pfx) === 0)
      .filter((id) => !/\(Conflicted/i.test(String((rowMap[id] || {}).content || "")));
    if (!apiOk) {
      extraIds.sort((a, b) => String(rowMap[a].path) < String(rowMap[b].path) ? -1 : 1);
    }
    extraIds.forEach((id) => { seen.add(id); out.push(id); });
    return out;
  }

  /**
   * 未指定输出文档：复用顶级文档下已存在的直接子文档 Reference，否则新建。
   * ⚠️ createDocWithMd 的 path 必须是人类可读 hpath，传 ID 路径会造垃圾目录（04c #4）。
   */
  async ensureReferenceDoc(rootId, rowMap) {
    const root = rowMap[rootId] || {};
    const pfx = scopePathPrefix(root.path);
    const hit = Object.keys(rowMap).find((id) => {
      const r = rowMap[id];
      return r && String(r.content || "").trim() === REF_DOC_TITLE &&
        String(r.path || "").indexOf(pfx) === 0 &&
        String(r.path || "").slice(pfx.length).indexOf("/") < 0;
    });
    if (hit) { return hit; }
    let hpath = "";
    try {
      const r = await apiQuiet("/api/filetree/getHPathByID", { id: rootId });
      hpath = String((r && r.data) || "");
    } catch (e) { /* 读不到就不冒险建文档 */ }
    if (!hpath || !root.box) { return ""; }
    const r = await apiQuiet("/api/filetree/createDocWithMd", {
      notebook: root.box,
      path: hpath.replace(/\/$/, "") + "/" + REF_DOC_TITLE,
      markdown: "",
    });
    const made = r && r.data ? String(r.data) : "";
    if (made) {
      /*
       * ⚠️ 新建文档的内核元数据有短暂延迟（04c #7，zc_lib.new_doc 也踩过）：
       *    不等就紧接着 appendBlock，会报 "document metadata is not ready"，
       *    文献表第一次写不进去，要等下一次重排才补上（2026-11-08 真机实测）。
       *    getChildBlocks 读内存块树，返回数组即代表文档可写。
       */
      for (let i = 0; i < 20; i++) {
        const q = await apiQuiet("/api/block/getChildBlocks", { id: made });
        if (q && q.code === 0 && Array.isArray(q.data)) { break; }
        await new Promise((res) => setTimeout(res, 200));
      }
      // 新建文档 SQL 有索引延迟，登记进本次 rowMap 与实例级缓存，供后续 resolveScope 复用
      rowMap[made] = { id: made, path: pfx + made + ".sy", hpath: "", content: REF_DOC_TITLE, box: root.box };
      this._knownDocs = this._knownDocs || {};
      this._knownDocs[made] = rowMap[made];
    }
    return made;
  }

  /**
   * 1.3.0：让自动生成的 Reference 文档始终排在该书同级子文档的最后。
   *
   * 思源新建文档默认接在同级末尾，会把 Reference 挤到中间（用户 2026-11-08 23:47 实测：
   * 新建「未命名文档」后 Reference 从 sort 4 变成倒数第二）。
   * /api/filetree/reorderDocs 是前端拖放排序用的同一个内核 API，实测可用载荷：
   *   { sourceIDs: [refId], targetID: <同级最后一个其它文档>, position: "after" }
   * ⚠️ position 只认字符串 "before" / "after"，不是布尔 after；
   * ⚠️ 已经在最后就直接返回，不重复调用（幂等，避免每轮重排都触发云同步与 ws 广播）。
   */
  async ensureReferenceLast(rootRow, refId) {
    if (!rootRow || !rootRow.box || !rootRow.path || !refId || rootRow.id === refId) {
      return false;
    }
    try {
      const r = await apiQuiet("/api/filetree/listDocsByPath", {
        notebook: rootRow.box,
        path: rootRow.path,
      });
      const files = (r && r.data && r.data.files) || [];
      if (files.length && files[files.length - 1].id === refId) { return false; }
      const others = files.filter((f) => f && f.id && f.id !== refId &&
        !/\(Conflicted/i.test(String(f.name || "")));
      if (!others.length) { return false; }
      const q = await apiQuiet("/api/filetree/reorderDocs", {
        sourceIDs: [refId],
        targetID: others[others.length - 1].id,
        position: "after",
      });
      return !!(q && q.code === 0);
    } catch (e) {
      return false;
    }
  }

  /** 当前文档 → 作用域。空配置时零 API 调用，保证单文档路径与 1.2.37 等价。 */
  async resolveScope(docId) {
    const d = String(docId || "");
    const single = () => ({ mode: "single", rootId: d, docIds: [d], bibDocId: d });
    if (!d || !this._scopes || !Object.keys(this._scopes).length) { return single(); }
    const rows = await this.allDocRows();
    const rowMap = {};
    rows.forEach((r) => { if (r && r.id) { rowMap[r.id] = r; } });
    const hit = scopeFromRows(rows, d, this._scopes);
    if (hit.mode !== "multi" || !rowMap[hit.rootId]) { return single(); }
    let docIds = await this.collectScopeDocIds(rowMap[hit.rootId], rowMap);
    let bibDocId = hit.bibDocId;
    if (!bibDocId || !rowMap[bibDocId]) {
      bibDocId = await this.ensureReferenceDoc(hit.rootId, rowMap);
      if (bibDocId) {
        this._scopes[hit.rootId] = Object.assign({}, this._scopes[hit.rootId], { bibDocId });
        await this.saveScopes();
      }
    }
    if (!bibDocId) { bibDocId = hit.rootId; } // 建不出来就退回顶级文档，绝不把文献表写丢
    if (docIds.indexOf(bibDocId) < 0) { docIds = docIds.concat([bibDocId]); }
    this._scopeIndex = this._scopeIndex || {};
    docIds.forEach((id) => { this._scopeIndex[id] = hit.rootId; });

    /* 自动生成的 Reference 保持同级最后（用户另行指定的输出文档不动） */
    const refRow = rowMap[bibDocId] || (this._knownDocs && this._knownDocs[bibDocId]) || {};
    if (String(refRow.content || "").trim() === REF_DOC_TITLE) {
      await this.ensureReferenceLast(rowMap[hit.rootId], bibDocId);
    }
    return { mode: "multi", rootId: hit.rootId, docIds: docIds, bibDocId: bibDocId };
  }

  async setScopeRoot(docId) {
    this._scopes = this._scopes || {};
    this._scopes[String(docId)] = { bibDocId: "" };
    await this.saveScopes();
    showMessage("已设为引文顶级文档：这篇及其所有嵌套子文档的引文将统一管理", 5000);
  }

  async unsetScopeRoot(docId) {
    this._scopes = this._scopes || {};
    delete this._scopes[String(docId)];
    await this.saveScopes();
    showMessage("已取消引文顶级文档，恢复单文档模式", 4000);
  }

  /** 指定输出文档。直接走纯判定，不调 resolveScope —— 免得先建出一个 Reference 文档。 */
  async setBibDoc(docId) {
    const rows = await this.allDocRows();
    const hit = scopeFromRows(rows, String(docId), this._scopes || {});
    if (hit.mode !== "multi") {
      showMessage("请先在顶级文档上右键「设为引文顶级文档」，再指定输出文档", 6000);
      return;
    }
    this._scopes[hit.rootId] = Object.assign({}, this._scopes[hit.rootId], { bibDocId: String(docId) });
    await this.saveScopes();
    showMessage("已设为文献列表输出文档；执行一次「重排全文」生效", 5000);
  }

  /** 设置面板里的只读状态说明（右键操作，不占 data-k，不进 settings） */
  scopeSettingStat() {
    const roots = Object.keys(this._scopes || {});
    if (!roots.length) {
      return "当前没有设置引文顶级文档 —— 全部按单文档模式运行，与旧版完全一致。" +
        "在任意文档里右键 →「设为引文顶级文档」后，该文档及所有嵌套子文档的引文统一管理、" +
        "编号全树连续；文献表只输出到一个文档，未指定则自动建 Reference 子文档。";
    }
    const assigned = roots.filter((r) => this._scopes[r] && this._scopes[r].bibDocId).length;
    return "已设 " + roots.length + " 个引文顶级文档；其中 " + assigned +
      " 个已指定文献表输出文档，其余自动输出到 Reference 子文档。";
  }


  /**
   * 1.3.0 设置面板：一本书一个 <details> 折叠块，块内只放这一本书的参数。
   * 参数刻意保持简单（只有「文献表输出到哪」一项可改），层级/子文档数只读展示 ——
   * 不同书籍的章节层次本来就不一样，由文档树自动算，不需要用户配。
   */
  async fillScopeGroups(root) {
    const box = root && root.querySelector("[data-scope-groups]");
    if (!box) { return; }
    const ids = Object.keys(this._scopes || {});
    if (!ids.length) {
      box.innerHTML = '<div class="zc-scope-empty">尚未设置引文顶级文档 —— 全部按单文档模式运行，与旧版一致。</div>';
      return;
    }
    let docRows = [];
    try { docRows = await this.allDocRows(); } catch (e) { docRows = []; }
    const map = {};
    docRows.forEach((r) => { if (r && r.id) { map[r.id] = r; } });
    const esc = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    box.innerHTML = ids.map((rid, i) => {
      const cfg = this._scopes[rid] || {};
      const selfRow = map[rid] || {};
      const title = esc(String(selfRow.content || rid));
      const pfx = scopePathPrefix(selfRow.path || "");
      const baseSeg = String(selfRow.path || "").split("/").length;
      let kids = 0;
      let depth = 1;
      Object.keys(map).forEach((id) => {
        const p = String((map[id] || {}).path || "");
        if (p.indexOf(pfx) !== 0 || /\(Conflicted/i.test(String((map[id] || {}).content || ""))) { return; }
        kids++;
        depth = Math.max(depth, p.split("/").length - baseSeg + 1);
      });
      const outTitle = cfg.bibDocId
        ? esc(String((map[cfg.bibDocId] || {}).content || cfg.bibDocId)) : "";
      return `<details class="zc-scope-group" data-root="${esc(rid)}" ${i === 0 ? "open" : ""}>
        <summary><span class="zc-scope-name">${title}</span>
          <span class="zc-scope-meta">${kids} 篇子文档 · 最深 ${depth} 层</span></summary>
        <div class="zc-scope-body">
          <div class="zc-scope-row"><span>文献表输出</span><b>${outTitle || "自动 → Reference 子文档"}</b></div>
          <div class="zc-scope-row"><span>顶级文档 ID</span><code>${esc(rid)}</code></div>
          <div class="zc-scope-acts">
            ${cfg.bibDocId ? '<button class="b3-button b3-button--outline zc-scope-clearout">恢复自动 Reference</button>' : ''}
            <button class="b3-button b3-button--outline zc-scope-drop">取消这本的顶级设置</button>
          </div>
        </div>
      </details>`;
    }).join("");
    box.querySelectorAll(".zc-scope-group").forEach((el) => {
      const rid = el.getAttribute("data-root");
      const clear = el.querySelector(".zc-scope-clearout");
      if (clear) {
        clear.addEventListener("click", async () => {
          this._scopes[rid] = Object.assign({}, this._scopes[rid], { bibDocId: "" });
          await this.saveScopes();
          await this.fillScopeGroups(root);
          showMessage("已恢复自动 Reference；执行一次「重排全文」生效", 4000);
        });
      }
      const drop = el.querySelector(".zc-scope-drop");
      if (drop) {
        drop.addEventListener("click", async () => {
          await this.unsetScopeRoot(rid);
          await this.fillScopeGroups(root);
        });
      }
    });
  }
  /**
   * 原重排步骤 2 的多文档版：对每个文档分别取块，排除各文档自己的文末文献表块。
   * SQL 有索引延迟，getChildBlocks 读内存块树补一遍（交接坑 9）。
   */
  async collectBlocksForDocs(docIds, heading) {
    const blocks = [];
    for (const docId of docIds) {
      const bibIds = new Set();
      try {
        const loc = await this.locateBib(docId, heading);
        loc.entries.forEach((c) => bibIds.add(c.id));
        if (loc.headingIndex >= 0 && loc.children[loc.headingIndex]) {
          bibIds.add(loc.children[loc.headingIndex].id);
        }
      } catch (e) { /* 取不到就按没有文末处理 */ }
      const rowsSql = await this.querySql(
        `SELECT id FROM blocks WHERE root_id='${docId}' AND type IN ('p','h','l','i','b','s','t') ORDER BY sort`
      );
      const seenIds = new Set((rowsSql || []).map((r) => r.id));
      let rows = rowsSql || [];
      try {
        const kids = ((await apiQuiet("/api/block/getChildBlocks", { id: docId })) || {}).data || [];
        const extra = kids
          .filter((k) => k && k.id && !seenIds.has(k.id) && /^(p|h|l|i|b|s|t)$/.test(k.type || ""))
          .map((k) => ({ id: k.id }));
        if (extra.length) { rows = rows.concat(extra); }
      } catch (e) { /* 补不到就按 SQL 结果走 */ }
      const batch = 20;
      for (let i = 0; i < rows.length; i += batch) {
        const slice = rows.slice(i, i + batch).filter((row) => !bibIds.has(row.id));
        const got = await Promise.all(slice.map((row) =>
          fetchSyncPost("/api/block/getBlockKramdown", { id: row.id }).catch(() => null)
        ));
        got.forEach((r, j) => {
          const row = slice[j];
          if (!row || !r) { return; }
          const kdRaw = r.data && r.data.kramdown;
          const kd = kdRaw ? collapseCiteMarkup(unwrapCiteSups(kdRaw)) : kdRaw;
          if (!kd || !/zotero:\/\/select\/library\/items\//.test(kd)) { return; }
          blocks.push({ id: row.id, kdRaw: kdRaw, kd: kd });
        });
      }
    }
    return blocks;
  }

  /** 清掉非输出文档的旧文献表：只删带标记的新版条目 + 插件标准标题，绝不碰用户正文 */
  async clearBibliography(docId) {
    const heading = resolveBibHeading(this.settings, null);
    let loc;
    try { loc = await this.locateBib(docId, heading); } catch (e) { return 0; }
    const ids = [];
    if (loc.marked) { loc.entries.forEach((c) => ids.push(c.id)); }
    if (loc.headingIndex >= 0 && loc.children[loc.headingIndex]) {
      const h = loc.children[loc.headingIndex];
      const txt = String(h.content || "").trim();
      if (LEGACY_BIB_HEADINGS.indexOf(txt) >= 0 || (heading && txt === heading)) { ids.push(h.id); }
    }
    if (!ids.length) { return 0; }
    try {
      const r = await apiQuiet("/api/transactions", {
        transactions: [{ doOperations: ids.map((id) => ({ action: "delete", id: id })) }],
        reqId: Date.now(),
      });
      if (!r || r.code !== 0) { throw new Error("tx failed"); }
    } catch (e) {
      for (const id of ids) { await apiQuiet("/api/block/deleteBlock", { id: id }); }
    }
    await apiQuiet("/api/attr/setBlockAttrs", {
      id: docId,
      attrs: { "custom-zotero-bibhash": "", "custom-zotero-bibheading": "" },
    });
    return ids.length;
  }

  /** 统一入口：把 payload 补上顶级名与旧名，再交给 ZBridge 执行 */
  docCollectionCall(payload) {
    return zoteroExec(this.settings, docCollectionScript(Object.assign({
      parentName: DOC_PARENT,
      legacyParents: DOC_LEGACY_PARENTS,
    }, payload || {})));
  }

  /** 扫这篇文档当前引用到的全部 key（正文，不含文末跳转链接） */
  async collectDocKeys(docId) {
    const r = await fetchSyncPost("/api/export/exportMdContent", { id: docId });
    const md = (r && r.data && r.data.content) || "";
    return scanCites(maskCode(md).s, this.settings.defaultFormat).keys;
  }

  /**
   * 让 Zotero 里的「本文件集合」与 keys 对齐。
   * keys 传 null = 让插件自己去文档里扫（文档打开时用）。
   *
   * 全程静默失败：Zotero 没开、令牌没填、文档没标题……都只是「这次没同步」，
   * 绝不能因此打断用户的插入/重排流程。
   */
  async syncDocCollection(docId, keys) {
    if (!this.settings.docCollection || !docId || !this.settings.token) {
      this.logDocCol("sync-skip", { docId: docId || null, off: !this.settings.docCollection, noToken: !this.settings.token });
      return { ok: false, skipped: "off" };
    }
    const map = this._docMap || (this._docMap = {});
    const rec = map[docId] || {};
    const title = await this.docTitleOf(docId);
    if (!title) {
      this.logDocCol("sync-skip", { docId: docId, reason: "no-title" });
      return { ok: false, skipped: "no-title" };
    }
    /*
     * 文档里一条引用都没有、而且还没建过集合 → 别建空壳。
     * 已经有集合的照常同步，keys 为空就把成员清空（等关文档时解散）。
     */
    if (!rec.key && !(keys && keys.length)) {
      this.logDocCol("sync-skip", { docId: docId, reason: "empty" });
      return { ok: false, skipped: "empty" };
    }
    let list = null;
    let avoidKeys = [];
    if (!rec.key) {
      /* 第一次给这篇文档建集合：先看一眼顶级下已有什么。
         凡是「本地映射里没有的」集合，都当成别人的（可能是 WPS 那边的同名文档），
         兜底按名字找时必须跳过它们 —— 否则两篇同名文档会互抢同一个集合。 */
      try {
        list = await this.docCollectionCall({ action: "list" });
      } catch (e) {
        list = null;
      }
      if (list && list.ok && Array.isArray(list.children)) {
        const mine = new Set(Object.keys(map).map((id) => (map[id] && map[id].key) || "").filter(Boolean));
        avoidKeys = list.children.filter((c) => c && c.key && !mine.has(c.key)).map((c) => c.key);
      }
    }
    const name = docCollectionName(title, docId, map);
    const r = await this.docCollectionCall({
      action: "sync",
      collectionKey: rec.key || "",
      docName: name,
      keys: keys || [],
      avoidKeys: avoidKeys,
      // 有 key 时严格按 key 找：找不到就新建，绝不去按名字捡别人的集合
      allowNameFallback: !rec.key,
    });
    if (r && r.ok && r.key) {
      map[docId] = { key: r.key, name: r.name, at: new Date().toISOString() };
      await this.saveDocMap();
    }
    this.logDocCol("sync", { docId: docId, name: name, r: r });
    return r;
  }

  /** 解散这篇文档的集合（顶级下没有别的了，脚本会把顶级一起收掉） */
  async dropDocCollection(docId) {
    const map = this._docMap || (this._docMap = {});
    const rec = map[docId];
    this.cancelDocSync(docId);
    if (!rec) {
      return { ok: false, skipped: "no-record" };
    }
    const avoidKeys = Object.keys(map)
      .filter((id) => id !== docId)
      .map((id) => (map[id] && map[id].key) || "")
      .filter(Boolean);
    let r = null;
    try {
      r = await this.docCollectionCall({
        action: "drop",
        collectionKey: rec.key || "",
        docName: rec.name || "",
        avoidKeys: avoidKeys,
      });
    } finally {
      delete map[docId];
      await this.saveDocMap();
    }
    return r;
  }

  /** 关掉开关时把本机建过的集合全部收掉（只动自己这棵树） */
  async dropAllDocCollections() {
    const map = this._docMap || {};
    const ids = Object.keys(map);
    for (const id of ids) {
      try {
        await this.dropDocCollection(id);
      } catch (e) { /* 尽力而为 */ }
    }
  }

  /**
   * 清理残渣：本地映射里有、但对应文档已经不在编辑器里的，解散掉。
   *
   * ⚠️ 只清「本地映射里有的」。Zotero 里那些映射里没有的集合（换电脑后映射丢了、
   *    或者根本是别的软件建的）一律不动 —— 宁可留着空壳，也不能误删别人的东西。
   * ⚠️ 问不出打开文档列表（openDocIds() 返回 null）时直接跳过。
   */
  async sweepDocCollections() {
    if (!this.settings.docCollection || !this.settings.token) {
      return { swept: 0, skipped: "off" };
    }
    const open = this.openDocIds();
    if (!open) {
      return { swept: 0, skipped: "unknown-open-docs" };
    }
    /*
     * 门闩：页面上一个编辑器都没有时，分不清「用户真把文档全关了」还是
     * 「前端刚启动、编辑器还没渲染出来」。后者若当成前者，就会把用户正在用的集合全清空
     * —— 2026-11-07 实测踩到：reload 后 8 秒扫一次，把「2026-11-07」的集合同步删光了。
     * 所以只有在确实有编辑器渲染出来时才清理；宁可留空壳，不可误删。
     */
    if (typeof document !== "undefined" && document.querySelectorAll &&
        document.querySelectorAll(".protyle").length === 0) {
      return { swept: 0, skipped: "no-editor" };
    }
    const openSet = new Set(open);
    let swept = 0;
    for (const id of Object.keys(this._docMap || {})) {
      if (openSet.has(id)) {
        continue;
      }
      try {
        const r = await this.dropDocCollection(id);
        if (r && r.dropped) {
          swept++;
        }
      } catch (e) { /* 一条失败不影响别的 */ }
    }
    return { swept };
  }

  /** 防抖排队：同一文档连改几下只同步一次 */
  scheduleDocCollection(docId, keys, delay) {
    if (!this.settings.docCollection) {
      return;
    }
    const timers = this._docSyncTimers || (this._docSyncTimers = {});
    if (timers[docId]) {
      clearTimeout(timers[docId]);
    }
    timers[docId] = setTimeout(() => {
      delete timers[docId];
      const job = (keys === null || keys === undefined)
        ? this.collectDocKeys(docId).then((ks) => this.syncDocCollection(docId, ks))
        : this.syncDocCollection(docId, keys);
      this.logDocCol("sync-run", { docId: docId, scanned: keys === null || keys === undefined });
      job.catch((e) => {
        this.logDocCol("sync-error", { docId: docId, err: String((e && e.message) || e) });
        console.log("[zotero-cite] 活跃文档集合同步跳过：", e && e.message ? e.message : e);
      });
    }, typeof delay === "number" ? delay : 900);
  }

  cancelDocSync(docId) {
    const timers = this._docSyncTimers;
    if (timers && timers[docId]) {
      clearTimeout(timers[docId]);
      delete timers[docId];
    }
  }

  /**
   * 记一条集合相关的决策（只留最近 60 条，只在内存里）。
   * 目的：出问题时不用让用户复述，直接看「事件有没有来、来的 docId 对不对、
   * 当时判成还开着还是关掉了」，一眼定位是事件没触发还是判断错了。
   */
  logDocCol(evt, info) {
    const log = this._docColLog || (this._docColLog = []);
    log.push(Object.assign({ t: new Date().toISOString(), evt }, info || {}));
    while (log.length > 60) {
      log.shift();
    }
  }

  /* ---------------- 插入 ---------------- */

  /**
   * 直接插入：拿 Zotero 当前选中条目就插，不弹窗。
   * 只有「编辑 / 删除 / 追加」才需要打开对话框（右键菜单里的编辑入口）。
   */
  async insertFromSelection() {
    if (!this.getDocId()) {
      showMessage("请先把光标放到要插入的位置");
      return;
    }
    let selected = [];
    try {
      selected = await fetchSelected(this.settings);
    } catch (e) {
      showMessage(String(e.message || e), 6000);
      return;
    }
    if (!selected.length) {
      showMessage("Zotero 里没有选中文献：先在 Zotero 选中条目（可多选），再回来点插入", 5000);
      return;
    }
    const keys = selected.map(x => x && x.key).filter(Boolean);
    if (!keys.length) {
      showMessage("选中的条目没有可引用的书目信息", 4000);
      return;
    }
    // 与对话框路径一致：先把实例与光标存下来，插入时才有落点
    const protyle = this.getProtyle();
    // 从右键菜单进来时用右键处的 range（它不属于 toolbar 的选区），用完即清
    let range = protyle && protyle.toolbar ? protyle.toolbar.range : null;
    if (this._ctxRange) {
      range = this._ctxRange;
      this._ctxRange = null;
    }
    this._pending = {
      protyle,
      range,
    };
    try {
      await this.insertCitation(keys, this.settings.defaultFormat);
      showMessage(`已插入 ${keys.length} 条文献引用`, 2000);
    } catch (e) {
      showMessage(String(e.message || e), 6000);
    }
  }

  /** 旧的「搜索 + 勾选」插入窗口：插入不再走它（一律直插），目前没有 UI 入口，
      保留作搜索式插入的备用实现；编辑/追加/删除走右键菜单里的编辑对话框。 */
  async openInsertDialog() {
    const docId0 = this.getDocId();
    if (!docId0) {
      showMessage("请先在文档里点一下光标位置");
      return;
    }
    // 打开对话框会让编辑器失焦，先把「当前实例 + 光标 range」存下来，
    // 否则点击「插入引用」时 protyle.toolbar.range 可能已被清空，插入会落到错误位置。
    const protyle0 = this.getProtyle();
    this._pending = {
      protyle: protyle0,
      range: protyle0 && protyle0.toolbar ? protyle0.toolbar.range : null,
    };
    let selected = [];
    try {
      showMessage("正在读取 Zotero 选中条目…", 1500);
      selected = await fetchSelected(this.settings);
    } catch (e) {
      showMessage(String(e.message || e), 6000);
      return;
    }
    const dlg = new Dialog({
      title: "插入 Zotero 文献引用",
      content: `<div class="zc-dlg zc-insert">
        <div class="zc-note">
          <svg class="zc-note__ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.3V11.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".85" fill="currentColor"/></svg>
          <span class="zc-note__text">勾选要插入的条目　勾多条会合并成一条引用；「追加」把 Zotero 当前选中并入列表</span>
        </div>
        <div class="zc-bar">
          <label>样式</label>
          <select class="b3-select zc-style"><option value="${this.settings.styleId}">${this.settings.styleId.split("/").pop()}</option></select>
          <label>形态</label>
          <select class="b3-select zc-fmt" title="只作用于这一处引用；下次插入会沿用你最后选的值">
            ${FMT_ORDER.map(k => `<option value="${k}" ${k === this.settings.defaultFormat ? "selected" : ""}>${FMT_LABEL[k]}</option>`).join("")}
          </select>
          <button class="b3-button b3-button--outline zc-refresh-style">刷新样式</button>
        </div>
        <div class="zc-search">
          <input class="b3-text-field fn__flex-1 zc-q" placeholder="在 Zotero 库里搜索（回车）" />
          <button class="b3-button b3-button--outline zc-go">搜索</button>
        </div>
        <div class="zc-list"></div>
        <div class="zc-foot">
          <span class="zc-tip"></span>
          <button class="b3-button b3-button--outline zc-checkall">全选/全不选</button>
          <button class="b3-button b3-button--outline zc-addsel">追加 Zotero 选中</button>
          <button class="b3-button b3-button--cancel zc-cancel">取消</button>
          <button class="b3-button zc-btn-primary zc-insert">插入引用</button>
        </div>
      </div>`,
      width: "720px",
      destroyCallback: () => {},
    });

    const el = dlg.element;
    const listEl = el.querySelector(".zc-list");
    const tipEl = el.querySelector(".zc-tip");
    const styleSel = el.querySelector(".zc-style");
    const fmtSel = el.querySelector(".zc-fmt");
    const qEl = el.querySelector(".zc-q");

    /*
     * 候选池 + 勾选模式。
     * 以前是「列表 = Zotero 当前选中」，想加第 2 条只能先去 Zotero 改选中；
     * 现在 Zotero 选中/搜索结果都进同一个池子，勾几条就插几条。
     */
    const pool = [];
    let styles = [];

    const pushItems = (items, keep) => {
      let added = 0;
      (items || []).forEach((it) => {
        if (!it || !it.key || pool.some(r => r.key === it.key)) {
          return;
        }
        pool.push({
          key: it.key,
          title: it.title,
          sub: [it.authors, it.year, it.itemType].filter(Boolean).join(" · "),
          keep: keep !== false,
        });
        added++;
      });
      return added;
    };

    const kept = () => pool.filter(r => r.keep);

    const renderList = () => {
      if (!pool.length) {
        listEl.innerHTML = `<div class="zc-empty">还没有候选。先在 Zotero 里选中文献，或用上面的搜索框加进来。</div>`;
        tipEl.textContent = "已勾选 0 条";
        return;
      }
      let ord = 0;
      listEl.innerHTML = pool.map((r, i) => {
        if (r.keep) {
          ord += 1;
        }
        return `
        <label class="zc-item ${r.keep ? "zc-item--on" : "zc-item--off"}">
          <span class="zc-ord">${r.keep ? ord : ""}</span>
          <input type="checkbox" class="zc-cb" data-i="${i}" ${r.keep ? "checked" : ""} />
          <div class="zc-meta">
            <div class="zc-title">${String(r.title || "(无题名)").replace(/</g, "&lt;")}</div>
            <div class="zc-sub">${String(r.sub || "").replace(/</g, "&lt;")}</div>
          </div>
        </label>`;
      }).join("");
      listEl.querySelectorAll(".zc-cb").forEach((cb) => {
        cb.addEventListener("change", () => {
          pool[Number(cb.getAttribute("data-i"))].keep = cb.checked;
          renderList();
        });
      });
      const n = kept().length;
      tipEl.textContent = `已勾选 ${n} 条 / 候选 ${pool.length} 条${n > 1 ? "（会合并成一条引用）" : ""}`;
    };

    pushItems(selected, true);
    renderList();

    // 异步补样式列表
    fetchStyles(this.settings).then((list) => {
      if (!list.length) {
        return;
      }
      styles = list;
      this.styleCache = list;
      const cur = this.settings.styleId;
      styleSel.innerHTML = list.map(s =>
        `<option value="${s.id}" ${s.id === cur ? "selected" : ""}>${(s.title || s.id).replace(/</g, "&lt;")}</option>`
      ).join("");
    }).catch(() => {});

    styleSel.addEventListener("change", async () => {
      await this.updateSettings({ styleId: styleSel.value });
    });

    // 形态只决定「这一处」怎么呈现；顺手记成默认值，下次插入沿用
    fmtSel.addEventListener("change", async () => {
      await this.updateSettings({ defaultFormat: fmtSel.value });
    });

    el.querySelector(".zc-refresh-style").addEventListener("click", async () => {
      try {
        const list = await fetchStyles(this.settings);
        styles = list;
        this.styleCache = list;
        const cur = this.settings.styleId;
        styleSel.innerHTML = list.map(s =>
          `<option value="${s.id}" ${s.id === cur ? "selected" : ""}>${(s.title || s.id).replace(/</g, "&lt;")}</option>`
        ).join("");
        showMessage("已读取 " + list.length + " 个样式");
      } catch (e) {
        showMessage(String(e.message || e), 6000);
      }
    });

    el.querySelector(".zc-checkall").addEventListener("click", () => {
      const allOn = pool.every(r => r.keep);
      pool.forEach((r) => { r.keep = !allOn; });
      renderList();
    });

    el.querySelector(".zc-addsel").addEventListener("click", async () => {
      try {
        const sel = await fetchSelected(this.settings);
        if (!sel.length) {
          tipEl.textContent = "Zotero 里没有选中文献";
          return;
        }
        const n = pushItems(sel, true);
        renderList();
        tipEl.textContent = n ? `已加入 ${n} 条（自动勾选）` : "这些条目已经在候选里了";
      } catch (e) {
        tipEl.textContent = String(e.message || e);
      }
    });

    const doSearch = async () => {
      const q = (qEl.value || "").trim();
      if (!q) {
        return;
      }
      tipEl.textContent = "搜索中…";
      try {
        const items = await searchLibrary(this.settings, q);
        const n = pushItems(items, true);
        renderList();
        if (n) {
          tipEl.textContent = `搜到 ${items.length} 条，已加入 ${n} 条（自动勾选）`;
        }
      } catch (e) {
        tipEl.textContent = String(e.message || e);
      }
    };
    el.querySelector(".zc-go").addEventListener("click", doSearch);
    qEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        doSearch();
      }
    });

    el.querySelector(".zc-cancel").addEventListener("click", () => dlg.destroy());

    el.querySelector(".zc-insert").addEventListener("click", async () => {
      const keys = kept().map(r => r.key);
      if (!keys.length) {
        showMessage("请至少勾选一条文献");
        return;
      }
      try {
        await this.insertCitation(keys, fmtSel.value);
        dlg.destroy();
      } catch (e) {
        showMessage(String(e.message || e), 8000);
      }
    });
  }

  /** 在光标处插入引用，然后整体重排。fmtId 决定这一处的形态 */
  async insertCitation(keys, fmtId) {
    const protyle = (this._pending && this._pending.protyle) || this.getProtyle();
    const docId = this.getDocId();
    if (!docId) {
      throw new Error("找不到当前文档");
    }
    const fmt = normFmt(fmtId || this.settings.defaultFormat);
    // 恢复打开对话框前记下的光标
    if (protyle && this._pending && this._pending.range && protyle.toolbar) {
      try {
        protyle.toolbar.range = this._pending.range;
      } catch (e) { /* 恢复失败就按当前状态插 */ }
    }
    // 先把新引用合成一条临时链接落进正文，再交给重排统一渲染
    const placeholder = makeCiteLink("[pending]", keys, this.settings, fmt);
    const ok = this.insertAtCursor(protyle, placeholder);
    this._pending = null;
    if (!ok) {
      throw new Error("插入失败：光标位置无效。请先在正文里点一下要插入的位置（让光标闪起来）再试。");
    }
    // 等思源把新内容落库，否则紧接着的重排扫不到这条引用
    await new Promise(r => setTimeout(r, 600));
    await this.refreshDocument(false, docId);
  }

  /**
   * 在 Protyle 光标处插入。
   * isPaste=true 会让思源把内容当富文本解析，markdown 链接才能成为真链接。
   */
  insertAtCursor(protyle, md) {
    if (!protyle) {
      return false;
    }
    // 思源的行内链接 DOM 是 <span data-type="a" data-href="...">，不是 <a href="...">。
    // 传 <a> 会被当纯文本落进去，链接不成立。
    const html = md.replace(/\[((?:\\.|[^\[\]\\])*)\]\(([^)]+)\)/g, (_, t, u) =>
      `<span data-type="a" data-href="${u}">${unescapeLinkText(t)}</span>`);
    const tries = [
      () => protyle.insert(html, false, true),
      () => protyle.insert(md, false, true),
      () => protyle.insert(md, true),
    ];
    for (const fn of tries) {
      try {
        fn();
        return true;
      } catch (e) {
        console.warn("[zotero-cite] insert try failed:", e && e.message);
      }
    }
    return false;
  }

  /* ---------------- 修改已有引用（右键菜单） ---------------- */

  /** 从被右键的链接元素反查：所在块 id + 该块内同 href 的第几个 */
  locateCiteAnchor(el) {
    if (!el || !el.closest) {
      return null;
    }
    const blk = el.closest("[data-node-id]");
    if (!blk) {
      return null;
    }
    const href = el.getAttribute("data-href") || el.getAttribute("href") || "";
    const same = Array.from(blk.querySelectorAll('[data-href]'))
      .filter(a => (a.getAttribute("data-href") || "") === href);
    const root = el.closest(".protyle");
    return {
      blockId: blk.getAttribute("data-node-id"),
      href,
      occ: Math.max(0, same.indexOf(el)),
      // 记下所属文档：改完要重排的是这篇，而不是「当前激活的标签页」那一篇
      docId: root ? root.getAttribute("data-node-id") : null,
    };
  }

  /** 光标所在（或当前段落里第一条）引用链接元素 */
  findCiteAnchorEl() {
    const sel = window.getSelection();
    let node = sel && sel.anchorNode ? sel.anchorNode : null;
    if (node && node.nodeType === 3) {
      node = node.parentElement;
    }
    // ⚠️ 不能写 [data-type="a"]：思源对「链接+上标」会渲染成 data-type="a sup"，
    //    精确等值匹配会漏掉（Nature 这类用上标编号的样式就中招）。用 data-href 判据最稳。
    const SEL = '[data-href*="zotero://select"]';
    const hit = node && node.closest ? node.closest(SEL) : null;
    if (hit) {
      return hit;
    }
    const blkEl = node && node.closest ? node.closest("[data-node-id]") : null;
    return blkEl ? blkEl.querySelector(SEL) : null;
  }

  /**
   * 就地改写某一处引用。
   * mutate(keys, fmtId) 返回 { keys?, fmt?, text?, remove? }，返回 false 表示放弃。
   */
  async patchCiteAt(anchor, mutate) {
    if (!anchor || !anchor.blockId) {
      throw new Error("找不到这处引用所在的块，请重新点开文档再试");
    }
    const r = await fetchSyncPost("/api/block/getBlockKramdown", { id: anchor.blockId });
    const kdRaw = (r && r.data && r.data.kramdown) || "";
    // ⚠️ 这里**不能**剥 <sup>：整体上标的引用是以 <sup>[1,3,4](url)</sup> 存的，
    //    剥了外壳再改写会丢上标。历史双层套娃由重排时的 unwrapCiteSups 负责清理。
    const kd = kdRaw;
    let seen = -1;
    let changed = false;
    const mk = maskCode(kd);
    const masked = mk.s.replace(CITE_RE, (full, text, kMain, query) => {
      const url = "zotero://select/library/items/" + kMain + (query ? "?" + query : "");
      if (url !== anchor.href) {
        return full;
      }
      seen++;
      if (seen !== anchor.occ) {
        return full;
      }
      const ks = citeKeysOf(kMain, query);
      const fmtId = fmtOfQuery(query, this.settings.defaultFormat);
      const out = mutate(ks, fmtId);
      if (!out) {
        return full;
      }
      changed = true;
      if (out.remove) {
        // 连同一侧多余空格一起清掉，避免留下 "（ ）" 这种残渣
        return "";
      }
      return makeCiteLink(
        unescapeLinkText(out.text != null ? out.text : text),
        out.keys || ks,
        this.settings,
        out.fmt || fmtId
      );
    });
    // 还原代码块，再剥掉块属性（属性由思源维护，回传会被当正文）
    const next = unmaskCode(stripBlockAttrs(masked), mk.store);
    if (!changed) {
      return { changed: false };
    }
    // 落盘前记一步撤销（改形态、增删条目都走这里）
    await this.snapBlocks(
      this.scopeRootIdSync((anchor && anchor.docId) || this.getDocId()),
      [{ id: anchor.blockId, kd: kdRaw }],
      "修改引用"
    );
    await fetchSyncPost("/api/block/updateBlock", {
      id: anchor.blockId,
      dataType: "markdown",
      data: next,
    });
    return { changed: true };
  }

  /** 右键引用弹出的浮层 */
  showCiteMenu(el, x, y) {
    this.closeCiteMenu();
    const href = el.getAttribute("data-href") || el.getAttribute("href") || "";
    const qm = /\?([^#\s]*)$/.exec(href);
    const cur = fmtOfQuery(qm ? qm[1] : "", this.settings.defaultFormat);
    const keys = parseCiteKeys(href);
    const anchor = this.locateCiteAnchor(el);

    // 叙述式只有作者年样式才有意义；数字样式调 author-only 只会输出 [NO_PRINTED_FORM]
    const numeric = this._lastRendered ? this._lastRendered.narrativeSupported === false : false;
    const styleName = (this._lastRendered && this._lastRendered.styleTitle)
      || this.settings.styleId.split("/").pop();

    const tick = (on) => `<span class="zc-menu__tick">${on ? "✓" : ""}</span>`;
    const menu = document.createElement("div");
    menu.className = "zc-menu";
    menu.innerHTML =
      `<div class="zc-menu__title">这处引用 ${keys.length} 条文献 · 样式 ${styleName}</div>` +
      `<div class="zc-menu__item${cur === "csl" ? " is-active" : ""}" data-fmt="csl">` +
        tick(cur === "csl") + `<span>文献引用默认格式<span class="zc-menu__sub">按 CSL 样式，链接不变</span></span></div>` +
      `<div class="zc-menu__item${cur === "narr" ? " is-active" : ""}${numeric ? " is-disabled" : ""}" data-fmt="narr">` +
        tick(cur === "narr") + `<span>Chen et al. (2026) 叙述式` +
        (numeric ? `<span class="zc-menu__sub">当前是数字式样式，不支持叙述式</span>` : "") +
        `</span></div>` +
      `<div class="zc-menu__sep"></div>` +
      `<div class="zc-menu__item" data-act="edit"><span class="zc-menu__tick">✎</span><span>编辑文献引用…（可增可删）</span></div>` +
      `<div class="zc-menu__item" data-act="style"><span class="zc-menu__tick">≡</span><span>切换全局默认 CSL 样式…</span></div>` +
      `<div class="zc-menu__item" data-act="setting"><span class="zc-menu__tick">⚙</span><span>插件设置…` +
        `<span class="zc-menu__sub">令牌 / 样式 / 文末标题 / 编号</span></span></div>` +
      `<div class="zc-menu__sep"></div>` +
      `<div class="zc-menu__item" data-act="locate"><span class="zc-menu__tick">↓</span><span>定位到文末参考文献中的这条</span></div>` +
      `<div class="zc-menu__sep"></div>` +
      `<div class="zc-menu__item" data-act="refresh"><span class="zc-menu__tick">↻</span><span>刷新本篇 Zotero 引用` +
        `<span class="zc-menu__sub">按当前样式重排正文与文末</span></span></div>`;
    document.body.appendChild(menu);

    // 贴边内收，避免弹出到屏幕外。放在下一帧量尺寸，否则刚插入还没布局，宽度是 0
    const place = () => {
      const box = menu.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8)) + "px";
      menu.style.top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) + "px";
    };
    place();
    requestAnimationFrame(place);

    this._menuEl = menu;
    this._menuOpenedAt = Date.now();

    menu.addEventListener("mousedown", (ev) => ev.stopPropagation());
    menu.addEventListener("click", async (ev) => {
      const item = ev.target.closest(".zc-menu__item");
      if (!item || item.classList.contains("is-disabled")) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const fmt = item.getAttribute("data-fmt");
      const act = item.getAttribute("data-act");
      this.closeCiteMenu();
      try {
        if (fmt) {
          await this.setCiteFormat(anchor, fmt);
          showMessage("已改为：" + FMT_LABEL[fmt], 3000);
        } else if (act === "edit") {
          await this.openCiteEditDialog(anchor, keys);
        } else if (act === "style") {
          await this.openStylePicker(anchor);
        } else if (act === "setting") {
          // 直接弹插件设置面板（思源 Plugin 自带 openSetting）
          if (typeof this.openSetting === "function") {
            await this.openSetting();
          } else {
            showMessage("当前思源版本不支持直接打开插件设置，请到 设置 → 集市 → 已下载 → 插件 → 设置 里打开。", 8000);
          }
        } else if (act === "locate") {
          const n = this.locateInBibliography(anchor, keys);
          if (!n) {
            showMessage("文末还没找到这条文献。先执行一次「重排全文 Zotero 引用」再试。", 5000);
          } else if (n > 1) {
            showMessage(`已标出文末对应的 ${n} 条文献`, 2500);
          }
        } else if (act === "refresh") {
          // 整篇重排：只在这一处点，但重排的是这篇文档（正文全部引用 + 文末）
          showMessage("正在按当前样式重排本篇…", 2000);
          await this.refreshDocument(true, (anchor && anchor.docId) || undefined);
        } else if (act === "open") {
          await this.openInZotero(href);
        } else if (act === "remove") {
          await this.removeCite(anchor);
        }
      } catch (e) {
        showMessage(String(e.message || e), 8000);
      }
    });
  }

  /**
   * 正文右键菜单里加「插入 Zotero 文献引用」。
   *
   * open-menu-content = 在块内文字上右键弹出的那个原生菜单（点块标那个入口是 click-blockicon）。
   * ⚠️ 1.3.0：多文档的「设顶级 / 设输出文档」只放左侧文档树右键（open-menu-doctree），
   *    **这里一律不加** —— 用户 2026-11-08 明确要求编辑器正文右键不出现这两项。
   * ⚠️ 两个必须：
   *   1) 菜单项要在同一个 tick 里加完，中间不能 await（菜单已经渲染了）；
   *   2) 必须加在**主菜单实例**上，不能用 detail.menu —— 那是思源临时造的子菜单，
   *      事件结束后会整体挂成「插件 ›」，用户得点两下才看得见（见 mainMenuOf 里的说明）。
   */
  bindContentMenu() {
    this.eventBus.on("open-menu-content", (e) => {
      const d = (e && e.detail) || {};
      if (!d.menu) {
        return;
      }
      try {
        const host = mainMenuOf(d.menu) || d.menu;
        const root = menuItemsRoot(host);
        const before = root && root.children ? root.children.length : 0;
        host.addItem({
          icon: "iconLink",
          label: "插入 Zotero 文献引用",
          click: () => {
            // 右键落点优先于「当前激活的标签页」：多标签时可能不是同一个文档
            if (d.protyle) {
              this.curProtyle = d.protyle;
            }
            this._ctxRange = d.range || null;
            this.insertFromSelection();
          },
        });
        promoteMenuItems(host, before);
      } catch (err) {
        /* 菜单 API 若改版，最多少这一项，不影响插入/右键引用等主功能 */
      }
    });
  }

  /* ---------------- 1.3.0 文档树右键菜单 ---------------- */

  bindDocTreeMenu() {
    this.eventBus.on("open-menu-doctree", (e) => this.onDocTreeMenu(e));
  }

  /**
   * 左侧文档树右键。用户说「在书的顶级文档上右键」，指的就是这里
   * （不是编辑器正文的 open-menu-content）。
   *
   * ⚠️ 三个实测口径（照抄工作区里已跑熟的 share-site / doc-num 两个插件）：
   *   1) detail.elements[0] 是选中的树节点，文档节点形如 li[data-type="navigation-file"]，
   *      文档 ID 在 data-node-id；笔记本节点是 navigation-root 且 data-node-id 为空，不给菜单；
   *   2) 菜单项必须**同步**挂上，click 回调里再去 await 没问题，但注册本身不能 await，
   *      否则菜单已经渲染完，项就不会出现；
   *   3) 文档树菜单直接用 detail.menu.addItem() 即可，不像 open-menu-content 那样
   *      需要 mainMenuOf() 绕开思源临时造的子菜单。
   */
  onDocTreeMenu(e) {
    const d = (e && e.detail) || {};
    if (!d.menu || !d.elements || !d.elements.length) { return; }
    const el = d.elements[0];
    const node = (el && el.closest && el.closest("li[data-type]")) || el;
    if (!node || !node.getAttribute) { return; }
    if (String(node.getAttribute("data-type") || "").toLowerCase() !== "navigation-file") { return; }
    const docId = String(node.getAttribute("data-node-id") || "");
    if (!/^\d{14}-[a-z0-9]{7}$/i.test(docId)) { return; }
    const isRoot = !!(this._scopes && this._scopes[docId]);
    /*
     * 用户 2026-11-08 23:36 定稿：文档树右键只留一个父项「Zotero多文档设置」，
     * 两项收进 submenu 变成二级项，不占一级菜单位置。
     * 子项固定两条：第一条按状态在「设为 / 取消顶级」之间切换；
     * 第二条始终给（已是顶级时也可能想改输出文档），不在树内时 setBibDoc 自己会提示。
     */
    try {
      d.menu.addItem({
        icon: "iconSettings",
        label: "Zotero多文档设置",
        submenu: [
          {
            icon: isRoot ? "iconClose" : "iconFolder",
            label: isRoot ? "取消「引文顶级文档」" : "设为引文顶级文档（多文档统一管理）",
            click: () => {
              if (isRoot) { this.unsetScopeRoot(docId); }
              else { this.setScopeRoot(docId); }
            },
          },
          {
            icon: "iconFile",
            label: "设为文献列表输出文档",
            click: () => { this.setBibDoc(docId); },
          },
        ],
      });
    } catch (err) { /* 菜单 API 若改版，最多少这一项，命令面板仍可用 */ }
  }

  closeCiteMenu() {
    if (this._menuEl && this._menuEl.parentNode) {
      this._menuEl.remove();
    }
    this._menuEl = null;
  }

  /**
   * 切换某一处引用的形态（默认格式 ↔ 叙述式）。
   *
   * ⚠️ 只改这一块，**不重建文末列表、不重写其他引用块**。
   *    以前这里改完就调 refreshDocument 整篇重排：导出全文 → 逐块读 → 逐块写 →
   *    删掉并重建整个文末参考文献。改一个字的显示形态却把全文重写一遍，文档一大就卡。
   *    形态只影响这一处的显示文本，条目集合没变，文末列表与别的引用都不需要动。
   *
   * 常态**不读全文**：只把这一处交给 Zotero 渲染一次，改这一块，结束。
   * 唯一的例外：当前样式是数字式（IEEE / Nature / GB/T 7714 这类），正文显示的是
   * 编号，而编号由 CSL 按全文引用顺序分配 —— 单独送渲染只会得到 [1]。
   * 所以只有「渲染结果看起来就是个编号」时，才补一次全文顺序重算，仍只写这一块。
   */
  async setCiteFormat(anchor, fmtId) {
    const fmt = normFmt(fmtId);
    const keys = parseCiteKeys((anchor && anchor.href) || "");
    if (!keys.length) {
      throw new Error("没读到这处引用的文献条目，请重新点开文档再试");
    }

    // 与整篇重排共用同一把串行锁，避免两条路径交叉写同一块
    const prevLock = this._refreshLock || Promise.resolve();
    let release;
    const myLock = new Promise((r) => { release = r; });
    this._refreshLock = prevLock.then(() => myLock);
    await prevLock;
    try {
      // 第一步：只渲染这一处
      /*
       * 条目在当前 Zotero 里全查不到时，Zotero 侧会报 no-items。那不是致命错误
       * （换了 profile、数据目录就会这样），下面还有文档存档可以兜底，先别抛。
       */
      let rendered;
      try {
        rendered = await zoteroExec(this.settings, buildRenderScript({
          keys,
          clusters: [keys],
          styleId: this.settings.styleId,
        }));
      } catch (e) {
        if (e.zcode !== "no-items") {
          throw e;
        }
        rendered = { cites: {}, order: [], style: null };
      }
      let rec = (rendered.cites && rendered.cites[keys.join("|")]) || null;

      // 数字式特征：渲染出来就是一串编号（[1] / <sup>1</sup> / (1)），没有作者年文本
      const looksNumeric = !!rec && !(rec.np && rec.np.length) &&
        /^[\s<]*[\[(（]?\s*(<sup>)?\s*\d/.test(String(rec.c || ""));
      if (looksNumeric) {
        const docId = (anchor && anchor.docId) || this.getDocId();
        if (docId) {
          const mdResp = await fetchSyncPost("/api/export/exportMdContent", { id: docId });
          const fullMd = (mdResp && mdResp.data && mdResp.data.content) || "";
          const scan = scanCites(maskCode(fullMd).s, this.settings.defaultFormat);
          if (scan.keys.length) {
            const seen = new Set();
            const list = [];
            scan.hits.forEach((h) => {
              const ck = h.keys.join("|");
              if (!seen.has(ck)) {
                seen.add(ck);
                list.push(h.keys);
              }
            });
            // 锚点可能是刚被改过的旧块，兜底把目标这处补进顺序里
            if (!seen.has(keys.join("|"))) {
              list.push(keys);
            }
            try {
              rendered = await zoteroExec(this.settings, buildRenderScript({
                keys: scan.keys.concat(keys.filter(k => scan.keys.indexOf(k) < 0)),
                clusters: list,
                styleId: this.settings.styleId,
              }));
              rec = (rendered.cites && rendered.cites[keys.join("|")]) || rec;
            } catch (e) {
              // 同上：全篇条目都查不到时继续用上一轮（或存档）的结果，不打断切换
              if (e.zcode !== "no-items") {
                throw e;
              }
            }
          }
        }
      }

      const narrable = rendered.narrativeSupported !== false;
      // 一条都取不到时 rendered 里没有样式信息，别把上次的「样式形态」冲掉：
      // 右键菜单靠它决定「叙述式」能不能点
      if (rendered.style) {
        this._lastRendered = {
          narrativeSupported: narrable,
          styleTitle: rendered.style.title || null,
        };
      }
      if (fmt === "narr" && !narrable) {
        throw new Error("当前是数字式样式，没有叙述式写法");
      }

      /*
       * 这几条在当前 Zotero 里取不到（换了 profile / 数据目录后 item key 对不上）时，
       * 用文档存档里那次的成品来切换格式：
       *   csl  → clusters[ck].c（上次样式渲染出的引用原文）
       *   narr → clusters[ck].np（上次的叙述式零件）
       * 存档就是「本机曾经真实渲染过」的结果，格式与当前样式一致，直接用它切换即可，
       * 不该因为库里查不到就拒绝——正文文本本来就不依赖 Zotero 在线。
       */
      if (!rec || (fmt === "narr" && !(rec.np && rec.np.length))) {
        const docId = (anchor && anchor.docId) || this.getDocId();
        const snap = docId ? await readSnapshot(this.scopeRootIdSync(docId)) : null;
        const prev = pickCluster(snap && snap.clusters, keys);
        if (prev && prev.c) {
          rec = { c: prev.c, np: prev.np || [] };
        }
      }

      if (!rec) {
        throw new Error("没拿到 CSL 渲染结果（这几篇文献不在当前 Zotero 库里，文档里也没有它们的存档）");
      }
      const text = fmt === "narr" ? joinNarrParts(rec.np) : cslHtmlToMarkdown(rec.c);
      if (!text) {
        throw new Error(fmt === "narr"
          ? "这几条在当前 Zotero 里查不到，文档存档里也没有它们的叙述式写法，先切回默认格式"
          : "样式没有给出这一处的显示文本");
      }

      // 只写这一块：patchCiteAt 自带单块撤销快照
      const res = await this.patchCiteAt(anchor, () => ({ text, fmt }));
      if (!res.changed) {
        throw new Error("没找到匹配的引用链接（可能内容刚被改动过），请刷新文档后再试");
      }
    } finally {
      release();
    }
  }

  /** 编辑这处引用：勾选保留的条目、从 Zotero 追加、搜索添加 */
  async openCiteEditDialog(anchor, keys) {
    const docId = (anchor && anchor.docId) || null;
    /*
     * 文档里存着上次成功重排时的条目存档（custom-zotero-bibsnap）。
     * 换了 Zotero profile / 数据目录之后，库里的 item key 会成批对不上，
     * 那时这张存档就是唯一还能说清「这几条原本是哪几篇」的东西 —— 必须读它，
     * 否则整屏都是「(该条目已不在库里)」。
     */
    const snap = docId ? await readSnapshot(this.scopeRootIdSync(docId)) : null;
    const snapRec = (k) => (snap && snap.items && snap.items[k]) || null;

    let metas = [];
    try {
      metas = await fetchMetaByKeys(this.settings, keys);
    } catch (e) {
      // Zotero 没开 / 令牌失效：条目本身还在，别把列表清空，先按 key 站着，下面照样读存档
      metas = keys.map(k => ({ key: k, found: null, title: "", authors: "", year: "" }));
    }
    const metaBy = {};
    metas.forEach((m) => { metaBy[m.key] = m; });

    /** 一条列表项：库里有的用库里元数据；库里没有的退回文档存档；都没有才承认「查不到」 */
    const rowOf = (k) => {
      const m = metaBy[k];
      const csl = (snapRec(k) && snapRec(k).csl) || null;
      if (m && m.found) {
        return { key: k, title: m.title || "(无题名)", sub: [m.authors, m.year].filter(Boolean).join(" · "), keep: true };
      }
      if (csl) {
        return {
          key: k,
          title: cslTitle(csl) || "(无题名)",
          sub: [cslAuthors(csl), cslYear(csl)].filter(Boolean).join(" · "),
          keep: true,
          missing: true,
          snap: true,
        };
      }
      return {
        key: k,
        title: m && m.title ? m.title : "（该条目已不在库里）",
        sub: ["文档里也没有它的存档，重排时这一处保持原样", k].filter(Boolean).join(" · "),
        keep: true,
        missing: true,
      };
    };
    const rows = keys.map(rowOf);

    const dlg = new Dialog({
      title: "编辑文献引用",
      content: `<div class="zc-dlg zc-edit">
        <div class="zc-note">
          <svg class="zc-note__ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.3V11.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".85" fill="currentColor"/></svg>
          <span class="zc-note__text"></span>
        </div>
        <div class="zc-edit__list"></div>
        <div class="zc-search">
          <input class="b3-text-field fn__flex-1 zc-q" placeholder="在 Zotero 库里搜索并添加（回车）" />
          <button class="b3-button b3-button--outline zc-go">搜索</button>
        </div>
        <div class="zc-foot">
          <span class="zc-tip"></span>
          <button class="b3-button b3-button--outline zc-relink">在库里找回</button>
          <button class="b3-button b3-button--outline zc-addsel">追加 Zotero 选中</button>
          <button class="b3-button b3-button--cancel zc-cancel">取消</button>
          <button class="b3-button zc-btn-primary zc-ok">保存</button>
        </div>
      </div>`,
      width: "680px",
      destroyCallback: () => {},
    });

    const el = dlg.element;
    const listEl = el.querySelector(".zc-edit__list");
    const tipEl = el.querySelector(".zc-tip");
    const qEl = el.querySelector(".zc-q");
    const noteEl = el.querySelector(".zc-note__text");
    const relinkBtn = el.querySelector(".zc-relink");

    const render = () => {
      if (!rows.length) {
        noteEl.textContent = "这一处已经没有条目了";
        listEl.innerHTML = `<div class="zc-empty">这一处没有条目了。保存后会连引用一起删掉。</div>`;
        return;
      }
      const keepCount = rows.filter(r => r.keep).length;
      const missCount = rows.filter(r => r.missing).length;
      noteEl.innerHTML = `共 <b>${rows.length}</b> 条 · 保留 <b>${keepCount}</b> 条　取消勾选即移除，保存后正文自动重排` +
        (missCount ? `　<span class="zc-note__warn">${missCount} 条不在当前 Zotero 库</span>` : "");
      // 只有真的还有「库里查不到」的条目，找回按钮才有意义
      relinkBtn.classList.toggle("fn__none", !missCount);
      let ord = 0;
      listEl.innerHTML = rows.map((r, i) => {
        if (r.keep) {
          ord += 1;
        }
        return `
        <label class="zc-item ${r.keep ? "zc-item--on" : "zc-item--off"}${r.missing ? " zc-item--miss" : ""}">
          <span class="zc-ord">${r.keep ? ord : ""}</span>
          <input type="checkbox" class="zc-cb" data-i="${i}" ${r.keep ? "checked" : ""} />
          <div class="zc-meta">
            <div class="zc-title">${String(r.title || "(无题名)").replace(/</g, "&lt;")}</div>
            <div class="zc-sub">${String(r.sub || "").replace(/</g, "&lt;")}${
              r.missing
                ? `<span class="zc-tag">${r.snap ? "当前库查不到 · 取自文档存档" : "当前库查不到 · 无存档"}</span>`
                : ""
            }</div>
          </div>
        </label>`;
      }).join("");
      listEl.querySelectorAll(".zc-cb").forEach((cb) => {
        cb.addEventListener("change", () => {
          rows[Number(cb.getAttribute("data-i"))].keep = cb.checked;
          render();
        });
      });
    };
    render();

    /*
     * 开局就把「为什么这几条查不到」讲明白：用户看到一屏「不在库里」时第一反应是
     * 文档数据坏了，其实只是 Zotero 换了 profile / 数据目录，条目 key 对不上了。
     * 只给一句短的：底栏还要塞四个按钮，长提示会挤成两行。
     */
    if (rows.some(r => r.missing)) {
      tipEl.textContent = "标题取自文档存档，可点「在库里找回」重接";
    }

    el.querySelector(".zc-relink").addEventListener("click", async () => {
      const asks = rows.filter(r => r.missing).map((r) => {
        const csl = ((snapRec(r.key) || {}).csl) || {};
        return {
          key: r.key,
          doi: String(csl.DOI || ""),
          title: String(csl.title || r.title || ""),
        };
      });
      if (!asks.length) {
        return;
      }
      const btn = el.querySelector(".zc-relink");
      btn.disabled = true;
      tipEl.textContent = "在 Zotero 库里按 DOI / 标题比对…";
      try {
        const found = await relinkEntries(this.settings, asks);
        let n = 0;
        found.forEach((x) => {
          if (!x.newKey) {
            return;
          }
          const r = rows.find(y => y.missing && y.key === x.key);
          if (!r) {
            return;
          }
          // 该条目已经被用户手动搜进来过了：不再重复占一行，只标一句
          if (rows.some(y => y !== r && y.key === x.newKey)) {
            r.title = `${r.title}（与列表中另一条重复）`;
            return;
          }
          r.key = x.newKey;
          r.missing = false;
          r.snap = false;
          r.title = x.title || r.title;
          r.sub = [r.sub, "已接回 Zotero 条目"].filter(Boolean).join(" · ");
          n++;
        });
        render();
        tipEl.textContent = n
          ? `已接回 ${n} 条，保存后正文按现在这份 Zotero 库重排`
          : "库里没找到同一条目（DOI 与标题都没有唯一命中）——这批文献可能不在当前 Zotero 库里";
      } catch (e) {
        tipEl.textContent = String(e.message || e);
      } finally {
        btn.disabled = false;
      }
    });

    const push = (items, keep) => {
      let added = 0;
      items.forEach((it) => {
        if (rows.some(r => r.key === it.key)) {
          return;
        }
        rows.push({ key: it.key, title: it.title, sub: [it.authors, it.year].filter(Boolean).join(" · "), keep });
        added++;
      });
      render();
      return added;
    };

    el.querySelector(".zc-addsel").addEventListener("click", async () => {
      try {
        const sel = await fetchSelected(this.settings);
        if (!sel.length) {
          tipEl.textContent = "Zotero 里没有选中文献";
          return;
        }
        const n = push(sel, true);
        tipEl.textContent = n ? `已加入 ${n} 条（勾选状态=保留）` : "这些条目已经在这处引用里了";
      } catch (e) {
        tipEl.textContent = String(e.message || e);
      }
    });

    const doSearch = async () => {
      const q = (qEl.value || "").trim();
      if (!q) {
        return;
      }
      tipEl.textContent = "搜索中…";
      try {
        const items = await searchLibrary(this.settings, q);
        const n = push(items, true);
        tipEl.textContent = n ? `搜到 ${items.length} 条，已加入 ${n} 条` : "搜到的条目都已在列表里";
      } catch (e) {
        tipEl.textContent = String(e.message || e);
      }
    };
    el.querySelector(".zc-go").addEventListener("click", doSearch);
    qEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        doSearch();
      }
    });

    el.querySelector(".zc-cancel").addEventListener("click", () => dlg.destroy());

    el.querySelector(".zc-ok").addEventListener("click", async () => {
      const nextKeys = rows.filter(r => r.keep).map(r => r.key);
      const btn = el.querySelector(".zc-ok");
      btn.disabled = true;
      try {
        if (!nextKeys.length) {
          await this.removeCite(anchor);
        } else {
          const res = await this.patchCiteAt(anchor, (oldKeys, fmt) => ({ keys: nextKeys, fmt }));
          if (!res.changed) {
            throw new Error("没找到匹配的引用链接（可能内容刚被改动过），请刷新文档后再试");
          }
          await new Promise(r => setTimeout(r, 400));
          await this.refreshDocument(false, (anchor && anchor.docId) || undefined);
        }
        dlg.destroy();
        showMessage(`这条引用现在 ${nextKeys.length} 条文献`, 3000);
      } catch (e) {
        btn.disabled = false;
        showMessage(String(e.message || e), 8000);
      }
    });
  }

  /** 切换全局默认 CSL 样式（读 Zotero 已装样式，选中后全文重排） */
  async openStylePicker(anchor) {
    let styles = [];
    try {
      styles = (this.styleCache && this.styleCache.length)
        ? this.styleCache
        : await fetchStyles(this.settings);
      this.styleCache = styles;
    } catch (e) {
      showMessage(String(e.message || e), 8000);
      return;
    }

    let cur = this.settings.styleId;
    const dlg = new Dialog({
      title: "切换全局默认 CSL 样式",
      content: `<div class="zc-dlg zc-pick">
        <div class="zc-note">
          <svg class="zc-note__ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.3V11.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="4.9" r=".85" fill="currentColor"/></svg>
          <span class="zc-note__text">Zotero 里已装 <b>${styles.length}</b> 个样式　切换后本文所有引用与文末列表都会按新样式重排</span>
        </div>
        <div class="zc-search">
          <input class="b3-text-field fn__flex-1 zc-filter" placeholder="输入样式名过滤，如 GB/T、APA、IEEE" />
        </div>
        <div class="zc-list zc-styles"></div>
        <div class="zc-foot">
          <span class="zc-tip"></span>
          <button class="b3-button b3-button--cancel zc-cancel">取消</button>
          <button class="b3-button zc-btn-primary zc-ok">应用并重排</button>
        </div>
      </div>`,
      width: "660px",
      destroyCallback: () => {},
    });

    const el = dlg.element;
    const listEl = el.querySelector(".zc-styles");
    const filterEl = el.querySelector(".zc-filter");

    const render = () => {
      const q = (filterEl.value || "").trim().toLowerCase();
      const list = styles.filter(s => !q
        || String(s.title || "").toLowerCase().includes(q)
        || String(s.id || "").toLowerCase().includes(q));
      if (!list.length) {
        listEl.innerHTML = `<div class="zc-empty">没有匹配的样式</div>`;
        return;
      }
      listEl.innerHTML = list.map(s => `
        <label class="zc-item${s.id === cur ? " is-active" : ""}">
          <input type="radio" name="zc-style" class="zc-radio" value="${s.id}" ${s.id === cur ? "checked" : ""} />
          <div class="zc-meta">
            <div class="zc-title">${String(s.title || s.id).replace(/</g, "&lt;")}</div>
            <div class="zc-sub">${String(s.id || "").split("/").pop()}</div>
          </div>
        </label>`).join("");
      listEl.querySelectorAll(".zc-radio").forEach((r) => {
        r.addEventListener("change", () => {
          cur = r.value;
          render();
        });
      });
    };
    render();
    filterEl.addEventListener("input", render);

    el.querySelector(".zc-cancel").addEventListener("click", () => dlg.destroy());
    el.querySelector(".zc-ok").addEventListener("click", async () => {
      const btn = el.querySelector(".zc-ok");
      btn.disabled = true;
      try {
        const prevStyle = this.settings.styleId;
        await this.updateSettings({ styleId: cur });
        // 把「切换前」的样式传给重排，撤销时才能连样式一起回滚
        await this.refreshDocument(false, (anchor && anchor.docId) || undefined, prevStyle);
        dlg.destroy();
        showMessage("已切换到：" + (styles.find(s => s.id === cur) || {}).title, 4000);
      } catch (e) {
        btn.disabled = false;
        showMessage(String(e.message || e), 8000);
      }
    });
  }

  /** 滚到文末参考文献里对应的条目，并把这个引用的**每一条**都标出来 */
  locateInBibliography(anchor, keys) {
    const want = (keys || []).filter(Boolean);
    if (!want.length) {
      return false;
    }
    const rootSel = (anchor && anchor.docId) ? `.protyle[data-node-id="${anchor.docId}"]` : ".protyle";
    const pros = Array.from(document.querySelectorAll(rootSel));
    const pro = pros.find(el => !el.closest(".fn__none")) || pros[0];
    if (!pro) {
      return false;
    }
    // 文末条目是 [↗](…?bib=1)，用 key 精确匹配，避免 UAPYI8NA 误中 UAPYI8NAB
    const marks = Array.from(pro.querySelectorAll('[data-href*="?bib=1"]'));
    const hitBlock = (k) => {
      const m = marks.find((el) => {
        const h = el.getAttribute("data-href") || "";
        return h.indexOf("/items/" + k + "?") >= 0 || h.indexOf("/items/" + k + "&") >= 0;
      });
      return m ? (m.closest("[data-node-id]") || m) : null;
    };

    // 多条目：按引用自己的顺序把每一条都找出来，别只标第一条
    const blocks = [];
    for (const k of want) {
      const b = hitBlock(k);
      if (b && !blocks.includes(b)) {
        blocks.push(b);
      }
    }
    if (!blocks.length) {
      return false;
    }

    // 先清掉上一次的残留，再统一打标
    pro.querySelectorAll(".zc-bib-hit").forEach(el => el.classList.remove("zc-bib-hit"));
    blocks.forEach((b) => {
      void b.offsetWidth;
      b.classList.add("zc-bib-hit");
    });
    setTimeout(() => {
      blocks.forEach(b => b.classList.remove("zc-bib-hit"));
    }, 2000);

    try {
      blocks[0].scrollIntoView({ block: "center", behavior: "smooth" });
    } catch (e) {
      blocks[0].scrollIntoView();
    }
    return blocks.length;
  }

  async removeCite(anchor) {
    const res = await this.patchCiteAt(anchor, () => ({ remove: true }));
    if (!res.changed) {
      throw new Error("没找到匹配的引用链接（可能内容刚被改动过），请刷新文档后再试");
    }
    await new Promise(r => setTimeout(r, 400));
    await this.refreshDocument(false, (anchor && anchor.docId) || undefined);
    showMessage("已删除这处引用", 3000);
  }

  /** 命令面板：循环切换光标处引用的形态 */
  async cycleCiteFormat() {
    const el = this.findCiteAnchorEl();
    if (!el) {
      showMessage("请把光标放到一处 Zotero 引用上（同一段落里有引用也行）", 5000);
      return;
    }
    const href = el.getAttribute("data-href") || el.getAttribute("href") || "";
    const qm = /\?([^#\s]*)$/.exec(href);
    const cur = fmtOfQuery(qm ? qm[1] : "", this.settings.defaultFormat);
    const i = FMT_ORDER.indexOf(cur);
    const nextFmt = FMT_ORDER[(i + 1) % FMT_ORDER.length];
    try {
      await this.setCiteFormat(this.locateCiteAnchor(el), nextFmt);
      showMessage("形态：" + FMT_LABEL[nextFmt], 3000);
    } catch (e) {
      showMessage(String(e.message || e), 7000);
    }
  }

  /* ---------------- 撤销栈 ---------------- */

  /**
   * 记录一次可撤销操作。
   *
   * ⚠️ 为什么要自己做：插件写入走的是内核 API（/api/block/updateBlock），
   *    不经过前端编辑器的撤销栈，思源的 Ctrl+Z 管不到它。
   *    所以这里给每篇文档单独留 20 步「受影响块快照」，撤销时写回快照再重排
   *    （重排会把文末列表按恢复后的正文重建，等于一并回滚）。
   *    也试过前端 protyle.transaction()，实测会重建块 ID、把文档结构打散，不可用。
   */
  async snapBlocks(docId, blocks, label, styleIdBefore) {
    if (this._inUndo || !docId || !blocks || !blocks.length) {
      return;
    }
    const cast = blocks
      .filter(b => b && b.id && typeof b.kd === "string")
      .map(b => ({ id: b.id, kd: b.kd }));
    if (!cast.length) {
      return;
    }
    const stack = (this._undoStack[docId] = this._undoStack[docId] || []);
    stack.push({
      ts: Date.now(),
      label: label || "Zotero 引用操作",
      // 样式要记「操作前」的值：撤销后要重排，样式没回滚会被当前样式重新渲染回去。
      // 切样式时 settings 已经改过了，所以由调用方把旧值传进来。
      styleId: styleIdBefore || this.settings.styleId,
      blocks: cast,
    });
    while (stack.length > 20) {
      stack.shift();
    }
  }

  /** 撤销最近一次 Zotero 引用操作 */
  async undoLast() {
    let docId = this.scopeRootIdSync(this.getDocId());
    // 当前文档没有记录时，回落到「最近一次操作过的那篇」，别让用户切个标签就撤不动
    const hasStack = (id) => !!(id && this._undoStack[id] && this._undoStack[id].length);
    if (!hasStack(docId)) {
      let best = null;
      let bestTs = 0;
      for (const k in this._undoStack) {
        const st = this._undoStack[k];
        const ts = st && st.length ? st[st.length - 1].ts : 0;
        if (ts > bestTs) {
          bestTs = ts;
          best = k;
        }
      }
      if (best) {
        docId = best;
      }
    }
    if (!docId) {
      showMessage("找不到当前文档");
      return;
    }
    const stack = this._undoStack[docId];
    if (!stack || !stack.length) {
      showMessage("这篇文档没有可撤销的 Zotero 引用操作", 4000);
      return;
    }
    const entry = stack.pop();
    this._inUndo = true;
    let n = 0;
    try {
      // 先回滚样式，否则重排会拿当前样式把快照重新渲染一遍
      if (entry.styleId && entry.styleId !== this.settings.styleId) {
        await this.updateSettings({ styleId: entry.styleId });
      }
      // 先筛掉已经不存在的块：文末列表这类块每次重排都会换 id，
      // 拿旧 id 去写只会得到一串 "block not found"，刷屏又没用
      let alive = entry.blocks;
      try {
        const ids = entry.blocks.map((b) => "'" + b.id + "'").join(",");
        const q = await fetchSyncPost("/api/query/sql", {
          stmt: "SELECT id FROM blocks WHERE id IN (" + ids + ")",
        });
        const set = new Set(((q && q.data) || []).map((x) => x.id));
        alive = entry.blocks.filter((b) => set.has(b.id));
      } catch (e) { /* 查不到就按原样回滚 */ }

      for (const b of alive) {
        const r = await fetchSyncPost("/api/block/updateBlock", {
          id: b.id,
          dataType: "markdown",
          // 快照存的是带 {: id=… } 的 kramdown，回写前必须剥掉，否则属性会变成正文
          data: canonicalContent(b.kd),
        });
        if (r && r.code === 0) {
          n++;
        }
      }
      await new Promise(res => setTimeout(res, 400));
      // 正文回滚后重排一次，文末列表与编号跟着回去
      await this.refreshDocument(false, docId);
      /*
       * 批量回滚会换掉不少块，编辑器手里还留着旧块引用，
       * 它会逐个去加载已经不在的块（满屏 "load block tree failed"）。
       * 让思源把这篇文档重开一次，比一屏报错干净。
       */
      try {
        await fetchSyncPost("/api/ui/reloadProtyle", { id: docId });
      } catch (e) { /* 老版本没有这个接口就算了 */ }
    } catch (e) {
      showMessage("撤销时出错：" + (e.message || e), 8000);
    } finally {
      this._inUndo = false;
    }
    if (!n) {
      // 块已被思源重建（id 变了），没法按块回滚；此时不要谎报成功
      showMessage(`「${entry.label}」这一步没能回滚：相关块已被思源重建。改用编辑器里的 Ctrl+Z，或重新选择一次样式即可。`, 8000);
      return;
    }
    showMessage(`已撤销「${entry.label}」，回滚 ${n} 个段落（还可撤销 ${stack.length} 步）`, 4000);
  }

  /* ---------------- 全文重排 ---------------- */

  /**
   * 扫描整篇文档里的引用链接 → 按首次出现顺序排序 → 一次送 Zotero 渲染
   * → 回写每处 in-text → 重建文末参考文献表。
   */
  async refreshDocument(verbose, docIdOverride, styleIdBefore) {
    const docId = docIdOverride || this.getDocId();
    if (!docId) {
      if (verbose) {
        showMessage("找不到当前文档");
      }
      return { updated: 0 };
    }
    /*
     * ⚠️ 必须串行化。
     * 重排 = 先导出全文快照 → 再逐块写回。如果两次重排重叠（用户连点、或刚改完形态
     * 立刻又触发一次），后开始的那次手持的是更旧的快照，会把先完成的结果整块覆盖回去。
     * 实测症状：刚把某处改成「叙述式+编号」，紧接着删掉另一处引用，前者被打回原形态。
     */
    const prevLock = this._refreshLock || Promise.resolve();
    let release;
    const myLock = new Promise((r) => { release = r; });
    this._refreshLock = prevLock.then(() => myLock);
    await prevLock;
    try {
      /*
       * 1.3.0：按作用域分流。没配任何顶级文档时 resolveScope 零 API 调用，
       * 单文档路径与 1.2.37 完全等价（zc_test.py 34/34 是判据）。
       */
      let scope = null;
      try {
        const s = await this.resolveScope(docId);
        if (s && s.mode === "multi") { scope = s; }
      } catch (e) { /* 作用域解析失败就退回单文档，不让重排整体失效 */ }
      return await this._refreshDocumentNow(verbose, docId, styleIdBefore, scope);
    } finally {
      release();
    }
  }

  async _refreshDocumentNow(verbose, docId, styleIdBefore, scope) {
    /*
     * 1.3.0 作用域：单文档时 rootId = docIds[0] = bibDocId = docId，
     * 下面每一步都退化为 1.2.37 的原逻辑；多文档时按文档树顺序聚合。
     */
    const rootId = (scope && scope.rootId) || docId;
    const docIds = (scope && scope.docIds && scope.docIds.length) ? scope.docIds : [docId];
    const bibDocId = (scope && scope.bibDocId) || docId;
    // 撤销帧里要记「这次渲染之前用的样式」：优先用调用方传的，
    // 否则用上一次实际渲染时用的样式（切样式时 settings 已经改过，不能直接取当前值）。
    const undoStyle = styleIdBefore || this._styleBeforeChange || this._lastStyleId || this.settings.styleId;
    // 1. 取全文 markdown（用来定顺序；后续逐块改写）
    /*
     * 1.3.0：多文档按树顺序拼成一份虚拟全文，一次送 CSL 渲染 → 编号全局连续。
     * ⚠️ 用 \n\n 分隔：groupCites 的 gap 只认 [ \t\u200b…]，换行能阻止
     *    「A 文档末尾的引用」与「B 文档开头的引用」被误合并成一处（交接坑 12/13）。
     */
    let fullMd = "";
    for (const oneId of docIds) {
      const mdResp = await fetchSyncPost("/api/export/exportMdContent", { id: oneId });
      fullMd += ((mdResp && mdResp.data && mdResp.data.content) || "") + "\n\n";
    }
    // 代码块里的示例链接不算引用
    const scan = scanCites(maskCode(fullMd).s, this.settings.defaultFormat);
    if (!scan.keys.length) {
      if (verbose) {
        showMessage("这篇文档里还没有 Zotero 引用");
      }
      return { updated: 0 };
    }

    // 2. 先把候选块全部读进来（渲染与改写共用这一份）。
    //    ⚠️ 顺序很重要：clusters 必须同时覆盖「全文分组」和「每块分组」。
    //       只按全文分组会漏 —— 全文导出与块内 kramdown 在换行/零宽字符上不完全一致，
    //       一旦块内分组结果不在 clusters 里，渲染取不到，正文就会变成 `[?]`。
    /*
     * ⚠️ 文末参考文献块必须排除在「改写」之外，逐文档的排除在 collectBlocksForDocs 里做。
     * 它们稍后会被 rebuildBibliography 整段删掉重建，如果这里也改写、也进撤销快照：
     *   · 每次重排都白写一遍（表现为 always updated N）；
     *   · 撤销时拿已被删除的块 id 去写，每块报一次 "block not found"，满屏提示。
     */
    const blocks = await this.collectBlocksForDocs(docIds, resolveBibHeading(this.settings, null));

    // 3. 每处引用算一个 cluster，按正文顺序交给 CSL 渲染。
    //    文本完全由样式决定，插件不拼括号、不算编号；链接结构不动（仍是 ?zkeys=&f=）。
    //    ⚠️ 紧挨着的多条引用算**一个** cluster：用户连着插两条得到 `(A, 2020)(B, 2023)`，
    //       应该被合成 `(A, 2020; B, 2023)`，而不是两个各自独立的括号。
    const fullMasked = maskCode(fullMd).s;
    const groups = groupCites(fullMasked, this.settings.defaultFormat);
    const clusters = [];
    const seenCluster = new Set();
    const pushCluster = (keys) => {
      const ck = keys.join("|");
      if (!ck || seenCluster.has(ck)) {
        return;
      }
      seenCluster.add(ck);
      clusters.push(keys);
    };
    groups.forEach((g) => pushCluster(g.keys));
    blocks.forEach((b) => {
      groupCites(maskCode(b.kd).s, this.settings.defaultFormat).forEach((g) => pushCluster(g.keys));
    });
    /*
     * ⚠️ 全篇条目都在当前 Zotero 里查不到（换了 profile / 数据目录后 item key 成批失效）时，
     *    Zotero 侧会报 no-items 而不是返回一份空结果。这里必须接住：
     *    下面本来就有「快照兜底」这条路，能让正文与文末原样保留；
     *    如果直接把它当致命错误抛出去，「刷新本篇」就彻底不可用了。
     */
    let rendered;
    try {
      rendered = await zoteroExec(this.settings, buildRenderScript({
        keys: scan.keys,
        clusters,
        styleId: this.settings.styleId,
        cslKeep: SNAP_CSL_KEEP,
      }));
    } catch (e) {
      if (e.zcode !== "no-items") {
        throw e;
      }
      rendered = { order: [], cites: {}, bibByKey: {}, bibOrder: [], style: null, snapCsl: {} };
    }
    /*
     * 有文献在当前 Zotero 里取不到（被删了、或这台机没同步全）时，用文档里的旧快照兜底：
     *   · 文末条目 → 恢复上次渲染出的条目原文，不再出现只有 ↗ 的空行；
     *   · 正文合并引用 → 恢复上次那一处的完整文本，不再静默少一条。
     * 快照是「上次成功重排」留下的，数据永远来自本机曾经真实存在过的条目。
     */
    const prevSnap = await readSnapshot(rootId);
    const renderedKeys = new Set(rendered.order || []);
    const missingKeys = scan.keys.filter((k) => !renderedKeys.has(k));
    /*
     * 哪几条是「用快照顶上的」。下游 rebuildBibliography 必须知道这件事：
     * 快照 html 也被塞进了 bibByKey，光看「bibByKey 有没有内容」分不出实时与存档，
     * 文献表补坏时就没法判断该怎么修顺序（2026-11-04 踩过：加了排序代码却完全不生效，
     * 因为 live 恒为 true）。
     */
    rendered.snapKeys = missingKeys.slice();
    let snapBib = 0;
    let snapCite = 0;
    if (missingKeys.length && prevSnap) {
      rendered.bibByKey = rendered.bibByKey || {};
      rendered.cites = rendered.cites || {};
      missingKeys.forEach((k) => {
        const rec = prevSnap.items && prevSnap.items[k];
        if (rec && rec.bib && !rendered.bibByKey[k]) {
          rendered.bibByKey[k] = rec.bib; // 与 CSL 输出同为 html，下游 cslHtmlToMarkdown 照常处理
          snapBib++;
        }
      });
      const missSet = new Set(missingKeys);
      Object.keys(prevSnap.clusters || {}).forEach((ck) => {
        if (!ck.split("|").some((k) => missSet.has(k))) {
          return;
        }
        const rec = prevSnap.clusters[ck];
        if (!rec || !rec.c) {
          return;
        }
        /*
         * ⚠️ 这里不能写 `if (rendered.cites[ck]) return;`。
         *    「A + 已删除的 B」这种合并引用，CSL 会把 B 过滤掉、只渲染出 A，
         *    于是 cites[ck] 照样有值 —— 如果因此跳过覆盖，B 就静默消失了（痕迹二本身）。
         *    快照里的 ck 键是「组合没变时」的完整文本，正是这种情况该用的。
         *    只有一种情形不覆盖：这处的 key 组合真的变了（用户新插了一条），
         *    此时 ck 不相等，压根进不到这个分支。
         */
        if (rendered.cites[ck] && rendered.cites[ck].c === rec.c) {
          return; // 内容完全一致，不算用上快照
        }
        rendered.cites[ck] = rec;
        snapCite++;
      });
    }
    const narrable = rendered.narrativeSupported !== false;
    // 记住这次用的样式形态，右键菜单要据此决定「叙述式」能不能点。
    // 一条都没取到（全用快照）时 rendered 里没有样式信息，别把上次记的清空。
    if (rendered.style) {
      this._lastRendered = {
        narrativeSupported: narrable,
        styleTitle: rendered.style.title || null,
      };
    }

    /**
     * 某处引用的正文内容。
     * 返回 { html, wholeSup }：wholeSup=true 表示样式把它整体做成了上标（ACS/Nature 的正文引用），
     * 这种情况必须把 **整个链接** 包进 <sup>，否则 <sup> 落在链接文本里会被思源剥掉，
     * 显示成普通数字；而包在外面时思源会渲染成 data-type="a sup"（data-href 仍在，点击/右键正常）。
     */
    const citeParts = (keys, fmtId) => {
      const rec = (rendered.cites && rendered.cites[keys.join("|")]) || null;
      if (!rec) {
        // 渲染结果里没有这个组合：宁可这一处不动，也不能写成 [?]（会把正文写坏）
        return null;
      }
      const wantNarr = normFmt(fmtId) === "narr";
      const narrText = wantNarr ? joinNarrParts(rec.np) : null;
      const raw = narrText || rec.c;
      if (!raw) {
        return null;
      }
      const inner = isWholeSup(raw);
      return inner !== null
        ? { html: inner, wholeSup: true }
        : { html: raw, wholeSup: false };
    };

    /** 生成一处引用的最终 markdown（必要时外层加 <sup>）；渲染不出来返回 null，调用方保留原文 */
    const renderCite = (keys, fmtId) => {
      const cp = citeParts(keys, fmtId);
      if (!cp) {
        return null;
      }
      const link = makeCiteLink(cslHtmlToMarkdown(cp.html), keys, this.settings, fmtId);
      return cp.wholeSup ? "<sup>" + link + "</sup>" : link;
    };

    // 4. 逐块改写正文里的引用链接（每处按自己的 ?f= 渲染；块内容已在第 2 步读好）
    let updated = 0;
    let skipped = 0;
    /* 两阶段：先算出所有要改的块，再统一记一次撤销帧，最后才落盘。
       这样「一次重排」= 撤销栈里的一步，Ctrl+Alt+Z 一按整批回滚。 */
    const todo = [];
    for (const b of blocks) {
      const kdRaw = b.kdRaw;
      const mk = maskCode(b.kd);
      // 紧挨着的多条引用合并成一处再渲染（`(A)(B)` → `(A; B)`）
      const gs = groupCites(mk.s, this.settings.defaultFormat);
      const masked = rewriteCites(mk.s, gs, (g) => {
        let fmtId = g.items[0].fmt;
        // 换成数字式样式后，原来的 narr 标记已无意义 → 顺手改回 csl，避免脏数据
        if (!narrable && fmtId === "narr") {
          fmtId = "csl";
        }
        return renderCite(g.keys, fmtId);
      });
      // ⚠️ 写盘前必须剥掉块属性：kramdown 的属性是紧贴正文的，按 markdown 写回去
      //    有可能被当成正文，用户就会看到 `…(2020)}{: id="…" updated="…"}`。
      const out = unmaskCode(stripBlockAttrs(masked), mk.store);
      /*
       * 比较与写盘都用规范化内容（去零宽）。
       * 思源在行内元素之间常塞 U+200B，读回来带、写之前不带时会算出「变了」，
       * 于是每次重排都白写一遍整篇（幂等测试里表现为「第 2 轮又改了 N 块」）。
       */
      const outNorm = canonicalContent(out);
      // 两个触发条件：
      //   1) 内容真的变了（规范化后比，避免零宽 / updated 导致无谓重写）
      //   2) 块属性已经脏了 —— 剥离后新旧会一模一样，光比内容永远判不出来，
      //      必须强制写一次把残留的 `{: id="…"}` 从正文里清掉
      if (outNorm !== canonicalContent(kdRaw) || attrsAreDirty(kdRaw)) {
        todo.push({ id: b.id, oldKd: kdRaw, next: outNorm });
      }
    }
    if (todo.length) {
      await this.snapBlocks(rootId, todo.map(t => ({ id: t.id, kd: t.oldKd })), "重排/切换样式", undoStyle);
      for (const t of todo) {
        /*
         * 容错：块可能在这轮里被别的东西改掉（编辑器重建块 id、另一窗口在编辑…）。
         * 写不进去就跳过，不要整批失败 —— 少写一块比整篇报错好。
         */
        const w = await fetchSyncPost("/api/block/updateBlock", {
          id: t.id,
          dataType: "markdown",
          data: t.next,
        });
        if (w && w.code === 0) {
          updated++;
        } else {
          skipped++;
        }
      }
    }

    // 4. 重建文末参考文献表（顺序与编号全部交给样式自己决定）
    //    1.3.0 多文档：只在输出文档留一份，其余子文档原有的旧表清掉（用户 2026-11-08 拍板）
    if (scope && scope.mode === "multi") {
      for (const oneId of docIds) {
        if (oneId !== bibDocId) { await this.clearBibliography(oneId); }
      }
    }
    await this.rebuildBibliography(bibDocId, scan.keys, rendered, rootId,
      !!(scope && scope.mode === "multi"));

    /*
     * 5. 落文档属性：引用 key 清单 + 样式 + 快照。
     * 快照只放「这次真在 Zotero 里取到的条目」；本次取不到的继续沿用旧快照里的那份，
     * 否则一次缺条重排就会把它自己的存档抹成空的 —— 那才是真正丢数据。
     */
    const snapItems = {};
    if (prevSnap && prevSnap.items) {
      missingKeys.forEach((k) => {
        if (prevSnap.items[k]) {
          snapItems[k] = prevSnap.items[k];
        }
      });
    }
    Object.keys(rendered.snapCsl || {}).forEach((k) => {
      const bib = (rendered.bibByKey && rendered.bibByKey[k]) || "";
      if (!bib) {
        return;
      }
      snapItems[k] = { csl: rendered.snapCsl[k], bib: bib };
    });
    const snapClusters = {};
    const missSetForWrite = new Set(missingKeys);
    Object.keys(rendered.cites || {}).forEach((ck) => {
      const rec = rendered.cites[ck];
      if (!rec || !rec.c) {
        return;
      }
      /*
       * ⚠️ 绝不能拿「含缺失条目的残缺文本」覆盖旧快照。
       *    这一处只要还有条目在 Zotero 里取不到，CSL 渲染出的就只是剩下的那条，
       *    拿它写回快照 = 亲手把完整存档降级成残缺版，下次再也补不回来。
       *    （第一版就栽在这里：兜底逻辑明明对，但存档被上一轮写坏了，看着像没生效。）
       */
      const hasMissing = ck.split("|").some((k) => missSetForWrite.has(k));
      const prev = prevSnap && prevSnap.clusters && prevSnap.clusters[ck];
      if (hasMissing && prev && prev.c && prev.c !== rec.c) {
        snapClusters[ck] = prev;
        return;
      }
      snapClusters[ck] = { c: rec.c, np: rec.np || [] };
    });
    const snap = {
      v: SNAP_VER,
      at: new Date().toISOString(),
      style: this.settings.styleId,
      items: snapItems,
      clusters: snapClusters,
      /*
       * 文献表顺序：换 Zotero profile 后会有条目查不到，那时只能靠「上一次的真实顺序」
       * 把它们插回原位，否则文献表会变成「实时的在前、缺的在后」。
       * 只存顺序、不存编号，重排时编号仍由样式与设置重新决定。
       */
      bibOrder: Array.isArray(this._lastBibOrder) ? this._lastBibOrder : [],
    };
    try {
      const fmtCount = {};
      scan.hits.forEach(h => { fmtCount[h.fmt] = (fmtCount[h.fmt] || 0) + 1; });
      await fetchSyncPost("/api/attr/setBlockAttrs", {
        id: rootId,
        attrs: {
          "custom-zotero-cites": scan.keys.join(","),
          "custom-zotero-style": this.settings.styleId,
          "custom-zotero-formats": JSON.stringify(fmtCount),
          [SNAP_ATTR]: snapPack(snap),
        },
      });
    } catch (e) { /* 属性写失败不影响主流程 */ }

    const styleName = (rendered.style && rendered.style.title) || this.settings.styleId.split("/").pop();
    this._lastStyleId = this.settings.styleId;
    this._styleBeforeChange = null;
    /*
     * 有文献取不到时，无论是不是手动触发都要说一声 —— 这是用户唯一能察觉的时机。
     * 说明「用的哪份数据」：快照里存的是上次成功重排时的原文，不是 Zotero 现况。
     */
    let warn = "";
    if (missingKeys.length) {
      const listed = missingKeys.slice(0, 3).join("、") + (missingKeys.length > 3 ? "…" : "");
      const saved = snapBib || snapCite;
      warn = `；Zotero 里找不到 ${missingKeys.length} 条文献（${listed}）` +
        (saved ? "，已用文档里保存的引用快照补全原文" : "，文档里还没有它们的快照，这几处保持原样");
    }
    if (verbose || missingKeys.length) {
      const tail = skipped ? `，${skipped} 块因内容刚被改动跳过（再执行一次即可）` : "";
      showMessage(`已重排 ${updated} 处引用、${scan.keys.length} 条参考文献（${styleName}）${tail}${warn}`,
        missingKeys.length ? 9000 : (skipped ? 7000 : 4000));
    }
    /*
     * 把这篇文档引用到的文献同步进 Zotero 的「【【Connected Documents】】→ 文档名」集合。
     * 放在最后、失败不影响主流程：Zotero 没开只是这次没同步，重排本身已经做完了。
     */
    this.scheduleDocCollection(rootId, scan.keys);

    return { updated, keys: scan.keys.length, missing: missingKeys.length };
  }

  /**
   * 定位文末文献表。返回 { headingIndex, entries, marked }：
   *   headingIndex  标题块在子块数组里的下标，-1 表示这一段没有标题
   *   entries       旧的文献条目块
   *   marked        true = 靠块属性认出来的（新版）；false = 靠标题文字兜底（老文档）
   *
   * ⚠️ 为什么不能只看标题：标题现在可配、还能不生成，一旦标题改了或删了，
   *    再靠文字找就会找不到旧表，于是每次重排都往文末再追加一份。
   *    新版条目一律打 BIB_ATTR 标记，定位与文字无关；老文档退回标题匹配，仍然能接管。
   */
  async locateBib(docId, headingText) {
    const children = ((await fetchSyncPost("/api/block/getChildBlocks", { id: docId })) || {}).data || [];
    if (!children.length) {
      return { headingIndex: -1, entries: [], marked: false, children };
    }

    // 1) 先按块属性找（一次批量查询，比逐块读 kramdown 快一个量级）
    const marked = new Set();
    try {
      const ids = children.map((c) => c.id);
      const r = await fetchSyncPost("/api/attr/batchGetBlockAttrs", { ids });
      const map = (r && r.data) || {};
      ids.forEach((id) => {
        if (map[id] && "1" === String(map[id][BIB_ATTR])) {
          marked.add(id);
        }
      });
    } catch (e) { /* 读不到属性就走兜底 */ }

    if (marked.size) {
      const firstIdx = children.findIndex((c) => marked.has(c.id));
      // 标记块紧挨着的那一块，如果是标题，算作这段的标题
      let hIdx = -1;
      if (firstIdx > 0 && children[firstIdx - 1] && "h" === children[firstIdx - 1].type) {
        hIdx = firstIdx - 1;
      }
      return { headingIndex: hIdx, entries: children.filter((c) => marked.has(c.id)), marked: true, children };
    }

    // 2) 兜底：老文档没有标记，按标题文字认
    const heads = [headingText].concat(LEGACY_BIB_HEADINGS).filter(Boolean);
    let hAt = -1;
    children.forEach((c, i) => {
      // 取最后一个命中：正文里偶尔也会出现同名小标题，文末那个才是文献表
      if (c && "h" === c.type && heads.some((h) => String(c.content || "").indexOf(h) >= 0)) {
        hAt = i;
      }
    });
    if (hAt >= 0) {
      /*
       * 兜底只在老文档（1.2.29 及以前，条目还没打标记）走一次。
       * 收集到「下一个标题块」为止：文献表后面常跟着「致谢」「附录」这类带标题
       * 的段落，它们绝不能被当成条目删掉。无标题的普通段落这一路仍可能误判，
       * 但接管过一次之后条目就有标记，不会再走到这里。
       */
      const tail = [];
      for (let i = hAt + 1; i < children.length; i++) {
        if (children[i] && "h" === children[i].type) {
          break;
        }
        tail.push(children[i]);
      }
      return { headingIndex: hAt, entries: tail, marked: false, children };
    }
    return { headingIndex: -1, entries: [], marked: false, children };
  }

  /**
   * 给刚写入的条目块打上 BIB_ATTR 标记。
   *
   * anchor 决定「哪几块是刚写的」：
   *   · 原位插入时条目不在文档末尾，不能再取末 count 个（那会把用户写在表后的
   *     附录、致谢标成文献条目，下次重排就被当旧表删掉）；
   *   · 有 beforeId → 取它后面 count 个；只有 afterId → 取它前面 count 个；
   *     都没有（追加到末尾）→ 取末 count 个。
   */
  async markBibEntries(docId, count, anchor) {
    if (!(count > 0)) {
      return;
    }
    try {
      const kids = ((await fetchSyncPost("/api/block/getChildBlocks", { id: docId })) || {}).data || [];
      let picked;
      const beforeId = anchor && anchor.beforeId;
      const afterId = anchor && anchor.afterId;
      if (beforeId) {
        const p = kids.findIndex((c) => c.id === beforeId);
        picked = p >= 0 ? kids.slice(p + 1, p + 1 + count) : [];
      } else if (afterId) {
        const p = kids.findIndex((c) => c.id === afterId);
        picked = p >= count ? kids.slice(p - count, p) : [];
      } else {
        picked = kids.slice(-count);
      }
      const tail = picked.filter((c) => c && "h" !== c.type);
      if (!tail.length) {
        return;
      }
      await apiQuiet("/api/attr/batchSetBlockAttrs", {
        blockAttrs: tail.map((c) => ({ id: c.id, attrs: { [BIB_ATTR]: "1" } })),
      });
    } catch (e) { /* 标记失败只影响下次定位精度，不影响这次结果 */ }
  }

  /** 文末参考文献表：先清掉旧表，再追加。顺序与编号完全用样式给出的结果 */
  async rebuildBibliography(docId, keys, rendered, snapDocId, suppressHeading) {
    let heading = resolveBibHeading(this.settings, rendered);
    /*
     * 1.3.0：多文档模式自动生成的输出文档，文档标题本身已经是 Reference / 参考文献，
     * 再插一层「参考文献」小标题就是重复（用户 2026-11-08 23:43 截图实证）。
     * 只在多文档模式生效 —— 单文档模式行为一字不改（34/34 回归是判据）。
     */
    if (suppressHeading && heading) {
      try {
        const r = await apiQuiet("/api/filetree/getHPathByID", { id: docId });
        const name = String((r && r.data) || "").split("/").pop().trim();
        if (name === REF_DOC_TITLE || LEGACY_BIB_HEADINGS.indexOf(name) >= 0) {
          heading = "";
        }
      } catch (e) { /* 读不到就照旧 */ }
    }
    /*
     * ⚠️ 不能用 SQL 的 sort 比较判断前后：思源 3.8.8 里多个块共享相同 sort 值
     * （h 与 p 都可能是 5 / 10 / 20），按 sort 过滤会误删正文。改用 getChildBlocks 的顺序。
     * ⚠️ 定位不再靠标题文字：标题可配、还能不生成。见 locateBib。
     */
    const { headingIndex, entries: oldEntries, children } = await this.locateBib(docId, heading);
    const idx = headingIndex;
    /*
     * ⚠️ 以前这里是「全删重建」：把标题之后的块逐个 deleteBlock，再一坨 appendBlock。
     *    实测 300 条文献时这一步要 14.7 秒（300 次删除调用），而且内容没变也照删照建。
     *    现在改成增量：内容一致就一个字都不写；有差异才 update / 删多余 / 补缺失。
     */

    // 组装条目：顺序直接用样式给出的 bibOrder（作者年=字母序，数字式=引用序）
    const entries = [];
    const set = new Set(keys);
    let list = (rendered.bibOrder || []).filter(k => set.has(k));
    keys.forEach(k => { if (!list.includes(k)) list.push(k); });

    /*
     * 编号归属：本来由 CSL 样式自己决定（数字式出 [1] / 1.，作者年式没有编号）。
     * 设置项只有三种意图：
     *   ""     → 跟随 CSL（保留样式给出的前缀）
     *   "none" → 关掉编号（剥掉前缀）
     *   其它   → 用用户的模板覆盖（先剥掉 CSL 前缀，再按顺序自己编号）
     */
    const rawNum = String(this.settings.bibNumber || "");
    const numMode = rawNum.trim();
    const cslNumRe = /^\s*(?:\[\s*\d+\s*\]|［\s*\d+\s*］|\(\s*\d+\s*\)|（\s*\d+\s*）|\d{1,4}\s*[.、．)）])\s*/;
    const keepCsl = numMode === "" || numMode === "csl";
    let seq = 0;

    /*
     * 有条目在当前库里查不到（换了 Zotero profile / 条目被删 / 这台机还没同步到）时，
     * 先读一次文档快照，用快照里存着的条目原文顶上。
     *
     * ⚠️ 不能只写占位符：快照里明明存着全文，却把它降级成「（文献已不在 Zotero 库中：key）」，
     *    用户看到的是文献表少了一条 —— 更糟的是那一条既没有正文、又带着旧样式留下的编号，
     *    与其余条目并排就是「部分编号、部分不编号」的混排。
     *    （2026-11-04 用户实测：JU9W4XI5 那条只剩一个 `(1)` 前缀 + 数字式样式的旧正文。）
     * 只在真缺条目时才读属性，正常重排一次属性都不多读。
     */
    let snapBib = null;
    let snapRec = null;
    if (list.some((k) => !String((rendered.bibByKey && rendered.bibByKey[k]) || "").trim())) {
      snapRec = await readSnapshot(snapDocId || docId);
      const items = (snapRec && snapRec.items) || {};
      snapBib = (k) => String((items[k] && items[k].bib) || "");
    }

    // ── 第一遍：每条先拿到「正文」，实时渲染缺的走快照兜底 ──
    const snapKeySet = new Set((rendered && rendered.snapKeys) || []);
    let rows = list.map((k) => {
      const html = String((rendered.bibByKey && rendered.bibByKey[k]) || "").trim()
        || (snapBib ? snapBib(k) : "");
      // live 只能代表「这条来自 Zotero 实时渲染」，存档补进来的不算
      return { k: k, text: cslHtmlToMarkdown(html), live: !!html && !snapKeySet.has(k) };
    });

    /*
     * 顺序复原（换 Zotero profile / 数据目录，或条目被删时）。
     *
     * 缺条的 key 在上一步被一律追加到 `list` 末尾，于是文献表变成「实时渲染的在前、
     * 缺条的挤在后」，作者年式样式本该按作者字母序 —— 一眼就是乱的。
     * 2026-11-04 实测：7 条里 6 条在当前库查不到，唯一的实时条目（许育新）被顶到第一位，
     * 整张表从 Case→…→许育新 变成 许育新、Ge、Dela Cruz、Ye、Case、Oh、Harris。
     *
     * 两条路，按样式类型分：
     *   · 数字式（条目带 [1] / 1. 前缀）：顺序 = 正文引用顺序，算不出来，只能靠快照
     *     记下的上一次真实顺序；连快照都没有就退回 keys 的原顺序。
     *   · 作者年式：顺序 = 作者字母序，有唯一正确答案，直接按条目正文排。
     *     这也是「自愈」——历史上被排坏过一次的表，重排就能修回来。
     *     ⚠️ 不能只信快照 bibOrder：它记的是「上次写进文档的顺序」，文档本身是坏的，
     *        记下来就是坏的，越记越锁死（第一版就栽在这）。
     *   ⚠️ 排序不能用 localeCompare(…, "zh")：那会按拼音把「许育新」排到 Ye 之前，
     *      而 CSL 里中文条目一律在拉丁字母之后，用码位比较才是对的。
     */
    if (rows.some((r) => !r.live)) {
      const liveRows = rows.filter((r) => r.live);
      const numbered = (liveRows.length ? liveRows : rows).some((r) => splitBibHead(r.text));
      if (numbered) {
        const saved = snapRec && Array.isArray(snapRec.bibOrder)
          ? snapRec.bibOrder.filter((k) => set.has(k))
          : null;
        const sameStyle = !snapRec || !snapRec.style || snapRec.style === this.settings.styleId;
        const byKey = new Map(rows.map((r) => [r.k, r]));
        if (saved && saved.length === rows.length && sameStyle) {
          rows = saved.map((k) => byKey.get(k)).filter(Boolean);
        } else {
          /*
           * 换了样式（作者年式 → 数字式）或没有历史顺序：编号顺序 = 正文引用顺序，
           * 退回扫描到的 key 原顺序 —— 这是唯一还能拿到的「引用先后」信息。
           * 直接把实时渲染的那条放最前是错的（实测：许育新从第 4 条被顶成 [1]）。
           */
          rows = keys.filter((k) => byKey.has(k)).map((k) => byKey.get(k));
        }
      } else {
        const sk = (r) => {
          const h = splitBibHead(r.text);
          return String((h ? h.body : r.text) || "")
            .replace(/^[\s"'“”‘’([［]+/, "")
            .toLowerCase();
        };
        rows = rows.slice().sort((a, b) => {
          const x = sk(a);
          const y = sk(b);
          return x < y ? -1 : x > y ? 1 : 0;
        });
      }
    }
    // 记下这一版真正写进文档的顺序，下一次换库时就靠它复原
    this._lastBibOrder = rows.map((r) => r.k);

    /*
     * 编号形态归一（跟随 CSL 模式）。
     * 症状：同一张文献表里「有的条目带 1. / [1] / (1)，有的什么都不带」。
     * 成因：跌回快照的那条自带别的样式（多半是顺序编码制）留下的编号，而当前样式
     *       是作者年式、本来根本没有编号 —— 两者并排就是混排。
     * 规则：有前缀的条数既不是 0 也不是全部 → 判定混排，整表统一。
     *   怎么统一，以「实时渲染的那几条」为准，不听快照的：
     *     · 实时条目全无前缀 → 作者年式 → 把混进来的一律剥掉；
     *     · 实时条目都带前缀 → 数字式   → 把缺的补齐成连号。
     * 正常情况（全无前缀 / 全有前缀）一个字都不改。
     */
    if (keepCsl) {
      const headOf = (r) => (r.text.trim() ? splitBibHead(r.text) : null);
      const heads = rows.map(headOf);
      const alive = rows.filter((r) => r.text.trim());
      const nums = heads.filter(Boolean);
      if (nums.length && nums.length < alive.length) {
        const live = rows.filter((r) => r.text.trim() && r.live);
        const liveNums = live.filter((r) => headOf(r)).length;
        const shouldNumber = live.length
          ? liveNums * 2 > live.length
          : nums.length * 2 > alive.length;
        if (shouldNumber) {
          const liveHead = live.length ? (live.map(headOf).find(Boolean) || null) : null;
          // 模板：`1.` → `{n}.`，`[1]` → `[{n}]`，`(1)` → `({n})`
          const tpl = String((liveHead || nums[0]).label).replace(/\d+/, "{n}");
          let n = 0;
          rows.forEach((r, i) => {
            if (!r.text.trim()) {
              return;
            }
            n++;
            const h = heads[i];
            r.text = tpl.replace("{n}", String(n)) + " " + (h ? h.body : r.text.trim());
          });
        } else {
          rows.forEach((r, i) => {
            if (heads[i]) {
              r.text = heads[i].body;
            }
          });
        }
      }
    }

    // ── 第二遍：按设置定编号，再转义、挂跳转链接 ──
    rows.forEach((r) => {
      let text = r.text;
      if (!text.trim()) {
        /*
         * 实时渲染和快照都取不到：绝不要只写一条「↗」—— 用户看到的是一个没有内容的
         * 空行，还以为文档坏了。明写一句占位，至少知道是哪条、怎么处理。
         */
        entries.push("（文献已不在 Zotero 库中：" + r.k + "）");
        return;
      }
      if (keepCsl) {
        /*
         * ⚠️ 保留 CSL 编号时必须防一件事：`1. ` 开头的段落会被 markdown 解析成
         *    有序列表，条目立刻变成带序号的列表项（实测：块类型从 p 变 l）。
         *    在点号前加反斜杠即可 —— 思源渲染时反斜杠不显示，正文仍是 "1. "。
         */
        text = text.replace(/^(\d{1,4})\.(\s)/, "$1\\.$2");
      } else {
        text = text.replace(cslNumRe, "");
        if (numMode !== "none") {
          seq++;
          // ⚠️ 用 rawNum，不能用 trim 过的：模板里的尾随空格（"{n}. "）是排版的一部分
          const tpl = rawNum.indexOf("{n}") >= 0 ? rawNum.replace(/\{n\}/g, String(seq)) : rawNum + seq;
          // 自定义模板给了 "1. " 这种前缀，同样要防被解析成有序列表
          text = tpl.replace(/^(\d{1,4})\.(\s)/, "$1\\.$2") + text;
        }
      }
      text = escapeLooseBrackets(text);
      // 文末条目的跳转链接带 ?bib=1，与正文引用区分（正文正则不含 ?，天然隔离）
      const jump = this.settings.linkEnabled
        ? " [↗](zotero://select/library/items/" + r.k + "?bib=1)"
        : "";
      // ⚠️ 用纯段落，不用 "- " 列表：列表会渲染出项目符号（看起来像编号），
      //    且条目以 "[1]" 开头时思源会误认成任务列表。
      entries.push(text + jump);
    });

    const finalEntries = entries.length ? entries : ["（暂无引用）"];
    // 标题要不要写：heading 为空串 = 不生成（中英文论文的标题写法不同，交给用户自己写）
    const headBlocks = heading ? [`## ${heading}`, ""] : [];
    /*
     * 内容指纹：只比条目文本，不逐块读。
     *   · 逐块 getBlockKramdown 读 300 条 → 5 秒；
     *   · 一次 SQL `id IN (...)` 读 → 0 行（刚写入的块还没进索引）；
     *   · 指纹存在文档属性里，读一次属性就能判断"要不要动"，常态 0 写入。
     */
    const hashOf = (arr) => {
      const s = arr.join("\u0001");
      let h = 5381;
      for (let i = 0; i < s.length; i++) {
        h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
      }
      return h.toString(36) + "-" + s.length;
    };
    const myHash = hashOf(finalEntries);

    /*
     * 没有文末：整段追加（标题 + 条目）。
     * ⚠️ 判断「有没有文末」不能只看 idx：标题关掉（或用户手动删掉了标题）时
     *    idx 是 -1，但标记过的条目还在，这时再走追加就会多出一份。
     * ⚠️ 首次追加后必须把「这次用的标题」记进文档属性，否则下一次重排会以为
     *    上一次是「不生成」，又给补一个标题上去。
     */
    if (idx < 0 && !oldEntries.length) {
      await fetchSyncPost("/api/block/appendBlock", {
        parentID: docId,
        dataType: "markdown",
        data: headBlocks.concat(finalEntries).join("\n\n"),
      });
      await this.markBibEntries(docId, finalEntries.length);
      try {
        await fetchSyncPost("/api/attr/setBlockAttrs", {
          id: docId,
          attrs: { "custom-zotero-bibhash": myHash, "custom-zotero-bibheading": heading },
        });
      } catch (e) { /* 属性写失败只影响下次比对精度 */ }
      return;
    }

    /* 读一次文档属性：上次的标题设置 + 文献表内容指纹，都在这里 */
    let docAttrs = {};
    try {
      const a = await fetchSyncPost("/api/attr/getBlockAttrs", { id: docId });
      docAttrs = (a && a.data) || {};
    } catch (e) { /* 读不到就当作都没有 */ }
    const prevHeading = String(docAttrs["custom-zotero-bibheading"] || "");

    /*
     * 标题跟着设置走：
     *   · 有设置值、现有标题文字不同 → 改文字；
     *   · 有设置值、但现在根本没有标题块（上次设的是「不生成」）→ 补一个，
     *     位置在第一个条目前面。只在上次设置不同的时候补 —— 否则就是用户自己
     *     把标题删掉了，不该每次都加回去；
     *   · 设置成「不生成」、现有标题正是插件以前写的那几个标准标题 → 删掉，
     *     否则用户把标题关掉了，文档里还挂着「参考文献」。
     *     非标准标题（用户自己写的）一律不动。
     */
    if (heading) {
      if (idx >= 0 && children[idx]) {
        const curHead = String(children[idx].content || "").trim();
        if (curHead !== heading) {
          // 尽力而为：改标题失败不该弹红条打扰用户，交给下次重排
          await apiQuiet("/api/block/updateBlock", {
            id: children[idx].id,
            dataType: "markdown",
            data: `## ${heading}`,
          });
        }
      } else if (prevHeading !== heading && oldEntries.length) {
        await apiQuiet("/api/block/insertBlock", {
          dataType: "markdown",
          data: `## ${heading}`,
          parentID: docId,
          nextID: oldEntries[0].id,
        });
      }
    } else if (idx >= 0 && children[idx] &&
               LEGACY_BIB_HEADINGS.indexOf(String(children[idx].content || "").trim()) >= 0) {
      await apiQuiet("/api/block/deleteBlock", { id: children[idx].id });
    }

    /* 指纹相同 = 内容没变，条目一个字都不写（幂等刷新到此为止） */
    const prevHash = String(docAttrs["custom-zotero-bibhash"] || "");
    if ((idx >= 0 || oldEntries.length) && prevHash === myHash && oldEntries.length === finalEntries.length) {
      /*
       * 但「这次用的标题」一定要记下来：标题刚被改过（比如从「参考文献」改成自定义），
       * 条目内容却一个字没变，如果这里直接返回，属性里还是旧标题，
       * 下次重排又会认为「上次和这次不一样」，于是再插一个标题。
       */
      if (prevHeading !== heading) {
        try {
          await fetchSyncPost("/api/attr/setBlockAttrs", {
            id: docId,
            attrs: { "custom-zotero-bibheading": heading },
          });
        } catch (e) { /* 属性写失败只影响下次比对精度 */ }
      }
      return;
    }

    /*
     * 插入锚点：新条目要放回「旧条目原来待的位置」，而不是一律追加到文档末尾。
     * ⚠️ 从前是一律 appendBlock。用户在文献表后面写了附录/致谢之后，删掉旧条目时
     *    标题块还留在原处，新条目被追加到最后 —— 附录就被夹进「参考文献」标题与
     *    条目之间，读起来像是文献条目的一部分（2026-11-04 复现）。
     *    用「旧条目前一块 / 后一块」两个邻居当锚点，删完立刻原位插回去。
     */
    let beforeId = "";
    let afterId = "";
    try {
      const kids = ((await fetchSyncPost("/api/block/getChildBlocks", { id: docId })) || {}).data || [];
      const firstIdx = oldEntries.length
        ? kids.findIndex((c) => c.id === oldEntries[0].id) : -1;
      const lastIdx = oldEntries.length
        ? kids.findIndex((c) => c.id === oldEntries[oldEntries.length - 1].id) : -1;
      if (firstIdx > 0) {
        beforeId = kids[firstIdx - 1].id;
      }
      if (lastIdx >= 0 && kids[lastIdx + 1]) {
        afterId = kids[lastIdx + 1].id;
      }
      // 有条目但一块都找不到（key 变了之类）：至少把新条目放到标题后面
      if (firstIdx < 0 && idx >= 0 && children[idx]) {
        beforeId = children[idx].id;
      }
    } catch (e) { /* 算不出锚点就退回追加到末尾 */ }

    /*
     * 真的变了：删旧的 + 一次批量插入。
     * ⚠️ 删除必须走事务：逐块 deleteBlock 300 次实测 14.7 秒（并发也没用，内核内部仍然串行）。
     *    改用 /api/transactions 一次提交 100 个 delete，实测 10 块 49ms。
     *    事务不可用（版本差异/被禁用）时自动退回逐块删，功能不受影响。
     */
    if (oldEntries.length) {
      const batch = 100;
      const applied = new Set();
      for (let i = 0; i < oldEntries.length; i += batch) {
        const ops = oldEntries.slice(i, i + batch).map((c) => ({ action: "delete", id: c.id }));
        let okTx = false;
        try {
          const r = await fetchSyncPost("/api/transactions", {
            transactions: [{ doOperations: ops }],
            reqId: Date.now() + i,
          });
          if (r && r.code === 0) {
            okTx = true;
            // 事务会回传「真正落实了哪些操作」，据此判断还有哪些块没删掉
            const tx = (r.data && r.data[0]) || {};
            ((tx.doOperations) || []).forEach((op) => {
              if (op && op.action === "delete" && op.id) {
                applied.add(op.id);
              }
            });
          }
        } catch (e) {
          okTx = false;
        }
        if (!okTx) {
          for (const op of ops) {
            const d = await apiQuiet("/api/block/deleteBlock", { id: op.id });
            if (d && d.code === 0) {
              applied.add(op.id);
            }
          }
        }
      }
      /*
       * 补删：只补「请求了、但事务明确没落实」的那些块（文档不允许整块清空时，
       * 事务会跳过最后一个 delete，这一块就会留在文末）。
       *
       * ⚠️ 两个必须：
       *  1) 绝不能无条件对 oldEntries 再删一遍 —— 已经删掉的块再删一次，
       *     内核返回 tree not found，fetchSyncPost 会把它弹成一条红条，
       *     用户重排一次就看见「tree not found v3.8.9」（2026-11-04 实锤）。
       *  2) 也绝不能重新 locateBib 定位后再删：oldEntries 删光后标记没了，
       *     定位会退回标题文字兜底，把「标题之后的所有块」都当文献条目，
       *     用户写在文献表后面的致谢、附录、刚插的引用会被一并删掉
       *     （2026-11-04 实测复现，整段内容丢失且无任何提示）。
       */
      const left = oldEntries.filter((c) => !applied.has(c.id));
      for (const c of left) {
        await apiQuiet("/api/block/deleteBlock", { id: c.id });
      }
    }
    const bibMd = finalEntries.join("\n\n");
    if (beforeId || afterId) {
      const payload = { dataType: "markdown", data: bibMd };
      if (beforeId) {
        payload.previousID = beforeId;
      }
      if (afterId) {
        payload.nextID = afterId;
      }
      await fetchSyncPost("/api/block/insertBlock", payload);
    } else {
      await fetchSyncPost("/api/block/appendBlock", {
        parentID: docId,
        dataType: "markdown",
        data: bibMd,
      });
    }
    await this.markBibEntries(docId, finalEntries.length, { beforeId, afterId });
    try {
      await fetchSyncPost("/api/attr/setBlockAttrs", {
        id: docId,
        attrs: { "custom-zotero-bibhash": myHash, "custom-zotero-bibheading": heading },
      });
    } catch (e) { /* 属性写失败只影响下次比对精度 */ }
  }

  async querySql(stmt) {
    const r = await fetchSyncPost("/api/query/sql", { stmt });
    return (r && r.data) || [];
  }

  /* ---------------- 设置面板 ---------------- */

  saveFromSetting() {
    const root = this._settingEl;
    if (!root) {
      return;
    }
    const patch = {};
    root.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.getAttribute("data-k");
      // 编号模板的尾随空格有排版意义（"{n}. " 里的空格），不能 trim；其余照旧去空白
      patch[k] = el.type === "checkbox" ? el.checked : (k === "bibNumber" ? el.value : el.value.trim());
    });
    this.updateSettings(patch);
  }

  /**
   * 设置面板里那条「样式在本机装没装」的提示。
   *
   * ⚠️ 为什么要专门查一次：自定义 CSL 样式是**本机文件**，不随 Zotero 账号同步。
   *    换电脑后样式 id 还在设置里，但那台机没这个样式 → 以前会静默换成可见列表
   *    第一个样式把全篇重排掉。现在重排会直接报错，这里提前一句话告诉用户。
   *    查不到（Zotero 没开 / 没令牌）时只提示「无法确认」，不误报成缺样式。
   */
  async updateStyleStat() {
    const root = this._settingEl;
    if (!root) {
      return;
    }
    const el = root.querySelector("[data-style-stat]");
    if (!el) {
      return;
    }
    const input = root.querySelector('[data-k="styleId"]');
    const fixRow = root.querySelector("[data-style-fix]");
    const sid = String((input && input.value) || "").trim();
    const paint = (cls, text, showFix) => {
      el.className = "zc-stylestat " + cls;
      el.textContent = text;
      // 只有「确实没有」或「没填」才给一键修复按钮；
      // 「Zotero 未连接」是不知道，不能给按钮（按了也没法确认）。
      if (fixRow) {
        fixRow.classList.toggle("fn__none", !showFix);
      }
    };
    if (!sid) {
      paint("is-bad", "还没填样式，重排与插入都会被拒绝", true);
      return;
    }
    paint("is-wait", "检查本机是否装了该样式…", false);
    let r = null;
    try {
      r = await zoteroExec(this.settings,
        `const s = Zotero.Styles.get(${JSON.stringify(sid)});
return JSON.stringify({ok: !!s, title: s ? s.title : null});`);
    } catch (e) {
      // Zotero 没启动 / 令牌不对：属于「不知道」，不是「没有」
      paint("is-unk", "无法确认（Zotero 未连接）：" + String(e.message || e).slice(0, 90), false);
      return;
    }
    if (r && r.ok) {
      paint("is-ok", "✓ 本机 Zotero 已装：" + (r.title || sid), false);
    } else {
      paint("is-bad", "✗ 本机 Zotero 没有这个样式，重排与插入会被拒绝。" +
        "换电脑后要把 .csl 装到本机，或点下面按钮改用 Zotero 自带样式。", true);
    }
  }

  settingRender() {
    const html = `
      <div class="zc-setting">
        <div class="zc-dep">
          <div class="zc-dep__head">
            <span class="zc-dep__badge">依赖</span>
            <span class="zc-dep__name">${DEP_NAME}</span>
            <span class="zc-dep__must">必须先装</span>
          </div>
          <div class="zc-dep__text">
            本插件不直接读 Zotero 数据库，而是通过这个 Zotero 扩展暴露的本地接口读写条目。
            没装它，插件只能报「连不上」——端口 23119 上根本没有
            <code>/zbridge/execute</code> 端点。
            ZBridge 是 Zotero Debug Bridge 的替代品，同时提供
            <code>/zbridge/execute</code> 与原版兼容端点
            <code>/debug-bridge/execute</code>，装了它就不必再装 Debug Bridge。
          </div>
          <ol class="zc-dep__steps">
            <li>下载最新 <code>zbridge-x.y.z.xpi</code>：
              <code>${DEP_URL}</code></li>
            <li>Zotero → 工具 → 插件 → 右上角齿轮 → Install Add-on From File…，
              选中 xpi，装完重启 Zotero</li>
            <li>Zotero → 工具 → 开发者 → Run JavaScript，执行
              <code>Zotero.Prefs.set("${DEP_TOKEN_PREF}","你的令牌",true);</code></li>
            <li>把同一个令牌填到下面的「访问令牌」，点「测试连接」确认</li>
            <li>若以前装过 Zotero Debug Bridge，可在插件列表里卸载它 ——
              ZBridge 已覆盖它的全部接口，两个同时装也能用</li>
          </ol>
          <div class="zc-dep__row">
            <button class="b3-button b3-button--text b3-button--small zc-depdoc">打开完整安装说明</button>
            <code class="zc-dep__url">${DEP_URL}</code>
          </div>
        </div>
        <div class="zc-set">
          <div class="zc-field">
            <div class="zc-field__label">Bridge 地址</div>
            <input class="b3-text-field" data-k="bridgeUrl" value="">
          </div>
          <div class="zc-field">
            <div class="zc-field__label">访问令牌</div>
            <input class="b3-text-field" data-k="token" value="" placeholder="Bearer token">
          </div>
          <div class="zc-field">
            <div class="zc-field__label">默认引用形态（只影响新插入的引用；已有引用右键单独改）</div>
            <select class="b3-select" data-k="defaultFormat">
              ${FMT_ORDER.map(k => `<option value="${k}">${FMT_LABEL[k]}</option>`).join("")}
            </select>
          </div>
          <div class="zc-field">
            <div class="zc-field__label">CSL 样式（正文引用与文末列表的格式都由它决定）</div>
            <input class="b3-text-field" data-k="styleId" value="" placeholder="http://www.zotero.org/styles/apa">
            <div class="zc-stylestat" data-style-stat></div>
            <div class="zc-fixrow fn__none" data-style-fix>
              <button class="b3-button b3-button--outline zc-useapa">改用 Zotero 自带样式（APA）</button>
            </div>
          </div>
          <div class="zc-field">
            <button class="b3-button b3-button--outline zc-openstyle">从 Zotero 已装样式里选一个…</button>
          </div>
          <div class="zc-field">
            <div class="zc-field__label">文末标题（中文论文写「参考文献」、英文论文写 References，各家要求不同）</div>
            <div class="zc-numrow">
              <select class="b3-select zc-head-preset">
                <option value="auto">自动（按样式语言）</option>
                <option value="">不生成标题</option>
                <option value="参考文献">参考文献</option>
                <option value="References">References</option>
              </select>
              <input class="b3-text-field fn__flex-1" data-k="bibHeading" value="" placeholder="auto">
            </div>
            <div class="zc-field__hint">「自动」＝ CSL 样式是中文样式（GB/T 7714、CSTR 等）就写「参考文献」，其它样式写 References。选「不生成标题」则只输出文献条目，标题你自己在文档里写（也可以填任意文字）。改完点「保存」，再执行一次「重排全文」生效。</div>
          </div>
          <div class="zc-field">
            <div class="zc-field__label">文末编号样式（编号本来就由 CSL 样式决定，这里只是「跟随 / 关掉 / 覆盖」）</div>
            <div class="zc-numrow">
              <select class="b3-select zc-num-preset">
                <option value="">跟随 CSL 样式（推荐）</option>
                <option value="none">不显示编号</option>
                <option value="{n}. ">1.</option>
                <option value="[{n}] ">[1]</option>
                <option value="({n}) ">(1)</option>
                <option value="（{n}）">（1）</option>
                <option value="{n}、">{n}、</option>
              </select>
              <input class="b3-text-field fn__flex-1" data-k="bibNumber" value="" placeholder="跟随 CSL">
            </div>
            <div class="zc-field__hint">留空 = 用 CSL 样式自带的编号（IEEE 出 [1]、Nature 出 1.、作者年式本来就没有）。想换成别的写法，选预设或自己写 <code>{n}</code> 占位模板（如 <code>【{n}】</code>、<code>Ref {n}: </code>）。改完点「保存」，再执行一次「重排全文」生效。</div>
          </div>
          <div class="zc-field zc-field--inline">
            <label class="zc-field__label">引用带链接（可点击跳回 Zotero）</label>
            <input type="checkbox" data-k="linkEnabled">
          </div>
          <div class="zc-field zc-field--inline">
            <label class="zc-field__label">活跃文档集合（Zotero 里自动建「【【Connected Documents】】→ 文档名」）</label>
            <input type="checkbox" data-k="docCollection">
          </div>
          <div class="zc-field">
            <div class="zc-field__label">多文档统一管理 · 按书籍分组</div>
            <div class="zc-field__hint">每本书一组参数，点开下面的折叠块查看。在文档上右键「设为引文顶级文档」即可新增一组；不同书籍的章节层次可以不同，插件按各自的文档树自动识别。未指定输出文档时自动建 Reference 子文档。</div>
            <div class="zc-scope-groups" data-scope-groups></div>
          </div>
          <div class="zc-field__hint">打开文档或改动引用时，在 Zotero 里自动建一个以文档名命名的临时集合，收这篇文档引用到的全部文献；关闭文档时自动解散，顶级集合下没有别的文档了就一起收掉。成员只做「加进来 / 移出去」，<b>不会改动文献原本在你各集合里的归属</b>。顶级集合跨软件共用，WPS 插件建的集合也在它下面。关掉这个开关会把本机建过的集合收掉。</div>
        </div>
        <div class="zc-actions">
          <button class="b3-button b3-button--text zc-save">保存</button>
          <button class="b3-button b3-button--outline zc-test">测试连接</button>
          <button class="b3-button b3-button--outline zc-restyle">刷新样式列表</button>
        </div>
      </div>`;
    return html;
  }

  settingBind(root) {
    const s = this.settings;
    root.querySelectorAll("[data-k]").forEach((el) => {
      const k = el.getAttribute("data-k");
      if (el.type === "checkbox") {
        el.checked = !!s[k];
      } else {
        el.value = s[k] == null ? "" : s[k];
      }
    });

    /* 「文末编号样式」预设 ↔ 输入框联动：选预设就填进输入框，自定义值也能原样回显 */
    const numSel = root.querySelector(".zc-num-preset");
    const numInput = root.querySelector('[data-k="bibNumber"]');
    if (numSel && numInput) {
      const cur = String(numInput.value || "");
      const hit = Array.from(numSel.options).some((o) => o.value === cur);
      if (!hit) {
        const o = document.createElement("option");
        o.value = cur;
        o.textContent = "自定义";
        numSel.appendChild(o);
      }
      numSel.value = cur;
      numSel.addEventListener("change", () => {
        numInput.value = numSel.value;
      });
    }

    /*
     * 「文末标题」预设 ↔ 输入框联动。
     * 值就存在 bibHeading 一个字段里：auto（按样式语言）/ 空（不生成）/ 任意文字。
     */
    const headSel = root.querySelector(".zc-head-preset");
    const headInput = root.querySelector('[data-k="bibHeading"]');
    if (headSel && headInput) {
      const cur = String(headInput.value || "");
      if (!Array.from(headSel.options).some((o) => o.value === cur)) {
        const o = document.createElement("option");
        o.value = cur;
        o.textContent = cur ? "自定义：" + cur : "不生成标题";
        headSel.appendChild(o);
      }
      headSel.value = cur;
      headSel.addEventListener("change", () => {
        headInput.value = headSel.value;
      });
    }

    const save = async () => {
      this.saveFromSetting();
      showMessage("设置已保存");
    };
    const btn = root.querySelector(".zc-save");
    if (btn) {
      btn.addEventListener("click", save);
    }
    const depdoc = root.querySelector(".zc-depdoc");
    if (depdoc) {
      depdoc.addEventListener("click", () => {
        if (!this.openExternalUrl(DEP_URL)) {
          showMessage("打不开浏览器，请手动访问：" + DEP_URL, 12000);
        }
      });
    }
    const test = root.querySelector(".zc-test");
    if (test) {
      test.addEventListener("click", async () => {
        await save();
        try {
          const r = await zoteroExec(this.settings, "return JSON.stringify({v: Zotero.version, uid: Zotero.Libraries.userLibraryID});");
          showMessage("连接正常：Zotero " + r.v + "，库 ID " + r.uid, 4000);
        } catch (e) {
          showMessage(String(e.message || e), 8000);
        }
      });
    }
    const restyle = root.querySelector(".zc-restyle");
    if (restyle) {
      restyle.addEventListener("click", async () => {
        await save();
        try {
          const styles = await fetchStyles(this.settings);
          showMessage("已读取 " + styles.length + " 个样式，示例：" + styles.slice(0, 3).map(x => x.title).join(" / "), 6000);
        } catch (e) {
          showMessage(String(e.message || e), 8000);
        }
      });
    }
    const openStyle = root.querySelector(".zc-openstyle");
    if (openStyle) {
      openStyle.addEventListener("click", async () => {
        await save();
        await this.openStylePicker(null);
      });
    }

    /* 打开面板就查一次样式；改完样式 id 再查一次（change = 失焦，不会边打字边发请求） */
    const styleInput = root.querySelector('[data-k="styleId"]');
    if (styleInput) {
      styleInput.addEventListener("change", () => { this.updateStyleStat(); });
    }

    /*
     * 一键修复：样式在本机不存在时（最常见于思源把配置同步到了另一台电脑），
     * 直接把样式换成 Zotero 全新安装就自带的 APA，用户不用去记样式 id 或找 .csl。
     */
    const useApa = root.querySelector(".zc-useapa");
    if (useApa) {
      useApa.addEventListener("click", async () => {
        const fallback = DEFAULT_SETTINGS.styleId;
        if (styleInput) {
          styleInput.value = fallback;
        }
        await this.updateSettings({ styleId: fallback });
        await this.updateStyleStat();
        showMessage("已改用 Zotero 自带样式：APA Style 7th edition");
      });
    }
    this.updateStyleStat();
    /* 1.3.0：按书籍分组的可折叠参数块要读文档树，异步填充 */
    this.fillScopeGroups(root);
  }
};

/*
 * 离线单测用的内部出口。
 * module.exports 是插件类本身（思源靠它实例化），这里把几个纯函数挂到类上，
 * 测试里把 require("siyuan") 换成桩就能直接跑，不必再复制一份实现去测。
 */
try {
  module.exports.__docCollectionScript = docCollectionScript;
  module.exports.__docCollectionName = docCollectionName;
  module.exports.__docTailOf = docTailOf;
  module.exports.__DOC_PARENT = DOC_PARENT;
  module.exports.__DOC_LEGACY_PARENTS = DOC_LEGACY_PARENTS;
  // 兼容旧测试的写法
  module.exports.__DOC_LEGACY_PARENT = DOC_LEGACY_PARENTS[0];
  module.exports.__scopePathPrefix = scopePathPrefix;
  module.exports.__isScopeDescendant = isScopeDescendant;
  module.exports.__normalizeScopes = normalizeScopes;
  module.exports.__orderScopeDocs = orderScopeDocs;
  module.exports.__scopeFromRows = scopeFromRows;
  module.exports.__SCOPE_FILE = SCOPE_FILE;
  module.exports.__REF_DOC_TITLE = REF_DOC_TITLE;
} catch (e) { /* 挂不上也不影响插件本体 */ }
