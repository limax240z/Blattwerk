import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { Dialog, DialogButton } from '../../components/Dialog';
import { useDocuments, type TabState } from '../../state/documents-store';
import { useUi } from '../../state/ui-store';
import styles from '../password/PasswordDialog.module.css';

// „Umbenennen …“: neuer Name im selben Ordner. Die Endung .pdf ergänzt die App; ungespeicherte Änderungen bleiben im Tab
// und landen beim nächsten Speichern in der umbenannten Datei.
export function RenameDialog({ tab }: { tab: TabState }) {
  const { t } = useTranslation();
  const [name, setName] = useState(tab.name.replace(/\.pdf$/i, ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => useUi.getState().setRenameTab(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const result = await api.renameFile(tab.fileId, name).catch(() => ({ ok: false as const, error: 'failed' as const }));
    setBusy(false);
    if (!result.ok) {
      setError(t(`rename.errors.${result.error}`));
      return;
    }
    useDocuments.getState().updateTab(tab.id, { name: result.file.name, dir: result.file.dir });
    close();
  };

  return (
    <Dialog
      title={t('rename.title')}
      onClose={close}
      onSubmit={() => void submit()}
      width={420}
      testId="rename-dialog"
      actions={
        <>
          <DialogButton onClick={close}>{t('prompt.cancel')}</DialogButton>
          <DialogButton type="submit" primary disabled={busy || name.trim() === ''} testId="rename-ok">
            {t('rename.ok')}
          </DialogButton>
        </>
      }
    >
      {error && (
        <p className={styles.error} role="alert" data-testid="rename-error">
          {error}
        </p>
      )}
      <label className={styles.field}>
        <span>{t('rename.label')}</span>
        <input
          className={styles.input}
          value={name}
          autoFocus
          onFocus={(event) => event.target.select()}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          data-testid="rename-input"
        />
      </label>
    </Dialog>
  );
}
