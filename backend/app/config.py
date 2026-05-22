from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    postgres_user: str = "tcg"
    postgres_password: str = "tcgpass"
    postgres_db: str = "tcgdb"
    postgres_host: str = "postgres"
    postgres_port: int = 5432

    redis_url: str = "redis://redis:6379/0"

    secret_key: str = "change-me"
    environment: str = "development"
    log_level: str = "info"

    pokemon_tcg_api_key: str = ""
    psa_api_key: str = ""

    pricecharting_rate_limit_seconds: float = 0.5
    scrape_cache_ttl_prices: int = 86400       # 24h
    scrape_cache_ttl_metadata: int = 604800    # 7d

    cors_origins: str = "http://localhost:8081,exp://localhost:8081"

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def database_url_sync(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",")]


@lru_cache
def get_settings() -> Settings:
    return Settings()
