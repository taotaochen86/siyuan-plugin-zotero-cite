#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Zotero Cite 插件自动化测试 —— 基础设施层。

三条通道：
  · 思源内核 API（6806）      建笔记本 / 建文档 / 读写块 / 读属性
  · jsbridge（6866）          在思源渲染进程里直接调插件实例的内部方法
  · Zotero debug bridge（23119）验证条目与样式的真实存在性

约定：本机服务一律绕过系统代理（代理端口 7890 打不通 127.0.0.1）。
"""
import base64
import gzip
import json
import os
import time
import urllib.error
import urllib.request

SIYUAN = "http://127.0.0.1:6806"
SY_TOKEN = "fqe01efwyfs8yxkm"
JSBRIDGE = "http://127.0.0.1:6866/run"
JS_TOKEN = "75bd91c99b2f381d796472815552f411"
ZOTERO = "http://127.0.0.1:23119/debug-bridge/execute"
Z_TOKEN = "CTT"

PLUGIN = "siyuan-plugin-zotero-cite"
SNAP_ATTR = "custom-zotero-bibsnap"

# 测试专用笔记本名前缀，收尾时按前缀清理
NB_PREFIX = "ZC-TEST-"

_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({})  # 显式空代理
)


def _post(url, data, headers, timeout=30, raw=False):
    body = data if raw else json.dumps(data, ensure_ascii=False).encode("utf-8")
    if isinstance(body, str):
        body = body.encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with _opener.open(req, timeout=timeout) as r:
            return r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        raise RuntimeError("HTTP %s @ %s\n%s" % (e.code, url, detail[:1200]))


def api(path, payload=None, timeout=60):
    """思源内核 API。返回 data 字段。"""
    txt = _post(SIYUAN + path, payload or {},
                {"Content-Type": "application/json",
                 "Authorization": "Token " + SY_TOKEN}, timeout=timeout)
    o = json.loads(txt)
    if o.get("code") != 0:
        raise RuntimeError("API %s 失败: %s" % (path, o.get("msg")))
    return o.get("data")


def js(code, timeout=120):
    """在思源渲染进程执行代码（code 是 async 函数的函数体，可用 await 与 return）。"""
    txt = _post(JSBRIDGE, {"code": code},
                {"Content-Type": "application/json",
                 "X-Bridge-Token": JS_TOKEN}, timeout=timeout)
    o = json.loads(txt)
    if not o.get("ok"):
        raise RuntimeError("jsbridge 失败: %s" % (o.get("error") or o))
    return o.get("result")


def plugin_js(body, timeout=120):
    """包一层：拿到插件实例 p，再执行 body。body 里可用 p。"""
    code = ('const p = window.siyuan.ws.app.plugins.find(function (x) '
            '{ return x.name === "%s"; });\n'
            'if (!p) { return JSON.stringify({__err: "plugin-not-loaded"}); }\n' % PLUGIN) + body
    return js(code, timeout=timeout)


def zot(code, timeout=30):
    """Zotero debug bridge。返回值已拆掉「字符串套 JSON」那层。"""
    txt = _post(ZOTERO, code,
                {"Content-Type": "text/plain; charset=utf-8",
                 "Authorization": "Bearer " + Z_TOKEN}, timeout=timeout, raw=True)
    v = txt
    for _ in range(4):
        if not isinstance(v, str):
            break
        t = v.strip()
        if not t.startswith(("{", "[", '"')):
            break
        try:
            v = json.loads(t)
        except Exception:
            break
    return v


# ------------------------------------------------------------------ 笔记本/文档

def new_notebook(name):
    nb = api("/api/notebook/createNotebook", {"name": name})
    return nb["notebook"]["id"]


def del_notebook(nb_id):
    api("/api/notebook/removeNotebook", {"notebook": nb_id})


def new_doc(nb_id, title, md, hint=None):
    path = "/%s-%s" % (title, hint or str(int(time.time() * 1000)))
    last = None
    # 刚建的笔记本要等内核把元数据准备好，否则报 document metadata is not ready
    for _ in range(40):
        try:
            d = api("/api/filetree/createDocWithMd",
                    {"notebook": nb_id, "path": path, "markdown": md})
            doc_id = d if isinstance(d, str) else (d or {}).get("id")
            if doc_id:
                return doc_id
            last = "返回里没有文档 id：%r" % (d,)
        except Exception as e:
            last = str(e)
            if "not ready" not in last and "metadata" not in last:
                raise
        time.sleep(0.25)
    raise RuntimeError("建文档失败：%s" % last)


def rm_doc(doc_id):
    try:
        api("/api/filetree/removeDoc", {"id": doc_id})
    except Exception:
        pass


def doc_children(doc_id):
    return api("/api/block/getChildBlocks", {"id": doc_id}) or []


def kd(block_id):
    d = api("/api/block/getBlockKramdown", {"id": block_id})
    return (d or {}).get("kramdown") or ""


def doc_md(doc_id):
    d = api("/api/export/exportMdContent", {"id": doc_id})
    return (d or {}).get("content") or ""


def attrs(block_id):
    d = api("/api/attr/getBlockAttrs", {"id": block_id})
    return d or {}


def set_attrs(block_id, a):
    api("/api/attr/setBlockAttrs", {"id": block_id, "attrs": a})


def append(doc_id, md):
    api("/api/block/appendBlock",
        {"parentID": doc_id, "dataType": "markdown", "data": md})


def delete_block(block_id):
    api("/api/block/deleteBlock", {"id": block_id})


def wait_index(doc_id, timeout=8.0):
    """新建/改动后 SQL 索引有延迟，轮询到能查到块为止。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            n = api("/api/query/sql", {
                "stmt": "SELECT count(*) AS c FROM blocks WHERE root_id='%s'" % doc_id})
            if n and int(n[0]["c"]) > 0:
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


# ------------------------------------------------------------------ 插件动作

def set_style(style_id):
    return plugin_js('await p.updateSettings({styleId: %s}); return JSON.stringify({ok: 1});'
                     % json.dumps(style_id, ensure_ascii=False))


def get_style():
    return json.loads(plugin_js('return JSON.stringify(p.settings.styleId);'))


def set_setting(k, v):
    return plugin_js('await p.updateSettings({%s: %s}); return JSON.stringify({ok: 1});'
                     % (k, json.dumps(v, ensure_ascii=False)))


def reflow(doc_id, verbose=True, style_before=None):
    """
    直接调插件内部入口（与命令面板「更新本文引用」同一条路径）。
    返回 {'ok':True,'r':…} 或 {'ok':False,'err':…}——异常不抛出，交给用例断言。
    """
    body = ('try {\n'
            '  const r = await p.refreshDocument(%s, "%s", %s);\n'
            '  return JSON.stringify({ok: true, r: r});\n'
            '} catch (e) {\n'
            '  return JSON.stringify({ok: false, err: String((e && e.message) || e)});\n'
            '}\n' % ("true" if verbose else "false", doc_id,
                     json.dumps(style_before) if style_before else "undefined"))
    return json.loads(plugin_js(body))


# ------------------------------------------------------------------ 快照

def snap_decode(raw):
    """把属性值解回对象。与插件 snapUnpack 同口径。"""
    if not raw:
        return None
    if raw.startswith("z1:"):
        return json.loads(gzip.decompress(base64.b64decode(raw[3:])).decode("utf-8"))
    if raw.startswith("j0:"):
        return json.loads(base64.b64decode(raw[3:]).decode("utf-8"))
    return json.loads(raw)


def snap_encode(obj):
    """gzip+base64，与插件 snapPack 同口径。"""
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return "z1:" + base64.b64encode(gzip.compress(raw)).decode("ascii")


def snap(doc_id):
    return snap_decode(attrs(doc_id).get(SNAP_ATTR))


def cite(text, keys, fmt="csl"):
    """构造插件写进正文的链接 markdown。"""
    ks = keys if isinstance(keys, list) else [keys]
    qs = []
    if len(ks) > 1:
        qs.append("zkeys=" + ",".join(ks))
    qs.append("f=" + fmt)
    return "[%s](zotero://select/library/items/%s?%s)" % (text, ks[0], "&".join(qs))


def bib_entries(doc_id):
    """文末参考文献条目（靠 custom-zotero-bib 标记认）。"""
    ch = doc_children(doc_id)
    if not ch:
        return []
    ids = [c["id"] for c in ch]
    m = api("/api/attr/batchGetBlockAttrs", {"ids": ids}) or {}
    out = []
    for c in ch:
        a = m.get(c["id"]) or {}
        if a.get("custom-zotero-bib"):
            out.append(c)
    return out


def headings(doc_id):
    return [c for c in doc_children(doc_id) if c.get("type") == "h"]


def body_md(doc_id):
    """只拼正文块（排除文末参考文献条目与标题），用来数正文里的引用链接。"""
    ch = doc_children(doc_id)
    if not ch:
        return ""
    ids = [c["id"] for c in ch]
    m = api("/api/attr/batchGetBlockAttrs", {"ids": ids}) or {}
    out = []
    for c in ch:
        a = m.get(c["id"]) or {}
        if a.get("custom-zotero-bib"):
            continue
        if c.get("type") == "h":
            continue
        out.append(kd(c["id"]))
    return "\n\n".join(out)


def bib_md(doc_id):
    """文末条目的 kramdown 拼接。"""
    return "\n\n".join(kd(c["id"]) for c in bib_entries(doc_id))


# ------------------------------------------------------------------ 收尾

def cleanup_notebooks():
    nbs = api("/api/notebook/lsNotebooks") or {}
    killed = []
    for nb in nbs.get("notebooks", []):
        if str(nb.get("name", "")).startswith(NB_PREFIX):
            try:
                del_notebook(nb["id"])
                killed.append(nb["name"])
            except Exception as e:
                killed.append("%s(失败:%s)" % (nb["name"], e))
    return killed


def make_notebook(tag):
    return new_notebook(NB_PREFIX + tag + "-" + time.strftime("%H%M%S"))
