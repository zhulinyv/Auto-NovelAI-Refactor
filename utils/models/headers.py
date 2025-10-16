from utils.environment import env
from utils.logger import logger

headers = {
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "Authorization": f"Bearer {env.token if env.token else logger.error("未配置 Token!")}",
    "Content-type": "application/json",
    "Origin": "https://novelai.net",
    "Priority": "u=1, i",
    "Referer": "https://novelai.net/",
    "Sec-Ch-Ua": '"Not(A:Brand";v="99", "Microsoft Edge";v="133", "Chromium";v="133"',
    "Sec-Ch-Ua-mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36",
}
