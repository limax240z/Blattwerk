import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { Dialog, DialogButton } from '../../components/Dialog';
import { useUi } from '../../state/ui-store';
import pageStyles from '../pages/PageDialogs.module.css';
import styles from '../password/PasswordDialog.module.css';

// Vollbild gibt es auf iPad und iPhone nicht
const canFullscreen = () => document.documentElement.dataset.platform !== 'ipad';

// Einstellungen: Name, der bei neuen Kommentaren als Verfasser eingetragen wird; Lesemodus mit oder ohne Vollbild.
export function SettingsDialog() {
  const { t } = useTranslation();
  const [name, setName] = useState(useUi.getState().authorName);
  const [fullscreen, setFullscreen] = useState(useUi.getState().readModeFullscreen);
  const close = () => useUi.getState().setSettingsOpen(false);

  const submit = () => {
    const value = name.trim();
    const ui = useUi.getState();
    void api
      .setAuthorName(value)
      .then(() => (canFullscreen() && fullscreen !== ui.readModeFullscreen ? api.setReadModeFullscreen(fullscreen) : api.getSettings()))
      .then((settings) => useUi.getState().applySettings(settings));
    close();
  };

  return (
    <Dialog
      title={t('settings.title')}
      onClose={close}
      onSubmit={submit}
      width={380}
      testId="settings-dialog"
      actions={
        <>
          <DialogButton onClick={close}>{t('settings.cancel')}</DialogButton>
          <DialogButton type="submit" primary disabled={!name.trim()} testId="settings-save">
            {t('settings.save')}
          </DialogButton>
        </>
      }
    >
      <label className={styles.field}>
        <span>{t('settings.authorName')}</span>
        <input
          className={styles.input}
          value={name}
          maxLength={200}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          data-testid="settings-author"
        />
      </label>
      <p className={styles.hint}>{t('settings.authorHint')}</p>
      {canFullscreen() && (
        <>
          <label className={pageStyles.check} style={{ marginTop: 'var(--space-4)' }}>
            <input type="checkbox" checked={fullscreen} onChange={(event) => setFullscreen(event.target.checked)} data-testid="settings-read-fullscreen" />
            {t('settings.readModeFullscreen')}
          </label>
          <p className={styles.hint}>{t('settings.readModeHint')}</p>
        </>
      )}
    </Dialog>
  );
}
