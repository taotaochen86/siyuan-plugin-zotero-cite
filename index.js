/**
 * Zotero Cite for SiYuan
 * ------------------------------------------------------------------
 * 通过 Zotero debug bridge（默认 http://127.0.0.1:23119/debug-bridge/execute）
 * 在思源里插入文献引用。
 *
 * 架构要点（实测依据，勿随意改动）：
 *   1. 思源渲染进程 fetch 127.0.0.1:23119 是通的，6ms 级，不需要任何中转。
 *   2. debug-bridge 的 body 是「裸 JS」，不能包成 JSON（会 SyntaxError）。
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

/* ============================ 常量 ============================ */

const DEFAULT_SETTINGS = {
  bridgeUrl: "http://127.0.0.1:23119/debug-bridge/execute",
  token: "",
  styleId: "http://www.zotero.org/styles/apa",
  defaultFormat: "csl",
  bibHeading: "参考文献",
  // 文末文献列表的编号样式。
  //   ""      → 跟随 CSL 样式自带的编号（IEEE 出 [1]、Nature 出 1.、作者年式本来就没有）
  //   "none"  → 不显示编号
  //   其它    → 当作模板覆盖，`{n}` 是序号占位符，如 "{n}. " / "[{n}] " / "【{n}】"
  bibNumber: "",
  linkEnabled: true,
};

/* ============================ 依赖与图标 ============================ */

/**
 * 本插件不是纯前端工具，它依赖 Zotero 侧的一个扩展：Zotero Debug Bridge。
 * 没有它，任何请求都会 404 / 连接被拒，用户看到的是"连不上 Zotero"，
 * 光看报错根本猜不到要装扩展，所以所有失败提示都必须把这份说明指出来。
 */
const DEP_NAME = "Zotero Debug Bridge";
const DEP_URL = "http://ttchen.w1.luyouxia.net/20260915211141-favpvyz-site/20260915211232-qh8ikcb.html";

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
 *    其余 key 放 ?zkeys=，由插件解析后走 debug bridge 多选。
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
 * 在 Zotero 里执行一段 JS，返回它 JSON.parse 后的结果。
 * code 必须是裸 JS（可用 return）。
 */
async function zoteroExec(settings, code) {
  const url = (settings.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl).trim();
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
    // 404 = 端口在（Zotero 起了）但没有这个端点 → 十成是没装扩展
    const hint = resp.status === 404
      ? " 端口通但没有 debug-bridge 端点，通常是没装「" + DEP_NAME + "」扩展。安装步骤：" + DEP_URL
      : (resp.status === 401 || resp.status === 403
        ? " 令牌不对。到 Zotero 设置编辑器核对 extensions.zotero.debug-bridge.token。"
        : "");
    throw new Error("Zotero debug bridge 返回 " + resp.status + "：" + String(txt).slice(0, 200) + hint);
  }
  let v = txt;
  // debug-bridge 会把返回值再 JSON.stringify 一层，形成「字符串套 JSON」
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
    throw new Error(v.error === "no-items"
      ? "这些条目在 Zotero 里找不到（可能已删除或换了库）：" + (v.missing || []).join(", ")
      : String(v.error));
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
 * 正常的 kramdown 只会有**一组**属性，且紧贴在最末尾：
 *   `[..](..){: id="…" updated="…"}`
 *
 * 出问题时会出现两种形态，都属于脏：
 *   · 出现两组以上（正文里残留一组 + 思源又补了一组）
 *   · 某一组后面还跟着正文（说明它被当成文字了）
 *
 * 为什么需要这个判定：剥离属性后新旧内容会变得一样，只靠内容比较永远判不出
 * 「该不该写一次去清理」，脏文本就会一直留着。
 */
function attrsAreDirty(kd) {
  const s = String(kd || "");
  const groups = s.match(/\{:[^{}\n]*\}/g) || [];
  if (!groups.length) {
    return false;
  }
  if (groups.length > 1) {
    return true;
  }
  const tail = s.trimEnd();
  if (!tail.endsWith(groups[0])) {
    return true;
  }
  // 唯一一组贴在最末尾，但它前面同一行还有别的 `{:`? （不可能，上面已限一组）
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
const style = Zotero.Styles.get(P.styleId) || Zotero.Styles.getVisible()[0];
const csl = style.getCiteProc();
csl.setOutputFormat("html");
csl.updateItems(items.map(function (i) { return i.id; }));
const citeFormat = (csl.opt && csl.opt.citation_format) || null;

const idByKey = {};
items.forEach(function (i) { idByKey[i.key] = i.id; });

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
  const unit = /(\u200b|\*|\s)*(<sup>)?[\s\*]*(\[[^\]\n]*\]\(zotero:\/\/select\/library\/items\/[A-Za-z0-9]+[^)\s]*\))[\s\*]*(<\/sup>)?[\s\*]*/g;
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
    return dup ? "" : link;
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

/** 转义 markdown 链接文本里的方括号 */
function escapeLinkText(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
function unescapeLinkText(s) {
  return String(s || "").replace(/\\([\\\[\]])/g, "$1");
}

/** 生成一条引用链接的 markdown。fmtId 决定这处引用怎么呈现，写进 ?f= */
function makeCiteLink(text, keys, settings, fmtId) {
  const label = escapeLinkText(text);
  if (!settings.linkEnabled) {
    return label.replace(/\\/g, "");
  }
  const list = (keys || []).filter(Boolean);
  if (!list.length) {
    return label.replace(/\\/g, "");
  }
  // 路径只放第一个 key（单条 URL，任何情况下都能被系统正常打开）；
  // 多条目时用 ?zkeys= 带上全部 key，由插件解析后走 debug bridge 多选。
  const qs = [];
  if (list.length > 1) {
    qs.push("zkeys=" + list.join(","));
  }
  // ⚠️ 形态总是显式写进链接：每处引用自带形态，
  //    以后改设置里的「默认形态」不会悄悄改掉已经写好的引用。
  qs.push("f=" + normFmt(fmtId));
  return "[" + label + "](zotero://select/library/items/" + list[0] + "?" + qs.join("&") + ")";
}

/** 按 key 批量取条目元数据（编辑引用对话框用） */
async function fetchMetaByKeys(settings, keys) {
  const code = `
const lib = Zotero.Libraries.userLibraryID;
const ks = ${JSON.stringify(keys)};
const out = ks.map(function (k) {
  const it = Zotero.Items.getByLibraryAndKey(lib, k);
  if (!it) { return {key: k, title: "(该条目已不在库里)", authors: "", year: "", itemType: ""}; }
  return {
    key: it.key,
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

    /* 拦截 zotero:// 链接点击，交给系统唤起 Zotero
       ⚠️ 思源的行内链接是 <span data-type="a" data-href="...">，没有 href 属性，
          所以不能用 a[href^="zotero://"] 选择器，否则永远选不中。 */
    this._linkHandler = (ev) => {
      const el = ev.target && ev.target.closest
        ? ev.target.closest('[data-href^="zotero://"], a[href^="zotero://"]')
        : null;
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
      callback: () => this.refreshDocument(true),
    });
    this.addCommand({
      langKey: "cycleCiteFormat",
      hotkey: "",
      callback: () => this.cycleCiteFormat(),
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
    console.log("[zotero-cite] unloaded");
  }

  /* ---------------- 设置 ---------------- */

  async updateSettings(patch) {
    const prevStyle = this.settings.styleId;
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
   *    所以：多条目一律走 debug bridge 在 Zotero 内部 selectItems()，
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
       文档 id 实际挂在 .protyle-title 上，这里必须走 title，否则活动编辑器取不到 id。 */
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
    this._pending = {
      protyle,
      range: protyle && protyle.toolbar ? protyle.toolbar.range : null,
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
      content: `<div class="zc-dlg" style="min-height:220px">
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
        <div class="zc-list" style="max-height:320px;overflow:auto"></div>
        <div class="zc-foot">
          <span class="zc-tip"></span>
          <button class="b3-button b3-button--outline zc-checkall">全选/全不选</button>
          <button class="b3-button b3-button--outline zc-addsel">追加 Zotero 选中</button>
          <button class="b3-button b3-button--cancel zc-cancel">取消</button>
          <button class="b3-button b3-button--text zc-insert">插入引用</button>
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
      listEl.innerHTML = pool.map((r, i) => `
        <label class="zc-item${r.keep ? "" : " zc-item--off"}">
          <input type="checkbox" class="zc-cb" data-i="${i}" ${r.keep ? "checked" : ""} />
          <div class="zc-meta">
            <div class="zc-title">${String(r.title || "(无题名)").replace(/</g, "&lt;")}</div>
            <div class="zc-sub">${String(r.sub || "").replace(/</g, "&lt;")}</div>
          </div>
        </label>`).join("");
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
      (anchor && anchor.docId) || this.getDocId(),
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
      let rendered = await zoteroExec(this.settings, buildRenderScript({
        keys,
        clusters: [keys],
        styleId: this.settings.styleId,
      }));
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
            rendered = await zoteroExec(this.settings, buildRenderScript({
              keys: scan.keys.concat(keys.filter(k => scan.keys.indexOf(k) < 0)),
              clusters: list,
              styleId: this.settings.styleId,
            }));
            rec = (rendered.cites && rendered.cites[keys.join("|")]) || rec;
          }
        }
      }

      const narrable = rendered.narrativeSupported !== false;
      this._lastRendered = {
        narrativeSupported: narrable,
        styleTitle: (rendered.style && rendered.style.title) || null,
      };
      if (fmt === "narr" && !narrable) {
        throw new Error("当前是数字式样式，没有叙述式写法");
      }

      if (!rec) {
        throw new Error("没拿到 CSL 渲染结果（这几篇文献可能已从 Zotero 删除）");
      }
      const text = fmt === "narr" ? joinNarrParts(rec.np) : cslHtmlToMarkdown(rec.c);
      if (!text) {
        throw new Error("样式没有给出这一处的显示文本");
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
    const rows = [];
    let metas = [];
    try {
      metas = await fetchMetaByKeys(this.settings, keys);
    } catch (e) {
      metas = keys.map(k => ({ key: k, title: k, authors: "", year: "" }));
    }
    metas.forEach(m => rows.push({ key: m.key, title: m.title, sub: [m.authors, m.year].filter(Boolean).join(" · "), keep: true }));

    const dlg = new Dialog({
      title: "编辑文献引用",
      content: `<div class="zc-dlg zc-edit">
        <div class="zc-edit__hint">取消勾选＝从这条引用里删掉；点「追加」或搜索可加新条目。保存后自动重排。</div>
        <div class="zc-edit__list"></div>
        <div class="zc-search">
          <input class="b3-text-field fn__flex-1 zc-q" placeholder="在 Zotero 库里搜索并添加（回车）" />
          <button class="b3-button b3-button--outline zc-go">搜索</button>
        </div>
        <div class="zc-foot">
          <span class="zc-tip"></span>
          <button class="b3-button b3-button--cancel zc-cancel">取消</button>
          <button class="b3-button b3-button--outline zc-addsel">追加 Zotero 选中</button>
          <button class="b3-button b3-button--text zc-ok">保存</button>
        </div>
      </div>`,
      width: "640px",
      destroyCallback: () => {},
    });

    const el = dlg.element;
    const listEl = el.querySelector(".zc-edit__list");
    const tipEl = el.querySelector(".zc-tip");
    const qEl = el.querySelector(".zc-q");

    const render = () => {
      if (!rows.length) {
        listEl.innerHTML = `<div class="zc-empty">这一处没有条目了。保存后会连引用一起删掉。</div>`;
        return;
      }
      listEl.innerHTML = rows.map((r, i) => `
        <label class="zc-item${r.keep ? "" : " zc-item--off"}">
          <input type="checkbox" class="zc-cb" data-i="${i}" ${r.keep ? "checked" : ""} />
          <div class="zc-meta">
            <div class="zc-title">${String(r.title || "(无题名)").replace(/</g, "&lt;")}</div>
            <div class="zc-sub">${String(r.sub || "").replace(/</g, "&lt;")}</div>
          </div>
        </label>`).join("");
      listEl.querySelectorAll(".zc-cb").forEach((cb) => {
        cb.addEventListener("change", () => {
          rows[Number(cb.getAttribute("data-i"))].keep = cb.checked;
          render();
        });
      });
    };
    render();

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
        <div class="zc-edit__hint">切换后本文所有引用与文末列表都会按新样式重排。Zotero 里已装 ${styles.length} 个样式。</div>
        <div class="zc-search">
          <input class="b3-text-field fn__flex-1 zc-filter" placeholder="输入样式名过滤，如 GB/T、APA、IEEE" />
        </div>
        <div class="zc-list zc-styles" style="max-height:340px;overflow:auto"></div>
        <div class="zc-foot">
          <span class="zc-tip"></span>
          <button class="b3-button b3-button--cancel zc-cancel">取消</button>
          <button class="b3-button b3-button--text zc-ok">应用并重排</button>
        </div>
      </div>`,
      width: "620px",
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
    let docId = this.getDocId();
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
      return await this._refreshDocumentNow(verbose, docId, styleIdBefore);
    } finally {
      release();
    }
  }

  async _refreshDocumentNow(verbose, docId, styleIdBefore) {
    // 撤销帧里要记「这次渲染之前用的样式」：优先用调用方传的，
    // 否则用上一次实际渲染时用的样式（切样式时 settings 已经改过，不能直接取当前值）。
    const undoStyle = styleIdBefore || this._styleBeforeChange || this._lastStyleId || this.settings.styleId;
    // 1. 取全文 markdown（用来定顺序；后续逐块改写）
    const mdResp = await fetchSyncPost("/api/export/exportMdContent", { id: docId });
    const fullMd = (mdResp && mdResp.data && mdResp.data.content) || "";
    // 代码块里的示例链接不算引用
    const scan = scanCites(maskCode(fullMd).s, this.settings.defaultFormat);
    if (!scan.keys.length) {
      if (verbose) {
        showMessage("这篇文档里还没有 Zotero 引用");
      }
      return { updated: 0 };
    }

    // 2. 把每处引用当成一个 cluster，按正文顺序交给 CSL 渲染。
    //    文本完全由样式决定，插件不拼括号、不算编号；链接结构不动（仍是 ?zkeys=&f=）。
    const clusters = [];
    const seenCluster = new Set();
    scan.hits.forEach((h) => {
      const ck = h.keys.join("|");
      if (!seenCluster.has(ck)) {
        seenCluster.add(ck);
        clusters.push(h.keys);
      }
    });
    const rendered = await zoteroExec(this.settings, buildRenderScript({
      keys: scan.keys,
      clusters,
      styleId: this.settings.styleId,
    }));
    const narrable = rendered.narrativeSupported !== false;
    // 记住这次用的样式形态，右键菜单要据此决定「叙述式」能不能点
    this._lastRendered = {
      narrativeSupported: narrable,
      styleTitle: (rendered.style && rendered.style.title) || null,
    };

    /**
     * 某处引用的正文内容。
     * 返回 { html, wholeSup }：wholeSup=true 表示样式把它整体做成了上标（ACS/Nature 的正文引用），
     * 这种情况必须把 **整个链接** 包进 <sup>，否则 <sup> 落在链接文本里会被思源剥掉，
     * 显示成普通数字；而包在外面时思源会渲染成 data-type="a sup"（data-href 仍在，点击/右键正常）。
     */
    const citeParts = (keys, fmtId) => {
      const rec = (rendered.cites && rendered.cites[keys.join("|")]) || null;
      if (!rec) {
        return { html: "[?]", wholeSup: false };
      }
      const wantNarr = normFmt(fmtId) === "narr";
      const narrText = wantNarr ? joinNarrParts(rec.np) : null;
      const raw = narrText || rec.c || "[?]";
      const inner = isWholeSup(raw);
      return inner !== null
        ? { html: inner, wholeSup: true }
        : { html: raw, wholeSup: false };
    };

    /** 生成一处引用的最终 markdown（必要时外层加 <sup>） */
    const renderCite = (keys, fmtId) => {
      const cp = citeParts(keys, fmtId);
      const link = makeCiteLink(cslHtmlToMarkdown(cp.html) || "[?]", keys, this.settings, fmtId);
      return cp.wholeSup ? "<sup>" + link + "</sup>" : link;
    };

    // 3. 逐块改写正文里的引用链接（每处按自己的 ?f= 渲染）
    const rows = await this.querySql(
      `SELECT id FROM blocks WHERE root_id='${docId}' AND type IN ('p','h','l','i','b','s','t') ORDER BY sort`
    );
    let updated = 0;
    let skipped = 0;
    /*
     * ⚠️ 文末参考文献块必须排除在「改写」之外。
     * 它们稍后会被 rebuildBibliography 整段删掉重建，如果这里也改写、也进撤销快照：
     *   · 每次重排都白写一遍（表现为 always updated N）；
     *   · 撤销时拿已被删除的块 id 去写，每块报一次 "block not found"，满屏提示。
     */
    const bibIds = new Set();
    try {
      const chResp = await fetchSyncPost("/api/block/getChildBlocks", { id: docId });
      const kids = (chResp && chResp.data) || [];
      const bibHeading = this.settings.bibHeading || "参考文献";
      let hAt = -1;
      kids.forEach((c, i) => {
        if (c && c.type === "h" && String(c.content || "").indexOf(bibHeading) >= 0) {
          hAt = i;
        }
      });
      if (hAt >= 0) {
        kids.slice(hAt).forEach((c) => bibIds.add(c.id));
      }
    } catch (e) { /* 取不到就按没有文末处理 */ }
    /* 两阶段：先算出所有要改的块，再统一记一次撤销帧，最后才落盘。
       这样「一次重排」= 撤销栈里的一步，Ctrl+Alt+Z 一按整批回滚。 */
    const todo = [];
    for (const row of rows) {
      if (bibIds.has(row.id)) {
        continue;
      }
      const r = await fetchSyncPost("/api/block/getBlockKramdown", { id: row.id });
      const kdRaw = r && r.data && r.data.kramdown;
      // 先合并历史残留（可能有多份叠加），再剥上标外壳，最后按当前样式重建
      const kd = kdRaw ? collapseCiteMarkup(unwrapCiteSups(kdRaw)) : kdRaw;
      if (!kd || !/zotero:\/\/select\/library\/items\//.test(kd)) {
        continue;
      }
      const mk = maskCode(kd);
      const masked = mk.s.replace(CITE_RE, (full, text, kMain, query) => {
        // 文末条目的跳转链接原样保留，别当正文引用改写
        if (parseQuery(query).bib === "1") {
          return full;
        }
        const ks = citeKeysOf(kMain, query);
        let fmtId = fmtOfQuery(query, this.settings.defaultFormat);
        // 换成数字式样式后，原来的 narr 标记已无意义 → 顺手改回 csl，避免脏数据
        if (!narrable && fmtId === "narr") {
          fmtId = "csl";
        }
        return renderCite(ks, fmtId);
      });
      // ⚠️ 写盘前必须剥掉块属性：kramdown 的属性是紧贴正文的，按 markdown 写回去
      //    有可能被当成正文，用户就会看到 `…(2020)}{: id="…" updated="…"}`。
      const out = unmaskCode(stripBlockAttrs(masked), mk.store);
      // 两个触发条件：
      //   1) 内容真的变了（剥属性后比，避免 updated 每次都变导致无谓重写）
      //   2) 块属性已经脏了 —— 剥离后新旧会一模一样，光比内容永远判不出来，
      //      必须强制写一次把残留的 `{: id="…"}` 从正文里清掉
      if (out !== canonicalContent(kdRaw) || attrsAreDirty(kdRaw)) {
        todo.push({ id: row.id, oldKd: kdRaw, next: out });
      }
    }
    if (todo.length) {
      await this.snapBlocks(docId, todo.map(t => ({ id: t.id, kd: t.oldKd })), "重排/切换样式", undoStyle);
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
    await this.rebuildBibliography(docId, scan.keys, rendered);

    // 5. 记录 keys 到文档属性（冗余备份，方便别的工具读）
    try {
      const fmtCount = {};
      scan.hits.forEach(h => { fmtCount[h.fmt] = (fmtCount[h.fmt] || 0) + 1; });
      await fetchSyncPost("/api/attr/setBlockAttrs", {
        id: docId,
        attrs: {
          "custom-zotero-cites": scan.keys.join(","),
          "custom-zotero-style": this.settings.styleId,
          "custom-zotero-formats": JSON.stringify(fmtCount),
        },
      });
    } catch (e) { /* 属性写失败不影响主流程 */ }

    const styleName = (rendered.style && rendered.style.title) || this.settings.styleId.split("/").pop();
    this._lastStyleId = this.settings.styleId;
    this._styleBeforeChange = null;
    if (verbose) {
      const tail = skipped ? `，${skipped} 块因内容刚被改动跳过（再执行一次即可）` : "";
      showMessage(`已重排 ${updated} 处引用、${scan.keys.length} 条参考文献（${styleName}）${tail}`, skipped ? 7000 : 4000);
    }
    return { updated, keys: scan.keys.length };
  }

  /** 文末参考文献表：先清掉旧表，再追加。顺序与编号完全用样式给出的结果 */
  async rebuildBibliography(docId, keys, rendered) {
    const heading = this.settings.bibHeading || "参考文献";
    // ⚠️ 不能用 SQL 的 sort 比较判断前后：思源 3.8.8 里多个块共享相同 sort 值
    // （h 与 p 都可能是 5 / 10 / 20），按 sort 过滤会误删正文。改用 getChildBlocks 的顺序。
    const childResp = await fetchSyncPost("/api/block/getChildBlocks", { id: docId });
    const children = (childResp && childResp.data) || [];
    let idx = -1;
    for (let i = children.length - 1; i >= 0; i--) {
      const c = children[i];
      if (c && c.type === "h" && String(c.content || "").indexOf(heading) >= 0) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      // 从后往前删，避免影响兄弟节点
      for (let i = children.length - 1; i >= idx; i--) {
        await fetchSyncPost("/api/block/deleteBlock", { id: children[i].id });
      }
    }

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

    list.forEach((k) => {
      const raw = (rendered.bibByKey && rendered.bibByKey[k]) || "";
      let text = cslHtmlToMarkdown(raw);
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
        ? " [↗](zotero://select/library/items/" + k + "?bib=1)"
        : "";
      // ⚠️ 用纯段落，不用 "- " 列表：列表会渲染出项目符号（看起来像编号），
      //    且条目以 "[1]" 开头时思源会误认成任务列表。
      entries.push(text + jump);
    });

    const body = [`## ${heading}`, ""].concat(entries.length ? entries : ["（暂无引用）"]).join("\n\n");
    await fetchSyncPost("/api/block/appendBlock", {
      parentID: docId,
      dataType: "markdown",
      data: body,
    });
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
            没装它，插件只能报「连不上」——端口 23119 上根本没有 <code>debug-bridge</code> 端点。
          </div>
          <ol class="zc-dep__steps">
            <li>下载 <code>Debug Bridge 1.2</code> 的 xpi —— 别用更旧的包，版本以说明文档为准</li>
            <li>Zotero → 工具 → 插件，把 xpi 直接拖进窗口安装，装完重启 Zotero</li>
            <li>Zotero → 工具 → 开发者 → Run JavaScript，执行
              <code>Zotero.Prefs.set("extensions.zotero.debug-bridge.token","你的令牌",true);</code></li>
            <li>把同一个令牌填到下面的「访问令牌」，点「测试连接」确认</li>
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
          </div>
          <div class="zc-field">
            <button class="b3-button b3-button--outline zc-openstyle">从 Zotero 已装样式里选一个…</button>
          </div>
          <div class="zc-field">
            <div class="zc-field__label">文末标题</div>
            <input class="b3-text-field" data-k="bibHeading" value="">
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
  }
};
