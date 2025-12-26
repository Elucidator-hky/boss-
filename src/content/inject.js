/**
 * 注入到页面上下文的脚本（通过 manifest world: "MAIN"）
 * 拦截 XHR 请求，监听 historyMsg 和 getBossData API 响应
 */
(function() {
  console.log("[inject.js] 脚本已注入");

  // ========================================
  // 拦截 XMLHttpRequest
  // ========================================
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._url = url;
    this._method = method;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    const url = this._url || "";

    if (url.includes("historyMsg")) {
      this.addEventListener("load", function() {
        handleHistoryMsgResponse(this.responseText);
      });
    }

    if (url.includes("getBossData")) {
      this.addEventListener("load", function() {
        handleGetBossDataResponse(this.responseText);
      });
    }

    return origSend.apply(this, arguments);
  };

  // ========================================
  // 响应处理函数
  // ========================================

  function handleHistoryMsgResponse(responseText) {
    try {
      const data = JSON.parse(responseText);
      if (data?.zpData?.messages) {
        const jobMsg = data.zpData.messages.find(m => m.bizType === 21050003);
        if (jobMsg?.body?.jobDesc) {
          console.log("[inject.js] 获取到 historyMsg 职位信息");
          window.postMessage({ type: "BOSS_JOB_INFO", jobInfo: jobMsg.body.jobDesc }, "*");
        }
      }
    } catch(e) {
      console.error("[inject.js] historyMsg 解析错误:", e);
    }
  }

  function handleGetBossDataResponse(responseText) {
    try {
      const data = JSON.parse(responseText);
      const zpData = data?.zpData;
      if (!zpData) return;

      const bossData = zpData.data || {};
      const jobData = zpData.job || {};

      const info = {
        encryptJobId: bossData.encryptJobId || "",
        securityId: bossData.securityId || "",
        encryptBossId: bossData.encryptBossId || "",
        jobName: jobData.jobName || "",
        salaryDesc: jobData.salaryDesc || "",
        locationName: jobData.locationName || "",
        degreeName: jobData.degreeName || "",
        experienceName: jobData.experienceName || "",
        brandName: jobData.brandName || "",
        bossName: bossData.name || "",
        bossTitle: bossData.title || "",
        companyName: bossData.companyName || ""
      };

      if (info.encryptJobId && info.securityId) {
        console.log("[inject.js] 获取到 getBossData 职位数据");
        window.postMessage({ type: "BOSS_JOB_DATA", jobData: info }, "*");
      }
    } catch(e) {
      console.error("[inject.js] getBossData 解析错误:", e);
    }
  }
})();
