"""Kotonoha 言の葉 — Japonca konuşma partneri. Başlatmak için: python run.py"""
import sys

from PyQt6.QtWebEngineWidgets import QWebEngineView  # noqa: F401  (QApplication'dan önce yüklenmeli)
from PyQt6.QtWidgets import QApplication

from kotonoha.gui.main_window import MainWindow


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("Kotonoha")
    app.setOrganizationName("Kotonoha")
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
