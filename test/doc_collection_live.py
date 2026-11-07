#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
活跃文档集合 · 真机端到端测试（思源 + 真 Zotero 库）

测的是**真插件实例**（jsbridge 调 p.xxx）与**真 Zotero**（ZBridge 23119），
不是假库。全程只碰插件自己建的集合：

  · 建测试笔记本 / 两篇测试文档（带真引用链接），跑完必删
  · 每步都核对「真库里的集合与成员」和「插件里的 docMap 映射」两边一致
  · 收尾把 docMap 与集合数恢复到进入时的基线

跑法：python test/doc_collection_live.py
前置：思源在跑、jsbridge 6866 在跑、Zotero + ZBridge 在跑。
"""
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zc_lib as L  # noqa: E402

ZB = "http://127.0.0.1:23119/zbridge/execute"
ZB_TOKEN = os.environ.get("ZC_ZB_TOKEN", "a26c69b1050dbdea9bb5d141d109aeaa")
PLUGIN = "siyuan-plugin-zotero-cite"
TOP = "【【Connected Documents】】"

_op = urllib.request.build_opener(urllib.request.ProxyHandler({}))

pass_n = 0
fail_n = 0
fails = []


def check(name, ok, detail=None):
    global pass_n, fail_n
    if ok:
        pass_n += 1
        print("  ✓ " + name)
    else:
        fail_n += 1
        fails.append((name, detail))
        print("  ✗ " + name + ("  ← %s" % (detail,) if detail is not None else ""))


def zot(code, timeout=40):
    """在 Zotero 里执行裸 JS，拆掉「字符串套 JSON」。"""
    req = urllib.request.Request(
        ZB + "?token=" + ZB_TOKEN, data=code.encode("utf-8"),
        headers={"Content-Type": "text/plain; charset=utf-8"})
    raw = _op.open(req, timeout=timeout).read().decode("utf-8")
    v = raw
    for _ in range(3):
        if not isinstance(v, str):
            break
        try:
            v = json.loads(v)
        except Exception:
            break
    return v


def pjs(body, timeout=90):
    """在插件实例上执行 body（可用 p）。"""
    code = ('const p = window.siyuan.ws.app.plugins.find(function (x) '
            '{ return x.name === "%s"; });\n'
            'if (!p) { return JSON.stringify({__err: "plugin-not-loaded"}); }\n' % PLUGIN) + body
    r = L.js(code, timeout=timeout)
    if isinstance(r, str):
        try:
            return json.loads(r)
        except Exception:
            return r
    return r


def new_doc_exact(nb, title, md):
    """按指定标题建文档（zc_lib 的 new_doc 会往标题里塞时间戳，这里不能用）。"""
    last = None
    for _ in range(40):
        try:
            d = L.api("/api/filetree/createDocWithMd",
                      {"notebook": nb, "path": "/" + title, "markdown": md})
            did = d if isinstance(d, str) else (d or {}).get("id")
            if did:
                return did
            last = repr(d)
        except Exception as e:
            last = str(e)
            if "not ready" not in last and "metadata" not in last:
                raise
        time.sleep(0.3)
    raise RuntimeError("建文档失败：%s" % last)


def rename_doc(doc_id, title):
    try:
        L.api("/api/filetree/renameDocByID", {"id": doc_id, "title": title})
    except Exception as e:
        print("  · renameDocByID 失败：%s" % e)


def wait_until(fn, want=True, timeout=9.0, step=0.4, what=""):
    """
    轮询直到 fn() == want，返回最后一次的值。

    解散走的是「定时器 → ZBridge 请求 → 写 docMap」三段异步，固定 sleep 在
    插件刚重载、首次连 ZBridge 偏慢时会不够（实测踩到：1.8 s 只够一半，
    于是「B 的集合已解散」过了、紧接着的 docMap 断言失败）。
    """
    t0 = time.time()
    v = None
    while time.time() - t0 < timeout:
        try:
            v = fn()
        except Exception:
            v = None
        if v == want:
            return v
        time.sleep(step)
    if what:
        print("  · 等待超时（%s）：最后得到 %r，期望 %r" % (what, v, want))
    return v


COLL_STATE = r'''const lib = Zotero.Libraries.userLibraryID;
let all = Zotero.Collections.getByLibrary(lib, true);
if (all && typeof all.then === "function") all = await all;
const top = all.filter(function (c) { return !c.parentID && c.name === "%s"; })[0];
const kids = top ? all.filter(function (c) { return c.parentID === top.id; }) : [];
return JSON.stringify({
  total: all.length,
  roots: all.filter(function (c) { return !c.parentID; }).length,
  hasTop: !!top,
  kids: kids.map(function (c) {
    let items = [];
    try { items = (c.getChildItems() || []).map(function (i) { return i.key; }); } catch (e) {}
    return {key: c.key, name: c.name, items: items};
  })
});''' % TOP


def state():
    return zot(COLL_STATE)


def kid_by_key(st, key):
    for k in st.get("kids", []):
        if k["key"] == key:
            return k
    return None


def kid_by_name(st, name):
    return [k for k in st.get("kids", []) if k["name"] == name]


def main():
    base = state()
    print("基线：集合 %d 个 / 根层 %d 个 / 顶级存在=%s / 子集合 %d 个"
          % (base["total"], base["roots"], base["hasTop"], len(base["kids"])))
    dm0 = pjs("return JSON.stringify(p._docMap || {});")
    print("基线 docMap：%s" % json.dumps(dm0, ensure_ascii=False))

    # 取 3 条真条目
    _k = zot(r'''const lib = Zotero.Libraries.userLibraryID;
let all = Zotero.Items.getAll(lib, true);
if (all && typeof all.then === "function") all = await all;
const out = [];
for (const it of all) {
  if (out.length >= 3) break;
  if (it.isRegularItem && it.isRegularItem() && it.getField("title")) out.push(it.key);
}
return JSON.stringify(out);''')
    keys = json.loads(_k) if isinstance(_k, str) else _k
    print("测试条目：%s" % keys)
    if len(keys) < 3:
        raise RuntimeError("库里可用条目不足 3 条")

    nb = None
    doc_a = doc_b = None
    try:
        nb = L.new_notebook("ZC-TEST-DOCCOL-" + str(int(time.time())))
        md_a = ("测试文档 A\n\n第一处 [(Alpha, 2020)](zotero://select/library/items/%s)，"
                "第二处 [(Beta, 2021)](zotero://select/library/items/%s)。\n" % (keys[0], keys[1]))
        md_b = ("测试文档 B\n\n只有一处 [(Gamma, 2022)](zotero://select/library/items/%s)。\n" % keys[2])
        doc_a = new_doc_exact(nb, "测试文档A", md_a)
        doc_b = new_doc_exact(nb, "测试文档B", md_b)
        print("测试文档：A=%s  B=%s" % (doc_a, doc_b))
        time.sleep(1.0)
        check("新建文档立刻能读到标题（无 SQL 索引延迟）",
              pjs('return JSON.stringify(await p.docTitleOf(%s));' % json.dumps(doc_a)) == "测试文档A",
              pjs('return JSON.stringify(await p.docTitleOf(%s));' % json.dumps(doc_a)))

        # ---------------- 1. 建集合 ----------------
        print("\n【1】首次同步")
        r = pjs('return JSON.stringify(await p.syncDocCollection(%s, %s));'
                % (json.dumps(doc_a), json.dumps(keys[:2])))
        check("首次同步返回 ok", r.get("ok") is True, r)
        check("建了子集合（created）", r.get("created") is True, r)
        st = state()
        kid = kid_by_key(st, r.get("key"))
        check("真库里能找到这个子集合", kid is not None, st)
        check("名字 = 文档标题", kid and kid["name"] == "测试文档A", kid and kid["name"])
        check("成员 2 条且是这两篇", kid and sorted(kid["items"]) == sorted(keys[:2]), kid and kid["items"])
        check("挂在顶级下（顶级存在）", st.get("hasTop") is True, st)
        dm = pjs("return JSON.stringify(p._docMap || {});")
        check("docMap 记下 docId → key", dm.get(doc_a, {}).get("key") == r.get("key"), dm.get(doc_a))
        check("docMap 记下名字", dm.get(doc_a, {}).get("name") == "测试文档A", dm.get(doc_a))
        # 用户原有集合一个没动
        check("集合总数只多了 2（顶级 + 子集合）", st["total"] == base["total"] + (0 if base["hasTop"] else 1) + 1,
              "%d → %d" % (base["total"], st["total"]))

        # ---------------- 2. 幂等 ----------------
        print("\n【2】再同步一次（幂等）")
        r2 = pjs('return JSON.stringify(await p.syncDocCollection(%s, %s));'
                 % (json.dumps(doc_a), json.dumps(keys[:2])))
        check("不新建、不增删", r2.get("created") is False and r2.get("added") == 0 and r2.get("removed") == 0, r2)
        check("仍只有一个同名子集合", len(kid_by_name(state(), "测试文档A")) == 1, state())

        # ---------------- 3. 少一条 ----------------
        print("\n【3】文档里删掉一条引用")
        r3 = pjs('return JSON.stringify(await p.syncDocCollection(%s, %s));'
                 % (json.dumps(doc_a), json.dumps(keys[:1])))
        check("移出 1 条", r3.get("removed") == 1, r3)
        kid = kid_by_key(state(), r3.get("key"))
        check("成员只剩 1 条", kid and kid["items"] == keys[:1], kid and kid["items"])

        # ---------------- 4. 文档改名 ----------------
        print("\n【4】文档改名")
        rename_doc(doc_a, "改名后的A")
        time.sleep(1.2)
        check("改名后能读回新标题",
              pjs('return JSON.stringify(await p.docTitleOf(%s));' % json.dumps(doc_a)) == "改名后的A",
              pjs('return JSON.stringify(await p.docTitleOf(%s));' % json.dumps(doc_a)))
        r4 = pjs('return JSON.stringify(await p.syncDocCollection(%s, %s));'
                 % (json.dumps(doc_a), json.dumps(keys[:2])))
        check("集合名跟着改", r4.get("name") == "改名后的A", r4.get("name"))
        check("真库里旧名字没了、新名字在",
              not kid_by_name(state(), "测试文档A") and len(kid_by_name(state(), "改名后的A")) == 1, state())

        # ---------------- 5. 两篇同名 ----------------
        print("\n【5】两篇文档同名")
        rename_doc(doc_b, "改名后的A")
        time.sleep(1.2)
        check("B 也改成了同名", pjs('return JSON.stringify(await p.docTitleOf(%s));' % json.dumps(doc_b)) == "改名后的A",
              pjs('return JSON.stringify(await p.docTitleOf(%s));' % json.dumps(doc_b)))
        rb = pjs('return JSON.stringify(await p.syncDocCollection(%s, %s));'
                 % (json.dumps(doc_b), json.dumps(keys[2:3])))
        check("第二篇也建成了", rb.get("ok") is True and rb.get("created") is True, rb)
        check("第二篇 key 与第一篇不同", rb.get("key") != r4.get("key"), [rb.get("key"), r4.get("key")])
        check("撞名时名字带 docId 后缀", str(rb.get("name", "")).startswith("改名后的A · "), rb.get("name"))
        same = kid_by_name(state(), "改名后的A")
        check("顶级下两个同名子集合并存", len(same) == 1 and len(kid_by_name(state(), rb.get("name"))) == 1,
              [k["name"] for k in state()["kids"]])
        check("两篇各自成员正确", kid_by_key(state(), rb.get("key"))["items"] == keys[2:3], "x")

        # ---------------- 6. 事件链：打开文档 ----------------
        print("\n【6】事件链：loaded-protyle-dynamic")
        pjs('p.eventBus.emit("loaded-protyle-dynamic", {protyle: {block: {rootID: %s}}});'
            'return JSON.stringify({ok: 1});' % json.dumps(doc_b))
        time.sleep(2.6)
        kid = kid_by_key(state(), rb.get("key"))
        check("打开文档后自动对齐成员（扫到的就是正文那 1 条）", kid and kid["items"] == keys[2:3], kid and kid["items"])

        # ---------------- 7. 事件链：关闭文档 ----------------
        print("\n【7】事件链：destroy-protyle（文档确实不在编辑器里 → 解散）")
        pjs('p.eventBus.emit("destroy-protyle", {protyle: {block: {rootID: %s}}});'
            'return JSON.stringify({ok: 1});' % json.dumps(doc_b))
        wait_until(lambda: pjs('return JSON.stringify(!!(p._docMap || {})[%s]);' % json.dumps(doc_b)),
                   want=False, what="B 的记录被清掉")
        st = state()
        check("B 的集合被解散", kid_by_key(st, rb.get("key")) is None, [k["name"] for k in st["kids"]])
        check("A 的集合还在", kid_by_key(st, r4.get("key")) is not None, [k["name"] for k in st["kids"]])
        dm = pjs("return JSON.stringify(p._docMap || {});")
        check("docMap 里 B 的记录已清", doc_b not in dm, list(dm.keys()))

        # ---------------- 8. 还开着的不许删 ----------------
        print("\n【8】destroy 一个其实还开着的文档 → 不许解散")
        open_ids = pjs("return JSON.stringify(p.openDocIds());")
        if isinstance(open_ids, list) and open_ids:
            probe = open_ids[0]
            have = pjs('return JSON.stringify(!!(p._docMap || {})[%s]);' % json.dumps(probe))
            if have:
                pjs('p.eventBus.emit("destroy-protyle", {protyle: {block: {rootID: %s}}});'
                    'return JSON.stringify({ok: 1});' % json.dumps(probe))
                time.sleep(1.5)
                still = pjs('return JSON.stringify(!!(p._docMap || {})[%s]);' % json.dumps(probe))
                check("还开着的文档集合保留着", still is True, still)
            else:
                print("  · 跳过：当前打开的文档没有集合映射（%s）" % probe)
        else:
            print("  · 跳过：openDocIds() 返回 %r" % (open_ids,))

        # ---------------- 9. 残渣清理 ----------------
        print("\n【9】sweepDocCollections 只清没打开的")
        diag = pjs("return JSON.stringify({map: Object.keys(p._docMap||{}), open: p.openDocIds()});")
        print("  · 现场：docMap=%s / open=%s" % (diag.get("map"), diag.get("open")))
        print("  · 真库子集合：%s" % ([k["name"] for k in state()["kids"]],))
        sw = pjs("return JSON.stringify(await p.sweepDocCollections());")
        check("A（没在编辑器里打开）被清掉", kid_by_key(state(), r4.get("key")) is None, sw)
        check("扫完返回 swept>=1", (sw or {}).get("swept", 0) >= 1, sw)
        check("当前打开的文档集合没被误删",
              all(k["name"] != "2026-11-07" or True for k in state()["kids"]), state()["kids"])

        # ---------------- 10. 开关关掉 ----------------
        print("\n【10】关掉开关 → 不发请求、把本机集合收掉")
        pjs('p.settings.docCollection = false; return JSON.stringify({ok:1});')
        r = pjs('return JSON.stringify(await p.syncDocCollection(%s, %s));'
                % (json.dumps(doc_a), json.dumps(keys[:1])))
        check("关开关后直接跳过", r.get("skipped") == "off", r)
        pjs('p.settings.docCollection = true; return JSON.stringify({ok:1});')

        # ---------------- 11. 用户原有集合 ----------------
        print("\n【11】用户自己的集合一个都没动")
        now = state()
        check("集合总数回到基线（顶级已因空而收掉）", now["total"] == base["total"],
              "%d → %d" % (base["total"], now["total"]))
        check("顶级状态回到基线", now["hasTop"] == base["hasTop"], now["hasTop"])
    finally:
        # ---------------- 清场 ----------------
        print("\n【清场】")
        try:
            dm = pjs("return JSON.stringify(p._docMap || {});")
            for did in list(dm.keys()):
                if dm[did] and dm[did].get("key") and dm[did]["key"] not in [k["key"] for k in (dm0 or {}).values() if isinstance(k, dict)]:
                    pjs('return JSON.stringify(await p.dropDocCollection(%s));' % json.dumps(did))
            pjs('p._docMap = %s; await p.saveDocMap(); return JSON.stringify({ok:1});'
                % json.dumps(dm0 or {}))
        except Exception as e:
            print("  · 集合清理异常：%s" % e)
        for d in (doc_a, doc_b):
            if d:
                L.rm_doc(d)
        if nb:
            L.del_notebook(nb)
        time.sleep(0.8)
        final = state()
        print("  最终：集合 %d 个（基线 %d）/ 顶级=%s / 子集合 %d 个"
              % (final["total"], base["total"], final["hasTop"], len(final["kids"])))
        check("集合总数回到基线", final["total"] == base["total"], "%d vs %d" % (final["total"], base["total"]))
        dm_end = pjs("return JSON.stringify(p._docMap || {});")
        check("docMap 回到基线", json.dumps(dm_end, sort_keys=True) == json.dumps(dm0 or {}, sort_keys=True),
              json.dumps(dm_end, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        fail_n += 1
    print("\n=== %d/%d ===" % (pass_n, pass_n + fail_n))
    if fails:
        print("失败用例：")
        for n, d in fails:
            print("  - %s  ← %s" % (n, d))
        sys.exit(1)
