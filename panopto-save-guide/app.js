(function () {
  'use strict';

  const shareForm = document.querySelector('#share-form');
  const downloadForm = document.querySelector('#download-form');
  if (!shareForm || !downloadForm) return;

  const shareInput = document.querySelector('#share-url');
  const authorization = document.querySelector('#authorization');
  const shareError = document.querySelector('#share-error');
  const authorizationError = document.querySelector('#authorization-error');
  const shareStatus = document.querySelector('#share-status');
  const downloadInput = document.querySelector('#download-url');
  const downloadError = document.querySelector('#download-error');
  const downloadStatus = document.querySelector('#download-status');
  const downloadLink = document.querySelector('#download-link');

  function parseHttpsUrl(value) {
    try {
      const url = new URL(value.trim());
      return url.protocol === 'https:' ? url : null;
    } catch (_) {
      return null;
    }
  }

  function isPanoptoShareUrl(url) {
    if (!url) return false;
    const hostLooksLikePanopto = url.hostname.toLowerCase().endsWith('.panopto.com');
    const pathLooksLikeViewer = /\/panopto\/(pages\/(viewer|embed)|sessions)\b/i.test(url.pathname);
    return hostLooksLikePanopto && pathLooksLikeViewer;
  }

  function isPanoptoDownloadUrl(url) {
    if (!url) return false;
    const hostLooksLikePanopto = url.hostname.toLowerCase().endsWith('.panopto.com');
    const pathLooksLikeDownload = /\/panopto\/(podcast|pages\/viewer)\/download\b/i.test(url.pathname);
    return hostLooksLikePanopto && pathLooksLikeDownload;
  }

  function isPanoptoEntryUrl(url) {
    return isPanoptoShareUrl(url) || isPanoptoDownloadUrl(url);
  }

  function triggerOfficialDownload(url) {
    const link = document.createElement('a');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function setFieldError(input, output, message) {
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    output.textContent = message ? `エラー: ${message}` : '';
  }

  shareForm.addEventListener('submit', function (event) {
    event.preventDefault();
    shareStatus.textContent = '';
    const url = parseHttpsUrl(shareInput.value);
    const urlMessage = !url
      ? 'HTTPSで始まる完全なURLを入力してください。'
      : !isPanoptoEntryUrl(url)
        ? 'panopto.com配下の公式な共有URLまたはダウンロードURLを入力してください。'
        : '';
    const authMessage = authorization.checked
      ? ''
      : 'アクセス権とダウンロード許可を確認してチェックしてください。';

    setFieldError(shareInput, shareError, urlMessage);
    setFieldError(authorization, authorizationError, authMessage);

    if (urlMessage || authMessage) {
      (urlMessage ? shareInput : authorization).focus();
      return;
    }

    if (isPanoptoDownloadUrl(url)) {
      shareStatus.textContent = 'Panopto公式のダウンロードURLを確認しました。ブラウザの案内に従って保存してください。';
      triggerOfficialDownload(url);
      return;
    }

    shareStatus.textContent = '共有URLのためPanopto公式ページを新しいタブで開きました。ダウンロード項目が表示される場合だけ保存してください。';
    window.open(url.href, '_blank', 'noopener,noreferrer');
  });

  shareInput.addEventListener('input', function () {
    setFieldError(shareInput, shareError, '');
  });
  authorization.addEventListener('change', function () {
    setFieldError(authorization, authorizationError, '');
  });

  downloadForm.addEventListener('submit', function (event) {
    event.preventDefault();
    downloadStatus.textContent = '';
    downloadLink.hidden = true;
    downloadLink.removeAttribute('href');
    const shareUrl = parseHttpsUrl(shareInput.value);
    const downloadUrl = parseHttpsUrl(downloadInput.value);
    let message = '';

    if (!shareUrl || !isPanoptoEntryUrl(shareUrl)) {
      message = '先に有効なPanopto共有URLまたは公式ダウンロードURLを入力してください。';
    } else if (!authorization.checked) {
      message = '先にアクセス権とダウンロード許可を確認してください。';
    } else if (!downloadUrl) {
      message = 'HTTPSで始まる完全なダウンロードURLを入力してください。';
    } else if (downloadUrl.hostname.toLowerCase() !== shareUrl.hostname.toLowerCase()) {
      message = '安全のため、共有URLと同じPanoptoサイトのURLだけを使用できます。';
    }

    setFieldError(downloadInput, downloadError, message);
    if (message) {
      downloadInput.focus();
      return;
    }

    downloadLink.href = downloadUrl.href;
    downloadLink.hidden = false;
    downloadStatus.textContent = '公式URLを確認しました。下の「動画をダウンロード」を選び、ブラウザの案内に従って保存してください。';
    downloadLink.focus();
  });

  downloadInput.addEventListener('input', function () {
    setFieldError(downloadInput, downloadError, '');
    downloadLink.hidden = true;
    downloadLink.removeAttribute('href');
  });
})();
