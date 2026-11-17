import { I18nProvider } from '@bestie/i18n';
import { ScaffoldPage } from '@bestie/ui';

export function App() {
  return (
    <I18nProvider>
      <ScaffoldPage app="pos" />
    </I18nProvider>
  );
}
