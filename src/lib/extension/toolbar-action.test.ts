import { initializeToolbarAction } from './toolbar-action';

it('keeps the existing popup until sidebar action behavior is enabled', async () => {
  let enableSidebar!: () => void;
  const behaviorReady = new Promise<void>(resolve => {
    enableSidebar = resolve;
  });
  const setPopup = jest.fn().mockResolvedValue(undefined);
  const setPanelBehavior = jest.fn(() => behaviorReady);
  const api = {
    action: { setPopup },
    sidePanel: { setPanelBehavior },
    storage: { local: { set: jest.fn().mockResolvedValue(undefined) } }
  } as unknown as typeof chrome;

  const initialization = initializeToolbarAction(api);
  try {
    await Promise.resolve();
    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    expect(setPopup).not.toHaveBeenCalled();
  } finally {
    enableSidebar();
    await initialization;
  }
  expect(setPopup).toHaveBeenCalledWith({ popup: '' });
});
