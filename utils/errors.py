class ANRError(Exception):
    """Base exception for application-level failures."""


class NovelAIAPIError(ANRError):
    """Raised when NovelAI returns an unusable response."""


class JobAlreadyRunningError(ANRError):
    """Raised when a long-running job is already active."""
