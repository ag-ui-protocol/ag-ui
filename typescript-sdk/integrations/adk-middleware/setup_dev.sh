#!/bin/bash
# typescript-sdk/integrations/adk-middleware/setup_dev.sh

# Development setup script for ADK Middleware

echo "Setting up ADK Middleware development environment..."

# Get the repository root
REPO_ROOT=$(cd ../../.. && pwd)
PYTHON_SDK_PATH="${REPO_ROOT}/python-sdk"

# Check if python-sdk exists
if [ ! -d "$PYTHON_SDK_PATH" ]; then
    echo "Error: python-sdk not found at $PYTHON_SDK_PATH"
    echo "Please ensure you're running this from typescript-sdk/integrations/adk-middleware/"
    exit 1
fi

# Add python-sdk to PYTHONPATH
export PYTHONPATH="${PYTHON_SDK_PATH}:${PYTHONPATH}"
echo "Added python-sdk to PYTHONPATH: ${PYTHON_SDK_PATH}"

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python -m venv venv
fi

# Activate virtual environment
echo "Activating virtual environment..."
source venv/bin/activate

# Upgrade pip
echo "Upgrading pip..."
pip install --upgrade pip

# Install dependencies
echo "Installing dependencies..."
pip install -r requirements.txt

# Install in development mode
echo "Installing adk-middleware in development mode..."
pip install -e .

# Install development dependencies
echo "Installing development dependencies..."
pip install pytest pytest-asyncio pytest-cov black isort flake8 mypy

echo ""
echo "Development environment setup complete!"
echo ""
echo "To activate the environment in the future, run:"
echo "  source venv/bin/activate"
echo ""
echo "PYTHONPATH has been set to include: ${PYTHON_SDK_PATH}"
echo ""
echo "You can now run the examples:"
echo "  python examples/simple_agent.py"
echo ""
echo "Or run tests:"
echo "  pytest"