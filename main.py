#!/usr/bin/env python
"""agent-thinking-live — agent 思考过程实时观测台。

    python main.py            启动（默认 http://127.0.0.1:9028）
    python main.py test       自检（DB 字段 + 静态资源 + 端口）
    python main.py -h         看全部参数

**环境自举**：不管你当前 shell 里的 `python` 指向哪里（Hermes venv / Store Python /
别的项目的 venv），本脚本都会自动切到通用环境 `E:\\Project\\.venv` 重跑 ——
所以不用 activate、不用记 venv 路径。Windows 上双击 `start.bat` 完全等价。

数据来源：Hermes 的 state.db（**只读**打开，不复制、不写入、不改动）。
页面走 SSE，把当前活跃会话的新消息按出现顺序推给前端。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

PROJECT = "agent-thinking-live"
# 通用环境（可选）：默认指向本机共享 venv，不存在就原地跑；别的机器用 ATL_PYTHON 覆盖
GLOBAL_PY = Path(os.environ.get("ATL_PYTHON", r"E:\Project\.venv\Scripts\python.exe"))
_REEXEC_FLAG = "_PROJECT_REEXEC"

ROOT = Path(__file__).resolve().parent
TAG = f"[{PROJECT}]"


def bootstrap() -> None:
    """确保跑在通用环境里。不在就切过去重跑一次（只切一次，防递归）。"""
    if os.environ.get(_REEXEC_FLAG) == "1":
        return
    if not GLOBAL_PY.is_file():
        return
    try:
        already = Path(sys.executable).resolve() == GLOBAL_PY.resolve()
    except OSError:
        already = False
    if already:
        return

    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env[_REEXEC_FLAG] = "1"
    print(f"{TAG} 当前解释器不是通用环境，自动切换：{GLOBAL_PY}")
    raise SystemExit(
        subprocess.call([str(GLOBAL_PY), str(ROOT / "main.py"), *sys.argv[1:]], env=env)
    )


bootstrap()

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    if argv and argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv and argv[0] == "test":
        from server.selftest import run_selftest

        return run_selftest()
    if argv and argv[0] == "serve":
        argv = argv[1:]

    from server.server import run

    return run(argv)


if __name__ == "__main__":
    raise SystemExit(main())
