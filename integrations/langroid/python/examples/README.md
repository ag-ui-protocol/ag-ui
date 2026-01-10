# Langroid AG-UI Examples

Simple example demonstrating Langroid integration with AG-UI.

## Setup

**⚠️ Important:** Use **Python 3.11 or 3.12** (not 3.13) to avoid `lxml` build errors on Windows.

1. **Install Poetry** (if not already installed):
   ```bash
   pip install poetry
   ```

2. **Set Python version** (if needed):
   ```powershell
   poetry env use python3.11
   ```

3. **Install dependencies:**
   ```bash
   # From the examples directory
   poetry install
   ```

**If you get `lxml` build errors:** See [FIX_NOW.md](./FIX_NOW.md) for quick fix.

3. **Create a `.env` file** in the examples directory:
   ```env
   GEMINI_API_KEY=your-gemini-api-key-here
   ```
   
   **Note:** You can get a Gemini API key from [Google AI Studio](https://makersuite.google.com/app/apikey).

## Running

Run the agentic chat example:

```bash
poetry run python -m server
```

The server will start on `http://localhost:8003/agentic_chat/`

## Example

- **agentic_chat.py** - Simple conversational agent using Langroid's ChatAgent

## Usage

Once running, connect to the server using any AG-UI compatible client (like Dojo) at `http://localhost:8003/agentic_chat/`.
