chrome.runtime.onInstalled.addListener(() => {
  console.log("Sumly installed");
});

chrome.runtime.onMessage.addListener(() => {
  return true;
});
