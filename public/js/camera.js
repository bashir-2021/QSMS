/* Take a student photo with the device camera and hand it to the normal file input,
   so a captured photo is uploaded and validated exactly like a chosen file. */
(function () {
  'use strict';

  const box = document.querySelector('[data-camera]');
  if (!box) return;

  const SIZE = 640; // square output: about 60 KB as JPEG, far below the upload limit
  const video = box.querySelector('[data-camera-video]');
  const preview = box.querySelector('#photoPreview');
  const fileInput = box.querySelector('input[type=file]');
  const openBtn = box.querySelector('[data-camera-open]');
  const captureBtn = box.querySelector('[data-camera-capture]');
  const cancelBtn = box.querySelector('[data-camera-cancel]');
  const errorEl = box.querySelector('[data-camera-error]');
  let stream = null;
  let previewWasHidden = true;

  const show = (el, visible) => el.classList.toggle('d-none', !visible);
  const showError = (message) => { errorEl.textContent = message || ''; show(errorEl, Boolean(message)); };

  function setLive(live) {
    show(video, live);
    show(captureBtn, live);
    show(cancelBtn, live);
    show(openBtn, !live);
    if (live) {
      previewWasHidden = preview.classList.contains('d-none');
      show(preview, false);
    }
  }

  function stop() {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
    setLive(false);
  }

  async function open() {
    showError('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError(box.dataset.msgInsecure);
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      video.srcObject = stream;
      setLive(true);
    } catch (err) {
      showError(box.dataset.msgDenied);
    }
  }

  function capture() {
    const side = Math.min(video.videoWidth, video.videoHeight);
    if (!side) return; // the first frame has not arrived yet
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    canvas.getContext('2d').drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
    canvas.toBlob((blob) => {
      const files = new DataTransfer();
      files.items.add(new File([blob], 'camera-photo.jpg', { type: 'image/jpeg' }));
      fileInput.files = files.files;
      previewWasHidden = false;
      stop();
      show(preview, true);
      fileInput.dispatchEvent(new Event('change', { bubbles: true })); // updates the preview
    }, 'image/jpeg', 0.85);
  }

  openBtn.addEventListener('click', open);
  captureBtn.addEventListener('click', capture);
  cancelBtn.addEventListener('click', () => { stop(); show(preview, !previewWasHidden); });
  window.addEventListener('pagehide', stop);
}());
