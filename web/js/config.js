// Sitenin genel ayarları (her kullanıcıda aynı).
//
// BACKUP_URL: Google Drive yedek sunucusunun adresi (tools/kotonoha-yedek.gs'yi Apps Script'te
// "Web uygulaması" olarak dağıtınca çıkan .../exec adresi). Boş bırakılırsa Drive yedeği kapalı;
// uygulama yalnızca dosyaya yedek alır.
export const BACKUP_URL = "https://script.google.com/macros/s/AKfycbwuhXJCJvRfuP_Mik7N-9FBpra0ZSiZid8nsHBH1CbG6q8PZoydtwg_lsUjoggCAeYc/exec";

// BACKUP_OWNER: yedeklerin saklandığı Google Drive'ın sahibi. Uygulama, Drive yedeğini açmadan önce
// kullanıcıya bunu açıkça söyler ve izin ister (uygulamayı tanımadığımız kişiler de kullanabilir).
export const BACKUP_OWNER = "Ferudun Keskin";
