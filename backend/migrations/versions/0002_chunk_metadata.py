"""add citation metadata to chunks (start_speaker, start_timestamp, meta)

Revision ID: 0002_chunk_metadata
Revises: 0001_initial
Create Date: 2026-10-09
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "0002_chunk_metadata"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("chunks", sa.Column("start_speaker", sa.String(length=200), nullable=True))
    op.add_column("chunks", sa.Column("start_timestamp", sa.String(length=40), nullable=True))
    op.add_column(
        "chunks",
        sa.Column("meta", sa.JSON(), server_default=sa.text("'{}'::json"), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("chunks", "meta")
    op.drop_column("chunks", "start_timestamp")
    op.drop_column("chunks", "start_speaker")
