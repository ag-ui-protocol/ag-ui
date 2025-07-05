#!/bin/bash
# Quick start script for ADK middleware

echo "🚀 ADK Middleware Quick Start"
echo "=============================="

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "📦 Creating virtual environment..."
    python -m venv venv
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source venv/bin/activate

# Install dependencies
echo "📥 Installing dependencies..."
pip install -e . > /dev/null 2>&1

# Check for Google API key
if [ -z "$GOOGLE_API_KEY" ]; then
    echo ""
    echo "⚠️  GOOGLE_API_KEY not set!"
    echo ""
    echo "To get started:"
    echo "1. Get an API key from: https://makersuite.google.com/app/apikey"
    echo "2. Export it: export GOOGLE_API_KEY='your-key-here'"
    echo "3. Run this script again"
    echo ""
    exit 1
fi

echo "✅ API key found"
echo ""
echo "Starting server..."
echo ""

# Run the complete setup example
cd examples
python complete_setup.py