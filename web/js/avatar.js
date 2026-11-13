// Avatar: Duygu'nun çizimleri gelene kadar sade bir siluet (masaüstüyle aynı).
// Çizimler sonraki sürümde cihazın kendisinden yüklenecek (internete gitmeden).

export class Avatar {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.mouth = "closed";
    this.blinking = false;
    this.thinking = false;
    this.sleeping = false;
    this.dots = 0;
    this.layers = {};
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.scheduleBlink();
    setInterval(() => { if (this.thinking) { this.dots = (this.dots + 1) % 4; this.draw(); } }, 400);
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(r.width * dpr));
    this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.draw();
  }

  setMouth(m) { if (m !== this.mouth) { this.mouth = m; this.draw(); } }
  setThinking(on) { this.thinking = on; this.draw(); }
  setSleeping(on) { this.sleeping = on; this.draw(); }

  scheduleBlink() {
    setTimeout(() => {
      this.blinking = true; this.draw();
      setTimeout(() => { this.blinking = false; this.draw(); this.scheduleBlink(); }, 140);
    }, 2500 + Math.random() * 3500);
  }

  draw() {
    const { ctx, cv } = this;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#7f95a3"); g.addColorStop(1, "#3f4f5c");
    ctx.fillStyle = g;
    roundRect(ctx, 0, 0, W, H, 16 * (window.devicePixelRatio || 1));
    ctx.fill();
    ctx.save();
    roundRect(ctx, 0, 0, W, H, 16 * (window.devicePixelRatio || 1));
    ctx.clip();
    this.drawPlaceholder(W, H);
    if (this.thinking) {
      ctx.fillStyle = "white";
      ctx.font = `${Math.round(H * 0.08)}px sans-serif`;
      ctx.textAlign = "right"; ctx.textBaseline = "top";
      ctx.fillText("•".repeat(this.dots), W - H * 0.04, H * 0.03);
    }
    ctx.restore();
  }

  drawPlaceholder(W, H) {
    const ctx = this.ctx;
    const cx = W / 2, u = Math.min(W, H) / 10, top = H * 0.18, bottom = H;
    // omuzlar
    ctx.fillStyle = "#1f1d22";
    ctx.beginPath();
    ctx.moveTo(cx - 3.6 * u, bottom);
    ctx.bezierCurveTo(cx - 3.4 * u, top + 6.6 * u, cx - 1.2 * u, top + 6 * u, cx, top + 6 * u);
    ctx.bezierCurveTo(cx + 1.2 * u, top + 6 * u, cx + 3.4 * u, top + 6.6 * u, cx + 3.6 * u, bottom);
    ctx.fill();
    // arka saç
    ctx.fillStyle = "#2a2629";
    ellipse(ctx, cx, top + 2.8 * u, 2.9 * u, 3.2 * u);
    // yüz
    ctx.fillStyle = "#f1d9c6";
    ellipse(ctx, cx, top + 3.3 * u, 2.0 * u, 2.4 * u);
    // kâkül
    ctx.fillStyle = "#2a2629";
    ctx.beginPath();
    ctx.moveTo(cx - 2.6 * u, top + 2.6 * u);
    ctx.bezierCurveTo(cx - 2.6 * u, top - 0.6 * u, cx + 2.6 * u, top - 0.6 * u, cx + 2.6 * u, top + 2.6 * u);
    [2.0, 1.2, 0.4, -0.5, -1.4, -2.2].forEach((dx, i) => ctx.lineTo(cx + dx * u, top + (i % 2 ? 2.4 : 1.9) * u));
    ctx.closePath(); ctx.fill();
    // gözler
    const ey = top + 3.1 * u;
    ctx.strokeStyle = ctx.fillStyle = "#2b2724";
    ctx.lineWidth = Math.max(2, u * 0.12);
    for (const ex of [cx - 0.85 * u, cx + 0.85 * u]) {
      if (this.blinking || this.sleeping) { ctx.beginPath(); ctx.moveTo(ex - 0.35 * u, ey); ctx.lineTo(ex + 0.35 * u, ey); ctx.stroke(); }
      else ellipse(ctx, ex, ey, 0.22 * u, 0.3 * u);
    }
    // ağız
    const my = top + 4.55 * u;
    const sizes = { a: [0.42, 0.42], i: [0.5, 0.12], u: [0.2, 0.22], e: [0.42, 0.25], o: [0.3, 0.36] };
    ctx.fillStyle = ctx.strokeStyle = "#9b4a45";
    if (sizes[this.mouth]) { const [w, h] = sizes[this.mouth]; ellipse(ctx, cx, my, w * u, h * u); }
    else {
      ctx.lineWidth = Math.max(2, u * 0.1);
      ctx.beginPath(); ctx.moveTo(cx - 0.3 * u, my); ctx.lineTo(cx + 0.3 * u, my); ctx.stroke();
    }
    // uyku: "z z z"
    if (this.sleeping) {
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      [[0, 0.9], [0.5, 1.15], [1.0, 1.4]].forEach(([dx, sz]) => {
        ctx.font = `bold ${Math.round(u * 0.55 * sz)}px sans-serif`;
        ctx.fillText("z", cx + (2.4 + dx) * u, top + (1.6 - dx * 0.9) * u);
      });
    }
    // not
    ctx.fillStyle = "rgba(255,255,255,.6)";
    ctx.font = `${Math.max(10, Math.round(H * 0.032))}px sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText("geçici siluet", cx, H - H * 0.02);
  }
}

function ellipse(ctx, x, y, rx, ry) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); }
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
