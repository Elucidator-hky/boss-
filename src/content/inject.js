/**
 * 注入到页面上下文的脚本（通过 manifest world: "MAIN"，全站注入）
 * 拦截 XHR/fetch 响应：
 *  - 聊天页：historyMsg（职位描述）、getBossData（职位结构化数据）
 *  - 推荐/搜索页：joblist（职位列表，含 encryptJobId/securityId）
 */
(function() {
  console.log("[inject.js] 脚本已注入");

  const WATCH_RE = /historyMsg|getBossData|joblist\.json|recommend\/job\/list/;

  function routeResponse(url, responseText) {
    if (url.includes("historyMsg")) handleHistoryMsgResponse(responseText);
    if (url.includes("getBossData")) handleGetBossDataResponse(responseText);
    if (url.includes("joblist.json") || url.includes("recommend/job/list")) {
      handleJobListResponse(responseText);
    }
  }

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
    if (WATCH_RE.test(url)) {
      this.addEventListener("load", function() {
        routeResponse(url, this.responseText);
      });
    }
    return origSend.apply(this, arguments);
  };

  // ========================================
  // 拦截 fetch（部分接口走 fetch）
  // ========================================
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(input) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (WATCH_RE.test(url)) {
          p.then((res) => {
            res.clone().text().then((t) => routeResponse(url, t)).catch(() => {});
          }).catch(() => {});
        }
      } catch (_) {}
      return p;
    };
  }

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

  function handleJobListResponse(responseText) {
    try {
      const data = JSON.parse(responseText);
      const list = data?.zpData?.jobList;
      if (!Array.isArray(list) || !list.length) return;

      const jobs = list.map(j => ({
        encryptJobId: j.encryptJobId || "",
        securityId: j.securityId || "",
        lid: j.lid || "",
        jobName: j.jobName || "",
        salaryDesc: j.salaryDesc || "",
        brandName: j.brandName || "",
        city: j.cityName || "",
        area: j.areaDistrict || "",
        experience: j.jobExperience || "",
        degree: j.jobDegree || "",
        skills: j.skills || [],
        labels: j.jobLabels || [],
        bossName: j.bossName || "",
        bossTitle: j.bossTitle || "",
        industry: j.brandIndustry || "",
        scale: j.brandScaleName || "",
        stage: j.brandStageName || "",
        welfare: j.welfareList || []
      }));

      console.log("[inject.js] 拦到职位列表:", jobs.length, "条");
      window.postMessage({ type: "BOSS_JOB_LIST", jobs }, "*");
    } catch(e) {
      console.error("[inject.js] joblist 解析错误:", e);
    }
  }
})();
