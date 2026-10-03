"""NovelAI 各模型请求体的构建函数集合。

# ============================================================================
# 【禁止修改本目录下任何文件 / DO NOT MODIFY】
#
# 本目录 (utils/models/) 刻意让每个模型各占一份文件, 每个文件里的 text2image() 都是
# 一份手写的字段清单。原因: NovelAI API 对**每个模型**的字段集合、字段顺序与默认值
# 要求不同, 这不是可以安全抽象的重复代码。
#
# 合并成一个"通用 builder + 差异表"看起来能省几千行, 实际会引入难以察觉的字段漂移。
# 现成的例子: nai_diffusion_5_full.py 里 skip_cfg_above_sigma 是被注释掉的, 而
# nai_diffusion_4_full.py 是启用的 —— 这类差异散落在 v3 / v4 / v4.5 / v5 / furry
# 之间, 一旦用共享逻辑 + 开关来表达, 漏一个开关就会静默发出错误的请求体
# (表现为出图风格不对/参数不生效, 而不是报错, 极难排查)。
#
# 因此: 新增字段请**逐个模型文件**手动添加; 重构时请勿改动 / 合并 / 派生本目录下
# 的任何文件。要改这里的代码, 请先确认能对着每个模型单独验证请求体。
# ============================================================================
"""

from utils.models.nai_diffusion_3 import image2image as nai3i2i  # noqa
from utils.models.nai_diffusion_3 import inpaint as nai3infill  # noqa
from utils.models.nai_diffusion_3 import text2image as nai3t2i  # noqa
from utils.models.nai_diffusion_3 import vibe_transfer as nai3vibe  # noqa
from utils.models.nai_diffusion_4_5_curated import character as nai45cchar  # noqa
from utils.models.nai_diffusion_4_5_curated import image2image as nai45ci2i  # noqa
from utils.models.nai_diffusion_4_5_curated import inpaint as nai45cinfill  # noqa
from utils.models.nai_diffusion_4_5_curated import text2image as nai45ct2i  # noqa
from utils.models.nai_diffusion_4_5_curated import vibe_transfer as nai45cvibe  # noqa
from utils.models.nai_diffusion_4_5_full import character as nai45fchar  # noqa
from utils.models.nai_diffusion_4_5_full import image2image as nai45fi2i  # noqa
from utils.models.nai_diffusion_4_5_full import inpaint as nai45finfill  # noqa
from utils.models.nai_diffusion_4_5_full import text2image as nai45ft2i  # noqa
from utils.models.nai_diffusion_4_5_full import vibe_transfer as nai45fvibe  # noqa
from utils.models.nai_diffusion_4_curated_preview import image2image as nai4cpi2i  # noqa
from utils.models.nai_diffusion_4_curated_preview import inpaint as nai4cpinfill  # noqa
from utils.models.nai_diffusion_4_curated_preview import text2image as nai4cpt2i  # noqa
from utils.models.nai_diffusion_4_curated_preview import vibe_transfer as nai4cpvibe  # noqa
from utils.models.nai_diffusion_4_full import image2image as nai4fi2i  # noqa
from utils.models.nai_diffusion_4_full import inpaint as nai4finfill  # noqa
from utils.models.nai_diffusion_4_full import text2image as nai4ft2i  # noqa
from utils.models.nai_diffusion_4_full import vibe_transfer as nai4fvibe  # noqa
from utils.models.nai_diffusion_5_curated import character as nai5cchar  # noqa
from utils.models.nai_diffusion_5_curated import image2image as nai5ci2i  # noqa
from utils.models.nai_diffusion_5_curated import inpaint as nai5cinfill  # noqa
from utils.models.nai_diffusion_5_curated import text2image as nai5ct2i  # noqa
from utils.models.nai_diffusion_5_curated import vibe_transfer as nai5cvibe  # noqa
from utils.models.nai_diffusion_5_full import character as nai5fchar  # noqa
from utils.models.nai_diffusion_5_full import image2image as nai5fi2i  # noqa
from utils.models.nai_diffusion_5_full import inpaint as nai5finfill  # noqa
from utils.models.nai_diffusion_5_full import text2image as nai5ft2i  # noqa
from utils.models.nai_diffusion_5_full import vibe_transfer as nai5fvibe  # noqa
from utils.models.nai_diffusion_furry_3 import image2image as naif3i2i  # noqa
from utils.models.nai_diffusion_furry_3 import inpaint as naif3infill  # noqa
from utils.models.nai_diffusion_furry_3 import text2image as naif3t2i  # noqa
from utils.models.nai_diffusion_furry_3 import vibe_transfer as naif3vibe  # noqa
