chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.action === 'openOptions') { chrome.runtime.openOptionsPage(); sendResponse({ok:true}); return true; }
  if (msg.type === 'ping') { sendResponse({ok:true, version: chrome.runtime.getManifest().version}); return true; }
  return false;
});
chrome.runtime.onInstalled.addListener(({reason}) => {
  if (reason === 'install') chrome.storage.local.set({installed_at: Date.now(), model: 'fbo'});
});