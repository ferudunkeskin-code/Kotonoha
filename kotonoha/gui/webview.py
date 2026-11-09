import json

from PyQt6.QtCore import QUrl, pyqtSignal
from PyQt6.QtWebEngineCore import QWebEnginePage
from PyQt6.QtWebEngineWidgets import QWebEngineView

from .render import BASE_HTML, ACTION_HOST


class ActionPage(QWebEnginePage):
    """kotonoha.app bağlantılarını yakalayıp Python'a 'action' sinyali olarak iletir."""
    action = pyqtSignal(str)

    def acceptNavigationRequest(self, url, nav_type, is_main_frame):
        if url.host() == ACTION_HOST:
            self.action.emit(url.path().lstrip("/"))
            return False
        if url.scheme() in ("http", "https") and \
                nav_type == QWebEnginePage.NavigationType.NavigationTypeLinkClicked:
            return False  # dış bağlantıları açma
        return super().acceptNavigationRequest(url, nav_type, is_main_frame)


class ContentView(QWebEngineView):
    action = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        page = ActionPage(self)
        page.action.connect(self.action)
        self.setPage(page)
        self._ready = False
        self._queue = []
        self.loadFinished.connect(self._on_loaded)
        self.setHtml(BASE_HTML, QUrl("http://kotonoha.local/"))

    def _on_loaded(self, ok):
        self._ready = True
        for js in self._queue:
            self.page().runJavaScript(js)
        self._queue.clear()

    def _js(self, js):
        if self._ready:
            self.page().runJavaScript(js)
        else:
            self._queue.append(js)

    def set_main(self, html):
        self._js(f"setMain({json.dumps(html)})")

    def append(self, html):
        self._js(f"appendHtml({json.dumps(html)})")

    def remove(self, element_id):
        self._js(f"removeId({json.dumps(element_id)})")

    def set_translation(self, on: bool):
        self._js(f"setTr({'true' if on else 'false'})")
