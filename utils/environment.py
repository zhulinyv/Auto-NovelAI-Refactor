import os
import shutil
from typing import Union

from pydantic_settings import BaseSettings, SettingsConfigDict

if not os.path.exists(".env"):
    shutil.copyfile(".env.example", ".env")


class Settings(BaseSettings):
    token: Union[str, None] = None

    proxy: Union[str, None] = None

    custom_path: Union[str, None] = "<类型>/<日期>/<种子>_<编号>"

    cool_time: int = 3

    port: int = 11451
    share: bool = False
    start_sound: bool = True
    finish_sound: bool = True
    theme: Union[str, None] = None
    check_update: bool = True

    model_config = SettingsConfigDict(env_file=".env", extra="allow", arbitrary_types_allowed=True)


env = Settings()
