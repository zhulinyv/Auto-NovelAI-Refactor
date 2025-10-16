from typing import Union

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    token: Union[str, None] = None

    proxy: Union[str, None] = None

    custom_path: Union[str, None] = None

    port: int = 11451
    share: bool = False

    model_config = SettingsConfigDict(env_file=".env", extra="allow", arbitrary_types_allowed=True)


env = Settings()
