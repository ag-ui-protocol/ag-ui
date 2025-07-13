# setup.py

"""Setup configuration for ADK Middleware."""

from setuptools import setup, find_packages
import os

# Determine the path to python-sdk
repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
python_sdk_path = os.path.join(repo_root, "python-sdk")

with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

setup(
    name="ag-ui-adk-middleware",
    version="0.2.1",
    author="AG-UI Protocol Contributors",
    description="ADK Middleware for AG-UI Protocol - Bridge Google ADK agents with AG-UI",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/ag-ui-protocol/ag-ui-protocol",
    packages=find_packages(where="src"),
    package_dir={"": "src"},
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
    ],
    python_requires=">=3.8",
    install_requires=[
        "ag-ui-protocol>=0.1.7",
        "google-adk>=1.6.1",
        "pydantic>=2.11.7",
        "asyncio>=3.4.3",
        "fastapi>=0.115.2",
        "uvicorn>=0.35.0",
    ],
    extras_require={
        "dev": [
            "pytest>=7.0",
            "pytest-asyncio>=0.21",
            "pytest-cov>=4.0",
            "black>=23.0",
            "isort>=5.12",
            "flake8>=6.0",
            "mypy>=1.0",
        ],
    },
    entry_points={
        "console_scripts": [
            # Add any CLI tools here if needed
        ],
    },
)