import base64, io, os
BASE = r"C:\Apps\lc-monitor\worker"
def b64(p):
    return base64.b64encode(open(p, "rb").read()).decode()
dash = b64(os.path.join(BASE, "public", "index.html"))
login = b64(os.path.join(BASE, "public", "login.html"))
fav = b64(os.path.join(BASE, "public", "favicon.svg")) if os.path.exists(os.path.join(BASE, "public", "favicon.svg")) else b64(r"C:\Apps\lc-monitor\public\favicon.svg")
core = open(os.path.join(BASE, "worker_core.js"), encoding="utf-8").read()
header = (
    "// Auto-generated. Pages are embedded as base64 below.\n"
    f'const DASH_HTML_B64 = "{dash}";\n'
    f'const LOGIN_HTML_B64 = "{login}";\n'
    f'const FAVICON_B64 = "{fav}";\n'
)
out = r"C:\Apps\lc-monitor\worker.js"
open(out, "w", encoding="utf-8").write(header + core)
print("wrote", out, "size", os.path.getsize(out))
