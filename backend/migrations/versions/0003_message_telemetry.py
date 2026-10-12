"""message telemetry (model, grounding, token_usage)

Revision ID: 0003_message_telemetry
Revises: 0002_chunk_metadata
Create Date: 2026-10-09
"""
from __future__ import annotations

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "0003_message_telemetry"
down_revision: str | None = "0002_chunk_metadata"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("model", sa.String(length=120), nullable=True))
    op.add_column("messages", sa.Column("grounding", sa.JSON(), nullable=True))
    op.add_column("messages", sa.Column("token_usage", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "token_usage")
    op.drop_column("messages", "grounding")
    op.drop_column("messages", "model")