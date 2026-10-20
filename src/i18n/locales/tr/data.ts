import type { Translation } from '../../types';
import type en from '../en/data';

/* Türkçe metinler: data. */
const data: Translation<typeof en> = {
  backup: {
    title: 'Yedekleme ve geri yükleme',
    descBefore: 'Her şeyi tek bir JSON dosyası olarak indirin veya bir yedek dosyasını geri yükleyin. Eski sürüm dosyaları (',
    descAfter: ') da içe aktarılabilir; böylece arşivlenmiş geçmiş geri gelir.',
    download: 'Tam yedeği indir',
    includePrograms: 'G-kodu dosyalarını dahil et (dosya büyür)',
    restore: 'Yedek dosyasını geri yükle / içe aktar...',
    replaceTools: 'Takım listesini dosyadakiyle değiştir',
    reading: '{{name}} okunuyor ({{size}} KB)...',
    invalidJson: 'Bu dosya geçerli bir JSON dosyası değil.',
  },
  retention: {
    title: 'Geçmiş temizliği (isteğe bağlı)',
    description:
      'Geçmiş, 30 günden sonra artık operatörleri engellemiyor. Ücretsiz veritabanı yıllarca kayıt tutabilir; bu yüzden temizlik yalnızca isterseniz gereklidir.',
    olderThan: 'Şundan eski kayıtları sil:',
    days: 'gün',
    archiveDelete: 'Arşivle ve sil',
    clearAll: 'Tüm geçmişi temizle',
    done: 'Tamamlandı',
    confirmPrune:
      '{{days}} günden eski geçmiş kayıtları (ve kayıtlı G-kodu dosyaları) silinsin mi?\n\nSilinen kayıtların JSON arşivi önce indirilir.',
    confirmClearAll:
      'TÜM geçmiş kayıtları ve kayıtlı G-kodu dosyaları silinsin mi?\n\nÖnce tam bir JSON arşivi indirilir. "Kazanılan süre" sayacı sıfırlanmaz.',
    typeToConfirm: 'Onaylamak için {{word}} yazın',
    deleteWord: 'SİL',
    noneOlder: '{{days}} günden eski kayıt yok.',
    removed: 'Arşiv indirildi, {{count}} kayıt silindi.',
  },
  log: {
    createdAccounts: 'Oluşturulan hesaplar: {{names}}',
    keptAccounts: 'Zaten mevcut, olduğu gibi bırakıldı: {{names}}',
    historyProgress: 'Geçmiş: {{done}}/{{total}} işlendi',
    partsImported: 'Parça kayıtları: {{total}} kayıttan {{inserted}} tanesi yeni',
    downloadingTools: 'Takım listesi indiriliyor...',
    downloadingAccounts: 'Hesaplar indiriliyor...',
    downloadingHistory: 'Geçmiş indiriliyor...',
    historyCount: 'Geçmiş: {{count}} kayıt...',
    downloadingParts: 'Parça kayıtları indiriliyor...',
    programsCount: 'Programlar: {{done}}/{{total}}...',
    backupReady: 'Yedek hazır.',
    toolsReplaced: 'Takım listesi değiştirildi: {{count}} takım.',
    toolsSkipped:
      'Dosyadaki takım listesi atlandı (geri yüklemek için "Takım listesini dosyadakiyle değiştir" seçeneğini işaretleyin).',
    importingHistory: '{{count}} geçmiş kaydı içe aktarılıyor...',
    historyRestored: 'Geçmiş: {{added}} yeni kayıt eklendi, {{present}} kayıt zaten mevcuttu.',
    restoreFinished: 'Geri yükleme tamamlandı.',
  },
  errors: {
    notBackup: 'Bu dosya bir CNC Process Pro yedeği değil',
    emptyBackup: 'Bu dosyada geçmiş, takım veya parça kaydı bulunamadı',
  },
};
export default data;
