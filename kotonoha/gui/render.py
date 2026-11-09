"""Ekranda gösterilen HTML parçaları.

Qt'nin kendi metin kutuları <ruby> etiketini (furigana) gösteremez;
bu yüzden içerik QWebEngineView içinde, gerçek bir tarayıcı motoruyla gösterilir.
Butonlar "http://kotonoha.app/<eylem>" bağlantılarıdır; tıklanınca
sayfa açılmaz, eylem Python tarafına iletilir.
"""
import html

from ..japanese import furigana

BASE_HTML = """<!doctype html><html><head><meta charset="utf-8">
<style>
:root{--bg:#f7f3ec;--card:#fffdf8;--ink:#2b2724;--muted:#8a8178;--line:#e6ddd0;
--accent:#b5523b;--accent2:#3e6b70;--ok:#4f7d4a;--bad:#b5523b;--me:#e9f0ef;}
*{box-sizing:border-box}
body{margin:0;padding:18px 22px 40px;background:var(--bg);color:var(--ink);
font:16px/1.75 "Yu Gothic UI","Meiryo","Noto Sans JP","Segoe UI",sans-serif;}
h1{font-size:22px;margin:4px 0 2px} h2{font-size:18px;margin:18px 0 8px}
.muted{color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;
padding:14px 18px;margin:12px 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.ja{font-size:20px;line-height:2.3}
ruby rt{font-size:.5em;color:#7b6f66}
.tr{display:none;color:var(--muted);font-size:14px;line-height:1.5;margin-top:2px}
body.show-tr .tr{display:block}
.tr.open{display:block}
a.btn{display:inline-block;text-decoration:none;color:#fff;background:var(--accent2);
padding:6px 14px;border-radius:999px;font-size:14px;margin:4px 6px 4px 0}
a.btn.alt{background:transparent;color:var(--accent2);border:1px solid var(--accent2)}
a.btn.warm{background:var(--accent)}
a.icon{text-decoration:none;font-size:15px;margin-left:6px;opacity:.75}
a.icon:hover{opacity:1}
.toggle{cursor:pointer;font-size:12px;color:var(--accent2);margin-left:6px;user-select:none}
.msg{display:flex;margin:10px 0}
.msg .b{max-width:82%;padding:10px 14px;border-radius:14px}
.msg.me{justify-content:flex-end} .msg.me .b{background:var(--me);border-bottom-right-radius:4px}
.msg.ai .b{background:var(--card);border:1px solid var(--line);border-bottom-left-radius:4px}
.fix{margin-top:8px;padding:8px 10px;border-left:3px solid var(--accent);background:#fbefe9;
border-radius:6px;font-size:14px;line-height:1.6}
.line{display:flex;gap:10px;padding:6px 0;border-bottom:1px dashed var(--line)}
.line:last-child{border-bottom:0}
.who{min-width:76px;color:var(--accent2);font-weight:600;font-size:14px;padding-top:8px}
table{border-collapse:collapse;width:100%} td,th{padding:6px 8px;border-bottom:1px solid var(--line);
text-align:left;vertical-align:top} th{font-size:13px;color:var(--muted);font-weight:600}
.opt{display:block;text-decoration:none;color:var(--ink);background:var(--card);
border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0;font-size:18px}
.opt:hover{border-color:var(--accent2)}
.opt.right{border-color:var(--ok);background:#eef5ec} .opt.wrong{border-color:var(--bad);background:#fbefe9}
.big{font-size:44px;text-align:center;margin:18px 0 6px;line-height:1.6}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;background:#efe7da;font-size:13px;margin:2px}
.bar{height:8px;background:#eadfce;border-radius:4px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent2)}
.thinking{color:var(--muted);font-style:italic}
</style></head>
<body><div id="main"></div>
<script>
function setMain(h){document.getElementById('main').innerHTML=h;window.scrollTo(0,0);}
function appendHtml(h){var d=document.createElement('div');d.innerHTML=h;
 document.getElementById('main').appendChild(d);window.scrollTo(0,document.body.scrollHeight);}
function removeId(id){var e=document.getElementById(id);if(e)e.remove();}
function setTr(on){document.body.classList.toggle('show-tr',on);}
</script></body></html>"""

ACTION_HOST = "kotonoha.app"


def act(path: str) -> str:
    return f"http://{ACTION_HOST}/{path}"


def esc(s) -> str:
    return html.escape(str(s or ""))


def para(s) -> str:
    return "".join(f"<p>{esc(p).replace(chr(10), '<br>')}</p>" for p in str(s or "").split("\n\n"))


TOGGLE = ('<span class="toggle" onclick="var t=this.parentNode.querySelector(\'.tr\');'
          'if(t)t.classList.toggle(\'open\')">TR</span>')


class Renderer:
    """Japonca metni furigana ayarına göre HTML'e çevirir."""

    def __init__(self, mode="unknown", known=None):
        self.mode = mode
        self.known = known or set()

    def ja(self, text) -> str:
        return furigana.to_ruby_html(str(text or ""), self.mode, self.known)

    # ---------- sohbet ----------
    def user_msg(self, text):
        return f'<div class="msg me"><div class="b">{esc(text).replace(chr(10), "<br>")}</div></div>'

    def ai_msg(self, data, speak_idx=None):
        speak = f'<a class="icon" href="{act(f"speak/{speak_idx}")}" title="Seslendir">🔊</a>' \
            if speak_idx is not None else ""
        tr = f'<div class="tr">{esc(data.get("reply_tr"))}</div>' if data.get("reply_tr") else ""
        fix = ""
        c = data.get("correction")
        if c:
            fix = (f'<div class="fix">✏️ 「{esc(c.get("original"))}」 → '
                   f'<b>「{self.ja(c.get("corrected"))}」</b><br>{esc(c.get("explanation_tr"))}</div>')
        words = ""
        if data.get("new_words"):
            words = '<div class="muted" style="margin-top:6px">Yeni: ' + " ".join(
                f'<span class="pill">{esc(w.get("word"))}（{esc(w.get("reading"))}）'
                f' {esc(w.get("meaning_tr"))}</span>'
                for w in data["new_words"] if isinstance(w, dict)) + "</div>"
        return (f'<div class="msg ai"><div class="b"><span class="ja">{self.ja(data.get("reply_ja"))}'
                f'</span>{speak}{TOGGLE if tr else ""}{tr}{fix}{words}</div></div>')

    @staticmethod
    def thinking(name):
        return f'<div id="thinking" class="thinking">{esc(name)} düşünüyor…</div>'

    @staticmethod
    def error(msg):
        return f'<div class="card" style="border-color:#e3b3a5">⚠️ {esc(msg)}</div>'

    # ---------- ünite adımları ----------
    def unit_header(self, unit, steps, steps_done, current):
        """steps: [(adım_id, ad)]"""
        dots = " ".join(
            f'<span class="pill" style="{"background:#dbe7e5;" if s in steps_done else ""}'
            f'{"outline:2px solid #3e6b70;" if s == current else ""}">'
            f'{"✓ " if s in steps_done else ""}{esc(n)}</span>' for s, n in steps)
        return (f'<div class="muted">{esc(unit["level_title"])} · {esc(unit["jlpt"])}</div>'
                f'<h1>{esc(unit["title_ja"])} <span class="muted">{esc(unit["title_tr"])}</span></h1>'
                f'<div class="muted">🎯 {esc(unit["can_do_tr"])}</div><div style="margin:6px 0">{dots}</div>')

    def scene(self, content, speak_start):
        sc = content["scene"]
        names = {c["id"]: c.get("name", c["id"]) for c in sc.get("characters", [])}
        roles = " · ".join(f'<b>{esc(c.get("name"))}</b>: {esc(c.get("role_tr"))}'
                           for c in sc.get("characters", []))
        lines = []
        for i, ln in enumerate(sc["lines"]):
            lines.append(
                f'<div class="line"><div class="who">{esc(names.get(ln.get("speaker"), ln.get("speaker")))}</div>'
                f'<div><span class="ja">{self.ja(ln.get("ja"))}</span>'
                f'<a class="icon" href="{act(f"speak/{speak_start + i}")}">🔊</a>{TOGGLE}'
                f'<div class="tr">{esc(ln.get("tr"))}</div></div></div>')
        return (f'<h2>場面 · Sahne</h2><div class="card"><div class="muted">{esc(sc.get("setting_tr"))}</div>'
                f'<div class="muted">{roles}</div></div>'
                f'<a class="btn" href="{act("playall")}">▶ Tümünü dinle</a>'
                f'<a class="btn alt" href="{act("stop")}">■ Durdur</a>'
                f'<div class="card">{"".join(lines)}</div>'
                f'<div class="muted">İpucu: Her repliği dinleyip yüksek sesle tekrar et (shadowing). '
                f'Çeviriyi görmek için TR\'ye tıkla. Sorularını aşağıya yazabilirsin.</div>')

    def vocab(self, content, speak_start):
        rows = []
        for i, w in enumerate(content["vocab"]):
            rows.append(
                f'<tr><td class="ja">{esc(w.get("word"))}<a class="icon" href="{act(f"speak/{speak_start + i}")}">🔊</a></td>'
                f'<td>{esc(w.get("reading"))}</td><td>{esc(w.get("meaning_tr"))}</td>'
                f'<td><span class="ja" style="font-size:16px">{self.ja(w.get("example_ja"))}</span>{TOGGLE}'
                f'<div class="tr">{esc(w.get("example_tr"))}</div></td></tr>')
        return (f'<h2>言葉 · Kelimeler</h2><div class="card"><table><tr><th>Kelime</th><th>Okunuş</th>'
                f'<th>Anlam</th><th>Örnek</th></tr>{"".join(rows)}</table></div>'
                f'<div class="muted">"Devam" dediğinde bu kelimeler tekrar listene eklenir.</div>')

    def grammar(self, content, speak_start):
        g = content["grammar"]
        ex = "".join(
            f'<div class="line"><div><span class="ja">{self.ja(e.get("ja"))}</span>'
            f'<a class="icon" href="{act(f"speak/{speak_start + i}")}">🔊</a>{TOGGLE}'
            f'<div class="tr">{esc(e.get("tr"))}</div></div></div>'
            for i, e in enumerate(g.get("examples", [])))
        return (f'<h2>文法 · Dilbilgisi: {esc(g.get("point"))}</h2>'
                f'<div class="card">{para(g.get("explanation_tr"))}</div>'
                f'<div class="card">{ex}</div>'
                f'<div class="muted">Anlamadığın bir yer varsa ya da kendi örnek cümleni denemek '
                f'istersen aşağıya yaz.</div>')

    def roleplay_intro(self, content):
        rp = content["roleplay"]
        return (f'<h2>演じる · Rol yapma</h2><div class="card">'
                f'<b>Sen:</b> {esc(rp.get("learner_role_tr"))}<br>'
                f'<b>Karşındaki:</b> {esc(rp.get("partner_name"))} — {esc(rp.get("partner_role_tr"))}<br>'
                f'<b>Görev:</b> {esc(rp.get("goal_tr"))}</div>'
                f'<a class="btn alt" href="{act("roleplay/end")}">Sahneyi bitir</a>')

    def writing_intro(self, content):
        w = content["writing"]
        return (f'<h2>書く · Yazma</h2><div class="card"><b>Görev:</b> {esc(w.get("task_tr"))}'
                f'<div class="muted">💡 {esc(w.get("hint_tr"))}</div></div>'
                f'<div class="muted">Metnini aşağıya yaz ve gönder (birkaç cümle).</div>')

    def writing_feedback(self, fb):
        comments = "".join(
            f'<div class="fix">「{esc(c.get("original"))}」 → <b>「{self.ja(c.get("corrected"))}」</b>'
            f'<br>{esc(c.get("explanation_tr"))}</div>'
            for c in fb.get("comments") or [] if isinstance(c, dict))
        try:
            score = int(float(fb.get("score", 0)) * 100)
        except (TypeError, ValueError):
            score = 0
        return (f'<div class="card"><b>Düzeltilmiş hali</b><div class="ja">{self.ja(fb.get("corrected_ja"))}</div>'
                f'{comments}<p>🌸 {esc(fb.get("praise_tr"))}</p><div class="muted">Puan: %{score}</div></div>')

    def quiz_question(self, q, qi, total, chosen=None):
        opts = []
        for oi, o in enumerate(q["options"]):
            cls = ""
            if chosen is not None:
                cls = "right" if oi == int(q["answer"]) else "wrong" if oi == chosen else ""
            href = act(f"quiz/{qi}/{oi}") if chosen is None else "#"
            opts.append(f'<a class="opt {cls}" href="{href}">{self.ja(o)}</a>')
        qja = f'<div class="ja">{self.ja(q.get("q_ja"))}</div>' if q.get("q_ja") else ""
        after = ""
        if chosen is not None:
            ok = chosen == int(q["answer"])
            after = (f'<div class="card">{"✅ Doğru!" if ok else "❌ Olmadı."} {esc(q.get("explain_tr"))}</div>'
                     f'<a class="btn" href="{act("quiz/next")}">Devam →</a>')
        return (f'<h2>確認 · Değerlendirme</h2><div class="muted">Soru {qi + 1} / {total}</div>'
                f'<div class="card"><b>{esc(q.get("q_tr"))}</b>{qja}</div>{"".join(opts)}{after}')

    @staticmethod
    def next_button(label="Devam →"):
        return f'<div style="margin-top:14px"><a class="btn warm" href="{act("next")}">{esc(label)}</a></div>'
