from typing import Union

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    token: Union[str, None] = None

    proxy: Union[str, None] = None

    custom_path: Union[str, None] = None

    cool_time: int = 3

    port: int = 11451
    share: bool = False
    start_sound: bool = True
    finish_sound: bool = True

    model_config = SettingsConfigDict(env_file=".env", extra="allow", arbitrary_types_allowed=True)


env = Settings()
