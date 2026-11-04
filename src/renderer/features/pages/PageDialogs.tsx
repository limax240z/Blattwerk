import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chunkPages, formatPageRanges, pageSelection, parsePageRanges, splitAtPages, type Margins } from '../../../shared/pages';
import { Dialog, DialogButton } from '../../components/Dialog';
import { IconButton } from '../../components/IconButton';
import { getRuntime } from '../../engine/runtime';
import { useDocuments, type TabState } from '../../state/documents-store';
import { useUi, type PageDialog, type SourceFile } from '../../state/ui-store';
import fieldStyles from '../password/PasswordDialog.module.css';
import {
  combineSources,
  cropPages,
  deletePages,
  extractPages,
  insertBlankPages,
  insertSources,
  pickSources,
  replacePages,
  splitDocument,
} from './actions';
import { topLevelBookmarkPages } from './bookmarks';
import styles from './PageDialogs.module.css';

const close = () => useUi.getState().setPageDialog(null);

// Eingabefeld für Seitenangaben wie „1-3, 5“ mit Prüfung
function PageRangeField({
  value,
  onChange,
  invalid,
  pageCount,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid: string | null;
  pageCount: number;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <label className={fieldStyles.field}>
        <span>{t('pages.dialog.pages', { count: pageCount })}</span>
        <input
          className={fieldStyles.input}
          value={value}
          autoFocus
          onChange={(event) => onChange(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          data-testid={testId}
        />
      </label>
      <p className={fieldStyles.hint}>{t('pages.dialog.pagesHint')}</p>
      {invalid && (
        <p className={fieldStyles.error} role="alert">
          {invalid}
        </p>
      )}
    </>
  );
}

function DeleteDialog({ tab, pages }: { tab: TabState; pages: number[] }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(formatPageRanges(pages));
  const [invalid, setInvalid] = useState<string | null>(null);
  const submit = () => {
    const parsed = parsePageRanges(value, tab.pageCount);
    if (!parsed) return setInvalid(t('pages.dialog.invalidPages', { count: tab.pageCount }));
    if (parsed.length >= tab.pageCount) return setInvalid(t('errors.pages.all-pages'));
    close();
    void deletePages(tab, parsed);
  };
  return (
    <Dialog
      title={t('pages.dialog.deleteTitle')}
      onClose={close}
      onSubmit={submit}
      width={380}
      testId="delete-pages-dialog"
      actions={
        <>
          <DialogButton onClick={close}>{t('pages.dialog.cancel')}</DialogButton>
          <DialogButton type="submit" primary testId="delete-pages-ok">
            {t('pages.dialog.delete')}
          </DialogButton>
        </>
      }
    >
      <PageRangeField value={value} onChange={(v) => (setValue(v), setInvalid(null))} invalid={invalid} pageCount={tab.pageCount} testId="delete-pages-input" />
    </Dialog>
  );
}

// Seiten ersetzen: welche Seiten dieses Dokuments durch welche der gewählten Datei (gleich viele)
function ReplaceDialog({ tab, pages, source }: { tab: TabState; pages: number[]; source: SourceFile }) {
  const { t } = useTranslation();
  const count = source.pageCount;
  const [targets, setTargets] = useState(formatPageRanges(pages));
  const [sources, setSources] = useState(formatPageRanges(Array.from({ length: Math.min(pages.length, count) }, (_, i) => i)));
  const [invalid, setInvalid] = useState<string | null>(null);
  const submit = () => {
    const parsedTargets = parsePageRanges(targets, tab.pageCount);
    if (!parsedTargets) return setInvalid(t('pages.dialog.invalidPages', { count: tab.pageCount }));
    // Beide Angaben aufsteigend: die erste genannte Seite ersetzt die erste genannte usw.
    const parsedSources = parsePageRanges(sources, count);
    if (!parsedSources) return setInvalid(t('pages.dialog.invalidPages', { count }));
    if (parsedSources.length !== parsedTargets.length) return setInvalid(t('pages.dialog.replaceMismatch', { targets: parsedTargets.length, sources: parsedSources.length }));
    close();
    void replacePages(tab, parsedTargets, source, parsedSources);
  };
  return (
    <Dialog
      title={t('pages.dialog.replaceTitle')}
      onClose={close}
      onSubmit={submit}
      width={420}
      testId="replace-pages-dialog"
      actions={
        <>
          <DialogButton onClick={close}>{t('pages.dialog.cancel')}</DialogButton>
          <DialogButton type="submit" primary testId="replace-pages-ok">
            {t('pages.dialog.replace')}
          </DialogButton>
        </>
      }
    >
      <label className={fieldStyles.field}>
        <span>{t('pages.dialog.replaceTargets', { count: tab.pageCount })}</span>
        <input className={fieldStyles.input} value={targets} autoFocus onChange={(event) => (setTargets(event.target.value), setInvalid(null))} data-testid="replace-targets" />
      </label>
      <label className={fieldStyles.field}>
        <span>{t('pages.dialog.replaceSources', { name: source.name, count })}</span>
        <input className={fieldStyles.input} value={sources} onChange={(event) => (setSources(event.target.value), setInvalid(null))} data-testid="replace-sources" />
      </label>
      <p className={fieldStyles.hint}>{t('pages.dialog.pagesHint')}</p>
      {invalid && (
        <p className={fieldStyles.error} role="alert">
          {invalid}
        </p>
      )}
    </Dialog>
  );
}

const MM = 72 / 25.4;

// Seiten zuschneiden: vier Ränder in Millimetern für die gewählten Seiten
function CropDialog({ tab, pages }: { tab: TabState; pages: number[] }) {
  const { t } = useTranslation();
  const [range, setRange] = useState(formatPageRanges(pages));
  const [values, setValues] = useState<Record<keyof Margins, string>>({ top: '10', right: '10', bottom: '10', left: '10' });
  const [invalid, setInvalid] = useState<string | null>(null);
  const submit = () => {
    const parsed = parsePageRanges(range, tab.pageCount);
    if (!parsed) return setInvalid(t('pages.dialog.invalidPages', { count: tab.pageCount }));
    const numbers = Object.fromEntries(Object.entries(values).map(([side, text]) => [side, Number(text.replace(',', '.').trim())])) as Record<keyof Margins, number>;
    if (Object.values(numbers).some((value) => !Number.isFinite(value) || value < 0)) return setInvalid(t('pages.dialog.invalidMargins'));
    close();
    void cropPages(tab, parsed, { top: numbers.top * MM, right: numbers.right * MM, bottom: numbers.bottom * MM, left: numbers.left * MM });
  };
  const sides: Array<keyof Margins> = ['top', 'right', 'bottom', 'left'];
  const label = { top: 'cropTop', right: 'cropRight', bottom: 'cropBottom', left: 'cropLeft' } as const;
  return (
    <Dialog
      title={t('pages.dialog.cropTitle')}
      onClose={close}
      onSubmit={submit}
      width={400}
      testId="crop-pages-dialog"
      actions={
        <>
          <DialogButton onClick={close}>{t('pages.dialog.cancel')}</DialogButton>
          <DialogButton type="submit" primary testId="crop-pages-ok">
            {t('pages.dialog.crop')}
          </DialogButton>
        </>
      }
    >
      <PageRangeField value={range} onChange={(v) => (setRange(v), setInvalid(null))} invalid={null} pageCount={tab.pageCount} testId="crop-pages-input" />
      <div className={styles.margins}>
        {sides.map((side) => (
          <label key={side} className={fieldStyles.field}>
            <span>
              {t(`pages.dialog.${label[side]}`)} ({t('pages.dialog.cropUnit')})
            </span>
            <input
              className={fieldStyles.input}
              inputMode="decimal"
              value={values[side]}
              onChange={(event) => (setValues({ ...values, [side]: event.target.value }), setInvalid(null))}
              data-testid={`crop-${side}`}
            />
          </label>
        ))}
      </div>
      <p className={fieldStyles.hint}>{t('pages.dialog.cropHint')}</p>
      {invalid && (
        <p className={fieldStyles.error} role="alert">
          {invalid}
        </p>
      )}
    </Dialog>
  );
}

type Relation = 'before' | 'after';
type Anchor = 'first' | 'last' | 'page';

// Einfügestelle wie in Acrobat: vor/nach erster, letzter oder bestimmter Seite
function PositionFields({
  tab,
  relation,
  anchor,
  page,
  onChange,
}: {
  tab: TabState;
  relation: Relation;
  anchor: Anchor;
  page: string;
  onChange: (next: { relation?: Relation; anchor?: Anchor; page?: string }) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.position}>
      <select
        className={styles.select}
        value={relation}
        aria-label={t('pages.dialog.relation')}
        onChange={(event) => onChange({ relation: event.target.value as Relation })}
        data-testid="insert-relation"
      >
        <option value="before">{t('pages.dialog.before')}</option>
        <option value="after">{t('pages.dialog.after')}</option>
      </select>
      <select
        className={styles.select}
        value={anchor}
        aria-label={t('pages.dialog.anchor')}
        onChange={(event) => onChange({ anchor: event.target.value as Anchor })}
        data-testid="insert-anchor"
      >
        <option value="first">{t('pages.dialog.firstPage')}</option>
        <option value="last">{t('pages.dialog.lastPage')}</option>
        <option value="page">{t('pages.dialog.page')}</option>
      </select>
      {anchor === 'page' && (
        <input
          className={`${fieldStyles.input} ${styles.number}`}
          inputMode="numeric"
          value={page}
          aria-label={t('pages.dialog.pageNumber', { count: tab.pageCount })}
          onChange={(event) => onChange({ page: event.target.value })}
          data-testid="insert-page"
        />
      )}
    </div>
  );
}

// Seitenindex, vor dem eingefügt wird, oder null bei ungültiger Seitenzahl
function insertIndex(tab: TabState, relation: Relation, anchor: Anchor, page: string): number | null {
  let target: number;
  if (anchor === 'first') target = 0;
  else if (anchor === 'last') target = tab.pageCount - 1;
  else {
    const number = Number(page);
    if (!Number.isInteger(number) || number < 1 || number > tab.pageCount) return null;
    target = number - 1;
  }
  return relation === 'before' ? target : target + 1;
}

function InsertDialog({ tab, after, sources }: { tab: TabState; after: number; sources: SourceFile[] | null }) {
  const { t } = useTranslation();
  const [relation, setRelation] = useState<Relation>('after');
  const [anchor, setAnchor] = useState<Anchor>(after >= tab.pageCount - 1 ? 'last' : 'page');
  const [page, setPage] = useState(String(after + 1));
  const [count, setCount] = useState('1');
  const [invalid, setInvalid] = useState<string | null>(null);

  const submit = () => {
    const at = insertIndex(tab, relation, anchor, page);
    if (at === null) return setInvalid(t('pages.dialog.invalidPage', { count: tab.pageCount }));
    if (sources) {
      close();
      void insertSources(tab, sources, at);
      return;
    }
    const number = Number(count);
    if (!Number.isInteger(number) || number < 1 || number > 100) return setInvalid(t('pages.dialog.invalidCount'));
    close();
    void insertBlankPages(tab, at, number);
  };

  const pagesTotal = sources?.reduce((sum, s) => sum + s.pageCount, 0) ?? 0;
  return (
    <Dialog
      title={sources ? t('pages.dialog.insertFilesTitle') : t('pages.dialog.insertBlankTitle')}
      onClose={close}
      onSubmit={submit}
      width={440}
      testId="insert-pages-dialog"
      actions={
        <>
          <DialogButton onClick={close}>{t('pages.dialog.cancel')}</DialogButton>
          <DialogButton type="submit" primary testId="insert-pages-ok">
            {t('pages.dialog.insert')}
          </DialogButton>
        </>
      }
    >
      {sources && (
        <>
          <p className={fieldStyles.message}>{t('pages.dialog.insertFilesSummary', { count: pagesTotal })}</p>
          <ul className={styles.fileList}>
            {sources.map((source, i) => (
              <li key={i} className={styles.fileRow}>
                <span className={styles.fileName}>{source.name}</span>
                <span className={styles.fileMeta}>{t('pages.dialog.pageCount', { count: source.pageCount })}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {!sources && (
        <label className={fieldStyles.field}>
          <span>{t('pages.dialog.count')}</span>
          <input
            className={`${fieldStyles.input} ${styles.number}`}
            inputMode="numeric"
            value={count}
            autoFocus
            onChange={(event) => (setCount(event.target.value), setInvalid(null))}
            data-testid="insert-count"
          />
        </label>
      )}
      <div className={fieldStyles.field}>
        <span>{t('pages.dialog.position')}</span>
        <PositionFields
          tab={tab}
          relation={relation}
          anchor={anchor}
          page={page}
          onChange={(next) => {
            if (next.relation) setRelation(next.relation);
            if (next.anchor) setAnchor(next.anchor);
            if (next.page !== undefined) setPage(next.page);
            setInvalid(null);
          }}
        />
      </div>
      {!sources && <p className={fieldStyles.hint}>{t('pages.dialog.blankHint')}</p>}
      {invalid && (
        <p className={fieldStyles.error} role="alert">
          {invalid}
        </p>
      )}
    </Dialog>
  );
}

function ExtractDialog({ tab, pages }: { tab: TabState; pages: number[] }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(formatPageRanges(pages));
  const [separate, setSeparate] = useState(false);
  const [deleteAfter, setDeleteAfter] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const submit = () => {
    const parsed = parsePageRanges(value, tab.pageCount);
    if (!parsed) return setInvalid(t('pages.dialog.invalidPages', { count: tab.pageCount }));
    if (deleteAfter && parsed.length >= tab.pageCount) return setInvalid(t('errors.pages.all-pages'));
    close();
    void extractPages(tab, parsed, { separate, deleteAfter });
  };
  return (
    <Dialog
      title={t('pages.dialog.extractTitle')}
      onClose={close}
      onSubmit={submit}
      width={420}
      testId="extract-pages-dialog"
      actions={
        <>
          <DialogButton onClick={close}>{t('pages.dialog.cancel')}</DialogButton>
          <DialogButton type="submit" primary testId="extract-pages-ok">
            {t('pages.dialog.extract')}
          </DialogButton>
        </>
      }
    >
      <PageRangeField value={value} onChange={(v) => (setValue(v), setInvalid(null))} invalid={invalid} pageCount={tab.pageCount} testId="extract-pages-input" />
      <label className={styles.check}>
        <input type="checkbox" checked={separate} onChange={(event) => setSeparate(event.target.checked)} data-testid="extract-separate" />
        {t('pages.dialog.separateFiles')}
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={deleteAfter}
          disabled={!tab.canAssemble}
          onChange={(event) => setDeleteAfter(event.target.checked)}
          data-testid="extract-delete"
        />
        {t('pages.dialog.deleteAfter')}
      </label>
    </Dialog>
  );
}

function SplitDialog({ tab }: { tab: TabState }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'count' | 'bookmarks'>('count');
  const [size, setSize] = useState('1');
  const [bookmarks, setBookmarks] = useState<number[] | null>(null);

  useEffect(() => {
    const pdf = getRuntime(tab.id)?.pdf;
    if (!pdf) return;
    let cancelled = false;
    void topLevelBookmarkPages(pdf).then((pages) => {
      if (!cancelled) setBookmarks(pages);
    });
    return () => {
      cancelled = true;
    };
  }, [tab.id]);

  const sizeNumber = Number(size);
  const sizeValid = Number.isInteger(sizeNumber) && sizeNumber >= 1 && sizeNumber <= tab.pageCount;
  const chunks =
    mode === 'count' ? (sizeValid ? chunkPages(tab.pageCount, sizeNumber) : null) : bookmarks ? splitAtPages(tab.pageCount, bookmarks) : null;
  const usable = chunks !== null && chunks.length > 1;

  const submit = () => {
    if (!chunks || !usable) return;
    close();
    void splitDocument(tab, chunks);
  };

  return (
    <Dialog
      title={t('pages.dialog.splitTitle')}
      onClose={close}
      onSubmit={submit}
      width={420}
      testId="split-dialog"
      actions={
        <>
          <DialogButton onClick={close}>{t('pages.dialog.cancel')}</DialogButton>
          <DialogButton type="submit" primary disabled={!usable} testId="split-ok">
            {t('pages.dialog.split')}
          </DialogButton>
        </>
      }
    >
      <label className={styles.check}>
        <input type="radio" name="split" checked={mode === 'count'} onChange={() => setMode('count')} data-testid="split-by-count" />
        {t('pages.dialog.splitByCount')}
        <input
          className={`${fieldStyles.input} ${styles.number}`}
          inputMode="numeric"
          value={size}
          disabled={mode !== 'count'}
          aria-label={t('pages.dialog.splitSize')}
          onChange={(event) => setSize(event.target.value)}
          data-testid="split-size"
        />
      </label>
      <label className={styles.check}>
        <input
          type="radio"
          name="split"
          checked={mode === 'bookmarks'}
          disabled={!bookmarks || bookmarks.filter((p) => p > 0).length === 0}
          onChange={() => setMode('bookmarks')}
          data-testid="split-by-bookmarks"
        />
        {t('pages.dialog.splitByBookmarks')}
      </label>
      <p className={fieldStyles.hint} data-testid="split-summary">
        {usable ? t('pages.dialog.splitResult', { count: chunks.length }) : t('pages.dialog.splitNothing')}
      </p>
    </Dialog>
  );
}

// Dialog „Dateien zusammenführen“: Reihenfolge festlegen, dann speichern und öffnen.
export function CombineDialog({ sources }: { sources: SourceFile[] }) {
  const { t } = useTranslation();
  const set = (next: SourceFile[] | null) => useUi.getState().setCombine(next);
  const move = (index: number, delta: number) => {
    const next = [...sources];
    const [item] = next.splice(index, 1);
    if (item) next.splice(index + delta, 0, item);
    set(next);
  };
  const add = async () => {
    const added = await pickSources('pdf-or-images');
    if (added) set([...(useUi.getState().combine ?? []), ...added]);
  };
  const choose = (index: number, selection: string) => set(sources.map((source, i) => (i === index ? { ...source, selection } : source)));
  // Seiten einer Datei im neuen Dokument; false bei ungültiger Angabe
  const chosen = (source: SourceFile) => pageSelection(source.selection ?? '', source.pageCount);
  const invalid = sources.some((source) => chosen(source) === false);
  const submit = () => {
    if (sources.length === 0 || invalid) return;
    set(null);
    void combineSources(sources, t('pages.names.combined'));
  };
  const total = sources.reduce((sum, source) => {
    const pages = chosen(source);
    return sum + (pages ? pages.length : source.pageCount);
  }, 0);
  return (
    <Dialog
      title={t('pages.dialog.combineTitle')}
      onClose={() => set(null)}
      onSubmit={submit}
      width={560}
      testId="combine-dialog"
      actions={
        <>
          <DialogButton onClick={() => void add()} testId="combine-add">
            {t('pages.dialog.addFiles')}
          </DialogButton>
          <DialogButton onClick={() => set(null)}>{t('pages.dialog.cancel')}</DialogButton>
          <DialogButton type="submit" primary disabled={sources.length === 0 || invalid} testId="combine-ok">
            {t('pages.dialog.combine')}
          </DialogButton>
        </>
      }
    >
      {sources.length === 0 ? (
        <p className={fieldStyles.message}>{t('pages.dialog.combineEmpty')}</p>
      ) : (
        <>
          <ul className={styles.fileList} data-testid="combine-list">
            {sources.map((source, i) => (
              <li key={`${source.name}-${i}`} className={styles.fileRow} data-testid="combine-entry">
                <span className={styles.fileName}>{source.name}</span>
                <span className={styles.fileMeta}>
                  {source.kind === 'pdf' ? t('pages.dialog.pageCount', { count: source.pageCount }) : t('pages.dialog.image')}
                </span>
                {source.kind === 'pdf' && (
                  <input
                    className={[fieldStyles.input, styles.fileRange].join(' ')}
                    value={source.selection ?? ''}
                    placeholder={t('pages.dialog.combineAll')}
                    aria-label={t('pages.dialog.combinePages', { name: source.name })}
                    aria-invalid={chosen(source) === false}
                    onChange={(event) => choose(i, event.target.value)}
                    data-testid="combine-pages"
                  />
                )}
                <IconButton icon={ArrowUp} size={14} label={t('pages.dialog.moveUp')} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton
                  icon={ArrowDown}
                  size={14}
                  label={t('pages.dialog.moveDown')}
                  disabled={i === sources.length - 1}
                  onClick={() => move(i, 1)}
                />
                <IconButton icon={X} size={14} label={t('pages.dialog.remove')} onClick={() => set(sources.filter((_, k) => k !== i))} />
              </li>
            ))}
          </ul>
          {invalid ? (
            <p className={fieldStyles.error} role="alert" data-testid="combine-invalid">
              {t('pages.dialog.combineInvalid')}
            </p>
          ) : (
            <p className={fieldStyles.hint}>{t('pages.dialog.combineSummary', { count: total })}</p>
          )}
        </>
      )}
    </Dialog>
  );
}

// Kennwort für eine Quelldatei (Einfügen, Zusammenführen)
export function SourcePasswordDialog() {
  const { t } = useTranslation();
  const request = useUi((s) => s.passwordRequest);
  const [value, setValue] = useState('');
  if (!request) return null;
  const answer = (password: string | null) => {
    setValue('');
    request.resolve(password);
  };
  return (
    <Dialog
      title={t('password.title')}
      onClose={() => answer(null)}
      onSubmit={() => answer(value)}
      width={380}
      testId="source-password-dialog"
      actions={
        <>
          <DialogButton onClick={() => answer(null)}>{t('password.cancel')}</DialogButton>
          <DialogButton type="submit" primary testId="source-password-ok">
            {t('pages.dialog.ok')}
          </DialogButton>
        </>
      }
    >
      <p className={fieldStyles.message}>{t('password.message', { name: request.name })}</p>
      {request.incorrect && (
        <p className={fieldStyles.error} role="alert">
          {t('password.incorrect')}
        </p>
      )}
      <label className={fieldStyles.field}>
        <span>{t('password.label')}</span>
        <input
          className={fieldStyles.input}
          type="password"
          value={value}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          data-testid="source-password-input"
        />
      </label>
    </Dialog>
  );
}

// Zeigt den offenen Seiten-Dialog für den zugehörigen Tab.
export function PageDialogs({ dialog }: { dialog: PageDialog }) {
  const tab = useDocuments((s) => s.tabs.find((t) => t.id === dialog.tabId));
  if (!tab || tab.status !== 'ready') return null;
  switch (dialog.kind) {
    case 'delete':
      return <DeleteDialog tab={tab} pages={dialog.pages} />;
    case 'insertBlank':
      return <InsertDialog tab={tab} after={dialog.after} sources={null} />;
    case 'insertFiles':
      return <InsertDialog tab={tab} after={dialog.after} sources={dialog.sources} />;
    case 'extract':
      return <ExtractDialog tab={tab} pages={dialog.pages} />;
    case 'split':
      return <SplitDialog tab={tab} />;
    case 'replace':
      return <ReplaceDialog tab={tab} pages={dialog.pages} source={dialog.source} />;
    case 'crop':
      return <CropDialog tab={tab} pages={dialog.pages} />;
  }
}
