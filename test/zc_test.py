#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Zotero Cite 插件全量稳定性测试。

覆盖：
  基础改写 / 幂等 / 相邻合并 / 数字式 / 叙述式 / 缺样式拒绝 / 快照写入与兜底 /
  快照不降级 / 坏属性容错 / 块属性往返安全 / 文末表定位（标题被删、表后有正文）/
  引用删除后条目回收 / 大文档性能 / 设置面板样式状态

用法：python test/zc_test.py [用例名过滤]
退出码 0 = 全绿。
"""
import json
import re
import sys
import time
import traceback

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import zc_lib as L  # noqa: E402

RESULTS = []
NOTES = []      # 各用例期间冒出来的界面提示
NB = None
KEYS = []          # 真实文献 [{k,t,y,a}]
ORIG_STYLE = None
CHAIR = "http://www.zotero.org/styles/syau-thesis"  # 启动时换成「本机真能 get 到」的那个（见 setup）
CHAIR_CANDIDATES = [
    # 同一个沈农样式在两台机上 ID 不同：单位机那份 .csl 的 <id> 带中文后缀，
    # 家机这份是官方 ID。Zotero.Styles.getVisible() 会把「文件在 styles 目录里、
    # 但没注册进样式库」的也算进来，所以不能只看可见列表，必须用 Styles.get 试。
    "http://www.zotero.org/styles/syau-thesis沈阳农业大学硕博论文",
    "http://www.zotero.org/styles/syau-thesis",
]
APA = "http://www.zotero.org/styles/apa"
IEEE = "http://www.zotero.org/styles/ieee"
FAKE = "FAKEKEY99"  # 库里必然不存在的 key


# ---------------------------------------------------------------- 断言小工具

def ok(cond, msg):
    if not cond:
        raise AssertionError(msg)


def eq(a, b, msg):
    if a != b:
        raise AssertionError("%s\n  期望: %r\n  实际: %r" % (msg, b, a))


def toasts(clear=True):
    """读走界面上当前的提示条（用来发现插件/内核报错）。"""
    try:
        r = L.js('const a = Array.prototype.slice.call(document.querySelectorAll(".b3-snackbar"))\n'
                 '.map(function (e) { return (e.textContent || "").trim(); }).filter(Boolean);\n'
                 '%s\n'
                 'return JSON.stringify(a);'
                 % ('document.querySelectorAll(".b3-snackbar").forEach(function (e) { e.remove(); });'
                    if clear else ""))
        return json.loads(r)
    except Exception:
        return []


def case(fn):
    def run():
        name = fn.__name__.replace("t_", "", 1)
        t0 = time.time()
        toasts()  # 先清场，只统计本用例产生的
        try:
            fn()
            RESULTS.append((name, "PASS", "", time.time() - t0))
            print("  [PASS] %-34s %5.1fs" % (name, time.time() - t0))
        except AssertionError as e:
            RESULTS.append((name, "FAIL", str(e), time.time() - t0))
            print("  [FAIL] %-34s %5.1fs\n         %s" % (name, time.time() - t0, str(e).replace("\n", "\n         ")))
        except Exception as e:
            RESULTS.append((name, "ERROR", repr(e), time.time() - t0))
            print("  [ERR ] %-34s %5.1fs\n         %s" % (name, time.time() - t0,
                                                          traceback.format_exc().replace("\n", "\n         ")))
        t = toasts()
        if t:
            NOTES.append((name, t))
            print("         ! 界面提示：%s" % " | ".join(t))
    run.__name__ = fn.__name__
    return run


def links(md):
    """正文里的 zotero 引用链接 → [(text, href)]"""
    return [(m.group(1), m.group(2)) for m in
            re.finditer(r"\[((?:\\.|[^\[\]\\])*)\]\((zotero://[^)]+)\)", md)]


def doc_of(title, md):
    d = L.new_doc(NB, title, md)
    L.wait_index(d)
    time.sleep(0.4)  # 索引落定再动插件，避免 SQL 查不到块
    return d


# ---------------------------------------------------------------- 启动准备

def setup():
    global NB, KEYS, ORIG_STYLE, CHAIR
    NB = L.make_notebook("main")
    ORIG_STYLE = L.get_style()
    code = ('const lib = Zotero.Libraries.userLibraryID;\n'
            'const s = new Zotero.Search(); s.libraryID = lib;\n'
            's.addCondition("itemType", "isNot", "note");\n'
            's.addCondition("itemType", "isNot", "attachment");\n'
            'const ids = await s.search();\n'
            'const items = await Zotero.Items.getAsync(ids.slice(0, 240));\n'
            'return JSON.stringify(items.map(function (i) { return {\n'
            '  k: i.key, t: String(i.getField("title") || "").slice(0, 60),\n'
            '  y: String(i.getField("date") || "").slice(0, 4),\n'
            '  a: (i.getCreators() || []).map(function (c) { return c.lastName || c.name || ""; }).join(", ")\n'
            '}; }));')
    KEYS = L.zot(code)
    for _ in range(3):
        if isinstance(KEYS, str):
            KEYS = json.loads(KEYS)
        else:
            break
    # 只要「有作者 + 年份是四位数」的常规文献。
    # 无作者的网页条目（比如学校教务处通知）会被 APA 渲染成 `(*标题*, 不详)`，
    # 这种文本里含斜体与括号，正文引用每轮重排都会漂移一次 —— 那是另一个待修的问题，
    # 不该让它污染这一整套用例。取 240 条再筛，保证筛完仍有 40 条够 t30 用。
    clean = [x for x in KEYS
             if (x.get("a") or "").strip() and (x.get("y") or "").isdigit()]
    if len(clean) >= 40:
        KEYS = clean[:40]
    print("笔记本 %s；原文样式 %s" % (NB, ORIG_STYLE))
    print("取到 %d 条真实文献，前 3 条：%s\n" % (
        len(KEYS), " | ".join("%s(%s)" % (x["k"], x["y"]) for x in KEYS[:3])))
    alive = L.zot('const ids = %s;\n'
                  'return JSON.stringify(ids.filter(function (id) { return !!Zotero.Styles.get(id); }));'
                  % json.dumps(CHAIR_CANDIDATES, ensure_ascii=False))
    while isinstance(alive, str):
        alive = json.loads(alive)
    CHAIR = alive[0] if alive else APA
    print("测试用样式：%s\n" % CHAIR)
    L.set_style(CHAIR)


# ---------------------------------------------------------------- 用例

@case
def t01_空文档不报错():
    d = doc_of("空文档", "这里没有任何引用，只是一段普通文字。\n")
    r = L.reflow(d)
    ok(r["ok"], "重排应成功，实际异常：%s" % r.get("err"))
    eq(r["r"]["updated"], 0, "空文档不应改写任何块")
    eq(r["r"].get("keys", 0), 0, "空文档不应扫到引用")
    eq(len(L.bib_entries(d)), 0, "空文档不应生成文末表")
    L.rm_doc(d)


@case
def t02_单条引用正常改写():
    k = KEYS[0]["k"]
    d = doc_of("单条", "这是第一段，引用了 %s 的研究。\n" % L.cite("占位", [k]))
    r = L.reflow(d)
    ok(r["ok"], "重排失败：%s" % r.get("err"))
    eq(r["r"]["keys"], 1, "应扫到 1 条引用")
    md = L.body_md(d)
    ls = links(md)
    eq(len(ls), 1, "正文应剩 1 个引用链接")
    ok("占位" not in md, "占位文字应被样式渲染结果替换掉")
    ok(k in ls[0][1], "链接应指向原条目 %s" % k)
    be = L.bib_entries(d)
    eq(len(be), 1, "文末应有 1 条文献")
    a = L.attrs(d)
    eq(a.get("custom-zotero-cites"), k, "文档属性应记住引用 key 清单")
    eq(a.get("custom-zotero-style"), CHAIR, "文档属性应记住本次样式")


@case
def t03_连续重排幂等():
    k = KEYS[0]["k"]
    d = doc_of("幂等", "甲 %s 乙。\n" % L.cite("x", [k]))
    r1 = L.reflow(d)
    ok(r1["ok"], "首轮失败：%s" % r1.get("err"))
    md1 = L.doc_md(d)
    snap1 = L.snap(d)
    for i in (2, 3, 4):
        r = L.reflow(d)
        ok(r["ok"], "第 %d 轮失败：%s" % (i, r.get("err")))
        eq(r["r"]["updated"], 0, "第 %d 轮不应再改写正文（幂等被破坏）" % i)
        eq(L.doc_md(d), md1, "第 %d 轮后正文应逐字一致" % i)
        eq(json.dumps(L.snap(d)["items"], sort_keys=True, ensure_ascii=False),
           json.dumps(snap1["items"], sort_keys=True, ensure_ascii=False),
           "第 %d 轮后快照条目应不变" % i)
    L.rm_doc(d)


@case
def t04_相邻引用合并为一处():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    d = doc_of("合并", "前文%s%s后文。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    r = L.reflow(d)
    ok(r["ok"], "重排失败：%s" % r.get("err"))
    md = L.body_md(d)
    ls = links(md)
    eq(len(ls), 1, "紧挨着的两条引用应合并成一个 cluster，实际 %d 个链接" % len(ls))
    ok("zkeys=%s,%s" % (k1, k2) in ls[0][1] or "zkeys=%s,%s" % (k2, k1) in ls[0][1],
       "合并后的链接应带两个 key：%s" % ls[0][1])
    eq(len(L.bib_entries(d)), 2, "文末应有 2 条文献")
    L.rm_doc(d)


@case
def t05_数字式样式():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    d = doc_of("数字式", "甲%s。乙%s。\n" % (L.cite("a", [k1]), L.cite("b", [k2], "narr")))
    L.set_style(IEEE)
    r = L.reflow(d)
    ok(r["ok"], "切 IEEE 重排失败：%s" % r.get("err"))
    md = L.body_md(d)
    plain = md.replace("\\", "")
    ok("[1]" in plain, "数字式应出现 [1]，实际正文：%s" % md[:200])
    ok("[2]" in plain, "数字式应出现 [2]")
    nar = json.loads(L.plugin_js("return JSON.stringify(p._lastRendered);"))
    eq(nar.get("narrativeSupported"), False, "数字式样式不应报告支持叙述式")
    ok("f=narr" not in md, "数字式下 narr 标记应被降级为 csl，实际仍有：%s" % md[:300])
    eq(len(L.bib_entries(d)), 2, "文末应有 2 条文献")
    md2 = L.doc_md(d)
    r2 = L.reflow(d)
    eq(r2["r"]["updated"], 0, "IEEE 下再重排应幂等")
    eq(L.doc_md(d), md2, "IEEE 下再重排正文应不变")
    L.set_style(CHAIR)
    L.rm_doc(d)


@case
def t06_叙述式():
    k = KEYS[0]["k"]
    L.set_style(APA)
    d = doc_of("叙述式", "正如%s所指出的那样。\n" % L.cite("x", [k], "narr"))
    r = L.reflow(d)
    ok(r["ok"], "APA 叙述式重排失败：%s" % r.get("err"))
    md = L.body_md(d)
    txt = links(md)[0][0] if links(md) else ""
    ok(txt and not txt.startswith("("), "叙述式不应以左括号开头，实际：%r" % txt)
    ok("(" in txt and ")" in txt, "叙述式应含年份括号，实际：%r" % txt)
    ok("f=narr" in md, "叙述式链接应保留 f=narr 标记")
    L.set_style(CHAIR)
    L.rm_doc(d)


@case
def t07_缺样式拒绝重排且零改动():
    k = KEYS[0]["k"]
    d = doc_of("缺样式", "甲 %s 乙。\n" % L.cite("x", [k]))
    ok(L.reflow(d)["ok"], "首轮应成功")
    md0 = L.doc_md(d)
    snap0 = L.attrs(d).get(L.SNAP_ATTR)
    bib0 = len(L.bib_entries(d))
    L.set_style("http://www.zotero.org/styles/__definitely_not_installed__")
    r = L.reflow(d)
    ok(not r["ok"], "缺样式时必须拒绝重排，实际却成功了")
    msg = r.get("err") or ""
    ok("没有这个 CSL 样式" in msg, "报错文案应说明缺样式，实际：%s" % msg[:200])
    eq(L.doc_md(d), md0, "被拒绝时正文必须零改动")
    eq(L.attrs(d).get(L.SNAP_ATTR), snap0, "被拒绝时快照必须零改动")
    eq(len(L.bib_entries(d)), bib0, "被拒绝时文末条目数必须不变")
    L.set_style(CHAIR)
    L.rm_doc(d)


@case
def t08_快照写入可用():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    d = doc_of("快照", "甲%s%s乙。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    ok(L.reflow(d)["ok"], "重排失败")
    a = L.attrs(d)
    raw = a.get(L.SNAP_ATTR) or ""
    ok(raw.startswith("z1:"), "快照应以 z1: 打头（gzip），实际：%s" % raw[:20])
    s = L.snap(d)
    ok(s, "快照应能解开")
    eq(s.get("v"), 1, "快照版本应为 1")
    eq(sorted(s["items"].keys()), sorted([k1, k2]), "快照应含两条文献")
    ok(s["items"][k1].get("bib"), "快照条目应带文末原文")
    ok(s["items"][k1].get("csl", {}).get("type"), "快照条目应带 CSL 类型")
    ck = "%s|%s" % (k1, k2)
    ok(s["clusters"].get(ck) or s["clusters"].get("%s|%s" % (k2, k1)),
       "快照应记住合并引用的正文原文，实际键：%s" % list(s["clusters"].keys()))
    ok(len(raw) < 60 * 1024, "2 条文献的快照不应超过 60KB，实际 %d 字节" % len(raw))
    L.rm_doc(d)


@case
def t09_缺条目时快照兜底正文与文末():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    d = doc_of("兜底", "甲%s%s乙。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    ok(L.reflow(d)["ok"], "首轮失败")
    s = L.snap(d)
    # 手工把 k2 换成库里不存在的 FAKE，模拟「Zotero 里那条被删了」；
    # 快照里给 FAKE 预置一份「上次成功渲染」的原文。
    s["items"][FAKE] = {
        "csl": {"id": 999999, "type": "article-journal", "title": "被删掉的文献"},
        "bib": "<i>快照条目测试</i>. 2099. 测试出版社.",
    }
    s["clusters"]["%s|%s" % (k1, FAKE)] = {"c": "(快照兜底, 2099)", "np": []}
    L.set_attrs(d, {L.SNAP_ATTR: L.snap_encode(s)})
    # 正文把第二处换成 FAKE
    ch = L.doc_children(d)
    L.api("/api/block/updateBlock", {
        "id": ch[0]["id"], "dataType": "markdown",
        "data": "甲%s%s乙。" % (L.cite("a", [k1]), L.cite("b", [FAKE]))})
    time.sleep(0.5)
    r = L.reflow(d)
    ok(r["ok"], "缺条目重排不应抛异常：%s" % r.get("err"))
    eq(r["r"]["missing"], 1, "应报告 1 条文献取不到")
    md = L.body_md(d)
    ok("快照兜底" in md, "正文该处应恢复成快照原文，实际正文：%s" % md[:300])
    ok("快照条目测试" in L.bib_md(d), "文末应补回快照里的条目原文，实际文末：%s" % md[-400:])
    empty_rows = [x for x in [L.kd(c["id"]) for c in L.bib_entries(d)]
                  if not re.sub(r"\[.*?\]\(.*?\)", "", x).strip()]
    eq(empty_rows, [], "不应出现只有箭头、没有文字的残条目：%s" % empty_rows)
    be = L.bib_entries(d)
    eq(len(be), 2, "文末仍应是 2 条（不因缺条而丢行）")
    # 快照不得被降级
    s2 = L.snap(d)
    ok(FAKE in s2["items"], "重排后快照必须保留 FAKE 那份存档（不能被抹掉）")
    eq(s2["clusters"]["%s|%s" % (k1, FAKE)]["c"], "(快照兜底, 2099)",
       "快照里的合并引用原文不能被残缺文本覆盖")
    ok(s2["items"].get(k1, {}).get("bib"), "其余条目应继续留在快照里")
    # 再重排一次，仍应稳定
    r3 = L.reflow(d)
    ok(r3["ok"], "二次缺条重排失败：%s" % r3.get("err"))
    eq(r3["r"]["updated"], 0, "二次缺条重排应幂等")
    ok("快照兜底" in L.body_md(d), "二次重排后正文快照原文仍在")
    L.rm_doc(d)


@case
def t10_坏快照不阻断重排():
    k = KEYS[0]["k"]
    d = doc_of("坏快照", "甲 %s 乙。\n" % L.cite("x", [k]))
    ok(L.reflow(d)["ok"], "首轮失败")
    L.set_attrs(d, {L.SNAP_ATTR: "z1:这不是合法的base64内容@@@"})
    r = L.reflow(d)
    ok(r["ok"], "坏快照不应阻断重排：%s" % r.get("err"))
    raw = L.attrs(d).get(L.SNAP_ATTR) or ""
    ok(raw.startswith("z1:"), "重排后应重新写回合法快照")
    ok(L.snap(d), "新快照应能解开")
    L.rm_doc(d)


@case
def t11_快照经块属性往返不丢字符():
    """base64 就是为了绕开块属性的实体转义与 _esc_newline_ 变换行，这里实测验证。"""
    k = KEYS[0]["k"]
    d = doc_of("往返", "甲 %s 乙。\n" % L.cite("x", [k]))
    ok(L.reflow(d)["ok"], "首轮失败")
    s = L.snap(d)
    tricky = {
        "under": "_esc_newline_ 与 _ESC_NEWLINE_",
        "brace": '{"a": 1, "b": ["x", "y"]}',
        "quote": '双引号"与单引号\'与反斜杠\\',
        "nl": "第一行\n第二行\t制表",
        "html": "<i>&lt;实体&gt;</i>",
        "uni": "中文·中文标点（，）、emoji 🚀",
        "long": "长" * 2000,
    }
    s["_tricky"] = tricky
    L.set_attrs(d, {L.SNAP_ATTR: L.snap_encode(s)})
    back = L.snap(d)
    eq(json.dumps(back.get("_tricky"), sort_keys=True, ensure_ascii=False),
       json.dumps(tricky, sort_keys=True, ensure_ascii=False),
       "快照经块属性往返后内容应逐字一致")
    # 再走一次重排，确认插件能读回且不崩
    r = L.reflow(d)
    ok(r["ok"], "带特殊字符的快照不应影响重排：%s" % r.get("err"))
    L.rm_doc(d)


@case
def t12_文末表之后的内容不被删():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    d = doc_of("表后内容", "甲%s乙%s。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    ok(L.reflow(d)["ok"], "首轮失败")
    L.append(d, "### 附录甲\n\n表后内容XYZ，必须保留。\n\n- 列表项一\n- 列表项二\n")
    time.sleep(0.6)
    r = L.reflow(d)
    ok(r["ok"], "二轮失败：%s" % r.get("err"))
    md = L.doc_md(d)
    ok("表后内容XYZ" in md, "文末表之后的正文被删了：%s" % md[-500:])
    ok("附录甲" in md, "文末表之后的标题被删了")
    ok("列表项二" in md, "文末表之后的列表被删了")
    eq(len(L.bib_entries(d)), 2, "文末条目数应仍为 2（不能重复追加）")
    L.rm_doc(d)


@case
def t13_删掉文末标题仍能定位旧表():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    d = doc_of("删标题", "甲%s乙%s。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    ok(L.reflow(d)["ok"], "首轮失败")
    hs = L.headings(d)
    ok(len(hs) >= 1, "首轮后应有文末标题块")
    before = len(L.bib_entries(d))
    L.delete_block(hs[-1]["id"])
    time.sleep(0.5)
    r = L.reflow(d)
    ok(r["ok"], "删标题后重排失败：%s" % r.get("err"))
    eq(len(L.bib_entries(d)), before,
       "标题被删后应接管旧表而不是再追加一份，条目数 %d → %d" % (before, len(L.bib_entries(d))))


@case
def t14_正文引用删光后文末条目回收():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    d = doc_of("回收", "甲%s乙%s。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    ok(L.reflow(d)["ok"], "首轮失败")
    eq(len(L.bib_entries(d)), 2, "应有 2 条")
    ch = L.doc_children(d)
    L.api("/api/block/updateBlock", {
        "id": ch[0]["id"], "dataType": "markdown", "data": "甲%s乙。" % L.cite("a", [k1])})
    time.sleep(0.5)
    r = L.reflow(d)
    ok(r["ok"], "二轮失败：%s" % r.get("err"))
    eq(len(L.bib_entries(d)), 1, "正文只剩 1 条引用时，文末应只剩 1 条")
    eq(r["r"]["keys"], 1, "应扫到 1 条引用")
    L.rm_doc(d)


@case
def t15_代码块里的示例链接不算引用():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    md = ("正文%s。\n\n```\n示例：%s\n```\n\n再正文%s。\n"
          % (L.cite("a", [k1]), L.cite("b", [k2]), L.cite("c", [k1])))
    d = doc_of("代码块", md)
    r = L.reflow(d)
    ok(r["ok"], "重排失败：%s" % r.get("err"))
    eq(r["r"]["keys"], 1, "代码块里的链接不应计入引用（应只扫到 1 条）")
    eq(len(L.bib_entries(d)), 1, "文末只应有 1 条")


@case
def t16_同一文献多处引用():
    k = KEYS[0]["k"]
    d = doc_of("多处", "甲%s。乙%s。丙%s。\n"
               % (L.cite("a", [k]), L.cite("b", [k]), L.cite("c", [k])))
    r = L.reflow(d)
    ok(r["ok"], "重排失败：%s" % r.get("err"))
    eq(len(links(L.body_md(d))), 3, "三处引用应各自保留链接")
    eq(len(L.bib_entries(d)), 1, "同一文献在文末只能出现 1 条")
    L.rm_doc(d)


@case
def t17_三十条文献性能与体积():
    ks = [x["k"] for x in KEYS[:30]]
    ok(len(ks) >= 30, "文献样本不足 30 条")
    body = "".join("第 %d 段 %s。\n\n" % (i, L.cite("x", [k])) for i, k in enumerate(ks))
    d = doc_of("大文档", body)
    t0 = time.time()
    r = L.reflow(d)
    cost = time.time() - t0
    ok(r["ok"], "大文档重排失败：%s" % r.get("err"))
    eq(r["r"]["keys"], 30, "应扫到 30 条")
    eq(len(L.bib_entries(d)), 30, "文末应有 30 条")
    raw = L.attrs(d).get(L.SNAP_ATTR) or ""
    s = L.snap(d)
    eq(len(s["items"]), 30, "快照应含 30 条")
    ok(len(raw) < 120 * 1024, "30 条快照不应超过 120KB，实际 %d 字节" % len(raw))
    print("         30 条重排耗时 %.1fs，快照 %d 字节（压缩后）" % (cost, len(raw)))
    ok(cost < 30, "30 条重排不应超过 30 秒，实际 %.1fs" % cost)
    r2 = L.reflow(d)
    eq(r2["r"]["updated"], 0, "大文档二次重排应幂等")
    L.rm_doc(d)


@case
def t18_设置面板样式状态三态():
    js = '''
    const root = document.createElement("div");
    root.innerHTML = '<input data-k="styleId" value="IDVAL">'
      + '<div data-style-stat></div><div data-style-fix class="fn__none"></div>';
    const old = p._settingEl;
    p._settingEl = root;
    const grab = function () {
      const el = root.querySelector("[data-style-stat]");
      const fix = root.querySelector("[data-style-fix]");
      return {cls: el.className, text: el.textContent,
              fix: !fix.classList.contains("fn__none")};
    };
    const out = {};
    root.querySelector("input").value = %s;
    await p.updateStyleStat(); out.ok = grab();
    root.querySelector("input").value = "http://www.zotero.org/styles/__nope__";
    await p.updateStyleStat(); out.bad = grab();
    root.querySelector("input").value = "";
    await p.updateStyleStat(); out.empty = grab();
    p._settingEl = old;
    return JSON.stringify(out);
    ''' % json.dumps(CHAIR, ensure_ascii=False)
    o = json.loads(L.plugin_js(js))
    ok("is-ok" in o["ok"]["cls"], "已装样式应显示绿色状态，实际：%r" % o["ok"])
    ok(o["ok"]["fix"] is False, "已装样式不应显示一键修复按钮")
    ok("is-bad" in o["bad"]["cls"], "缺样式应显示红色状态，实际：%r" % o["bad"])
    ok("没有这个样式" in o["bad"]["text"], "缺样式文案不对：%r" % o["bad"]["text"])
    ok(o["bad"]["fix"] is True, "缺样式时必须给一键修复按钮")
    ok("is-bad" in o["empty"]["cls"], "空样式应显示红色状态")


@case
def t19_并发重排串行化():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    d = doc_of("并发", "甲%s乙%s。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    js = '''
    const ps = [p.refreshDocument(true, "%s"), p.refreshDocument(true, "%s"),
                p.refreshDocument(true, "%s")];
    const rs = await Promise.all(ps.map(function (x) {
      return x.then(function () { return "ok"; }, function (e) { return "err:" + e.message; });
    }));
    return JSON.stringify(rs);
    ''' % (d, d, d)
    rs = json.loads(L.plugin_js(js))
    eq([x for x in rs if x != "ok"], [], "并发重排不应有失败：%s" % rs)
    eq(len(L.bib_entries(d)), 2, "并发后文末仍应为 2 条（不能重复追加）")
    md1 = L.doc_md(d)
    r = L.reflow(d)
    eq(r["r"]["updated"], 0, "并发后状态应自洽，再重排幂等")
    eq(L.doc_md(d), md1, "并发后正文应稳定")
    L.rm_doc(d)


@case
def t20_撤销能回到上一步():
    k = KEYS[0]["k"]

    def strip_ts(md):
        """块属性里的 updated 是写入时刻，两次采集天然会差 1 秒；比内容不比时钟。"""
        return re.sub(r'\s*updated="\d+"', "", md)

    L.set_style(CHAIR)
    d = doc_of("撤销", "甲%s。\n" % L.cite("a", [k]))
    ok(L.reflow(d)["ok"], "首轮失败")
    before = strip_ts(L.body_md(d))
    L.set_style(IEEE)
    ok(L.reflow(d)["ok"], "切样式重排失败")
    mid = strip_ts(L.body_md(d))
    ok(mid != before, "切到 IEEE 后正文应变化，否则用例无效")
    # getDocId 会返回编辑器里当前打开的文档（可能是用户的），临时钉死到测试文档
    L.plugin_js('const old = p.getDocId; p.getDocId = function () { return "%s"; };\n'
                'try { await p.undoLast(); } finally { p.getDocId = old; }\n'
                'return "1";' % d)
    time.sleep(1.2)
    after = strip_ts(L.body_md(d))
    eq(after, before, "撤销后正文应回到切换样式前的原文")
    eq(L.get_style(), CHAIR, "撤销后设置里的样式也应回到上一步")
    L.rm_doc(d)


@case
def t21_不生成文末标题():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    L.set_setting("bibHeading", "")
    d = doc_of("无标题", "甲%s乙%s。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    ok(L.reflow(d)["ok"], "首轮失败")
    eq(len(L.headings(d)), 0, "设为不生成标题时不应出现任何标题块")
    eq(len(L.bib_entries(d)), 2, "文末仍应有 2 条")
    md = L.doc_md(d)
    r = L.reflow(d)
    eq(r["r"]["updated"], 0, "无标题模式再重排应幂等")
    eq(L.doc_md(d), md, "无标题模式再重排正文应不变")
    eq(len(L.bib_entries(d)), 2, "无标题模式重复重排不应追加第二份")
    L.set_setting("bibHeading", "auto")
    L.rm_doc(d)


@case
def t22_自定义编号模板():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    L.set_setting("bibNumber", "{n}. ")
    d = doc_of("编号", "甲%s乙%s。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    ok(L.reflow(d)["ok"], "首轮失败")
    bm = L.bib_md(d)
    # 行首「1. 」会被思源解析成有序列表，插件写盘时把它转义成「1\. 」，两种都算对
    ok(re.search(r"(^|\n)1\\?\. ", bm), "第一条应以「1. 」开头，实际：%s" % bm[:160])
    ok(re.search(r"(^|\n)2\\?\. ", bm), "第二条应以「2. 」开头，实际：%s" % bm[:300])
    L.set_setting("bibNumber", "")
    L.rm_doc(d)


@case
def t23_属性在关闭重开笔记本后仍完好():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    L.set_style(CHAIR)
    d = doc_of("持久化", "甲%s%s乙。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    ok(L.reflow(d)["ok"], "首轮失败")
    s0 = L.snap(d)
    cites0 = L.attrs(d).get("custom-zotero-cites")
    try:
        L.api("/api/notebook/closeNotebook", {"notebook": NB})
        time.sleep(2.0)
        L.api("/api/notebook/openNotebook", {"notebook": NB})
        time.sleep(1.0)
        L.wait_index(d, timeout=15)
    except Exception as e:
        raise AssertionError("关闭/重开笔记本失败：%s" % e)
    a = L.attrs(d)
    s1 = L.snap(d)
    ok(s1, "重开笔记本后快照应仍能解开（.sy 已落盘）")
    eq(sorted(s1["items"].keys()), sorted(s0["items"].keys()),
       "重开后快照条目应完整")
    eq(a.get("custom-zotero-cites"), cites0, "重开后引用清单属性应一致")
    eq(len(L.bib_entries(d)), 2, "重开后文末条目标记应仍在")
    r = L.reflow(d)
    ok(r["ok"], "重开后重排失败：%s" % r.get("err"))
    eq(r["r"]["updated"], 0, "重开后重排应幂等")
    L.rm_doc(d)


@case
def t24_关掉链接后不破坏已有引用():
    k = KEYS[0]["k"]
    L.set_setting("linkEnabled", False)
    try:
        d = doc_of("无链接", "甲 %s 乙。\n" % L.cite("a", [k]))
        r = L.reflow(d)
        ok(r["ok"], "关掉链接后重排不应报错：%s" % r.get("err"))
        body = L.body_md(d)
        ok("zotero://" not in body, "关掉链接后正文不应再写链接，实际：%s" % body[:200])
        ok("甲" in body and "乙" in body, "关掉链接后正文前后文字不能丢：%s" % body[:200])
        r2 = L.reflow(d)
        ok(r2["ok"], "二次重排不应报错")
        eq(L.body_md(d), body, "没有链接可扫时重排不得改动正文")
        L.rm_doc(d)
    finally:
        L.set_setting("linkEnabled", True)


@case
def t25_文档属性被清空后能重建():
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    d = doc_of("清属性", "甲%s乙%s。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    ok(L.reflow(d)["ok"], "首轮失败")
    L.set_attrs(d, {"custom-zotero-cites": "", "custom-zotero-style": "",
                    L.SNAP_ATTR: ""})
    time.sleep(0.3)
    r = L.reflow(d)
    ok(r["ok"], "属性被清空后重排失败：%s" % r.get("err"))
    eq(len(L.bib_entries(d)), 2, "属性清空后不应重复追加文末条目")
    a = L.attrs(d)
    ok(a.get("custom-zotero-cites"), "重排应写回引用清单属性")
    ok(L.snap(d), "重排应写回快照")
    L.rm_doc(d)


@case
def t26_命令面板失败有可见提示():
    k = KEYS[0]["k"]
    d = doc_of("命令提示", "甲 %s 乙。\n" % L.cite("a", [k]))
    ok(L.reflow(d)["ok"], "首轮失败")
    js = '''
    const cmd = (p.commands || []).filter(function (c) { return c.langKey === "refreshCites"; })[0];
    if (!cmd) { return JSON.stringify({__err: "command not found"}); }
    const oldGet = p.getDocId, oldStyle = p.settings.styleId;
    p.getDocId = function () { return "%s"; };
    p.settings.styleId = "http://www.zotero.org/styles/__nope_for_cmd__";
    document.querySelectorAll(".b3-snackbar").forEach(function (e) { e.remove(); });
    cmd.callback();
    await new Promise(function (r) { setTimeout(r, 3000); });
    const txt = Array.prototype.slice.call(document.querySelectorAll(".b3-snackbar"))
      .map(function (e) { return (e.textContent || "").trim(); }).filter(Boolean);
    p.getDocId = oldGet; p.settings.styleId = oldStyle;
    return JSON.stringify({snack: txt});
    ''' % d
    o = json.loads(L.plugin_js(js))
    ok("__err" not in o, "没找到 refreshCites 命令：%r" % o)
    hit = [t for t in o["snack"] if "CSL 样式" in t or "没有这个" in t]
    ok(hit, "命令面板重排失败时必须弹出可见提示，实际提示：%r" % o["snack"])
    print("         提示文案：%s" % hit[0][:90])
    L.rm_doc(d)


@case
def t27_列表表格标题里的引用():
    k1, k2, k3 = KEYS[0]["k"], KEYS[1]["k"], KEYS[2]["k"]
    md = ("## 小节标题 %s\n\n"
          "- 列表项甲 %s\n- 列表项乙\n\n"
          "| 列一 | 列二 |\n| --- | --- |\n| 甲 %s | 乙 |\n\n"
          "结尾段落。\n" % (L.cite("h", [k3]), L.cite("l", [k1]), L.cite("t", [k2])))
    d = doc_of("多结构", md)
    r = L.reflow(d)
    ok(r["ok"], "重排失败：%s" % r.get("err"))
    eq(r["r"]["keys"], 3, "标题/列表/表格里的引用都应被扫到，实际 %d" % r["r"]["keys"])
    eq(len(L.bib_entries(d)), 3, "文末应有 3 条")
    full = L.doc_md(d)
    for k in (k1, k2, k3):
        ok(k in full, "条目 %s 的引用在重排后丢失" % k)
    # 结构不能被打坏
    ch = L.doc_children(d)
    types = [c.get("type") for c in ch]
    for t, name in (("h", "标题"), ("l", "列表"), ("t", "表格")):
        ok(t in types, "%s块在重排后消失了，现有块类型：%s" % (name, types))
    ok("列二" in full and "列表项乙" in full, "表格/列表里的普通文字被改坏了：%s" % full[:400])
    r2 = L.reflow(d)
    eq(r2["r"]["updated"], 0, "多结构文档再重排应幂等")
    L.rm_doc(d)


@case
def t28_缺条同时插入新文献():
    """用户问过的场景：Zotero 少一条时，新插入别的是否受影响。"""
    k1, k2, k3 = KEYS[0]["k"], KEYS[1]["k"], KEYS[2]["k"]
    d = doc_of("缺条加新", "甲%s%s乙。\n" % (L.cite("a", [k1]), L.cite("b", [k2])))
    ok(L.reflow(d)["ok"], "首轮失败")
    s = L.snap(d)
    s["items"][FAKE] = {"csl": {"id": 1, "type": "article-journal", "title": "已删条目"},
                        "bib": "<i>已删条目兜底原文</i>. 2099."}
    s["clusters"]["%s|%s" % (k1, FAKE)] = {"c": "(兜底原文, 2099)", "np": []}
    L.set_attrs(d, {L.SNAP_ATTR: L.snap_encode(s)})
    ch = L.doc_children(d)
    # 原处改成「k1 + 已删的 FAKE」，另起一段插入新文献 k3
    L.api("/api/block/updateBlock", {
        "id": ch[0]["id"], "dataType": "markdown",
        "data": "甲%s%s乙。" % (L.cite("a", [k1]), L.cite("b", [FAKE]))})
    L.append(d, "\n新插入的一段 %s。\n" % L.cite("c", [k3]))
    time.sleep(0.8)
    r = L.reflow(d)
    ok(r["ok"], "重排失败：%s" % r.get("err"))
    eq(r["r"]["missing"], 1, "应只报告 1 条取不到")
    body = L.body_md(d)
    ok("兜底原文" in body, "缺条处应保留快照原文")
    ok(k3 in body, "新插入的文献必须正常渲染出文字，实际：%s" % body[:400])
    ok("c]" not in body and "[c]" not in body, "新插入的文献不应停留在占位状态")
    eq(len(L.bib_entries(d)), 3, "文末应有 3 条（k1 / 兜底 / k3）")
    s2 = L.snap(d)
    eq(sorted(s2["items"].keys()), sorted([k1, k3, FAKE]), "快照应含三条")
    L.rm_doc(d)


@case
def t29_复杂文档连跑十轮不漂移():
    k1, k2, k3 = KEYS[0]["k"], KEYS[1]["k"], KEYS[2]["k"]
    md = ("## 标题 %s\n\n"
          "正文甲 %s，正文乙 %s。\n\n"
          "- 列表项 %s\n- 列表项二\n\n"
          "| 列一 | 列二 |\n| --- | --- |\n| %s | 乙 |\n\n"
          "结尾。\n" % (L.cite("h", [k3]), L.cite("a", [k1]),
                        L.cite("b", [k2]), L.cite("l", [k1]), L.cite("t", [k2])))
    d = doc_of("长跑", md)
    ok(L.reflow(d)["ok"], "首轮失败")
    base = L.doc_md(d)
    snap0 = json.dumps(L.snap(d)["items"], sort_keys=True, ensure_ascii=False)
    for i in range(2, 11):
        r = L.reflow(d)
        ok(r["ok"], "第 %d 轮失败：%s" % (i, r.get("err")))
        eq(r["r"]["updated"], 0, "第 %d 轮不应再改写正文（漂移）" % i)
        eq(L.doc_md(d), base, "第 %d 轮后全文应逐字一致" % i)
    eq(json.dumps(L.snap(d)["items"], sort_keys=True, ensure_ascii=False), snap0,
       "十轮后快照条目应不变")
    eq(len(L.bib_entries(d)), 3, "十轮后文末仍应为 3 条")
    L.rm_doc(d)


@case
def t30_一百条文献():
    ks = [x["k"] for x in KEYS[:40]]
    ok(len(ks) >= 40, "文献样本不足")
    # 40 条样本重复引用到 100 处，顺带验证同一文献多处引用在文末仍只出一条
    body = "".join("第 %d 段 %s，又见 %s。\n\n"
                   % (i, L.cite("x", [ks[i % len(ks)]]), L.cite("y", [ks[(i * 7) % len(ks)]]))
                   for i in range(50))
    d = doc_of("一百条", body)
    t0 = time.time()
    r = L.reflow(d)
    cost = time.time() - t0
    ok(r["ok"], "重排失败：%s" % r.get("err"))
    eq(len(L.bib_entries(d)), 40, "40 条不同文献应各出一条（去重后 40）")
    raw = L.attrs(d).get(L.SNAP_ATTR) or ""
    eq(r["r"]["keys"], 40, "应扫到 40 条不同文献")
    links_n = len(links(L.body_md(d)))
    print("         %d 处引用 / 40 条文献：耗时 %.1fs，快照 %d KB"
          % (links_n, cost, len(raw) // 1024))
    ok(cost < 60, "重排不应超过 60 秒，实际 %.1fs" % cost)
    ok(len(raw) < 200 * 1024, "快照不应超过 200KB，实际 %d" % len(raw))
    r2 = L.reflow(d)
    eq(r2["r"]["updated"], 0, "百条规模二次重排应幂等")
    L.rm_doc(d)


@case
def t31_快照里的旧编号被剥掉():
    """
    2026-11-04 用户实测（文档 20261103202849-fve8nmv）：换 Zotero profile 后某条 key
    失效，文末表 7 条里 6 条是 APA 无编号、唯独它带着 `(1)` —— 因为快照里存的是当初
    用顺序编码制样式渲染出来的、自带编号的原文。

    期望：整表形态一致。当前样式是作者年式时，从快照回落的那条也必须把旧编号剥掉；
    正文照样保留（不能为了一条编号就把整条降级成占位符）。
    """
    k1 = KEYS[0]["k"]
    d = doc_of("旧编号", "甲%s。\n" % L.cite("a", [k1]))
    ok(L.reflow(d)["ok"], "首轮失败")
    old = L.get_style()
    try:
        L.set_style(APA)
        s = L.snap(d)
        s["items"][FAKE] = {
            "csl": {"id": 1, "type": "article-journal", "title": "已删条目"},
            "bib": '<div class="csl-entry">(1) 已删条目兜底原文. 2099.</div>',
        }
        s["clusters"]["%s|%s" % (k1, FAKE)] = {"c": "(Case et al., 2012; 兜底 2099)", "np": []}
        L.set_attrs(d, {L.SNAP_ATTR: L.snap_encode(s)})
        ch = L.doc_children(d)
        L.api("/api/block/updateBlock", {
            "id": ch[0]["id"], "dataType": "markdown",
            "data": "甲%s%s。" % (L.cite("a", [k1]), L.cite("b", [FAKE]))})
        time.sleep(0.8)
        r = L.reflow(d)
        ok(r["ok"], "重排失败：%s" % r.get("err"))
        eq(r["r"]["missing"], 1, "应报告 1 条取不到")
        texts = [c.get("content") or "" for c in L.bib_entries(d)]
        eq(len(texts), 2, "文末应有 2 条")
        fb = [x for x in texts if "兜底原文" in x]
        eq(len(fb), 1, "缺条处应保留快照原文，实际：%s" % texts)
        # 核心断言：作者年式的列表里，一条都不许带编号前缀
        for x in texts:
            ok(not re.match(r"^\s*(?:\(\d+\)|\[\d+\]|\d{1,3}\.)", x),
               "文末条目不应当带编号（混排）：%r" % x)
    finally:
        L.set_style(old)
    L.rm_doc(d)


@case
def t32_换库后缺条文献表不乱序():
    """
    2026-11-04 用户实测（文档 20261103202849-fve8nmv，切换 Zotero profile 到另一个数据目录）：
    7 条引用里 6 条在当前库里查不到，只能靠快照原文顶上。旧代码把缺条的 key 一律
    追加到末尾，作者年式文献表就从字母序变成「实时的在前、缺的在后」——
    当时「许育新」那条唯一的实时条目被顶到了第一位。

    期望：作者年式按条目正文排序，缺条也回到字母序该在的位置；并把顺序记进快照，
    下次（数字式那种无法自行计算的样式）才有得复原。
    """
    # 挑一条「有作者、年份是四位数」的常规文献：无作者的网页条目会被 APA 渲染成
    # `(*标题*, 不详)`，那属于另一个待修的问题（正文引用每轮漂移），别混进来。
    k1 = next((x["k"] for x in KEYS
               if (x.get("a") or "").strip() and (x.get("y") or "").isdigit()),
              KEYS[1]["k"])
    FZ, FA = "FAKEZULU01", "FAKEALPHA02"
    d = doc_of("换库顺序", "甲%s。尾。\n\n乙%s。尾。\n\n丙%s。尾。"
               % (L.cite("a", [k1]), L.cite("b", [FZ]), L.cite("c", [FA])))
    ok(L.reflow(d)["ok"], "首轮失败")
    old = L.get_style()
    try:
        L.set_style(APA)
        s = L.snap(d)
        s["items"][FZ] = {
            "csl": {"id": 900001, "type": "article-journal", "title": "Zulu 的文献"},
            "bib": '<div class="csl-entry">Zulu, A. 2100. 换库顺序测试甲.</div>',
        }
        s["items"][FA] = {
            "csl": {"id": 900002, "type": "article-journal", "title": "Alpha 的文献"},
            "bib": '<div class="csl-entry">Alpha, B. 2100. 换库顺序测试乙.</div>',
        }
        L.set_attrs(d, {L.SNAP_ATTR: L.snap_encode(s)})
        r = L.reflow(d)
        ok(r["ok"], "缺条重排不应抛异常：%s" % r.get("err"))
        eq(r["r"]["missing"], 2, "应报告 2 条取不到")
        md = L.bib_md(d)
        ok("Alpha" in md and "Zulu" in md, "缺条应补回快照原文，实际文末：%s" % md[:400])
        ok(md.index("Alpha") < md.index("Zulu"),
           "作者年式文献表必须按字母序，缺条不能顶到前面：%s" % md[:400])
        s2 = L.snap(d)
        ok(s2.get("bibOrder"), "重排后快照应记下文献表顺序，否则下次换库无从复原")
        eq(len(s2["bibOrder"]), 3, "顺序应记全 3 条，实际 %s" % (s2.get("bibOrder"),))
        r2 = L.reflow(d)
        if r2["r"]["updated"]:
            for c in L.doc_children(d):
                print("         DEBUG", c["type"], c["id"], repr(L.kd(c["id"])))
        eq(r2["r"]["updated"], 0, "二次重排应幂等")
        eq(L.bib_md(d), md, "二次重排后文献表不应变化")
    finally:
        L.set_style(old)
    L.rm_doc(d)


@case
def t33_网页类无作者条目不再每轮漂移():
    """
    2026-11-04 用户实测：库里排在最前面的「课程建设（校级）-教务处」是网页条目
    （无作者、无年份），APA 把它渲染成 `(*标题*, 不详)`。这个斜体星号落进
    `[…](zotero://…)` 的链接文本后，思源会把它拆成三段链接：
        [(](…)​*[标题](…)​*[, 不详)](…)
    下一轮扫描就把这一处当成 3 条独立引用，每重排一次再拆一次，永远不收敛。

    期望：正文引用里不出现强调标记，链接保持单段，第二轮起零写入。
    """
    code = ('const lib = Zotero.Libraries.userLibraryID;\n'
            'const s = new Zotero.Search(); s.libraryID = lib;\n'
            's.addCondition("itemType", "is", "webpage");\n'
            'const ids = await s.search();\n'
            'const its = await Zotero.Items.getAsync(ids.slice(0, 40));\n'
            'const hit = its.filter(function (i) { return (i.getCreators() || []).length === 0; })[0];\n'
            'return JSON.stringify(hit ? hit.key : "");')
    k = L.zot(code)
    # zot 的返回值可能被 JSON.stringify 包了 1~2 层；空 key 时会退化成 '""'，
    # 不能无脑 while，否则对空串反复 json.loads 直接抛异常。
    for _ in range(3):
        if isinstance(k, str) and k[:1] in ('"', '['):
            k = json.loads(k)
        else:
            break
    if not k:
        print("         库里没有无作者的网页条目，跳过")
        return
    d = doc_of("网页条目", "甲 %s 乙。\n" % L.cite("占位", [k]))
    r1 = L.reflow(d)
    ok(r1["ok"], "首轮失败：%s" % r1.get("err"))
    kd = L.kd(L.doc_children(d)[0]["id"])
    eq(kd.count("zotero://select"), 1,
       "一处引用只能有一个链接，被拆成多段就是嵌套强调导致的：%r" % kd[:220])
    ok("*" not in kd.split("\n{:")[0], "正文引用里不应残留强调星号：%r" % kd[:220])
    md1 = L.body_md(d)
    for i in (2, 3):
        r = L.reflow(d)
        eq(r["r"]["updated"], 0, "第 %d 轮不应再改写正文（漂移）" % i)
        eq(L.body_md(d), md1, "第 %d 轮后正文应逐字一致" % i)
    L.rm_doc(d)


@case
def t34_重排后自动建活跃文档集合():
    """
    v1.2.36：真实插入路径（reflow 结束时会排队同步）后，
    Zotero 里应出现「【【Connected Documents】】→ 文档名」，成员正是正文引用的那几条。
    这条用例守的是「refresh → scheduleDocCollection」这根线，而不是直接调 sync。
    """
    k1, k2 = KEYS[0]["k"], KEYS[1]["k"]
    d = doc_of("活跃集合", "甲 %s 乙 %s。\n" % (L.cite("x", [k1]), L.cite("y", [k2])))
    r = L.reflow(d)
    ok(r.get("ok"), "重排失败：%s" % (r.get("err") or r))
    print("         重排结果=%r" % (r.get("r"),))
    # 集合同步是 900 ms 防抖 + 一次 Zotero 往返，给足时间
    rec = None
    for _ in range(12):
        time.sleep(0.5)
        info = L.plugin_js('return JSON.stringify((p._docMap || {})[%s] || null);' % json.dumps(d))
        if isinstance(info, str):
            try:
                info = json.loads(info)
            except Exception:
                info = None
        if info and info.get("key"):
            rec = info
            break
    ok(rec is not None, "重排后没有在 docMap 里留下这篇文档的集合映射；docMap=%s 日志=%s" %
       (L.plugin_js("return JSON.stringify(p._docMap || {});"),
        L.plugin_js("return JSON.stringify((p._docColLog||[]).slice(-6));")))
    if not rec:
        L.rm_doc(d)
        return
    got = L.zot(r'''const lib = Zotero.Libraries.userLibraryID;
let all = await Zotero.Collections.getByLibrary(lib, true);
const c = all.filter(function (x) { return x.key === "%s"; })[0];
return JSON.stringify(c ? {name: c.name, items: (c.getChildItems() || []).map(function (i) { return i.key; })} : null);''' % rec["key"])
    for _ in range(3):
        if isinstance(got, str):
            got = json.loads(got)
        else:
            break
    ok(bool(got), "Zotero 里找不到这个集合（key=%s）" % rec["key"])
    if got:
        ok(got["name"].startswith("活跃集合"), "集合名应跟随文档标题，实际 %r" % got["name"])
        eq(sorted(got["items"]), sorted([k1, k2]), "集合成员应与正文引用一致")
    # 清场：解散这个集合，别把测试痕迹留在用户库里
    L.plugin_js('return JSON.stringify(await p.dropDocCollection(%s));' % json.dumps(d))
    L.rm_doc(d)


# ---------------------------------------------------------------- 主流程

ALL = [t01_空文档不报错, t02_单条引用正常改写, t03_连续重排幂等, t04_相邻引用合并为一处,
       t05_数字式样式, t06_叙述式, t07_缺样式拒绝重排且零改动, t08_快照写入可用,
       t09_缺条目时快照兜底正文与文末, t10_坏快照不阻断重排, t11_快照经块属性往返不丢字符,
       t12_文末表之后的内容不被删, t13_删掉文末标题仍能定位旧表, t14_正文引用删光后文末条目回收,
       t15_代码块里的示例链接不算引用, t16_同一文献多处引用, t17_三十条文献性能与体积,
       t18_设置面板样式状态三态,
       t19_并发重排串行化, t20_撤销能回到上一步, t21_不生成文末标题, t22_自定义编号模板,
       t23_属性在关闭重开笔记本后仍完好, t24_关掉链接后不破坏已有引用, t25_文档属性被清空后能重建,
       t26_命令面板失败有可见提示, t27_列表表格标题里的引用, t28_缺条同时插入新文献,
       t29_复杂文档连跑十轮不漂移, t30_一百条文献, t31_快照里的旧编号被剥掉,
       t32_换库后缺条文献表不乱序, t33_网页类无作者条目不再每轮漂移,
       t34_重排后自动建活跃文档集合]


def main():
    filt = sys.argv[1] if len(sys.argv) > 1 else ""
    print("=" * 72)
    print("Zotero Cite 插件稳定性测试")
    print("=" * 72)
    try:
        setup()
    except Exception:
        print("初始化失败：\n" + traceback.format_exc())
        L.cleanup_notebooks()
        return 2
    for c in ALL:
        if filt and filt not in c.__name__:
            continue
        c()
    print("-" * 72)
    # 收尾：样式回原、测试笔记本全删
    try:
        L.set_style(ORIG_STYLE)
    except Exception as e:
        print("!! 恢复样式失败：%s" % e)
    killed = L.cleanup_notebooks()
    print("已恢复样式：%s" % ORIG_STYLE)
    print("已清理测试笔记本：%s" % (", ".join(killed) or "无"))
    fails = [r for r in RESULTS if r[1] != "PASS"]
    print("-" * 72)
    print("合计 %d 项：通过 %d，失败 %d" % (len(RESULTS), len(RESULTS) - len(fails), len(fails)))
    for n, st, msg, _ in fails:
        print("  %s  %s\n     %s" % (st, n, msg.replace("\n", "\n     ")))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
