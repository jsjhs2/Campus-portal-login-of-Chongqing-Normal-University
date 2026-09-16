(async function main() {
  console.log('CAS 自动填充脚本已启动');

  function requestCredentials(initialUsername = '') {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'display:flex', 'align-items:center', 'justify-content:center',
        'background:rgba(0,0,0,.35)'
      ].join(';');

      const form = document.createElement('form');
      form.style.cssText = 'width:320px;padding:24px;border-radius:10px;background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.25);font:14px sans-serif';
      form.innerHTML = `
        <h2 style="margin:0 0 16px;font-size:18px">设置 CAS 登录信息</h2>
        <label style="display:block;margin:10px 0 5px">用户名</label>
        <input name="username" autocomplete="username" required style="box-sizing:border-box;width:100%;padding:9px" />
        <label style="display:block;margin:12px 0 5px">密码</label>
        <input name="password" type="password" autocomplete="current-password" required style="box-sizing:border-box;width:100%;padding:9px" />
        <p id="cas-credential-error" style="display:none;margin:10px 0;color:#c00"></p>
        <button type="submit" style="width:100%;margin-top:14px;padding:10px;border:0;border-radius:5px;background:#1677ff;color:#fff;cursor:pointer">保存并填入</button>
      `;
      form.elements.username.value = initialUsername;

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const username = form.elements.username.value.trim();
        const password = form.elements.password.value;
        if (!username || !password) return;
        overlay.remove();
        resolve({ username, password });
      });

      overlay.append(form);
      document.documentElement.append(overlay);
      form.elements.username.focus();
    });
  }

  async function getCredentials() {
    const { username, password } = await chrome.storage.local.get(['username', 'password']);
    if (username && password) return { username, password };

    const credentials = await requestCredentials();
    await chrome.storage.local.set(credentials);
    return credentials;
  }

  function fillCredentials({ username, password }) {
    const usernameEl = document.querySelector('#username');
    const passwordEl = document.querySelector('#password');
    usernameEl && (usernameEl.value = username);
    passwordEl && (passwordEl.value = password);
  }

  function addEditCredentialsButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '修改已保存账号';
    button.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483646',
      'padding:8px 12px', 'border:0', 'border-radius:5px',
      'background:#1677ff', 'color:#fff', 'cursor:pointer', 'font-size:13px'
    ].join(';');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const { username } = await chrome.storage.local.get('username');
        const credentials = await requestCredentials(username || '');
        await chrome.storage.local.set(credentials);
        fillCredentials(credentials);
      } finally {
        button.disabled = false;
      }
    });
    document.documentElement.append(button);
  }

  // ========== 1. 首次设置后自动填充账号密码 ==========
  const credentials = await getCredentials();
  fillCredentials(credentials);
  addEditCredentialsButton();

  // ========== 2. 获取验证码图片【这里一定要改成你页面上验证码img的选择器】 ==========
  const captchaImg = document.querySelector("img#validatorCodeOfLogin");
  if (!captchaImg) {
    alert("❌ 找不到验证码图片，请检查图片选择器");
    return;
  }
  console.log('找到了')

  // 页面刷新验证码时会先清空 src 再设置新地址；确保 OCR 读取的是新图片。
  async function waitForImage(image) {
    if (image.complete && image.naturalWidth > 0) return;
    await new Promise((resolve, reject) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', () => reject(new Error('验证码图片加载失败')), { once: true });
    });
  }
  // 验证码字符为深色或高饱和彩色；干扰线基本是低饱和度的浅灰色。
  // 依颜色而不是单纯亮度筛选，能保住紫色/绿色字符并去除大部分细干扰线。
  function captchaToCanvas(image) {
    const scale = 3;
    const canvas = document.createElement('canvas');
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) {
      throw new Error('验证码图片尚未加载完成');
    }

    canvas.width = width * scale;
    canvas.height = height * scale;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const red = pixels.data[i];
      const green = pixels.data[i + 1];
      const blue = pixels.data[i + 2];
      const brightest = Math.max(red, green, blue);
      const darkest = Math.min(red, green, blue);
      const saturation = brightest === 0 ? 0 : (brightest - darkest) / brightest;
      const brightness = red * 0.299 + green * 0.587 + blue * 0.114;

      // 保留深黑字符（如样本中的 8）和明显带颜色的字符；滤掉灰色网纹。
      const isCharacter = brightness < 95 || (saturation > 0.24 && brightness < 225);
      const color = isCharacter ? 0 : 255;
      pixels.data[i] = color;
      pixels.data[i + 1] = color;
      pixels.data[i + 2] = color;
      pixels.data[i + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  }

  function canvasToDataUrl(canvas) {
    return canvas.toDataURL('image/png');
  }

  function cleanCode(text) {
    return text.replace(/[^0-9A-Za-z]/g, '');
  }

  let isRecognizing = false;
  let rerunRequested = false;

  async function recognizeCaptcha() {
    // 避免连续点击时多个 OCR worker 同时读取同一张图片。
    if (isRecognizing) {
      rerunRequested = true;
      return;
    }
    isRecognizing = true;

    let worker;
    try {
      await waitForImage(captchaImg);

      // 此项目的 tesseract.js 为 v5：第一个参数必须是语言，而非 options。
      worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
        langPath: chrome.runtime.getURL("lib/"),
        gzip: false
      });
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_WORD
      });

      const captchaCanvas = captchaToCanvas(captchaImg);
      const result = await worker.recognize(canvasToDataUrl(captchaCanvas));
      const captchaCode = cleanCode(result.data.text);
      console.log("识别到验证码：", captchaCode);

      const captchaInput = document.querySelector("#authCode");
      if (captchaInput) captchaInput.value = captchaCode;
    } catch (error) {
      console.error('验证码识别失败：', error);
      alert(`❌ 验证码识别失败：${error.message || error}`);
    } finally {
      if (worker) await worker.terminate();
      isRecognizing = false;
      if (rerunRequested) {
        rerunRequested = false;
        void recognizeCaptcha();
      }
    }
  }

  // 初次打开页面时识别一次。
  void recognizeCaptcha();

  // 点击图片后，页面自己的 click handler 会先换验证码；下一轮任务再读取新图。
  captchaImg.addEventListener('click', () => {
    window.setTimeout(() => void recognizeCaptcha(), 0);
  });
})();
