# Kotonoha 言の葉 — Japonca konuşma partneri

ABA English'in ünite mantığıyla (sahne → kelime → dilbilgisi → rol yapma → yazma → değerlendirme)
çalışan, avatarlı, hafızalı bir Japonca pratik programı.

## Kurulum (Anaconda Prompt)

```
conda create -n kotonoha python=3.11 -y
conda activate kotonoha
cd %USERPROFILE%\Documents\Kotonoha
pip install -r requirements.txt
python run.py
```

İlk açılışta **⚙ Ayarlar**'dan API anahtarını girin. Claude varsayılandır; OpenAI anahtarı da
girip "Kullanılacak" kısmından geçiş yapabilirsiniz. Anahtarlar Windows kayıt defterinde durur,
proje klasöründe değil; klasörü zip'leyip paylaşmak güvenlidir.

## Ses: VOICEVOX (isteğe bağlı ama önerilir)

1. https://voicevox.hiroshiba.jp adresinden VOICEVOX'u indirip kurun ve açın.
   Açık olduğu sürece arka planda `http://127.0.0.1:50021` adresinde çalışır.
2. Kotonoha'da **⚙ Ayarlar → Sesleri VOICEVOX'tan yükle**, sonra avatarın sesini ve sahnedeki
   ikinci kişinin sesini seçin.
3. Her VOICEVOX karakterinin kendi kullanım şartları vardır; program, kullanılan seslerin
   kredisini ("VOICEVOX:karakter adı") avatarın altında otomatik gösterir.

VOICEVOX kapalıysa avatar sessiz konuşur: ağız yine hareket eder ama ses çıkmaz.

## Avatar çizimi (kızınız için)

`avatar/` klasörüne **aynı tuval boyutunda, saydam arka planlı** PNG'ler konur.
En kolay yol: tek bir dosyada katmanlarla çizip her katmanı ayrı PNG olarak dışa aktarmak.

| Dosya | İçerik | Gerekli mi? |
|---|---|---|
| `base.png` | Karakterin tamamı; gözler açık, **ağız yok** | Evet |
| `mouth_closed.png` | Kapalı ağız | Önerilir |
| `mouth_a.png` | あ: geniş açık | Evet (tek ağız bu bile olur) |
| `mouth_i.png` | い: yana gergin, dar | İsteğe bağlı |
| `mouth_u.png` | う: küçük, yuvarlak | İsteğe bağlı |
| `mouth_e.png` | え: orta açık, yayvan | İsteğe bağlı |
| `mouth_o.png` | お: yuvarlak, orta | İsteğe bağlı |
| `eyes_closed.png` | Gözleri kapatan katman (göz kırpma) | Önerilir |

Ağız ve göz katmanları `base.png`'nin tam üstüne oturur; yalnızca ağız/göz bölgesi dolu,
gerisi saydam olmalıdır. Eksik ağız şekilleri en yakınıyla tamamlanır. Önerilen boyut:
800×1000 piksel civarı, dikey. Dosyalar konduktan sonra programı yeniden açın veya
Ayarlar'ı kaydedin.

Avatarın adını ve karakterini de **⚙ Ayarlar → Karakter**'den kızınız belirleyebilir.

## Nasıl çalışır

- **Üniteler**: 3 seviye × 8 ünite (Japonya'ya varıştan edebiyat konuşmaya). Her ünitenin
  içeriği ilk açılışta yapay zekâyla üretilir, sonra kaydedilir. Beğenilmezse ünite sayfasının
  altındaki bağlantıyla yeniden üretilebilir. Değerlendirmede %70 ve üstü üniteyi tamamlar.
- **Serbest sohbet**: Gündelik sohbet; hatalar birer birer düzeltilir.
- **Hafıza** (`data/kotonoha.db`): Oturum özetleri, öğrenci hakkında öğrenilenler, seviye
  tahmini, sık hatalar. Avatar her konuşmada bunları bilir. **📈 İlerleme** ekranında
  avatarın neyi bildiği açıkça görünür.
- **Kelime tekrarı**: Ünite ve sohbetten gelen kelimeler aralıklı tekrar (SRS) ile sorulur.
- **Furigana**: Bilgisayarda yerel olarak üretilir (fugashi). "Bilmediklerimde" ayarında,
  tekrarda iyi bilinen kelimelerin furiganası kendiliğinden kaybolur.

## Klasörler

```
Kotonoha/
├── run.py                  başlatıcı
├── requirements.txt
├── avatar/                 çizimler (PNG katmanları)
├── data/                   hafıza veritabanı (kişisel; paylaşmayın)
└── kotonoha/
    ├── llm/                Claude ve OpenAI bağlantısı
    ├── japanese/           furigana
    ├── memory/             SQLite hafıza + SRS
    ├── curriculum/         units.json (ünite listesi, düzenlenebilir)
    ├── tutor/              ders motoru ve yapay zekâ talimatları
    ├── voice/              VOICEVOX + dudak senkronu
    └── gui/                PyQt6 arayüzü
```

## Sıradakiler

- 2. aşama: Mikrofonla konuşma (faster-whisper, yerel) ve telaffuz geri bildirimi
- Görselden okuma (eski FuriJapan OCR'ı): tabela/menü fotoğrafı üzerine sohbet
- İfadeler (gülme, şaşırma) ve isteğe bağlı Live2D
