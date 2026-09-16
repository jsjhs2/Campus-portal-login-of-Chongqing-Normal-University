// 点击扩展图标，注入content脚本
chrome.action.onClicked.addListener(async (tab) => {
  // 只在重师cas域名执行脚本
  if(tab.url.startsWith("https://csxrz.cqnu.edu.cn/cas/login")){
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  }else{
    alert("请打开重庆师大统一身份认证登录页面");
  }
});