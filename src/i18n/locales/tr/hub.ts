import type { Translation } from '../../types';
import type en from '../en/hub';

/* Türkçe metinler: sitenin girişindeki ülke seçimi. */
const hub: Translation<typeof en> = {
  title: 'Ülkenizi seçin',
  subtitle: 'Her ülkenin kendi tezgahları, takımları, hesapları ve verileri vardır.',
  language: 'Uygulama dili: {{language}}',
  lastUsed: 'Son kullanılan',
  open: 'Aç',
  master: 'Ana yönetici',
  masterHint: 'Ana yöneticiler herhangi bir ülkeden de giriş yapabilir.',
};
export default hub;
