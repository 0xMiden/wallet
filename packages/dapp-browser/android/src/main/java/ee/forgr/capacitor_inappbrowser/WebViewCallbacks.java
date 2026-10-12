package ee.forgr.capacitor_inappbrowser;

public interface WebViewCallbacks {
    default void presentationChanged(boolean fullscreen, boolean resolved, long revision, String lifetime) {}

    public void urlChangeEvent(String url);

    public void closeEvent(String url);

    public void pageLoaded();

    public void pageLoadError();

    public void javascriptCallback(String message);

    public void buttonNearDoneClicked();

    public void confirmBtnClicked(String url);
}
