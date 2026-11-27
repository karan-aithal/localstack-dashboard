from fastapi import Depends, FastAPI
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import appinspector, aws, extensions, features, instance, logs
from .security import ALLOWED_HOSTS, csrf_guard

app = FastAPI(
    title="LocalStack Dashboard",
    dependencies=[Depends(csrf_guard)],
    docs_url=None,
    redoc_url=None,
)
# rejects DNS rebinding: a foreign domain resolving to 127.0.0.1 sends its own Host header
app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)
app.include_router(instance.router)
app.include_router(logs.router)
app.include_router(aws.router)
app.include_router(features.router)
app.include_router(appinspector.router)
app.include_router(extensions.router)
