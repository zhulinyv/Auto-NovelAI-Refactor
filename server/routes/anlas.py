"""剩余点数与用量 API: 读取缓存快照 / 手动重查全部 Token。"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/api", tags=["anlas"])

# ---------------------------------------------------------------- 剩余点数 / 用量
# 启动时查询全部 Token, 生成后仅更新本次所用 Token, 前端按 Token 展示; 值为 -1 表示尚未查询到


def _anlas_payload() -> dict:
    """把按 Token 的剩余点数/用量 (点数 + 用量% + 订阅状态 + 下次恢复 1% 的秒数) 组装成前端要的形状。

    active: 订阅是否有效 (对号/错号); recover_seconds: 下次恢复 1% 的秒数 (前端换算小时)。
    """
    from utils.generator import get_anlas_extra, get_anlas_snapshot
    from utils.tokens import get_tokens, mask_token

    snapshot = get_anlas_snapshot()
    extras = get_anlas_extra()
    tokens = get_tokens()
    anlas_list = []
    for i, token in enumerate(tokens):
        anlas, remains = snapshot.get(token, (-1, -1))
        active, recover_seconds = extras.get(token, (None, None))
        anlas_list.append(
            {
                "index": i,
                "token": mask_token(token),
                "anlas": anlas,
                "remains": remains,
                "active": active,
                "recover_seconds": recover_seconds,
            }
        )
    return {"tokens": anlas_list}


@router.get("/anlas")
def get_anlas():
    """返回全部 Token 的剩余点数/用量 (读缓存快照: 启动时查询一次, 生成后只更新所用 Token)。

    想强制重新查询走 POST /api/anlas/refresh (输出区右上角那个「刷新」按钮)。
    """
    return _anlas_payload()


@router.post("/anlas/refresh")
def refresh_anlas():
    """手动重查全部 Token 的剩余点数/用量, 返回刷新后的快照 (输出区右上角「刷新」按钮调用)。

    与 GET 的区别: 这里会**真实请求 NovelAI** 的 /user/subscription, 所以是 POST (有副作用, 不该被缓存)。
    查询是阻塞式外部 HTTP (每个 Token 最长 15s 连接 + 30s 读), 故用同步 def —— FastAPI 会把同步端点
    丢进线程池执行, 不会卡住事件循环上的其它接口; 返回体与 GET 完全同形状, 前端可复用同一套渲染。
    """
    # 并发查询各 Token: 每个 Token 最坏 15s 连接 + 30s 读取, 串行时 5 个 Token 会把这个
    # 线程池 worker 占住 ~225 秒 (期间其它同步接口排队)。线程内已是 requests 阻塞 IO,
    # 开线程并发即可, 结果写入与串行一致 (按 Token 的字典缓存)。
    import concurrent.futures

    from utils.generator import inquire_all_anlas
    from utils.tokens import get_tokens

    tokens = get_tokens()
    if len(tokens) <= 1:
        inquire_all_anlas()
    else:
        from utils.generator import inquire_anlas

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(tokens))) as ex:
            list(ex.map(inquire_anlas, tokens))
    return _anlas_payload()
