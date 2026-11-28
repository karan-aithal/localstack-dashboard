from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import (
    appinspector,
    aws,
    chaos,
    extensions,
    features,
    iam,
    insights,
    instance,
    logs,
    replicator,
    state,
)
from .security import ALLOWED_HOSTS, csrf_guard

UI = Path(__file__).resolve().parents[2] / "web" / "dist"

UI_HEADERS = {
    # no other site may frame the dashboard, and the page loads nothing from elsewhere
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    # ask again each time, so that a new build shows at once
    "cache-control": "no-cache",
}


class BuiltUI(StaticFiles):
    """The built UI. It routes in the browser, so a page address gets the page itself."""

    async def get_response(self, path, scope):
        try:
            response = await super().get_response(path, scope)
        except HTTPException as e:
            if e.status_code != 404 or path.startswith(("api/", "assets/")):
                raise
            response = await super().get_response("index.html", scope)
        response.headers.update(UI_HEADERS)
        return response


def mount_ui(site: FastAPI, directory: Path) -> None:
    """Serve a build of the UI, if there is one, at every address the API does not answer."""
    if directory.is_dir():
        site.mount("/", BuiltUI(directory=directory, html=True), name="ui")


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
app.include_router(insights.router)
app.include_router(chaos.router)
app.include_router(iam.router)
app.include_router(state.router)
app.include_router(replicator.router)
# registered last: it takes whatever is left
mount_ui(app, UI)
