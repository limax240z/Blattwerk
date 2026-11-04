import { useEffect } from 'react';
import { trackPointerLight } from '../components/glass/liquid-glass';
import { useNativeGlass } from './native-glass';
import { UpdateBanner } from '../features/update/UpdateBanner';
import { api } from '../api';
import {
  giveAllTabs,
  handleCloseRequest,
  handleOpenResult,
  executeCommand,
  receiveTab,
} from '../engine/session';
import { CommentToolbar } from '../features/annotations/CommentToolbar';
import { MarkToolbar } from '../features/annotations/MarkToolbar';
import { ContentEditToolbar } from '../features/content-edit/ContentEditToolbar';
import { FieldDialog } from '../features/form-edit/FieldDialog';
import { FormEditToolbar } from '../features/form-edit/FormEditToolbar';
import { RedactApplyDialog, RedactFindDialog } from '../features/redaction/RedactDialogs';
import { RedactToolbar } from '../features/redaction/RedactToolbar';
import {
  HeaderFooterDialog,
  PageNumbersDialog,
  WatermarkDialog,
} from '../features/stamping/StampDialogs';
import { TooltipHost } from '../components/Tooltip';
import { SecurityDialog } from '../features/security/SecurityDialog';
import { ExportImagesDialog } from '../features/export/ExportImagesDialog';
import { CompressDialog } from '../features/compress/CompressDialog';
import { CleanDialog } from '../features/clean/CleanDialog';
import { startPageProvider } from '../features/pages/page-drag';
import { OcrDialog } from '../features/ocr/OcrDialog';
import { CertifyDialog, CreateIdDialog } from '../features/certify/CertifyDialogs';
import { useCertify } from '../features/certify/certify-store';
import { SignaturesDialog } from '../features/certify/Signatures';
import { PdfADialog } from '../features/pdfa/PdfADialog';
import { usePdfA } from '../features/pdfa/pdfa-store';
import { AccessibilityDialog } from '../features/accessibility/AccessibilityDialog';
import { useAccessibility } from '../features/accessibility/accessibility-store';
import { ProgressDialog } from '../features/progress/ProgressDialog';
import { BusyOverlay } from '../features/pages/BusyOverlay';
import {
  ChooseSignatureDialog,
  CreateSignatureDialog,
} from '../features/signatures/SignatureDialogs';
import { CombineDialog, PageDialogs, SourcePasswordDialog } from '../features/pages/PageDialogs';
import { GoToPageDialog } from '../features/goto/GoToPageDialog';
import { PasswordDialog } from '../features/password/PasswordDialog';
import { PrintProgressDialog } from '../features/print/PrintProgressDialog';
import { PromptDialog } from '../features/prompt/PromptDialog';
import { PropertiesDialog } from '../features/properties/PropertiesDialog';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { DocumentPane } from '../features/viewer/DocumentPane';
import { useActiveTab, useDocuments } from '../state/documents-store';
import { useFormEdit } from '../state/form-edit-store';
import { useUi } from '../state/ui-store';
import { PRODUCT_NAME } from '../../shared/product';
import styles from './App.module.css';
import { DropOverlay } from './DropOverlay';
import { LeftSidebar } from './LeftSidebar';
import { SidebarToggle } from './SidebarToggle';
import { ReadModeBar } from '../features/read-mode/ReadModeBar';
import { exitReadMode } from '../features/read-mode/read-mode';
import { Notices } from './Notices';
import { RightPanel } from './RightPanel';
import { StartScreen } from './StartScreen';
import { SaveTemplateDialog } from '../features/start/SaveTemplateDialog';
import { TabBar } from './TabBar';
import { Toolbar } from './Toolbar';
import { useAnnotationSync, useFileDrop, useGlobalKeys, useMenuStateSync } from './hooks';
import { useCompact } from './compact';

export function App() {
  const tabs = useDocuments((s) => s.tabs);
  const activeId = useDocuments((s) => s.activeId);
  const active = useActiveTab();
  const sidebarVisible = useUi((s) => s.sidebarVisible);
  const readMode = useUi((s) => s.readMode);
  const rightPanelVisible = useUi((s) => s.rightPanelVisible);
  const propertiesTabId = useUi((s) => s.propertiesTabId);
  const goToPageOpen = useUi((s) => s.goToPageOpen);
  const print = useUi((s) => s.print);
  const prompt = useUi((s) => s.prompt);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const homeOpen = useUi((s) => s.homeOpen);
  const templateDialogTab = useUi((s) =>
    s.templateDialogTab ? (tabs.find((tab) => tab.id === s.templateDialogTab) ?? null) : null,
  );
  const commentToolsVisible = useUi((s) => s.commentToolsVisible);
  const markToolsVisible = useUi((s) => s.markToolsVisible);
  const redactToolsVisible = useUi((s) => s.redactToolsVisible);
  const redactDialog = useUi((s) => s.redactDialog);
  const stampDialog = useUi((s) => s.stampDialog);
  const securityDialogOpen = useUi((s) => s.securityDialogOpen);
  const exportImagesOpen = useUi((s) => s.exportImagesOpen);
  const compressOpen = useUi((s) => s.compressOpen);
  const cleanOpen = useUi((s) => s.cleanOpen);
  const ocrOpen = useUi((s) => s.ocrOpen);
  const certifyOpen = useCertify((s) => s.dialogOpen);
  const createIdOpen = useCertify((s) => s.createOpen);
  const signaturesOpen = useCertify((s) => s.detailsOpen);
  const pdfaOpen = usePdfA((s) => s.open);
  const accessibilityOpen = useAccessibility((s) => s.open);
  const pageDialog = useUi((s) => s.pageDialog);
  const combine = useUi((s) => s.combine);
  const signatureDialog = useUi((s) => s.signatureDialog);
  const fieldDialog = useFormEdit((s) => s.dialog);

  // Lichtquelle der Glanzkanten folgt der Maus
  useEffect(() => trackPointerLight(), []);
  // Seiten, die aus diesem Fenster in ein anderes gezogen werden, auf Anfrage liefern
  useEffect(() => startPageProvider(), []);
  // macOS 26+: Apples Liquid Glass unter den durchsichtigen Bereichen
  useNativeGlass();

  useEffect(() => {
    const offOpened = api.onFileOpened((result) => void handleOpenResult(result));
    const offCommand = api.onMenuCommand((command) => executeCommand(command));
    const refreshRecent = () =>
      void api.recent.list().then((list) => useUi.getState().setRecent(list));
    const offRecent = api.onRecentChanged(refreshRecent);
    const offClose = api.onRequestClose(() => void handleCloseRequest());
    // Mehrere Fenster (ADR 0026): Tab aus einem anderen Fenster übernehmen, alle Tabs an das vordere abgeben
    const offReceived = api.onTabReceived((message) => void receiveTab(message));
    const offMerge = api.onMergeRequest(() => void giveAllTabs());
    refreshRecent();
    void api.getSettings().then((settings) => useUi.getState().setAuthorName(settings.authorName));
    api.signalReady();
    return () => {
      offOpened();
      offCommand();
      offRecent();
      offClose();
      offReceived();
      offMerge();
    };
  }, []);

  useMenuStateSync();
  useGlobalKeys();
  useFileDrop();
  useAnnotationSync();

  useEffect(() => {
    document.title = active ? `${active.name} – ${PRODUCT_NAME}` : PRODUCT_NAME;
  }, [active]);

  // Kompaktansicht (ADR 0030): Seitenleisten liegen über dem Dokument, beim Wechsel dorthin sind sie zu; nach einem
  // Seitenwechsel (Miniatur, Lesezeichen, Kommentar angetippt) schließt sich die linke Leiste von selbst
  const compact = useCompact();
  useEffect(() => {
    if (!compact) return;
    useUi.getState().setSidebarVisible(false);
    useUi.getState().setRightPanelVisible(false);
  }, [compact]);
  const currentPage = active?.status === 'ready' ? active.currentPage : null;
  useEffect(() => {
    if (compact && currentPage !== null) useUi.getState().setSidebarVisible(false);
  }, [compact, currentPage]);

  // Ein neuer oder anderer Tab beendet die Startseite als Überlagerung (Dokument aus Vorlage, zuletzt geöffnet, Tabwechsel)
  useEffect(() => {
    useUi.getState().setHomeOpen(false);
    exitReadMode();
  }, [tabs.length, activeId]);

  const propertiesTab = tabs.find((tab) => tab.id === propertiesTabId);
  const showDocumentChrome = tabs.length > 0 && active !== null;

  return (
    <div className={styles.app} data-glass-app data-read-mode={readMode ? '' : undefined}>
      <div data-read-chrome>
        <Toolbar />
        {tabs.length > 0 && <TabBar />}
        {!homeOpen &&
          commentToolsVisible &&
          active?.status === 'ready' &&
          active.mode === 'view' &&
          !active.formEditing &&
          !active.contentEditing && <CommentToolbar tab={active} />}
        {!homeOpen &&
          active?.status === 'ready' &&
          active.mode === 'view' &&
          active.formEditing && <FormEditToolbar tab={active} />}
        {!homeOpen &&
          active?.status === 'ready' &&
          active.mode === 'view' &&
          active.contentEditing && <ContentEditToolbar tab={active} />}
        {!homeOpen &&
          markToolsVisible &&
          active?.status === 'ready' &&
          active.mode === 'view' &&
          !active.formEditing &&
          !active.contentEditing && <MarkToolbar tab={active} />}
        {!homeOpen &&
          redactToolsVisible &&
          active?.status === 'ready' &&
          active.mode === 'view' &&
          !active.formEditing &&
          !active.contentEditing && <RedactToolbar tab={active} />}
      </div>
      <div className={styles.workspace} data-glass-workspace>
        {!showDocumentChrome ? (
          <StartScreen />
        ) : (
          <>
            {homeOpen && <StartScreen overlay />}
            {!readMode && sidebarVisible && active.status === 'ready' && active.mode === 'view' && (
              <LeftSidebar tab={active} />
            )}
            <main className={styles.documents}>
              {!readMode && !homeOpen && active.status === 'ready' && active.mode === 'view' && (
                <SidebarToggle />
              )}
              {readMode && <ReadModeBar />}
              {tabs.map((tab) => (
                <DocumentPane key={tab.id} tab={tab} active={tab.id === activeId} />
              ))}
            </main>
            {!readMode &&
              rightPanelVisible &&
              active.status === 'ready' &&
              active.mode === 'view' && <RightPanel tab={active} />}
          </>
        )}
      </div>
      {active?.status === 'password' && <PasswordDialog key={active.id} tab={active} />}
      {propertiesTab && <PropertiesDialog tab={propertiesTab} />}
      {goToPageOpen && active?.status === 'ready' && <GoToPageDialog tab={active} />}
      {print && <PrintProgressDialog progress={print} />}
      {settingsOpen && <SettingsDialog />}
      {templateDialogTab && (
        <SaveTemplateDialog key={templateDialogTab.id} tab={templateDialogTab} />
      )}
      {pageDialog && (
        <PageDialogs key={`${pageDialog.kind}-${pageDialog.tabId}`} dialog={pageDialog} />
      )}
      {combine && <CombineDialog sources={combine} />}
      {signatureDialog === 'choose' && <ChooseSignatureDialog />}
      {signatureDialog === 'create' && <CreateSignatureDialog />}
      {fieldDialog && <FieldDialog key={JSON.stringify(fieldDialog)} dialog={fieldDialog} />}
      {redactDialog === 'apply' && active?.status === 'ready' && <RedactApplyDialog tab={active} />}
      {redactDialog === 'find' && active?.status === 'ready' && <RedactFindDialog tab={active} />}
      {stampDialog === 'watermark' && active?.status === 'ready' && (
        <WatermarkDialog tab={active} />
      )}
      {stampDialog === 'headerFooter' && active?.status === 'ready' && (
        <HeaderFooterDialog tab={active} />
      )}
      {stampDialog === 'pageNumbers' && active?.status === 'ready' && (
        <PageNumbersDialog tab={active} />
      )}
      {securityDialogOpen && active?.status === 'ready' && <SecurityDialog tab={active} />}
      {exportImagesOpen && active?.status === 'ready' && <ExportImagesDialog tab={active} />}
      {compressOpen && active?.status === 'ready' && <CompressDialog tab={active} />}
      {cleanOpen && active?.status === 'ready' && <CleanDialog tab={active} />}
      {ocrOpen && active?.status === 'ready' && <OcrDialog tab={active} />}
      {certifyOpen && active?.status === 'ready' && <CertifyDialog tab={active} />}
      {createIdOpen && <CreateIdDialog />}
      {signaturesOpen && active?.status === 'ready' && <SignaturesDialog tab={active} />}
      {pdfaOpen && active?.status === 'ready' && <PdfADialog tab={active} />}
      {accessibilityOpen && active?.status === 'ready' && <AccessibilityDialog tab={active} />}
      <ProgressDialog />
      <SourcePasswordDialog />
      <BusyOverlay />
      {prompt && <PromptDialog key={`${prompt.kind}-${prompt.tabId}`} prompt={prompt} />}
      <Notices />
      <UpdateBanner />
      <DropOverlay />
      <TooltipHost />
    </div>
  );
}
