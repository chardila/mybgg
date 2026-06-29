import sys
from pathlib import Path

# Add scripts to sys.path so tests can import from compiler
scripts_path = str(Path(__file__).parent.parent / "scripts")
sys.path.insert(0, scripts_path)
