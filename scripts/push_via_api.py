#!/usr/bin/env python3
"""当 github.com:443 被墙、但 api.github.com 可通时，用 Git Data API 推一次提交。

用法：
    TK=$(...git credential fill...) python3 scripts/push_via_api.py "提交说明" 文件1 文件2 ...

不依赖 git 的 Smart HTTP，只打 api.github.com，因此比 git push 更容易通。
注意：由 API 生成的 commit sha 与本地 commit 不同，网络恢复后需要
      git fetch origin && git reset --hard origin/main 对齐。
"""
import base64
import json
import os
import subprocess
import sys
import urllib.request

REPO = os.environ.get("REPO", "taotaochen86/siyuan-plugin-zotero-cite")
BRANCH = os.environ.get("BRANCH", "main")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def token():
    env = os.environ.get("GH_TOKEN")
    if env:
        return env.strip()
    out = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\nusername=taotaochen86\n\n",
        capture_output=True, text=True, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    ).stdout
    for line in out.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("拿不到 GitHub 令牌")


TK = token()


def api(method, path, payload=None):
    url = path if path.startswith("http") else "https://api.github.com" + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "token " + TK)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "push-via-api")
    if data:
        req.add_header("Content-Type", "application/json")
    # 本机 Python 需直连，显式清掉代理环境
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=60) as r:
        body = r.read()
    return json.loads(body) if body else {}


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    message = sys.argv[1]
    files = sys.argv[2:]

    ref = api("GET", f"/repos/{REPO}/git/ref/heads/{BRANCH}")
    base = ref["object"]["sha"]
    commit = api("GET", f"/repos/{REPO}/git/commits/{base}")
    base_tree = commit["tree"]["sha"]
    print("base commit", base[:8], "tree", base_tree[:8])

    entries = []
    for rel in files:
        p = os.path.join(ROOT, rel)
        with open(p, "rb") as f:
            raw = f.read()
        blob = api("POST", f"/repos/{REPO}/git/blobs",
                   {"content": base64.b64encode(raw).decode(), "encoding": "base64"})
        entries.append({"path": rel.replace("\\", "/"), "mode": "100644",
                        "type": "blob", "sha": blob["sha"]})
        print("  blob", rel, len(raw), "bytes ->", blob["sha"][:8])

    tree = api("POST", f"/repos/{REPO}/git/trees",
               {"base_tree": base_tree, "tree": entries})
    new = api("POST", f"/repos/{REPO}/git/commits",
              {"message": message, "tree": tree["sha"], "parents": [base]})
    api("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}", {"sha": new["sha"]})
    print("pushed", new["sha"][:8], "->", BRANCH)


if __name__ == "__main__":
    main()
