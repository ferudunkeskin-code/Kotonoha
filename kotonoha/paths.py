"""Proje içindeki klasör yolları."""
import sys
from pathlib import Path

if getattr(sys, "frozen", False):          # PyInstaller ile exe yapılırsa
    ROOT = Path(sys.executable).resolve().parent
else:
    ROOT = Path(__file__).resolve().parent.parent

DATA_DIR = ROOT / "data"
AVATAR_DIR = ROOT / "avatar"
DB_PATH = DATA_DIR / "kotonoha.db"
CURRICULUM_PATH = Path(__file__).resolve().parent / "curriculum" / "units.json"

DATA_DIR.mkdir(parents=True, exist_ok=True)
AVATAR_DIR.mkdir(parents=True, exist_ok=True)
