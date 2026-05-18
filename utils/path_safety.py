from pathlib import Path

from utils.environment import env


def is_share_path_allowed(path, roots=("outputs",)):
    if not env.share:
        return True
    if not path:
        return False

    resolved = Path(path).resolve()
    for root in roots:
        safe_root = (Path.cwd() / root).resolve()
        if resolved == safe_root or resolved.is_relative_to(safe_root):
            return True
    return False
