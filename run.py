"""Kotonoha 言の葉 — Japonca konuşma partneri. Başlatmak için: python run.py"""
import sys
import traceback

from PyQt6.QtWebEngineWidgets import QWebEngineView  # noqa: F401  (QApplication'dan önce yüklenmeli)
from PyQt6.QtWidgets import QApplication

from kotonoha.gui.main_window import MainWindow


def _excepthook(exc_type, exc, tb):
    """Beklenmeyen bir hata programı kapatmasın: ayrıntıyı konsola yaz, kısaca göster."""
    traceback.print_exception(exc_type, exc, tb)
    try:
        from PyQt6.QtWidgets import QMessageBox
        QMessageBox.warning(None, "Kotonoha · Hata",
                            f"Beklenmeyen bir hata oldu:\n\n{exc_type.__name__}: {exc}\n\n"
                            "Ayrıntı Anaconda Prompt penceresinde.")
    except Exception:
        pass


def main():
    sys.excepthook = _excepthook
    app = QApplication(sys.argv)
    app.setApplicationName("Kotonoha")
    app.setOrganizationName("Kotonoha")
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
