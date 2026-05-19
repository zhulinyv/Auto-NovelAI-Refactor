from functools import wraps
from threading import Lock

from utils.errors import JobAlreadyRunningError

_job_lock = Lock()


def single_job(job_name: str, busy_return=None):
    """Prevent multiple long-running callbacks from sharing temp state."""

    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            if not _job_lock.acquire(blocking=False):
                message = f"Another task is already running; please stop it or wait before starting {job_name}."
                try:
                    from utils.logger import logger

                    logger.warning(message)
                except Exception:
                    pass
                if callable(busy_return):
                    return busy_return(message)
                if busy_return is not None:
                    return busy_return
                raise JobAlreadyRunningError(message)
            try:
                return func(*args, **kwargs)
            finally:
                _job_lock.release()

        return wrapper

    return decorator
