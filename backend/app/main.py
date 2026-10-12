"""FastAPI application factory and Uvicorn entry point.

Run with:  uvicorn app.main:app --reload
or:        python -m app.main
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.agent.router import router as chat_router
from app.api.routes import config, health, retrieval, sessions, artifacts
from app.config import get_settings
from app.db.session import check_database, dispose_engine
from app.logging_config import configure_logging
from app.services.agent_client import AgentServiceClient

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)

    app.state.settings = settings
    app.state.agent_client = AgentServiceClient(settings)

    # Best-effort dependency checks: the app must boot even when PostgreSQL is
    # not running so /health can report the outage instead of the process dying.
    db_ok, db_error = await check_database()
    if not db_ok:
        logger.warning("database_not_ready_at_startup", extra={"error": db_error})
    logger.info(
        "startup_complete",
        extra={
            "environment": settings.environment,
            "database_reachable": db_ok,
            "agent_service_url": app.state.agent_client.base_url,
        },
    )

    yield

    await dispose_engine()
    logger.info("shutdown_complete")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version=settings.api_version,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.status_code, "message": exc.detail}},
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.exception("unhandled_exception", extra={"path": request.url.path})
        return JSONResponse(
            status_code=500,
            content={"error": {"code": 500, "message": "Internal server error. This has been logged."}},
        )

    @app.get("/", tags=["meta"])
    async def root() -> dict[str, str]:
        return {"service": settings.app_name, "version": settings.api_version, "docs": "/docs"}

    app.include_router(health.router)
    app.include_router(config.router)
    app.include_router(sessions.router)
    app.include_router(artifacts.router)
    app.include_router(retrieval.router)
    app.include_router(chat_router)

    return app


app = create_app()


def main() -> None:  # pragma: no cover - process entry point
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8000,
        log_level=settings.log_level.lower(),
        reload=False,
    )


if __name__ == "__main__":  # pragma: no cover
    main()
