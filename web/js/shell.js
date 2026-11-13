// Sayfa iskeleti: üç dilin index.html'i aynı iskeleti kullanır (yalnızca başlık, simge ve
// manifest farklı). Böylece arayüzdeki bir değişiklik tek yerden yapılır.
import { esc } from "./furigana.js";

export function buildShell(pack) {
  document.body.classList.add("lang-" + pack.code);
  if (!pack.furigana) document.body.classList.add("no-ruby");
  const furi = pack.furigana ? `
      <select id="sel-furi" aria-label="Furigana">
        <option value="unknown">Furigana: bilmediklerimde</option>
        <option value="all">Furigana: hepsinde</option>
        <option value="none">Furigana: kapalı</option>
      </select>` : "";
  document.body.innerHTML = `
<div id="app">
  <aside id="side">
    <div class="avatar-wrap"><canvas id="avatar" aria-label="Avatar"></canvas></div>
    <div class="side-info">
      <div id="char-name" class="char-name"></div>
      <nav id="nav">
        <button data-nav="home">🏠<span>Ana sayfa</span></button>
        <button data-nav="free">💬<span>Serbest sohbet</span></button>
        <button data-nav="text">📄<span>Metinle çalış</span></button>
        <button data-nav="progress">📈<span>İlerleme</span></button>
        <button data-nav="settings">⚙️<span>Ayarlar</span></button>
      </nav>
    </div>
  </aside>
  <section id="right">
    <header id="top">
      <h1 id="title">${esc(pack.appName)}</h1>
      <label class="tr-toggle"><input type="checkbox" id="chk-tr"> Türkçe</label>${furi}
    </header>
    <div id="update-bar" hidden>✨ ${esc(pack.appName)} için yeni sürüm hazır. <button id="btn-update">Güncelle</button></div>
    <main id="main"><div id="content"></div></main>
    <div id="vbar" hidden>
      <span id="vbar-state">🎧</span>
      <span id="vbar-text"></span>
      <span class="vctl" title="Sıra geçme süresi: sustuktan kaç saniye sonra gönderilsin">⏱
        <button data-vctl="wait-">−</button><b id="vctl-wait">1.4</b><button data-vctl="wait+">+</button></span>
      <span class="vctl" title="Avatarın konuşma hızı">🗣
        <button data-vctl="rate-">−</button><b id="vctl-rate">0.90</b><button data-vctl="rate+">+</button></span>
      <button id="vbar-off" title="Konuşma modunu kapat">✕</button>
    </div>
    <footer id="composer">
      <textarea id="input" rows="2" placeholder="${esc(pack.nameTr)} (ya da Türkçe) yaz…" disabled></textarea>
      <button id="btn-voice" title="Konuşma modu" disabled>🎧</button>
      <button id="btn-mic" title="Konuş" disabled>🎤</button>
      <button id="btn-send" disabled>Gönder</button>
    </footer>
  </section>
</div>
<div id="toast" role="status"></div>`;
}
