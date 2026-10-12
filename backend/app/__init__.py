"""FastAPI backend package for the Lenny Growth Assistant v2.

The backend owns data persistence and (later) transcript retrieval. The Node.js
`agent-service` remains the agent runtime; this package talks to it over its
documented internal HTTP interface (see app/services/agent_client.py).
"""
