"""Health check endpoint for testing."""
from fastapi import APIRouter

router = APIRouter()

@router.get("/health")
async def health_check():
    """Simple health check endpoint."""
    return {"status": "healthy", "service": "ag-ui-example-server"}