import { ArrowLeft, ChevronRight, Combine, FilePlus2, FileText, FileType2, FolderOpen, Images, Pin, PinOff, Search, X, type LucideIcon } from 'lucide-react';
import appIcon from '../../../resources/icon.svg?url';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommandId } from '../../shared/commands';
import type { OpenResult, RecentFile } from '../../shared/ipc';
import type { TemplateInfo } from '../../shared/templates';
import { api } from '../api';
import type { Tone } from '../components/tone';
import { executeCommand, handleOpenResult, openWithDialog } from '../engine/session';
import { createTemplateThumbnail } from '../features/start/thumbnails';
import { useUi } from '../state/ui-store';
import styles from './StartScreen.module.css';

const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

// Weitere Wege zu einem Dokument: je Kachel Befehl, Symbol und Farbe des Arbeitsbereichs
const MORE: Array<{ command: CommandId; key: string; icon: LucideIcon; tone: Tone }> = [
  { command: 'file.combine', key: 'combine', icon: Combine, tone: 'pages' },
  { command: 'file.fromImages', key: 'fromImages', icon: Images, tone: 'sign' },
  { command: 'file.fromDocument', key: 'fromDocument', icon: FileType2, tone: 'forms' },
];

// Farblegende: welche Farbe für welchen Arbeitsbereich steht
const LEGEND: Tone[] = ['comment', 'edit', 'forms', 'pages', 'redact', 'sign'];

// Öffnen von der Startseite: Ergebnis wie üblich behandeln und die Überlagerung schließen (das Dokument kann auch in
// einem neuen Fenster erscheinen, ADR 0026)
function openFromHome(result: Promise<OpenResult>): void {
  void result.then(async (value) => {
    await handleOpenResult(value);
    useUi.getState().setHomeOpen(false);
  });
}

// Vorschaubilder der Vorlagen bleiben für die Sitzung im Speicher (erzeugen kostet einen Satz mit Chromium)
const templateThumbs = new Map<string, string | null>();

function matches(query: string, ...values: string[]): boolean {
  const needle = query.trim().toLocaleLowerCase('de');
  return needle === '' || values.some((value) => value.toLocaleLowerCase('de').includes(needle));
}

// Vorschaubilder für Vorlagen und zuletzt geöffnete Dateien. Fehlende Vorlagenbilder entstehen nacheinander.
function useThumbnails(recent: RecentFile[], templates: TemplateInfo[]) {
  const [recentThumbs, setRecentThumbs] = useState<Record<string, string | null>>({});
  const [templateVersion, setTemplateVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const paths = recent.map((file) => file.path);
    const ids = templates.map((template) => template.id).filter((id) => !templateThumbs.has(id));
    void api.thumbnails
      .get({ recent: paths, templates: ids })
      .then(async (result) => {
        if (cancelled) return;
        setRecentThumbs(result.recent);
        const missing: string[] = [];
        for (const id of ids) {
          const url = result.templates[id] ?? null;
          if (url) templateThumbs.set(id, url);
          else missing.push(id);
        }
        setTemplateVersion((v) => v + 1);
        // Erst kurz warten: Beim Start mit einer Datei ist die Startseite nur einen Augenblick zu sehen
        if (missing.length > 0) await new Promise((resolve) => setTimeout(resolve, 800));
        for (const id of missing) {
          if (cancelled) return;
          templateThumbs.set(id, await createTemplateThumbnail(id).catch(() => null));
          setTemplateVersion((v) => v + 1);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [recent, templates]);

  return { recentThumbs, templateThumb: (id: string) => templateThumbs.get(id) ?? null, templateVersion };
}

function TemplateCard({
  template,
  thumb,
  onRemove,
}: {
  template: TemplateInfo;
  thumb: string | null;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const key = template.id.replace(/^builtin:/, '');
  return (
    <li className={styles.card} data-testid="template-card" data-template-id={template.id}>
      <button type="button" className={styles.cardButton} title={template.name} onClick={() => openFromHome(api.templates.open(template.id))}>
        <span className={styles.paper}>{thumb ? <img src={thumb} alt="" /> : <FileText size={28} strokeWidth={1.25} aria-hidden="true" />}</span>
        <span className={styles.cardName}>{template.name}</span>
        <span className={styles.cardDetail}>{template.builtin ? t(`templates.details.${key}`) : t('start.ownTemplate')}</span>
      </button>
      {onRemove && !confirming && (
        <button
          type="button"
          className={styles.cardRemove}
          aria-label={t('start.removeTemplate')}
          data-tooltip={t('start.removeTemplate')}
          onClick={() => setConfirming(true)}
          data-testid="template-remove"
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
      {onRemove && confirming && (
        <div className={styles.cardConfirm}>
          <span>{t('start.removeTemplateQuestion')}</span>
          <button type="button" className={styles.danger} onClick={onRemove} data-testid="template-remove-confirm">
            {t('start.removeTemplateConfirm')}
          </button>
          <button type="button" className={styles.linkButton} onClick={() => setConfirming(false)}>
            {t('start.cancel')}
          </button>
        </div>
      )}
    </li>
  );
}

function RecentItem({ file, thumb }: { file: RecentFile; thumb: string | null }) {
  const { t } = useTranslation();
  const setRecent = useUi((s) => s.setRecent);
  return (
    <li className={styles.item} data-testid="recent-item" data-pinned={file.pinned ? 'true' : undefined}>
      <button type="button" className={styles.itemButton} title={file.path} onClick={() => openFromHome(api.recent.open(file.path))}>
        <span className={styles.itemThumb}>{thumb ? <img src={thumb} alt="" /> : <FileText size={18} strokeWidth={1.5} aria-hidden="true" />}</span>
        <span className={styles.itemText}>
          <span className={styles.itemName}>{file.name}</span>
          <span className={styles.itemDir}>{file.dir}</span>
        </span>
        <span className={styles.itemDate}>{dateFormat.format(file.openedAt)}</span>
      </button>
      <span className={styles.itemActions}>
        <button
          type="button"
          className={styles.itemAction}
          aria-label={file.pinned ? t('start.unpin') : t('start.pin')}
          data-tooltip={file.pinned ? t('start.unpin') : t('start.pin')}
          aria-pressed={file.pinned === true}
          onClick={() => void api.recent.pin(file.path, !file.pinned).then(setRecent)}
          data-testid="recent-pin"
        >
          {file.pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={styles.itemAction}
          aria-label={t('start.remove')}
          data-tooltip={t('start.remove')}
          onClick={() => void api.recent.remove(file.path).then(setRecent)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </span>
    </li>
  );
}

// Startseite wie in Word (ADR 0028): Vorlagen-Galerie, weitere Wege zu einem Dokument, zuletzt geöffnete Dateien mit
// Vorschaubild und Anheften, Suche über beides. Als Überlagerung (Home-Knopf) liegt sie über den offenen Dokumenten.
export function StartScreen({ overlay = false }: { overlay?: boolean }) {
  const { t } = useTranslation();
  const recent = useUi((s) => s.recent);
  const setRecent = useUi((s) => s.setRecent);
  const setHomeOpen = useUi((s) => s.setHomeOpen);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const load = () => void api.templates.list().then(setTemplates).catch(() => undefined);
    load();
    const off = api.templates.onChanged(load);
    // Die Liste kann sich in einem anderen Fenster geändert haben
    void api.recent.list().then(setRecent).catch(() => undefined);
    return off;
  }, [setRecent]);

  // Als Überlagerung: Esc kehrt zum Dokument zurück (außer in der Suche, dort leert Esc erst das Feld)
  useEffect(() => {
    if (!overlay) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.activeElement === searchRef.current && searchRef.current?.value) return;
      setHomeOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, setHomeOpen]);

  const { recentThumbs, templateThumb } = useThumbnails(recent, templates);

  const blankName = t('start.blankName');
  const shownTemplates = useMemo(() => templates.filter((template) => matches(query, template.name)), [templates, query]);
  const showBlank = matches(query, blankName);
  const shownRecent = recent.filter((file) => matches(query, file.name, file.dir));
  const pinned = shownRecent.filter((file) => file.pinned);
  const others = shownRecent.filter((file) => !file.pinned);
  const hasUserTemplates = templates.some((template) => !template.builtin);
  const nothing = query.trim() !== '' && !showBlank && shownTemplates.length === 0 && shownRecent.length === 0;

  return (
    <div className={[styles.screen, overlay ? styles.overlay : ''].join(' ')} data-testid="start-screen" data-overlay={overlay || undefined}>
      <div className={styles.inner}>
        <header className={styles.masthead}>
          <img className={styles.mark} src={appIcon} alt="" aria-hidden="true" />
          <div className={styles.titles}>
            <h1 className={styles.title}>{t('start.title')}</h1>
            <p className={styles.tagline}>{t('start.tagline')}</p>
          </div>
          <label className={styles.search}>
            <Search size={15} strokeWidth={2} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={t('start.searchPlaceholder')}
              aria-label={t('start.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  event.preventDefault();
                  setQuery('');
                }
              }}
              data-testid="start-search"
            />
          </label>
          {overlay && (
            <button type="button" className={styles.back} onClick={() => setHomeOpen(false)} data-testid="start-back">
              <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
              {t('start.backToDocument')}
            </button>
          )}
        </header>

        {nothing && <p className={styles.empty}>{t('start.noResults', { query: query.trim() })}</p>}

        {(showBlank || shownTemplates.length > 0) && (
          <section aria-labelledby="new-heading" className={styles.gallerySection}>
            <h2 id="new-heading" className={styles.sectionTitle}>
              {t('start.create')}
            </h2>
            <ul className={styles.gallery}>
              {showBlank && (
                <li className={styles.card}>
                  <button type="button" className={styles.cardButton} onClick={() => {
                      executeCommand('file.newBlank');
                      setHomeOpen(false);
                    }} data-testid="start-blank">
                    <span className={[styles.paper, styles.blankPaper].join(' ')}>
                      <FilePlus2 size={26} strokeWidth={1.25} aria-hidden="true" />
                    </span>
                    <span className={styles.cardName}>{blankName}</span>
                    <span className={styles.cardDetail}>{t('start.tiles.blank.detail')}</span>
                  </button>
                </li>
              )}
              {shownTemplates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  thumb={templateThumb(template.id)}
                  onRemove={template.builtin ? undefined : () => void api.templates.remove(template.id).then(setTemplates)}
                />
              ))}
            </ul>
            {!hasUserTemplates && query.trim() === '' && <p className={styles.hint}>{t('start.templateHint')}</p>}
          </section>
        )}

        <div className={styles.columns}>
          <div className={styles.main}>
            <div className={styles.openRow}>
              <button type="button" className={styles.openButton} onClick={() => void openWithDialog().then(() => setHomeOpen(false))}>
                <FolderOpen size={19} strokeWidth={1.75} aria-hidden="true" />
                {t('start.open')}
              </button>
              <p className={styles.hint}>{t('start.dropHint')}</p>
            </div>

            <section aria-labelledby="more-heading">
              <h2 id="more-heading" className={styles.sectionTitle}>
                {t('start.more')}
              </h2>
              <div className={styles.tiles}>
                {MORE.map(({ command, key, icon: Icon, tone }) => (
                  <button key={key} type="button" className={styles.tile} data-tone={tone} onClick={() => {
                      executeCommand(command);
                      setHomeOpen(false);
                    }} data-testid={`start-${key}`}>
                    <span className={styles.tileIcon}>
                      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <span className={styles.tileText}>
                      <span className={styles.tileTitle}>{t(`start.tiles.${key}.title`)}</span>
                      <span className={styles.tileDetail}>{t(`start.tiles.${key}.detail`)}</span>
                    </span>
                    <ChevronRight size={15} strokeWidth={2} className={styles.chevron} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </section>

            <section className={styles.legend} aria-labelledby="legend-heading">
              <h2 id="legend-heading" className={styles.sectionTitle}>
                {t('start.legend')}
              </h2>
              <ul className={styles.legendList}>
                {LEGEND.map((tone) => (
                  <li key={tone} data-tone={tone} className={styles.legendItem}>
                    <span className={styles.swatch} aria-hidden="true" />
                    {t(`start.tones.${tone}`)}
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section className={styles.recent} aria-labelledby="recent-heading">
            {pinned.length > 0 && (
              <>
                <h2 className={styles.sectionTitle}>{t('start.pinned')}</h2>
                <ul className={[styles.list, styles.pinnedList].join(' ')} data-testid="pinned-list">
                  {pinned.map((file) => (
                    <RecentItem key={file.path} file={file} thumb={recentThumbs[file.path] ?? null} />
                  ))}
                </ul>
              </>
            )}
            {(others.length > 0 || recent.length === 0) && (
              <>
                <div className={styles.recentHeader}>
                  <h2 id="recent-heading" className={styles.sectionTitle}>
                    {t('start.recent')}
                  </h2>
                  {others.length > 0 && (
                    <button type="button" className={styles.linkButton} onClick={() => void api.recent.clear().then(setRecent)}>
                      {t('start.clear')}
                    </button>
                  )}
                </div>
                {others.length === 0 ? (
                  <p className={styles.empty}>{t('start.noRecent')}</p>
                ) : (
                  <ul className={styles.list} data-testid="recent-list">
                    {others.map((file) => (
                      <RecentItem key={file.path} file={file} thumb={recentThumbs[file.path] ?? null} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
