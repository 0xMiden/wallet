(function () {
  // This page must run even when the WebView cannot parse the wallet bundle.
  var english = {
    webViewUpdateTitle: 'Update Android System WebView',
    webViewUpdateBody:
      'Bread needs a newer version of Android System WebView, the part of Android that shows web pages in apps. Update it from Google Play, then open Bread again.',
    webViewUpdateAction: 'Open Google Play',
    webViewUpdateChromeTitle: 'Update Chrome',
    webViewUpdateChromeBody:
      'Bread needs a newer version of Chrome, which shows web pages in apps on this version of Android. Update it from Google Play, then open Bread again.',
    webViewStartFailedTitle: "Bread couldn't start",
    webViewStartFailedBody: 'Something stopped Bread from loading. Try again, or close Bread and open it again.',
    webViewStartFailedAction: 'Try again'
  };

  function localeDirectory(language) {
    var locale = (language || 'en').replace(/-/g, '_').toLowerCase();
    var directories = ['de', 'en', 'en_GB', 'es', 'fr', 'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh_CN', 'zh_TW'];
    for (var i = 0; i < directories.length; i++) {
      if (directories[i].toLowerCase() === locale) return directories[i];
    }
    var base = locale.split('_')[0];
    if (base === 'zh') {
      return /(^|_)(hant|tw|hk|mo)(_|$)/.test(locale) ? 'zh_TW' : 'zh_CN';
    }
    return directories.indexOf(base) !== -1 ? base : 'en';
  }

  function render(userAgent, language) {
    var chrome = /Chrome\/(\d+)/.exec(userAgent);
    // capacitor.config.ts android.minWebViewVersion; the page test checks the two agree.
    var needsUpdate = chrome && parseInt(chrome[1], 10) < 98;
    // Capacitor checks the current WebView provider. Android 7 to 9 take Chrome whenever it is enabled; Android 10
    // and later always take Android System WebView.
    var android = /Android (\d+)/.exec(userAgent);
    var chromeProvider = android && parseInt(android[1], 10) <= 9;
    var keys = !needsUpdate
      ? { title: 'webViewStartFailedTitle', body: 'webViewStartFailedBody', action: 'webViewStartFailedAction' }
      : chromeProvider
        ? { title: 'webViewUpdateChromeTitle', body: 'webViewUpdateChromeBody', action: 'webViewUpdateAction' }
        : { title: 'webViewUpdateTitle', body: 'webViewUpdateBody', action: 'webViewUpdateAction' };
    var directory = localeDirectory(language);

    function apply(messages) {
      ['title', 'body', 'action'].forEach(function (id) {
        var key = keys[id];
        var entry = messages && messages[key];
        document.getElementById(id).textContent =
          entry && typeof entry.message === 'string' && entry.message ? entry.message : english[key];
      });
      document.title = document.getElementById('title').textContent;
    }

    apply(null);
    document.documentElement.lang = 'en';
    document
      .getElementById('action')
      .setAttribute(
        'href',
        !needsUpdate
          ? '/'
          : 'https://play.google.com/store/apps/details?id=' +
              (chromeProvider ? 'com.android.chrome' : 'com.google.android.webview')
      );

    try {
      var request = new XMLHttpRequest();
      request.open('GET', '/_locales/' + directory + '/messages.json', true);
      request.timeout = 5000;
      request.onload = function () {
        if (request.status < 200 || request.status >= 300) return;
        try {
          var messages = JSON.parse(request.responseText);
          apply(messages);
          document.documentElement.lang = directory.replace('_', '-');
        } catch (e) {
          // A broken locale file must leave the English recovery action usable.
        }
      };
      request.send();
    } catch (e) {
      // English is already visible if the locale request cannot start.
    }
  }

  render(navigator.userAgent, navigator.language);
})();
