export async function initializeToolbarAction(api: typeof chrome): Promise<void> {
  try {
    await api.action.setPopup({ popup: '' });
    if (!api.sidePanel?.setPanelBehavior) throw new Error('Sidebar unavailable');
    await api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('[Toolbar] Sidebar unavailable; using popup fallback:', error);
    try {
      await api.action.setPopup({ popup: 'popup.html' });
    } catch (fallbackError) {
      console.warn('[Toolbar] Popup fallback unavailable:', fallbackError);
    }
    return;
  }
  try {
    await api.storage.local.set({ sidepanel_mode: true });
  } catch (error) {
    console.warn('[Toolbar] Sidebar preference migration failed:', error);
  }
}

if (process.env.TARGET_BROWSER === 'chrome' && typeof chrome !== 'undefined') {
  void initializeToolbarAction(chrome);
}
