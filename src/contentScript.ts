import browser from 'webextension-polyfill';

import { MidenPageMessageType, MidenPageMessage } from 'lib/adapter/types';
import { IntercomClient } from 'lib/intercom/client';
import { serializeErrorForPage } from 'lib/intercom/helpers';
import { MidenMessageType, MidenResponse } from 'lib/miden/types';

enum BeaconMessageTarget {
  Page = 'toPage',
  Extension = 'toExtension'
}

type BeaconMessage =
  | {
      target: BeaconMessageTarget;
      payload: any;
    }
  | {
      target: BeaconMessageTarget;
      encryptedPayload: any;
    };
type BeaconPageMessage = BeaconMessage | { message: BeaconMessage; sender: { id: string } };

async function testIntercomConnection() {
  try {
    await getIntercom().request({
      type: 'PING',
      payload: 'PING'
    });
  } catch (err: any) {
    console.debug('Intercom connection corrupted', err);
    throw err;
  }
}

let script = document.createElement('script');
script.src = browser.runtime.getURL('addToWindow.js');
(document.head || document.documentElement).appendChild(script);

function keepSWAlive() {
  setTimeout(async function () {
    try {
      await browser.runtime.sendMessage('wakeup');
      await testIntercomConnection();
    } catch (e) {
      console.debug('Intercom connection corrupted', e);
    }
    keepSWAlive();
  }, 10_000);
}

const manifest = browser.runtime.getManifest();
if (manifest.manifest_version === 3) {
  keepSWAlive();
}

window.addEventListener(
  'message',
  evt => {
    if (evt.source !== window) return;

    const isMidenRequest = evt.data?.type === MidenPageMessageType.Request;

    if (isMidenRequest) {
      midenRequest(evt);
    } else {
      return;
    }
  },
  false
);

function midenRequest(evt: MessageEvent) {
  const { payload, reqId } = evt.data;

  getIntercom()
    .request({
      type: MidenMessageType.PageRequest,
      origin: evt.origin,
      payload
    })
    .then((res: MidenResponse) => {
      if (res?.type === MidenMessageType.PageResponse) {
        send(
          {
            type: MidenPageMessageType.Response,
            payload: res.payload,
            reqId
          },
          evt.origin
        );
      }
    })
    .catch(err => {
      send(
        {
          type: MidenPageMessageType.ErrorResponse,
          payload: serializeErrorForPage(err),
          reqId
        },
        evt.origin
      );
    });
}

function send(msg: MidenPageMessage | BeaconPageMessage, targetOrigin: string) {
  if (!targetOrigin || targetOrigin === '*') return;
  window.postMessage(msg, targetOrigin);
}

let intercom: IntercomClient | null;
function getIntercom() {
  if (!intercom) {
    intercom = new IntercomClient();
  }
  return intercom;
}
