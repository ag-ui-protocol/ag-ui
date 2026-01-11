# Quick Start Guide - Langroid Integration

## Prerequisites

- **Python 3.11 or 3.12** (3.10 works but 3.13 has issues with lxml on Windows)
- Poetry (Python package manager)
- Node.js and pnpm (for frontend)
- Gemini API key (get one from [Google AI Studio](https://makersuite.google.com/app/apikey))

**⚠️ Important for Windows users:** Python 3.13 may cause `lxml` build errors. Use Python 3.11 or 3.12 instead.

## Step 1: Install Poetry

If you don't have Poetry installed:

**Windows (PowerShell):**
```powershell
pip install poetry
```

**macOS/Linux:**
```bash
curl -sSL https://install.python-poetry.org | python3 -
```

## Step 2: Install Backend Dependencies

1. **Navigate to the examples directory:**
   ```bash
   cd integrations/langroid/python/examples
   ```

2. **Install dependencies with Poetry:**
   ```bash
   poetry install
   ```

   This will install:
   - `langroid`
   - `ag-ui-protocol`
   - `fastapi`
   - `uvicorn`
   - `python-dotenv`
   - The local `ag_ui_langroid` package

3. **Create a `.env` file** in the `examples` directory:
   ```env
   GEMINI_API_KEY=your-gemini-api-key-here
   ```
   **Note:** You can get a Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey).

## Step 3: Run the Backend

From the `integrations/langroid/python/examples` directory:

```bash
poetry run python -m server
```

The server will start on **http://localhost:8003/agentic_chat/**

You should see output like:
```
INFO:     Uvicorn running on http://0.0.0.0:8003 (Press CTRL+C to quit)
INFO:     Started reloader process
INFO:     Started server process
```

## Step 4: Install Frontend Dependencies

1. **Navigate to the project root:**
   ```bash
   cd ../../../../  # Back to project root (ag-ui)
   ```

2. **Install frontend dependencies:**
   ```bash
   pnpm install
   ```

## Step 5: Run the Frontend (Dojo)

From the project root:

```bash
pnpm --filter dojo dev
```

Or if you're in the `apps/dojo` directory:

```bash
pnpm dev
```

The frontend will start on **http://localhost:3000** (or another port if 3000 is busy)

## Step 6: Access the Langroid Agent

1. Open your browser to **http://localhost:3000**
2. In the Dojo interface, select **"Langroid"** from the integrations menu
3. Select **"agentic_chat"** feature
4. Start chatting with the Langroid agent!

## Troubleshooting

### Backend Issues

**Problem: Poetry install fails with `lxml` build errors (Windows)**
- **You're likely using Python 3.13** - this is the main cause!
- **Solution: Use Python 3.11 or 3.12 instead:**
  ```powershell
  # Remove current environment
  poetry env remove python
  # Use Python 3.11 or 3.12
  poetry env use python3.11
  # Reinstall
  poetry install
  ```
- See [python/examples/INSTALL_WINDOWS_FIX.md](python/examples/INSTALL_WINDOWS_FIX.md) for detailed solutions

**Problem: `ModuleNotFoundError: No module named 'langroid'`**
- Make sure you're running commands with `poetry run`
- Try: `poetry install` again

**Problem: Port 8003 already in use**
- Change the port in `server/__main__.py` or set environment variable:
  ```bash
  $env:PORT=8004; poetry run python -m server
  ```

### Frontend Issues

**Problem: Frontend can't connect to backend**
- Make sure backend is running on port 8003
- Check `apps/dojo/src/env.ts` - `langroidUrl` should be `http://localhost:8003`
- Check browser console for CORS errors

**Problem: `pnpm install` fails**
- Try: `pnpm install --shamefully-hoist`
- Or: `npm install` (if pnpm is not available)

## Environment Variables

### Backend (.env file)
```env
GEMINI_API_KEY=your-gemini-api-key-here
```

### Frontend (optional, defaults work)
The frontend uses defaults in `apps/dojo/src/env.ts`:
- `LANGROID_URL` defaults to `http://localhost:8003`

To override, create `.env.local` in `apps/dojo/`:
```env
LANGROID_URL=http://localhost:8003
```

## What's Running Where

- **Backend**: http://localhost:8003/agentic_chat/
- **Frontend**: http://localhost:3000
- **Backend API Docs**: http://localhost:8003/docs (when backend is running)

## Next Steps

- Check out the agent code: `integrations/langroid/python/examples/server/api/agentic_chat.py`
- Modify the system message or add tools to customize the agent
- See Langroid docs: https://langroid.github.io/langroid/

