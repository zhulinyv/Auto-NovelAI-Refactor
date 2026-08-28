"""自动将 requirements.txt 中的依赖版本更新到 PyPI 上的最新版本。

用法:
    python .github/scripts/update_requirements.py [--dry-run]

规则:
    - 只处理 `>=` 与 `~=` 约束 (分别升级到最新版本 / 最新次版本);
    - 保留 `==` 精确锁定与 `<`、`<=`、`!=` 等其他约束, 避免破坏刻意锁定;
    - 跳过注释行、空行、本地路径、git 链接及 pip 选项行;
    - 未指定 --dry-run 时直接写回文件。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REQUIREMENTS = ROOT / "requirements.txt"
PYPI_JSON_URL = "https://pypi.org/pypi/{name}/json"
TIMEOUT = 30

# 需要人工维护、不参与自动更新的包 (例如上游已停止维护或与项目强绑定)
EXCLUDE: set[str] = set()

# 形如: fastapi>=0.110.0  python-multipart>=0.0.9  playsound==1.2.2
REQ_RE = re.compile(
    r"^\s*(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)"
    r"(?P<extras>\[[^]]*\])?"
    r"\s*(?P<op>>=|==|~=|<=|!=|<|>)\s*"
    r"(?P<ver>[A-Za-z0-9._*+!-]+)"
    r"(?P<tail>.*)$"
)


def fetch_latest_version(name: str) -> str | None:
    """查询 PyPI 上指定包的最新稳定版本。"""
    normalized = name.lower().replace("_", "-").replace(".", "-")
    url = PYPI_JSON_URL.format(name=normalized)
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
            data = json.load(resp)
        return str(data["info"]["version"])
    except Exception as exc:
        print(f"[warn] 无法获取 {name} 的最新版本: {exc}", file=sys.stderr)
        return None


def new_version_for(op: str, latest: str) -> str | None:
    """根据约束运算符返回应写入的新版本; 返回 None 表示不修改。"""
    if op == ">=":
        return latest
    if op == "~=":
        # ~=X.Y 等价于 >=X.Y,<X.(Y+1), 取最新版的前两段
        parts = latest.split(".")
        return ".".join(parts[:2]) if len(parts) >= 2 else latest
    return None  # == / < / <= / != 等一律不自动修改


def update_line(line: str) -> tuple[str, bool]:
    """更新单行, 返回 (新行, 是否发生修改)。"""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return line, False
    # 跳过 pip 选项 / 本地路径 / git 链接等
    if stripped.startswith(("-r", "-e", "-c", "git+", "http", "./", "../", "/")):
        return line, False

    match = REQ_RE.match(stripped)
    if not match:
        return line, False

    name, extras, op, cur_ver, tail = match.groups()
    if name.lower() in EXCLUDE:
        return line, False

    latest = fetch_latest_version(name)
    if latest is None:
        return line, False

    new_ver = new_version_for(op, latest)
    if new_ver is None or new_ver == cur_ver:
        return line, False

    new_line = f"{name}{extras or ''}{op}{new_ver}{tail}"
    print(f"[update] {stripped}  ->  {new_line.strip()}")
    return new_line, True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="仅打印将要发生的修改, 不写回文件")
    args = parser.parse_args()

    if not REQUIREMENTS.exists():
        print(f"[error] 未找到 {REQUIREMENTS}", file=sys.stderr)
        return 1

    lines = REQUIREMENTS.read_text(encoding="utf-8").splitlines()
    updated_lines: list[str] = []
    changed = False
    for line in lines:
        new_line, is_changed = update_line(line)
        updated_lines.append(new_line)
        changed = changed or is_changed

    if not changed:
        print("[info] 所有依赖均为最新, 无需修改。")
        return 0

    if args.dry_run:
        print("[dry-run] 未写回文件。")
        return 0

    REQUIREMENTS.write_text("\n".join(updated_lines) + "\n", encoding="utf-8")
    print("[info] requirements.txt 已更新。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
