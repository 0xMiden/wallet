/**
 * Extension-only: allow the MoonPay Buy widget to be iframed by our pages.
 *
 * MoonPay serves `Content-Security-Policy: frame-ancestors *` on the widget,
 * and per the CSP spec `*` matches only network schemes (http/https/ws/wss) —
 * NEVER `chrome-extension://` — so the frame dies with "refused to connect"
 * (ERR_BLOCKED_BY_RESPONSE) on extension pages no matter what the MoonPay
 * dashboard allowlist says. The sanctioned escape hatch is a
 * declarativeNetRequest rule that strips that header, scoped as tightly as
 * DNR allows: sub_frame responses from the MoonPay widget hosts, initiated by
 * THIS extension only (`initiatorDomains: [chrome.runtime.id]`), so MoonPay's
 * clickjacking protection elsewhere in the browser is untouched.
 *
 * Registered as a session rule on every SW start — session rules don't
 * persist, so there's nothing stale to migrate on update.
 */

const MOONPAY_FRAME_RULE_ID = 7301;

export async function installMoonPayFrameRules(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [MOONPAY_FRAME_RULE_ID],
      addRules: [
        {
          id: MOONPAY_FRAME_RULE_ID,
          priority: 1,
          condition: {
            requestDomains: ['buy.moonpay.com', 'buy-sandbox.moonpay.com'],
            // The extension initiates only the FIRST navigation (the iframe
            // src). The sandbox shell then JS-navigates the frame to
            // buy.moonpay.com/v2/buy — that navigation's initiator is the
            // MoonPay document itself, so the widget hosts must be listed
            // here too or the second hop is left unstripped and blocked.
            initiatorDomains: [chrome.runtime.id, 'buy.moonpay.com', 'buy-sandbox.moonpay.com'],
            resourceTypes: [chrome.declarativeNetRequest.ResourceType.SUB_FRAME]
          },
          action: {
            type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
            responseHeaders: [
              {
                header: 'Content-Security-Policy',
                operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE
              }
            ]
          }
        }
      ]
    });
  } catch (error) {
    console.warn('[moonpay] failed to install frame-ancestors strip rule', error);
  }
}
