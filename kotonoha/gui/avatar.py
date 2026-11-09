"""Avatar: kızınızın çizimlerinden oluşan katmanlar ya da geçici bir siluet.

avatar/ klasörüne aynı boyutta, saydam arka planlı PNG'ler konur:
  base.png          gözleri açık, ağzı OLMAYAN (ya da kapalı) karakter   (zorunlu)
  eyes_closed.png   kapalı gözler katmanı                                   (göz kırpma)
  mouth_closed.png  kapalı ağız
  mouth_a.png  mouth_i.png  mouth_u.png  mouth_e.png  mouth_o.png         (あ い う え お)
Eksik ağız dosyaları en yakın şekille tamamlanır; yalnızca mouth_a.png bile yeter.
base.png yoksa program geçici siluet çizer.
"""
import random

from PyQt6.QtCore import Qt, QTimer, QRectF, QPointF
from PyQt6.QtGui import QPainter, QPixmap, QColor, QPainterPath, QLinearGradient, QPen
from PyQt6.QtWidgets import QWidget

MOUTH_FALLBACK = {
    "a": ["a", "o", "e"], "i": ["i", "e", "a"], "u": ["u", "o", "a"],
    "e": ["e", "i", "a"], "o": ["o", "a", "u"], "n": ["closed"], "closed": ["closed"],
}


class AvatarWidget(QWidget):
    def __init__(self, avatar_dir, parent=None):
        super().__init__(parent)
        self.setMinimumSize(260, 300)
        self.layers = {}
        self.mouth = "closed"
        self.blinking = False
        self.thinking = False
        self._dots = 0
        self.load(avatar_dir)

        self._blink = QTimer(self, singleShot=True)
        self._blink.timeout.connect(self._do_blink)
        self._schedule_blink()
        self._think_timer = QTimer(self, interval=400)
        self._think_timer.timeout.connect(self._tick_think)

    def load(self, avatar_dir):
        self.layers = {}
        for name in ["base", "eyes_closed", "mouth_closed", "mouth_a", "mouth_i",
                     "mouth_u", "mouth_e", "mouth_o"]:
            p = avatar_dir / f"{name}.png"
            if p.exists():
                pm = QPixmap(str(p))
                if not pm.isNull():
                    self.layers[name] = pm
        self.update()

    @property
    def has_art(self):
        return "base" in self.layers

    # ---------- durum ----------
    def set_mouth(self, mouth):
        if mouth != self.mouth:
            self.mouth = mouth
            self.update()

    def set_thinking(self, on):
        self.thinking = on
        if on:
            self._think_timer.start()
        else:
            self._think_timer.stop()
        self.update()

    def _tick_think(self):
        self._dots = (self._dots + 1) % 4
        self.update()

    def _schedule_blink(self):
        self._blink.start(random.randint(2500, 6000))

    def _do_blink(self):
        self.blinking = True
        self.update()
        QTimer.singleShot(140, self._end_blink)

    def _end_blink(self):
        self.blinking = False
        self.update()
        self._schedule_blink()

    # ---------- çizim ----------
    def paintEvent(self, ev):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        r = QRectF(self.rect()).adjusted(4, 4, -4, -4)
        g = QLinearGradient(r.topLeft(), r.bottomLeft())
        g.setColorAt(0, QColor("#7f95a3"))
        g.setColorAt(1, QColor("#3f4f5c"))
        path = QPainterPath()
        path.addRoundedRect(r, 16, 16)
        p.fillPath(path, g)
        p.setClipPath(path)
        if self.has_art:
            self._paint_art(p, r)
        else:
            self._paint_placeholder(p, r)
        if self.thinking:
            p.setPen(QColor("white"))
            f = p.font()
            f.setPointSize(16)
            p.setFont(f)
            p.drawText(r.adjusted(0, 8, -14, 0), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignTop,
                       "•" * self._dots)
        p.end()

    def _target(self, pm, r):
        s = min(r.width() / pm.width(), r.height() / pm.height())
        w, h = pm.width() * s, pm.height() * s
        return QRectF(r.center().x() - w / 2, r.bottom() - h, w, h)

    def _mouth_layer(self):
        for m in MOUTH_FALLBACK.get(self.mouth, ["closed"]):
            if f"mouth_{m}" in self.layers:
                return self.layers[f"mouth_{m}"]
        if self.mouth not in ("closed", "n") and "mouth_a" in self.layers:
            return self.layers["mouth_a"]
        return self.layers.get("mouth_closed")

    def _paint_art(self, p, r):
        base = self.layers["base"]
        t = self._target(base, r)
        p.drawPixmap(t, base, QRectF(base.rect()))
        if self.blinking and "eyes_closed" in self.layers:
            p.drawPixmap(t, self.layers["eyes_closed"], QRectF(base.rect()))
        m = self._mouth_layer()
        if m is not None:
            p.drawPixmap(t, m, QRectF(m.rect()))

    def _paint_placeholder(self, p, r):
        """Çizim gelene kadar sade bir siluet: saç, yüz, göz ve ağız şekilleri."""
        cx = r.center().x()
        u = min(r.width(), r.height()) / 10
        top = r.top() + r.height() * 0.18
        # omuzlar
        body = QPainterPath()
        body.moveTo(cx - 3.6 * u, r.bottom())
        body.cubicTo(cx - 3.4 * u, top + 6.6 * u, cx - 1.2 * u, top + 6.0 * u, cx, top + 6.0 * u)
        body.cubicTo(cx + 1.2 * u, top + 6.0 * u, cx + 3.4 * u, top + 6.6 * u, cx + 3.6 * u, r.bottom())
        p.fillPath(body, QColor("#1f1d22"))
        # arka saç
        p.setBrush(QColor("#2a2629"))
        p.setPen(Qt.PenStyle.NoPen)
        p.drawEllipse(QRectF(cx - 2.9 * u, top - 0.4 * u, 5.8 * u, 6.4 * u))
        # yüz
        p.setBrush(QColor("#f1d9c6"))
        p.drawEllipse(QRectF(cx - 2.0 * u, top + 0.9 * u, 4.0 * u, 4.8 * u))
        # kâkül
        bang = QPainterPath()
        bang.moveTo(cx - 2.6 * u, top + 2.6 * u)
        bang.cubicTo(cx - 2.6 * u, top - 0.6 * u, cx + 2.6 * u, top - 0.6 * u, cx + 2.6 * u, top + 2.6 * u)
        for i, dx in enumerate([2.0, 1.2, 0.4, -0.5, -1.4, -2.2]):
            bang.lineTo(cx + dx * u, top + (1.9 if i % 2 == 0 else 2.4) * u)
        bang.closeSubpath()
        p.fillPath(bang, QColor("#2a2629"))
        # gözler
        ey = top + 3.1 * u
        p.setPen(QPen(QColor("#2b2724"), max(2.0, u * 0.12)))
        for ex in (cx - 0.85 * u, cx + 0.85 * u):
            if self.blinking:
                p.drawLine(QPointF(ex - 0.35 * u, ey), QPointF(ex + 0.35 * u, ey))
            else:
                p.setBrush(QColor("#2b2724"))
                p.drawEllipse(QPointF(ex, ey), 0.22 * u, 0.3 * u)
        # ağız
        my = top + 4.55 * u
        sizes = {"a": (0.42, 0.42), "i": (0.5, 0.12), "u": (0.2, 0.22), "e": (0.42, 0.25),
                 "o": (0.3, 0.36)}
        p.setBrush(QColor("#9b4a45"))
        p.setPen(Qt.PenStyle.NoPen)
        if self.mouth in sizes:
            w, h = sizes[self.mouth]
            p.drawEllipse(QPointF(cx, my), w * u, h * u)
        else:
            p.setPen(QPen(QColor("#9b4a45"), max(2.0, u * 0.1)))
            p.drawLine(QPointF(cx - 0.3 * u, my), QPointF(cx + 0.3 * u, my))
        # not
        p.setPen(QColor(255, 255, 255, 150))
        f = p.font()
        f.setPointSize(8)
        p.setFont(f)
        p.drawText(r.adjusted(0, 0, 0, -6), Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignBottom,
                   "geçici siluet · avatar/ klasörüne çizim konunca değişir")
