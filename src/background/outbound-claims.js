(() => {
  "use strict";

  const CLAIM_MESSAGE = "BOSS_CLAIM_OUTBOUND";
  const ID = /^[A-Za-z0-9_~-]{1,128}$/;
  let claimQueue = Promise.resolve();

  function isBossContentScript(sender) {
    return sender.id === chrome.runtime.id && sender.frameId === 0 &&
      Number.isInteger(sender.tab?.id) && sender.tab.id >= 0 &&
      sender.url?.startsWith("https://www.zhipin.com/");
  }

  function claim(jobKey, recruiterKey) {
    const result = claimQueue.then(async () => {
      const existing = await chrome.storage.local.get([jobKey, recruiterKey]);
      if (Object.hasOwn(existing, jobKey) || Object.hasOwn(existing, recruiterKey)) {
        return { ok: true, claimed: false };
      }
      await chrome.storage.local.set({ [jobKey]: true, [recruiterKey]: true });
      return { ok: true, claimed: true };
    });
    // Only this service worker can reserve an action. Wait for the durable write
    // before checking the next request, including requests from other tabs.
    claimQueue = result.catch(() => {});
    return result;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== CLAIM_MESSAGE) return;
    if (!isBossContentScript(sender)) {
      sendResponse({ ok: false, error: "外发登记必须来自 BOSS 页面。" });
      return;
    }

    const { kind, jobId, recruiterId } = message;
    if ((kind !== "greeting" && kind !== "resume") ||
        typeof jobId !== "string" || !ID.test(jobId) ||
        typeof recruiterId !== "string" || !ID.test(recruiterId)) {
      sendResponse({ ok: false, error: "外发登记需要确切的职位和招聘者标识。" });
      return;
    }
    const stableRecruiterId = recruiterId.replace(/~+$/, "");
    if (!stableRecruiterId) {
      sendResponse({ ok: false, error: "外发登记需要确切的招聘者标识。" });
      return;
    }

    const prefix = `bossOutboundClaim:v1:${kind}`;
    claim(`${prefix}:job:${jobId}`, `${prefix}:recruiter:${stableRecruiterId}`).then(sendResponse, () => {
      sendResponse({ ok: false, error: "无法保存本地外发登记。" });
    });
    return true;
  });
})();
