from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path.home() / ".frameforge"
JOBS_FILE = DATA_DIR / "jobs.json"
TEMP_DIR = DATA_DIR / "tmp"
OUTPUT_DIR = DATA_DIR / "output"

for d in [DATA_DIR, TEMP_DIR, OUTPUT_DIR]:
    d.mkdir(parents=True, exist_ok=True)
