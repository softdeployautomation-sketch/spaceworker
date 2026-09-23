// background.js — service worker bridge between the popup and the native
// messaging host. Kept minimal on purpose: the popup opens the native
// messaging channel directly, and the worker only fans out clone requests so
// they survive popup closure (status polling continues in the popup).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command === 'clone_browser') {
    chrome.runtime.sendNativeMessage(
      'com.spaceworker.clone',
      message,
      (response) => sendResponse(response)
    );
    return true; // keep the channel open for the async response
  }
  if (message.command === 'get_clone_status') {
    chrome.runtime.sendNativeMessage(
      'com.spaceworker.clone',
      message,
      (response) => sendResponse(response)
    );
    return true;
  }
});